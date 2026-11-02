import type { RoiRect } from '../core/profileSchema'

/** Observe the existing commentary element. This module never owns playback. */
export function watchCameraFrames(video: HTMLVideoElement, receive: (mediaTime: number) => void,
  options: { previewFallback?: boolean } = {}): () => void {
  let stopped = false
  let frame = 0
  let animation = 0
  let lastTime = Number.NaN
  const paint = (time: number, force = false): void => {
    if (!stopped && video.readyState >= 2 && !video.seeking && video.videoWidth > 0 && video.videoHeight > 0 && (force || time !== lastTime)) {
      lastTime = time
      receive(time)
    }
  }
  const refresh = (): void => paint(video.currentTime, true)
  const invalidate = (): void => { lastTime = Number.NaN }
  const events = options.previewFallback
    ? ['loadeddata', 'seeked', 'resize', 'pause', 'canplay', 'playing', 'timeupdate'] as const
    : ['loadeddata', 'seeked', 'resize', 'pause'] as const
  events.forEach(event => video.addEventListener(event, refresh))
  if (options.previewFallback) {
    video.addEventListener('emptied', invalidate)
    video.addEventListener('loadstart', invalidate)
  }
  if (typeof video.requestVideoFrameCallback === 'function') {
    const next: VideoFrameRequestCallback = (_now, metadata) => {
      paint(metadata.mediaTime)
      if (!stopped) frame = video.requestVideoFrameCallback(next)
    }
    frame = video.requestVideoFrameCallback(next)
    if (options.previewFallback) {
      // A modal or occluded video may stop presentation callbacks while its pixels remain readable.
      // Only previews use this recovery path; analysis still requires decoded frame timestamps.
      let checkedAt = -Infinity
      const recover = (now: number): void => {
        if (stopped) return
        if (now - checkedAt >= 100) { checkedAt = now; paint(video.currentTime) }
        animation = requestAnimationFrame(recover)
      }
      animation = requestAnimationFrame(recover)
    }
  } else {
    const next = (): void => {
      paint(video.currentTime)
      if (!stopped) animation = requestAnimationFrame(next)
    }
    animation = requestAnimationFrame(next)
  }
  refresh()
  return () => {
    stopped = true
    if (frame) video.cancelVideoFrameCallback(frame)
    if (animation) cancelAnimationFrame(animation)
    events.forEach(event => video.removeEventListener(event, refresh))
    video.removeEventListener('emptied', invalidate)
    video.removeEventListener('loadstart', invalidate)
  }
}

const FRAME_COUNT = 6
const SAMPLE_SECONDS = 0.4
const STALL_MS = 2400
const MAX_WAIT_MS = 12_000

export interface CameraSample {
  frames: Uint8Array
  width: number
  height: number
  /** Sampled region and rough ROI, respectively in source-frame and local coordinates. */
  region: RoiRect
  rough: RoiRect
}

export function cameraSamplingPlan(sourceWidth: number, sourceHeight: number, rough: RoiRect) {
  if (![sourceWidth, sourceHeight].every(n => Number.isSafeInteger(n) && n >= 8 && n <= 16_384)
    || ![rough.x, rough.y, rough.w, rough.h].every(Number.isFinite) || rough.x < 0 || rough.y < 0
    || rough.w <= 0 || rough.h <= 0 || rough.x + rough.w > 1 + 1e-9 || rough.y + rough.h > 1 + 1e-9) throw new Error('摄像头选框无效, 请重新框选.')
  // Downsample the selection, not the full 4K broadcast. A small native camera keeps its border pixels.
  const padding = Math.max(4, Math.ceil(Math.min(rough.w * sourceWidth, rough.h * sourceHeight) * 0.03))
  const x = Math.max(0, Math.floor(rough.x * sourceWidth) - padding)
  const y = Math.max(0, Math.floor(rough.y * sourceHeight) - padding)
  const right = Math.min(sourceWidth, Math.ceil((rough.x + rough.w) * sourceWidth) + padding)
  const bottom = Math.min(sourceHeight, Math.ceil((rough.y + rough.h) * sourceHeight) + padding)
  const sw = right - x, sh = bottom - y
  const scale = Math.min(1, 960 / Math.max(sw, sh))
  const width = Math.max(1, Math.round(sw * scale)), height = Math.max(1, Math.round(sh * scale))
  if (rough.w * sourceWidth * scale < 14 || rough.h * sourceHeight * scale < 14) throw new Error('选框太小, 请框住完整摄像头后重新贴边.')
  const region = { x: x / sourceWidth, y: y / sourceHeight, w: sw / sourceWidth, h: sh / sourceHeight }
  return { x, y, sw, sh, width, height, region,
    rough: { x: (rough.x - region.x) / region.w, y: (rough.y - region.y) / region.h, w: rough.w / region.w, h: rough.h / region.h } }
}

/** Six distinct decoded media timestamps, rather than six wall-clock copies of one frame. */
export async function sampleCameraFrames(video: HTMLVideoElement, rough: RoiRect, signal: AbortSignal): Promise<CameraSample> {
  if (video.paused) throw new Error('解说已暂停. 请恢复播放后重新贴边, 或直接手动调整并保存.')
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error('解说画面尚未就绪. 请等待画面恢复后重试.')
  signal.throwIfAborted()
  const source = video.currentSrc
  const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight
  const plan = cameraSamplingPlan(sourceWidth, sourceHeight, rough)
  const { width, height } = plan
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法读取解说画面. 可以手动调整取景框并保存.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const frameBytes = width * height * 4
  const frames = new Uint8Array(frameBytes * FRAME_COUNT)
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    let count = 0, lastTime = Number.NEGATIVE_INFINITY, lastFrameAt = startedAt
    let stop = (): void => {}
    let timer: ReturnType<typeof setInterval> | undefined
    let settled = false
    const cleanup = (): void => {
      stop()
      if (timer) clearInterval(timer)
      signal.removeEventListener('abort', abort)
      interruptions.forEach(event => video.removeEventListener(event, interrupt))
    }
    const fail = (error: unknown): void => { if (!settled) { settled = true; cleanup(); reject(error) } }
    const abort = (): void => fail(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const interrupt = (): void => fail(new Error(video.paused
      ? '采样期间解说已暂停. 恢复播放后可重新贴边.'
      : '采样期间解说源或播放位置发生变化. 请重新贴边.'))
    const interruptions = ['pause', 'seeking', 'emptied', 'loadstart', 'error', 'ended', 'resize'] as const
    signal.addEventListener('abort', abort, { once: true })
    interruptions.forEach(event => video.addEventListener(event, interrupt))
    timer = setInterval(() => {
      if (performance.now() - lastFrameAt > STALL_MS || performance.now() - startedAt > MAX_WAIT_MS) fail(new Error('解说未提供足够的连续视频帧. 请等待播放恢复后重试, 或手动调整取景框.'))
    }, 200)
    stop = watchCameraFrames(video, mediaTime => {
      if (settled) return
      if (source !== video.currentSrc || sourceWidth !== video.videoWidth || sourceHeight !== video.videoHeight) { interrupt(); return }
      if (!Number.isFinite(mediaTime) || mediaTime < lastTime + SAMPLE_SECONDS) return
      try {
        context.drawImage(video, plan.x, plan.y, plan.sw, plan.sh, 0, 0, width, height)
        const rgba = context.getImageData(0, 0, width, height).data
        if (rgba.length !== frameBytes) throw new Error('无法完整读取解说画面.')
        frames.set(rgba, count * frameBytes)
        count++
        lastTime = mediaTime
        lastFrameAt = performance.now()
        if (count === FRAME_COUNT) { settled = true; cleanup(); resolve({ frames, width, height, region: plan.region, rough: plan.rough }) }
      } catch (error) { fail(error) }
    })
    // The first synchronous paint may fail before watchCameraFrames returns its disposer.
    if (settled) cleanup()
  })
}
