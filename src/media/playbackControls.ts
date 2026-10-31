import { clampSeek, readTimebase, seekReached } from './timebase'
import type { Timebase } from '../core/types'

export interface PlaybackSeekResult { ok: boolean; target: number | null; clamped: boolean; reason: 'unavailable' | 'cancelled' | 'timeout' | null }
export interface NativePipResult { ok: boolean; active: boolean; reason: 'unsupported' | 'not-ready' | 'user-gesture-required' | 'failed' | null }

/**
 * Behind the newest segment when hls.js has no sync point to offer: three of the local
 * buffer's 2-second segments, about where hls.js itself rejoins.
 */
const LIVE_FALLBACK_BEHIND_SECONDS = 6

/**
 * Where 回到直播 lands. Not the newest frame: right behind it nothing is buffered yet, so the
 * picture waits for the next segment to be written and fetched, a stall of up to a segment
 * every time. hls.js's sync point stays a few segments back, where it starts a live stream.
 */
export function latestPlayableTime(timebase: Timebase, livePosition: number | null = null): number | null {
  if (timebase.kind !== 'live') return null
  const target = livePosition !== null && Number.isFinite(livePosition) ? Math.min(livePosition, timebase.seekableEnd)
    : timebase.seekableEnd - LIVE_FALLBACK_BEHIND_SECONDS
  return Math.max(timebase.seekableStart, target)
}

/** Headless media controls. Claude binds gestures/keys without owning or remounting video. */
export class PlaybackControls {
  private cancelSeek: (() => void) | null = null
  private disposed = false
  constructor(readonly video: HTMLVideoElement, private readonly isLive?: () => boolean | undefined, private readonly timeoutMs = 8_000,
    private readonly livePosition: () => number | null = () => null) {}
  async seekBy(seconds: number): Promise<PlaybackSeekResult> {
    if (!Number.isFinite(seconds) || Math.abs(seconds) > 86_400) return this.unavailable()
    return this.seekTo(this.video.currentTime + seconds)
  }
  async returnToLive(): Promise<PlaybackSeekResult> {
    const timebase = readTimebase(this.video, this.isLive?.())
    const target = timebase ? latestPlayableTime(timebase, this.livePosition()) : null
    return target === null ? this.unavailable() : this.seekTo(target)
  }
  seekTo(target: number): Promise<PlaybackSeekResult> {
    if (this.disposed || !Number.isFinite(target) || this.video.readyState < 1) return Promise.resolve(this.unavailable())
    const timebase = readTimebase(this.video, this.isLive?.())
    if (!timebase) return Promise.resolve(this.unavailable())
    this.cancelSeek?.()
    const next = clampSeek(target, timebase)
    if (!this.video.seeking && seekReached(this.video.currentTime, next.target)) return Promise.resolve({ ok: true, target: next.target, clamped: next.clamped, reason: null })
    return new Promise(resolve => {
      let done = false
      const finish = (ok: boolean, reason: PlaybackSeekResult['reason']) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.video.removeEventListener('seeked', onSeek)
        this.video.removeEventListener('emptied', onCancel)
        if (this.cancelSeek === onCancel) this.cancelSeek = null
        resolve({ ok, target: next.target, clamped: next.clamped, reason })
      }
      const onSeek = () => { if (seekReached(this.video.currentTime, next.target)) finish(true, null) }
      const onCancel = () => finish(false, 'cancelled')
      const timer = setTimeout(() => finish(false, 'timeout'), this.timeoutMs)
      this.cancelSeek = onCancel
      this.video.addEventListener('seeked', onSeek)
      this.video.addEventListener('emptied', onCancel)
      try { this.video.currentTime = next.target } catch { finish(false, 'unavailable') }
    })
  }
  supportsNativePip(): boolean {
    return !this.disposed && this.video.ownerDocument.pictureInPictureEnabled === true
      && typeof this.video.requestPictureInPicture === 'function' && !this.video.disablePictureInPicture
  }
  /** Invoke directly from the gesture handler so transient activation is preserved. */
  async toggleNativePip(): Promise<NativePipResult> {
    const document = this.video.ownerDocument
    if (!this.supportsNativePip()) return { ok: false, active: false, reason: 'unsupported' }
    if (this.video.readyState < 1 || !this.video.videoWidth) return { ok: false, active: false, reason: 'not-ready' }
    try {
      if (document.pictureInPictureElement === this.video) await document.exitPictureInPicture()
      else await this.video.requestPictureInPicture()
      return { ok: true, active: document.pictureInPictureElement === this.video, reason: null }
    } catch (error) {
      return { ok: false, active: document.pictureInPictureElement === this.video,
        reason: error instanceof DOMException && error.name === 'NotAllowedError' ? 'user-gesture-required' : 'failed' }
    }
  }
  dispose(): void { this.disposed = true; this.cancelSeek?.() }
  private unavailable(): PlaybackSeekResult { return { ok: false, target: null, clamped: false, reason: 'unavailable' } }
}
