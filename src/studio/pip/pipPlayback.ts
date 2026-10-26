/**
 * The PiP window's one video and what it tells main about it.
 *
 * Main shows the window only after a `ready` report and treats twelve seconds without
 * progress as a stall, so every report here is read off the element: media time as it
 * stands, frames as they were actually presented. Nothing is extrapolated. A paused video
 * says `playing: false`, which is how main tells a pause from a stall.
 *
 * Readiness needs real progress, not a resolved `play()` promise: a presented frame
 * (`requestVideoFrameCallback`), or the media clock moving forward while playing. The
 * second matters because the window is hidden until ready, and a hidden window may not
 * present frames at all.
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { PipState } from '../../../electron/pipManager'
import type { ResolvedStream } from '../../../server/platforms/types'
import type { MediaDescriptor } from '../../core/types'
import { IndependentMedia } from '../../media/independentMedia'

/** Reports while ready, well inside main's 20 s silence limit and 12 s stall window. */
export const REPORT_INTERVAL_MS = 2_000
const CHECK_INTERVAL_MS = 1_000
/** Below HAVE_CURRENT_DATA there is no picture to call ready. */
const HAVE_CURRENT_DATA = 2

export function descriptorFor(source: ResolvedStream): MediaDescriptor {
  return {
    kind: source.kind === 'hls' ? 'hls' : 'progressive',
    url: source.url,
    input: source.url,
    label: source.label,
    loop: false,
    viaProxy: false,
    platform: source.platform,
    ...(source.sourceRoom ? { sourceRoom: source.sourceRoom } : {}),
  }
}

/** One element for the window's whole life; recoveries reload it in place. */
export function usePipMedia(): IndependentMedia | null {
  const [media, setMedia] = useState<IndependentMedia | null>(null)
  useEffect(() => {
    const created = new IndependentMedia('pip')
    // Main mutes this window until it owns the audio, so the element itself can stay unmuted.
    created.video.muted = false
    setMedia(created)
    return () => {
      created.dispose()
      setMedia(current => current === created ? null : current)
    }
  }, [])
  return media
}

/** The allowed local source: from the state, or asked for by stream id when absent. */
export function usePipSource(state: PipState | null): { source: ResolvedStream | null; problem: string | null } {
  const [fetched, setFetched] = useState<{ id: string; source: ResolvedStream | null; problem: string | null } | null>(null)
  const id = state?.streamId ?? null
  const needsFetch = !!id && !state?.source && (state?.phase === 'opening' || state?.phase === 'ready')

  useEffect(() => {
    if (!needsFetch || !id) return
    let live = true
    void apiClient.feature('getStreamPlayback', { id }).then(result => {
      if (!live) return
      if (result.ok) setFetched({ id, source: result.value, problem: result.value ? null : '画面来源尚未就绪' })
      else setFetched({ id, source: null, problem: result.message })
    })
    return () => { live = false }
  }, [id, needsFetch])

  if (state?.source) return { source: state.source, problem: null }
  if (fetched && fetched.id === id) return { source: fetched.source, problem: fetched.problem }
  return { source: null, problem: null }
}

/**
 * Load the source, and load it again on each `recoveryRevision`, on the same element.
 * `onReload` runs before each load so the danmaku timeline can drop what it parked.
 */
export function usePipLoad(media: IndependentMedia | null, source: ResolvedStream | null,
  recoveryRevision: number, active: boolean, onReload: () => void): string | null {
  const [problem, setProblem] = useState<string | null>(null)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const reloadRef = useRef(onReload)
  reloadRef.current = onReload
  const key = source ? `${source.kind} ${source.url}` : null

  useEffect(() => {
    const current = sourceRef.current
    if (!media || !current || !active) return
    let cancelled = false
    setProblem(null)
    reloadRef.current()
    const video = media.video
    void media.load(descriptorFor(current)).then(async () => {
      if (cancelled) return
      try { await video.play() } catch (error) {
        if (cancelled || !(error instanceof DOMException) || error.name !== 'NotAllowedError' || video.muted) return
        // An autoplay refusal for sound: play silently rather than not at all.
        video.muted = true
        await video.play().catch(() => {})
      }
    }).catch(error => {
      if (!cancelled) setProblem(error instanceof Error && error.message ? `画面载入失败：${error.message}` : '画面载入失败')
    })
    return () => { cancelled = true }
  }, [media, key, recoveryRevision, active])

  useEffect(() => {
    if (!media) return
    const onError = (): void => { if (media.video.error) setProblem('画面播放出错') }
    const onPlaying = (): void => setProblem(null)
    media.video.addEventListener('error', onError)
    media.video.addEventListener('playing', onPlaying)
    return () => {
      media.video.removeEventListener('error', onError)
      media.video.removeEventListener('playing', onPlaying)
    }
  }, [media])

  // Failed or closed: stop the player so nothing keeps decoding behind the message.
  useEffect(() => { if (media && !active) media.video.pause() }, [media, active])

  return problem
}

/**
 * Report readiness once playback really runs, then real progress every couple of seconds
 * and at once on play/pause. Silent while `active` is false (failed or closed).
 */
export function usePipReporter(media: IndependentMedia | null, active: boolean, onState: (state: PipState) => void): boolean {
  const [ready, setReady] = useState(false)
  const stateRef = useRef(onState)
  stateRef.current = onState

  useEffect(() => {
    if (!media || !active) return
    const video = media.video
    let disposed = false
    let isReady = false
    let frames = 0
    let qualityBase: number | null = null
    let baseline: number | null = null
    let lastReport = 0
    const frameApi = typeof video.requestVideoFrameCallback === 'function'
    let frameHandle: number | null = null
    const onFrame = (): void => {
      if (disposed) return
      frames += 1
      frameHandle = video.requestVideoFrameCallback(onFrame)
      check()
    }
    if (frameApi) frameHandle = video.requestVideoFrameCallback(onFrame)

    const sampleDecoded = (): void => {
      if (frameApi || typeof video.getVideoPlaybackQuality !== 'function') return
      const total = video.getVideoPlaybackQuality().totalVideoFrames
      if (!Number.isSafeInteger(total) || total < 0) return
      // A reload restarts the element's own count; only forward steps are frames.
      if (qualityBase !== null && total > qualityBase) frames += total - qualityBase
      qualityBase = total
    }
    const sample = () => {
      sampleDecoded()
      const time = video.currentTime
      return {
        playing: !video.paused && !video.ended,
        mediaTime: Number.isFinite(time) && time >= 0 ? time : 0,
        frameCount: Math.min(frames, Number.MAX_SAFE_INTEGER),
      }
    }
    const report = (value: ReturnType<typeof sample>): void => {
      lastReport = Date.now()
      void apiClient.feature('reportEnhancedPip', { ready: true, ...value }).then(result => {
        if (!disposed && result.ok) stateRef.current(result.value)
      })
    }
    const check = (): void => {
      if (disposed) return
      const value = sample()
      if (!isReady) {
        const moving = value.playing && !video.seeking && video.readyState >= HAVE_CURRENT_DATA
        const advanced = baseline !== null && value.mediaTime > baseline
        baseline = moving ? value.mediaTime : null
        if (!moving || (frames === 0 && !advanced)) return
        isReady = true
        setReady(true)
        report(value)
        return
      }
      if (Date.now() - lastReport >= REPORT_INTERVAL_MS) report(value)
    }
    // A jump is not playback: measure progress again from where the seek landed.
    const onSeek = (): void => { baseline = null }
    const onPlayState = (): void => { if (isReady) report(sample()); else check() }
    const events: Array<[string, () => void]> = [
      ['timeupdate', check], ['playing', onPlayState], ['pause', onPlayState], ['ended', onPlayState],
      ['seeking', onSeek], ['seeked', onSeek], ['emptied', onSeek],
    ]
    for (const [name, listener] of events) video.addEventListener(name, listener)
    const timer = setInterval(check, CHECK_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
      for (const [name, listener] of events) video.removeEventListener(name, listener)
      if (frameHandle !== null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameHandle)
    }
  }, [media, active])

  return ready
}
