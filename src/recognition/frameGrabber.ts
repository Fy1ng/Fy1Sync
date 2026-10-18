/**
 * Main-thread frame grabbing.
 *
 * Only the ROI is copied out of the video: a full 1080p frame is 8.3 MB of RGBA,
 * while a clock ROI is tens of kilobytes. Cropping here and transferring the
 * small buffer is what makes 30 fps sampling affordable, so the worker always
 * receives a pre-cropped image and treats it as a whole frame.
 */

import { roiToPixels } from '../core/imageOps'
import type { RoiRect } from '../core/profileSchema'
import type { RecognitionFailure } from '../core/types'

export const FULL_FRAME_ROI: RoiRect = { x: 0, y: 0, w: 1, h: 1 }

export interface GrabbedFrame {
  pixels: Uint8ClampedArray
  width: number
  height: number
  /** Media time of the grabbed frame. */
  mediaTime: number
  /** Wall clock (ms) the frame was presented/sampled. */
  wallTime: number
}

export type GrabResult =
  | { ok: true; frame: GrabbedFrame }
  | { ok: false; reason: RecognitionFailure; detail?: string }

interface CanvasTarget {
  canvas: HTMLCanvasElement | OffscreenCanvas
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
}

export class FrameGrabber {
  private target: CanvasTarget | null = null

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Crop `roi` out of the current video frame. */
  grab(video: HTMLVideoElement, roi: RoiRect, mediaTimeOverride?: number): GrabResult {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height || video.readyState < 2) {
      return { ok: false, reason: 'no-video-frame', detail: '视频尚未解码出画面' }
    }

    const rect = roiToPixels(roi, width, height)
    const target = this.ensureTarget(rect.width, rect.height)
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
        rect.width,
        rect.height,
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
      image = target.context.getImageData(0, 0, rect.width, rect.height)
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
        width: rect.width,
        height: rect.height,
        mediaTime: mediaTimeOverride ?? video.currentTime,
        wallTime: this.clock(),
      },
    }
  }

  dispose(): void {
    this.target = null
  }

  private ensureTarget(width: number, height: number): CanvasTarget | null {
    const existing = this.target
    if (existing && existing.canvas.width === width && existing.canvas.height === height) {
      return existing
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (context) {
        this.target = { canvas, context }
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
