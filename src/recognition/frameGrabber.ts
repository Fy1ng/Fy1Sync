/**
 * Frame acquisition with asynchronous worker readback and a synchronous editor fallback.
 *
 * Only the ROI is copied out of the video: a full 1080p frame is 8.3 MB of RGBA,
 * while a clock ROI is tens of kilobytes. Cropping here and transferring the
 * small buffer is what makes 30 fps sampling affordable, so the worker always
 * receives a pre-cropped image and treats it as a whole frame.
 */

import { roiToPixels } from '../core/imageOps'
import type { RoiRect } from '../core/profileSchema'
import type { RecognitionFailure } from '../core/types'
import type { Rect } from '../core/imageOps'
import { readbackFailure, type ReadbackResponse } from './frameReadback'

export const FULL_FRAME_ROI: RoiRect = { x: 0, y: 0, w: 1, h: 1 }

export interface GrabbedFrame {
  pixels: Uint8ClampedArray
  width: number
  height: number
  /** Media time of the grabbed frame. */
  mediaTime: number
  /** Wall clock (ms) the frame was presented/sampled. */
  wallTime: number
  /** Exact native clock pixels inside a combined scoreboard strip. */
  clockRect?: Rect
}

export type GrabResult =
  | { ok: true; frame: GrabbedFrame }
  | { ok: false; reason: RecognitionFailure; detail?: string }

export type AsyncGrabResult = GrabResult | { ok: false; skipped: true; reason: 'backpressure' | 'cancelled' }

export interface FrameGrabberOptions {
  createWorker?: () => Worker
  timeoutMs?: number
}

// Discovery and measurement may temporarily share a video, but never a readback slot.
const inFlightVideos = new WeakMap<HTMLVideoElement, object>()

interface PendingReadback {
  id: number
  video: HTMLVideoElement
  creating: boolean
  settled: boolean
  timer: ReturnType<typeof setTimeout>
  resolve: (result: AsyncGrabResult) => void
  width: number
  height: number
  mediaTime: number
  wallTime: number
}

interface CanvasTarget {
  canvas: HTMLCanvasElement | OffscreenCanvas
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
}

export class FrameGrabber {
  private target: CanvasTarget | null = null
  private readonly targets = new Map<string, CanvasTarget>()
  private worker: Worker | null = null
  private pending: PendingReadback | null = null
  private requestId = 0
  private dropped = 0
  private disposed = false

  constructor(private readonly clock: () => number = () => Date.now(), private readonly options: FrameGrabberOptions = {}) {}

  get busy(): boolean { return this.pending !== null }
  getStats(): { dropped: number } { return { dropped: this.dropped } }

  grabAsync(video: HTMLVideoElement, roi: RoiRect, mediaTimeOverride?: number): Promise<AsyncGrabResult> {
    return this.grabScaledAsync(video, roi, Number.POSITIVE_INFINITY, mediaTimeOverride)
  }

  async grabStripAsync(video: HTMLVideoElement, clock: RoiRect, mediaTimeOverride?: number): Promise<AsyncGrabResult> {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return this.grabAsync(video, clock, mediaTimeOverride)
    const rect = roiToPixels(clock, width, height)
    const x = Math.max(0, rect.x - Math.ceil(rect.width * 2.2))
    const y = Math.max(0, rect.y - Math.ceil(rect.height * 0.8))
    const right = Math.min(width, rect.x + rect.width + Math.ceil(rect.width * 2.2))
    const bottom = Math.min(height, rect.y + rect.height + Math.ceil(rect.height * 1.1))
    const result = await this.grabAsync(video, { x: x / width, y: y / height,
      w: (right - x) / width, h: (bottom - y) / height }, mediaTimeOverride)
    if (result.ok) result.frame.clockRect = { x: rect.x - x, y: rect.y - y, width: rect.width, height: rect.height }
    return result
  }

  grabScaledAsync(video: HTMLVideoElement, roi: RoiRect, maxWidth: number, mediaTimeOverride?: number): Promise<AsyncGrabResult> {
    if (this.disposed) return Promise.resolve({ ok: false, skipped: true, reason: 'cancelled' })
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height || video.readyState < 2) {
      return Promise.resolve({ ok: false, reason: 'no-video-frame', detail: '视频尚未解码出画面' })
    }
    if (this.pending || inFlightVideos.has(video)) {
      this.dropped += 1
      return Promise.resolve({ ok: false, skipped: true, reason: 'backpressure' })
    }
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined'
      || (!this.options.createWorker && typeof Worker === 'undefined')) {
      return Promise.resolve(maxWidth === Infinity ? this.grab(video, roi, mediaTimeOverride)
        : this.grabScaled(video, roi, maxWidth, mediaTimeOverride))
    }

    const rect = roiToPixels(roi, width, height)
    const scale = Math.min(1, Math.max(1, maxWidth) / rect.width)
    const outputWidth = Math.max(1, Math.round(rect.width * scale))
    const outputHeight = Math.max(1, Math.round(rect.height * scale))
    // Snapshot both clocks before yielding: readback latency is not presentation time.
    const mediaTime = mediaTimeOverride ?? video.currentTime
    const wallTime = this.clock()
    return new Promise(resolve => {
      const pending: PendingReadback = {
        id: ++this.requestId, video, creating: true, settled: false, resolve,
        width: outputWidth, height: outputHeight, mediaTime, wallTime,
        timer: setTimeout(() => {
          if (this.pending !== pending) return
          this.terminateWorker()
          this.settle(pending, { ok: false, reason: 'decode-failed', detail: '抓帧读回超时, 请重试' })
        }, this.options.timeoutMs ?? 1000),
      }
      this.pending = pending
      inFlightVideos.set(video, pending)
      let bitmapPromise: Promise<ImageBitmap>
      try {
        bitmapPromise = createImageBitmap(video, rect.x, rect.y, rect.width, rect.height, {
          resizeWidth: outputWidth, resizeHeight: outputHeight, colorSpaceConversion: 'default',
        })
      } catch (error) {
        pending.creating = false
        this.settle(pending, readbackFailure(error))
        return
      }
      void bitmapPromise.then(bitmap => {
        pending.creating = false
        try {
          if (pending.settled) { this.release(pending); return }
          const worker = this.ensureWorker()
          worker.postMessage({ id: pending.id, source: bitmap,
            rect: { x: 0, y: 0, width: outputWidth, height: outputHeight },
            width: outputWidth, height: outputHeight }, [bitmap])
        } catch (error) {
          this.terminateWorker()
          this.settle(pending, readbackFailure(error))
        } finally {
          // close() is also safe after transfer; the worker closes its owning handle.
          bitmap.close()
        }
      }, error => {
        pending.creating = false
        if (pending.settled) this.release(pending)
        else this.settle(pending, readbackFailure(error))
      })
    })
  }

  cancel(): void {
    this.terminateWorker()
    if (this.pending) this.settle(this.pending, { ok: false, skipped: true, reason: 'cancelled' })
  }

  private readonly onReadback = (event: MessageEvent<ReadbackResponse>): void => {
    const pending = this.pending
    const result = event.data
    if (!pending || pending.settled || result.id !== pending.id) return
    this.settle(pending, result.ok ? { ok: true, frame: {
      pixels: result.pixels, width: pending.width, height: pending.height,
      mediaTime: pending.mediaTime, wallTime: pending.wallTime,
    } } : result)
  }

  private readonly onWorkerError = (): void => {
    this.terminateWorker()
    if (this.pending) this.settle(this.pending, { ok: false, reason: 'decode-failed', detail: '抓帧 Worker 运行失败, 请重试' })
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = this.options.createWorker?.() ?? new Worker(new URL('./frameReadback.worker.ts', import.meta.url), {
        type: 'module', name: 'frame-readback',
      })
      this.worker.addEventListener('message', this.onReadback)
      this.worker.addEventListener('error', this.onWorkerError)
      this.worker.addEventListener('messageerror', this.onWorkerError)
    }
    return this.worker
  }

  private terminateWorker(): void {
    this.worker?.removeEventListener('message', this.onReadback)
    this.worker?.removeEventListener('error', this.onWorkerError)
    this.worker?.removeEventListener('messageerror', this.onWorkerError)
    this.worker?.terminate()
    this.worker = null
  }

  private settle(pending: PendingReadback, result: AsyncGrabResult): void {
    if (!pending.settled) {
      pending.settled = true
      clearTimeout(pending.timer)
      pending.resolve(result)
    }
    // ImageBitmap creation cannot be aborted. Keep its slot until a late bitmap is closed,
    // even after timeout/cancel, rather than accumulating unbounded capture promises.
    if (!pending.creating) this.release(pending)
  }

  private release(pending: PendingReadback): void {
    if (inFlightVideos.get(pending.video) === pending) inFlightVideos.delete(pending.video)
    if (this.pending === pending) this.pending = null
  }

  /** Crop `roi` out of the current video frame. */
  grab(video: HTMLVideoElement, roi: RoiRect, mediaTimeOverride?: number): GrabResult {
    return this.grabScaled(video, roi, Number.POSITIVE_INFINITY, mediaTimeOverride)
  }

  /** One GPU readback for clock and both scores, preserving every original clock pixel. */
  grabStrip(video: HTMLVideoElement, clock: RoiRect, mediaTimeOverride?: number): GrabResult {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return this.grab(video, clock, mediaTimeOverride)
    const rect = roiToPixels(clock, width, height)
    const x = Math.max(0, rect.x - Math.ceil(rect.width * 2.2))
    const y = Math.max(0, rect.y - Math.ceil(rect.height * 0.8))
    const right = Math.min(width, rect.x + rect.width + Math.ceil(rect.width * 2.2))
    const bottom = Math.min(height, rect.y + rect.height + Math.ceil(rect.height * 1.1))
    const result = this.grab(video, { x: x / width, y: y / height,
      w: (right - x) / width, h: (bottom - y) / height }, mediaTimeOverride)
    if (result.ok) result.frame.clockRect = { x: rect.x - x, y: rect.y - y, width: rect.width, height: rect.height }
    return result
  }

  /** Crop and downscale a discovery frame without changing the ROI's aspect ratio. */
  grabScaled(
    video: HTMLVideoElement,
    roi: RoiRect,
    maxWidth: number,
    mediaTimeOverride?: number,
  ): GrabResult {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height || video.readyState < 2) {
      return { ok: false, reason: 'no-video-frame', detail: '视频尚未解码出画面' }
    }

    const rect = roiToPixels(roi, width, height)
    const scale = Math.min(1, Math.max(1, maxWidth) / rect.width)
    const outputWidth = Math.max(1, Math.round(rect.width * scale))
    const outputHeight = Math.max(1, Math.round(rect.height * scale))
    const target = this.ensureTarget(outputWidth, outputHeight)
    if (!target) {
      return { ok: false, reason: 'decode-failed', detail: '无法创建 2D 画布' }
    }

    try {
      target.context.drawImage(
        video,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        outputWidth,
        outputHeight,
      )
    } catch (error) {
      return {
        ok: false,
        reason: 'decode-failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    let image: ImageData
    try {
      image = target.context.getImageData(0, 0, outputWidth, outputHeight)
    } catch (error) {
      // Cross-origin media without CORS headers taints the canvas. This is the
      // single most common reason recognition cannot run, and it is fixable by
      // routing the source through the local proxy, so say so precisely.
      return {
        ok: false,
        reason: 'canvas-tainted',
        detail:
          error instanceof Error && /secur/iu.test(error.message)
            ? '画布被跨域视频污染，无法读取像素。请通过本地代理加载该源。'
            : (error instanceof Error ? error.message : String(error)),
      }
    }

    return {
      ok: true,
      frame: {
        pixels: image.data,
        width: outputWidth,
        height: outputHeight,
        mediaTime: mediaTimeOverride ?? video.currentTime,
        wallTime: this.clock(),
      },
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
    this.target = null
    this.targets.clear()
  }

  private ensureTarget(width: number, height: number): CanvasTarget | null {
    const key = `${width}x${height}`
    const cached = this.targets.get(key)
    if (cached) { this.target = cached; return cached }
    const existing = this.target
    if (existing && existing.canvas.width === width && existing.canvas.height === height) {
      return existing
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (context) {
        this.target = { canvas, context }
        this.targets.set(key, this.target)
        if (this.targets.size > 4) this.targets.delete(this.targets.keys().next().value!)
        return this.target
      }
    }
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    this.target = { canvas, context }
    this.targets.set(key, this.target)
    if (this.targets.size > 4) this.targets.delete(this.targets.keys().next().value!)
    return this.target
  }
}

interface VideoFrameMetadata {
  mediaTime: number
  presentedFrames: number
  expectedDisplayTime: number
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameMetadata) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export function supportsFrameCallback(video: HTMLVideoElement): boolean {
  return typeof (video as FrameCallbackVideo).requestVideoFrameCallback === 'function'
}

/**
 * Drive a per-frame callback.
 *
 * `requestVideoFrameCallback` reports the exact media time of the frame that was
 * just presented, which is what the sync anchors need; without it we fall back to
 * a timer and `currentTime`, which is coarser but works everywhere.
 */
export function startFrameLoop(
  video: HTMLVideoElement,
  fps: number,
  onFrame: (mediaTime: number) => void,
): () => void {
  const frameVideo = video as FrameCallbackVideo
  if (typeof frameVideo.requestVideoFrameCallback === 'function') {
    let handle = 0
    let stopped = false
    const step = (_now: number, metadata: VideoFrameMetadata): void => {
      if (stopped) return
      onFrame(metadata.mediaTime)
      handle = frameVideo.requestVideoFrameCallback!(step)
    }
    handle = frameVideo.requestVideoFrameCallback(step)
    return () => {
      stopped = true
      frameVideo.cancelVideoFrameCallback?.(handle)
    }
  }

  const interval = Math.max(1000 / Math.max(1, fps), 16)
  const timer = setInterval(() => onFrame(video.currentTime), interval)
  return () => clearInterval(timer)
}
