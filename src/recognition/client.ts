import { isBasicClock, isHudPack, captureRoi, type ActiveProfile } from '../core/activeProfile'
/**
 * Main-thread side of the recognition worker.
 *
 * Three responsibilities, all of them about not lying to the caller:
 *  - backpressure: exactly one frame is in flight. At 30 fps a slow machine would
 *    otherwise queue frames faster than it drains them and every reading would be
 *    seconds stale — worse than no reading at all.
 *  - generations: any change to the profile, ROI or source bumps a counter, and
 *    results from an older generation are discarded rather than applied to the new
 *    configuration.
 *  - style packs keep the full frame for their configured HUD regions.
 */

import type { RoiRect } from '../core/profileSchema'
import type { SourceRole } from '../core/types'
import { FULL_FRAME_ROI, type GrabbedFrame } from './frameGrabber'
import type {
  ConfiguredMessage,
  ResultMessage,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

export type { TickMoment } from './protocol'

export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  terminate(): void
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponse>) => void): void
  addEventListener(type: 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponse>) => void): void
  removeEventListener(type: 'error', listener: (event: Event) => void): void
}

export interface RecognitionClientOptions {
  createWorker: () => WorkerLike
  onResult?: (result: ResultMessage) => void
  onConfigured?: (message: ConfiguredMessage) => void
  onError?: (message: string) => void
  now?: () => number
  /** A frame held longer than this is assumed lost so sampling can resume. */
  stallTimeoutMs?: number
}

export interface ClientStats {
  submitted: number
  completed: number
  dropped: number
  stalled: number
  lastElapsedMs: number
}

export class RecognitionClient {
  private worker: WorkerLike | null = null
  private generationValue = 0
  private frameIndex = 0
  private inFlight: { frameIndex: number; at: number } | null = null
  private profile: ActiveProfile | null = null
  private disposed = false
  private faulted = false
  private readonly stats: ClientStats = {
    submitted: 0,
    completed: 0,
    dropped: 0,
    stalled: 0,
    lastElapsedMs: 0,
  }

  private readonly now: () => number
  private readonly stallTimeoutMs: number

  private readonly handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const message = event.data
    if (message.generation !== this.generationValue) return
    switch (message.type) {
      case 'configured':
        this.options.onConfigured?.(message)
        break
      case 'result':
        // Only the frame in flight is answered. A reply to one given up on after a stall is
        // older than the frame that replaced it and would read the clock out of order.
        if (!this.inFlight || this.inFlight.frameIndex !== message.frameIndex) return
        this.inFlight = null
        this.stats.completed += 1
        this.stats.lastElapsedMs = message.elapsedMs
        this.options.onResult?.(message)
        break
      case 'error':
        this.failWorker(message.message)
        break
    }
  }

  private readonly handleError = (event: Event): void => {
    const message =
      event instanceof ErrorEvent && event.message ? event.message : '识别 Worker 发生错误'
    this.failWorker(message)
  }

  constructor(private readonly options: RecognitionClientOptions) {
    this.now = options.now ?? (() => Date.now())
    this.stallTimeoutMs = options.stallTimeoutMs ?? 2000
  }

  get generation(): number {
    return this.generationValue
  }

  /** ROI in source fractions, used by the caller to crop before submitting. */
  get roi(): RoiRect | null {
    return this.profile ? captureRoi(this.profile) : null
  }

  get activeProfile(): ActiveProfile | null {
    return this.profile
  }

  /**
   * A frame the worker has held past the stall timeout no longer counts: callers check this
   * before grabbing, so a frame that is never answered must stop holding them back, and the
   * next submit replaces it.
   */
  get busy(): boolean {
    return this.inFlight !== null && this.now() - this.inFlight.at < this.stallTimeoutMs
  }

  getStats(): ClientStats {
    return { ...this.stats }
  }

  /** Install a profile. Always starts a new generation. */
  configure(profile: ActiveProfile, preserveBasic = false): number {
    if (this.disposed) return this.generationValue
    this.profile = profile
    this.faulted = false
    this.generationValue += 1
    this.inFlight = null
    // The frame arrives pre-cropped, so the worker must not crop again.
    try {
      const worker = this.ensureWorker()
      worker.postMessage({
        type: 'configure',
        generation: this.generationValue,
        profile: isHudPack(profile) || isBasicClock(profile) ? profile : { ...profile, roi: { ...FULL_FRAME_ROI } },
        ...(preserveBasic ? { preserveBasic: true } : {}),
      })
    } catch (error) { this.failWorker(error instanceof Error ? error.message : String(error)) }
    return this.generationValue
  }

  /**
   * Hand a cropped frame to the worker. Returns false when the frame was dropped
   * (no profile, or one already in flight) — callers use it for a drop counter,
   * not as an error.
   */
  submit(role: SourceRole, frame: GrabbedFrame, wantDebug = false): boolean {
    if (this.disposed || this.faulted || !this.profile) return false
    if (this.inFlight) {
      if (this.now() - this.inFlight.at < this.stallTimeoutMs) {
        this.stats.dropped += 1
        return false
      }
      // The worker never answered. Give up on that frame rather than wedging
      // recognition forever.
      this.stats.stalled += 1
      this.inFlight = null
    }
    const index = ++this.frameIndex
    const buffer = toTransferable(frame.pixels)
    this.inFlight = { frameIndex: index, at: this.now() }
    this.stats.submitted += 1
    try { this.ensureWorker().postMessage(
      {
        type: 'frame',
        generation: this.generationValue,
        role,
        frameIndex: index,
        mediaTime: frame.mediaTime,
        wallTime: frame.wallTime,
        width: frame.width,
        height: frame.height,
        pixels: buffer,
        wantDebug,
      },
      [buffer],
    ) } catch (error) {
      this.failWorker(error instanceof Error ? error.message : String(error))
      return false
    }
    return true
  }

  /** Invalidate in-flight and queued work without dropping the profile. */
  cancel(preserveBasic = false, resetTiming = false): number {
    if (this.disposed) return this.generationValue
    this.generationValue += 1
    this.inFlight = null
    this.worker?.postMessage({ type: 'cancel', generation: this.generationValue,
      ...(preserveBasic ? { preserveBasic: true } : {}), ...(resetTiming ? { resetTiming: true } : {}) })
    return this.generationValue
  }

  dispose(): void {
    this.disposed = true
    this.inFlight = null
    this.profile = null
    if (this.worker) {
      this.worker.removeEventListener('message', this.handleMessage)
      this.worker.removeEventListener('error', this.handleError)
      this.worker.terminate()
      this.worker = null
    }
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker
    const worker = this.options.createWorker()
    worker.addEventListener('message', this.handleMessage)
    worker.addEventListener('error', this.handleError)
    this.worker = worker
    return worker
  }

  private failWorker(message: string): void {
    if (this.disposed || this.faulted) return
    this.faulted = true
    this.inFlight = null
    this.generationValue += 1
    if (this.worker) {
      this.worker.removeEventListener('message', this.handleMessage)
      this.worker.removeEventListener('error', this.handleError)
      this.worker.terminate()
      this.worker = null
    }
    // A fresh configure is the retry boundary; more frames cannot flood a failed worker.
    this.options.onError?.(message)
  }
}

/**
 * `getImageData` returns a view that owns its buffer, but a caller may hand us a
 * subarray. Transferring a shared buffer would detach more than intended, so copy
 * unless the view covers the whole buffer.
 */
function toTransferable(pixels: Uint8ClampedArray): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = pixels
  if (byteOffset === 0 && byteLength === buffer.byteLength && buffer instanceof ArrayBuffer) {
    return buffer
  }
  return pixels.slice().buffer as ArrayBuffer
}
