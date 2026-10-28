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
 *  - cropping: frames are cropped here (see FrameGrabber), so the worker gets a
 *    profile whose ROI is the whole image.
 */

import type { RecognitionProfile, RoiRect } from '../core/profileSchema'
import type { SourceRole } from '../core/types'
import { FULL_FRAME_ROI, type GrabbedFrame } from './frameGrabber'
import type {
  ConfiguredMessage,
  AutoOperationFailure,
  LearnResult,
  LocateResult,
  ResultMessage,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

export type { AutoOperationFailure, LearnReport, LearnResult, LocateResult, RoiCandidate, TickMoment } from './protocol'

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
  /** Discovery/learning may take longer than one recognition frame. */
  autoTimeoutMs?: number
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
  private profile: RecognitionProfile | null = null
  private disposed = false
  private requestId = 0
  private retainedWindowId: number | null = null
  private latestLocateRequestId = 0
  private readonly pending = new Map<number, {
    type: 'locate' | 'learn'
    retainForLearning?: boolean
    resolve: (result: LocateResult | LearnResult) => void
    timer: ReturnType<typeof setTimeout>
  }>()
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
        if (this.inFlight && this.inFlight.frameIndex === message.frameIndex) {
          this.inFlight = null
        }
        this.stats.completed += 1
        this.stats.lastElapsedMs = message.elapsedMs
        this.options.onResult?.(message)
        break
      case 'error':
        this.inFlight = null
        this.failWorkerOperations(message.message)
        this.options.onError?.(message.message)
        break
      case 'located':
      case 'learned': {
        const pending = this.pending.get(message.requestId)
        if (!pending || (pending.type === 'locate') !== (message.type === 'located')) return
        if (message.type === 'located' && message.result.status === 'success' && pending.retainForLearning
          && message.requestId === this.latestLocateRequestId) this.retainedWindowId = message.result.windowId ?? null
        clearTimeout(pending.timer)
        this.pending.delete(message.requestId)
        pending.resolve(message.result)
        break
      }
    }
  }

  private readonly handleError = (event: Event): void => {
    this.inFlight = null
    const message =
      event instanceof ErrorEvent && event.message ? event.message : '识别 Worker 发生错误'
    this.failWorkerOperations(message)
    this.options.onError?.(message)
  }

  constructor(private readonly options: RecognitionClientOptions) {
    this.now = options.now ?? (() => Date.now())
    this.stallTimeoutMs = options.stallTimeoutMs ?? 2000
  }

  get generation(): number {
    return this.generationValue
  }

  /** ROI in source fractions, used by the caller to crop before submitting. */
  get roi(): RecognitionProfile['roi'] | null {
    return this.profile?.roi ?? null
  }

  get activeProfile(): RecognitionProfile | null {
    return this.profile
  }

  get busy(): boolean {
    return this.inFlight !== null
  }

  getStats(): ClientStats {
    return { ...this.stats }
  }

  /** Install a profile. Always starts a new generation. */
  configure(profile: RecognitionProfile, options: { automatic?: boolean } = {}): number {
    if (this.disposed) return this.generationValue
    this.finishPending({ status: 'cancelled', reason: 'reconfigured' })
    this.retainedWindowId = null
    this.profile = profile
    this.generationValue += 1
    this.inFlight = null
    const worker = this.ensureWorker()
    // The frame arrives pre-cropped, so the worker must not crop again.
    worker.postMessage({
      type: 'configure',
      generation: this.generationValue,
      profile: { ...profile, roi: { ...FULL_FRAME_ROI } },
      ...(options.automatic ? { automatic: true } : {}),
    })
    return this.generationValue
  }

  /**
   * Hand a cropped frame to the worker. Returns false when the frame was dropped
   * (no profile, or one already in flight) — callers use it for a drop counter,
   * not as an error.
   */
  submit(role: SourceRole, frame: GrabbedFrame, wantDebug = false,
    score?: Omit<NonNullable<Extract<WorkerRequest, { type: 'frame' }>['score']>, 'clockRect'>): boolean {
    if (this.disposed || !this.profile) return false
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
    const worker = this.ensureWorker()
    const index = ++this.frameIndex
    const buffer = toTransferable(frame.pixels)
    this.inFlight = { frameIndex: index, at: this.now() }
    this.stats.submitted += 1
    worker.postMessage(
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
        ...(frame.clockRect && score ? { score: { ...score, clockRect: frame.clockRect } } : {}),
      },
      [buffer],
    )
    return true
  }

  /** Transfer a full-frame window; optionally retain its grayscale session for one learn. */
  locate(frames: GrabbedFrame[], options: { retainForLearning?: boolean } = {}): Promise<LocateResult> {
    return this.requestWindow('locate', frames, undefined, options) as Promise<LocateResult>
  }

  /** Pass [] with windowId to reuse a retained window. Never installs or persists the candidate. */
  learn(frames: GrabbedFrame[], roi: RoiRect, options: { windowId?: number } = {}): Promise<LearnResult> {
    return this.requestWindow('learn', frames, roi, options) as Promise<LearnResult>
  }

  /** Invalidate in-flight and queued work without dropping the profile. */
  cancel(): number {
    if (this.disposed) return this.generationValue
    this.generationValue += 1
    this.inFlight = null
    this.retainedWindowId = null
    this.finishPending({ status: 'cancelled', reason: 'cancelled' })
    this.worker?.postMessage({ type: 'cancel', generation: this.generationValue })
    return this.generationValue
  }

  dispose(): void {
    this.disposed = true
    this.retainedWindowId = null
    this.finishPending({ status: 'cancelled', reason: 'disposed' })
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

  private requestWindow(type: 'locate' | 'learn', frames: GrabbedFrame[], roi?: RoiRect,
    options: { retainForLearning?: boolean; windowId?: number } = {}): Promise<LocateResult | LearnResult> {
    if (this.disposed) return Promise.resolve({ status: 'cancelled', reason: 'disposed' })
    return new Promise((resolve) => {
      const requestId = ++this.requestId
      if (type === 'locate' || options.windowId === undefined || options.windowId === this.retainedWindowId) this.retainedWindowId = null
      if (type === 'locate') this.latestLocateRequestId = requestId
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.invalidateAutomaticGeneration()
        this.finishPending({ status: 'cancelled', reason: 'window-invalidated' })
        resolve({ status: 'failed', reason: 'worker-timeout', detail: '自动识别 Worker 响应超时' })
      }, this.options.autoTimeoutMs ?? 60_000)
      this.pending.set(requestId, { type, resolve, timer, retainForLearning: options.retainForLearning })
      try {
        const window = frames.map((frame) => ({ ...frame, pixels: toTransferable(frame.pixels) }))
        const transfer = [...new Set(window.map((frame) => frame.pixels))]
        const common = { generation: this.generationValue, requestId, frames: window }
        const worker = this.ensureWorker()
        if (type === 'locate') worker.postMessage({ type: 'locate', ...common,
          ...(options.retainForLearning ? { retainForLearning: true } : {}) }, transfer)
        else worker.postMessage({ type: 'learn', ...common, roi: roi!,
          ...(options.windowId !== undefined ? { windowId: options.windowId } : {}) }, transfer)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        this.invalidateAutomaticGeneration()
        this.finishPending({ status: 'cancelled', reason: 'window-invalidated' })
        resolve({ status: 'failed', reason: 'worker-error', detail: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  private finishPending(result: AutoOperationFailure): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(result)
    }
    this.pending.clear()
  }

  private failWorkerOperations(detail: string): void {
    const hadAutomaticWork = this.pending.size > 0 || this.retainedWindowId !== null
    this.finishPending({ status: 'failed', reason: 'worker-error', detail })
    if (hadAutomaticWork) this.invalidateAutomaticGeneration()
  }

  private invalidateAutomaticGeneration(): void {
    this.generationValue += 1
    this.inFlight = null
    this.retainedWindowId = null
    try {
      this.worker?.postMessage({ type: 'cancel', generation: this.generationValue })
    } catch {
      // A broken transport may reject cancel too. The new generation still rejects late replies.
    }
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
