/** Observe the existing commentary element. This module never owns playback. */
export function watchCameraFrames(video: HTMLVideoElement, receive: (mediaTime: number) => void): () => void {
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
  const events = ['loadeddata', 'seeked', 'resize', 'pause'] as const
  events.forEach(event => video.addEventListener(event, refresh))
  if (typeof video.requestVideoFrameCallback === 'function') {
    const next: VideoFrameRequestCallback = (_now, metadata) => {
      paint(metadata.mediaTime)
      if (!stopped) frame = video.requestVideoFrameCallback(next)
    }
    frame = video.requestVideoFrameCallback(next)
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
  }
}

const FRAME_COUNT = 6
const SAMPLE_SECONDS = 0.4
const STALL_MS = 2400

/** Six distinct decoded media timestamps, rather than six wall-clock copies of one frame. */
export async function sampleCameraFrames(video: HTMLVideoElement, signal: AbortSignal): Promise<{ frames: Uint8Array; width: number; height: number }> {
  if (video.paused) throw new Error('解说已暂停. 请恢复播放后重新收紧, 或直接手动调整并保存.')
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error('解说画面尚未就绪. 请等待画面恢复后重试.')
  signal.throwIfAborted()
  const source = video.currentSrc
  const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight
  const width = Math.min(960, sourceWidth), height = Math.max(1, Math.round(width * sourceHeight / sourceWidth))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法读取解说画面. 可以手动调整取景框并保存.')
  const frames = new Uint8Array(width * height * FRAME_COUNT)
  return new Promise((resolve, reject) => {
    let count = 0, lastTime = Number.NEGATIVE_INFINITY, lastFrameAt = performance.now()
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
      ? '采样期间解说已暂停. 恢复播放后可重新收紧.'
      : '采样期间解说源或播放位置发生变化. 请重新收紧.'))
    const interruptions = ['pause', 'seeking', 'emptied', 'loadstart', 'error', 'ended', 'resize'] as const
    signal.addEventListener('abort', abort, { once: true })
    interruptions.forEach(event => video.addEventListener(event, interrupt))
    timer = setInterval(() => {
      if (performance.now() - lastFrameAt > STALL_MS) fail(new Error('解说未提供足够的连续视频帧. 请等待播放恢复后重试, 或手动调整取景框.'))
    }, 200)
    stop = watchCameraFrames(video, mediaTime => {
      if (settled) return
      if (source !== video.currentSrc || sourceWidth !== video.videoWidth || sourceHeight !== video.videoHeight) { interrupt(); return }
      if (!Number.isFinite(mediaTime) || mediaTime < lastTime + SAMPLE_SECONDS) return
      try {
        context.drawImage(video, 0, 0, width, height)
        const rgba = context.getImageData(0, 0, width, height).data
        for (let i = 0; i < width * height; i++) frames[count * width * height + i] = (rgba[i * 4]! * 77 + rgba[i * 4 + 1]! * 150 + rgba[i * 4 + 2]! * 29) >> 8
        count++
        lastTime = mediaTime
        lastFrameAt = performance.now()
        if (count === FRAME_COUNT) { settled = true; cleanup(); resolve({ frames, width, height }) }
      } catch (error) { fail(error) }
    })
    // The first synchronous paint may fail before watchCameraFrames returns its disposer.
    if (settled) cleanup()
  })
}
