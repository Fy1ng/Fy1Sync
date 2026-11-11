import { useEffect, useRef } from 'react'
import { apiClient } from '../../app/apiClient'
import { useSession, useSessionSnapshot } from '../../app/SessionContext'
import { SOURCE_ROLES, type SourceRole } from '../../core/types'

export const WATCH_SAMPLE_MS = 2_000
const LOCAL_HEARTBEAT_MS = 5_000
const STOP_EVENTS = ['pause', 'waiting', 'stalled', 'seeking', 'ended', 'emptied', 'error'] as const

export interface VideoWatchSample {
  currentTime: number
  decodedBytes: number | null
  presentedFrames: number | null
  playable: boolean
}

const counter = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Browser counters are optional. Missing counters stay null instead of being estimated. */
export function readVideoWatchSample(video: HTMLVideoElement): VideoWatchSample {
  let presentedFrames: number | null = null
  try {
    const quality = video.getVideoPlaybackQuality?.()
    const total = counter(quality?.totalVideoFrames), dropped = counter(quality?.droppedVideoFrames)
    if (total !== null && dropped !== null && dropped <= total) presentedFrames = total - dropped
  } catch { /* Some decoders do not expose frame counters. */ }
  const decodedBytes = counter((video as HTMLVideoElement & { webkitVideoDecodedByteCount?: number }).webkitVideoDecodedByteCount)
  return {
    currentTime: Number.isFinite(video.currentTime) && video.currentTime >= 0 ? video.currentTime : 0,
    decodedBytes,
    presentedFrames,
    playable: Number.isFinite(video.currentTime) && video.currentTime >= 0 && !video.paused && !video.seeking
      && !video.ended && !video.error && video.readyState >= 2,
  }
}

/** Only observed media progress counts. A first sample, seek or counter reset is a baseline. */
export function videoWatchAdvancing(previous: VideoWatchSample | null, current: VideoWatchSample): boolean {
  if (!previous?.playable || !current.playable || current.currentTime < previous.currentTime) return false
  if (previous.presentedFrames !== null && current.presentedFrames !== null && current.presentedFrames < previous.presentedFrames) return false
  if (previous.decodedBytes !== null && current.decodedBytes !== null && current.decodedBytes < previous.decodedBytes) return false
  return current.currentTime > previous.currentTime
    || (previous.presentedFrames !== null && current.presentedFrames !== null && current.presentedFrames > previous.presentedFrames)
}

/** Match the selected room to its actual source, never to an unrelated playing video. */
export function useDouyuPlaybackReports(): void {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const latest = useRef(snapshot)
  latest.current = snapshot
  const selected = snapshot.danmaku.room
  const room = selected && /^[1-9]\d{0,11}$/.test(selected) ? selected : null
  const sourceKey = SOURCE_ROLES.map(role => {
    const descriptor = snapshot.media[role].descriptor
    return `${role}:${descriptor?.platform ?? ''}:${descriptor?.sourceRoom ?? ''}:${descriptor?.url ?? ''}`
  }).join('|')

  useEffect(() => {
    if (!room) return
    let live = true
    let localPlaying = false
    const entries = new Map<SourceRole, { video: HTMLVideoElement; previous: VideoWatchSample | null; playing: boolean; release: () => void }>()
    const reportLocal = (playing: boolean): void => {
      if (!live) return
      localPlaying = playing
      void apiClient.feature('reportDouyuPlayback', { room, playing }).catch(() => {})
    }
    const report = (role: SourceRole, sample: VideoWatchSample, playing: boolean): void => {
      void apiClient.feature('reportDouyuWatchPlayback', {
        role, playing, currentTime: sample.currentTime, decodedBytes: sample.decodedBytes, presentedFrames: sample.presentedFrames,
      }).catch(() => {})
    }
    const updateLocal = (): void => {
      const playing = [...entries.values()].some(entry => entry.playing)
      if (playing !== localPlaying) reportLocal(playing)
    }
    const remove = (role: SourceRole): void => {
      const entry = entries.get(role)
      if (!entry) return
      entry.release()
      report(role, readVideoWatchSample(entry.video), false)
      entries.delete(role)
    }
    const sampleRole = (role: SourceRole): void => {
      const state = latest.current.media[role]
      const descriptor = state.descriptor
      const matches = state.status === 'ready' && descriptor?.platform === 'douyu' && descriptor.sourceRoom === room
      if (!matches) { remove(role); return }
      const video = session.engine.element(role)
      let entry = entries.get(role)
      if (entry && entry.video !== video) { remove(role); entry = undefined }
      if (!entry) {
        const stop = (): void => {
          const current = entries.get(role)
          if (!live || current?.video !== video) return
          current.previous = null
          current.playing = false
          report(role, readVideoWatchSample(video), false)
          updateLocal()
        }
        for (const event of STOP_EVENTS) video.addEventListener(event, stop)
        entry = { video, previous: null, playing: false,
          release: () => { for (const event of STOP_EVENTS) video.removeEventListener(event, stop) } }
        entries.set(role, entry)
      }
      const sample = readVideoWatchSample(video)
      entry.playing = videoWatchAdvancing(entry.previous, sample)
      entry.previous = sample
      report(role, sample, entry.playing)
    }
    const sampleAll = (): void => {
      if (!live) return
      for (const role of SOURCE_ROLES) sampleRole(role)
      updateLocal()
    }
    reportLocal(false)
    sampleAll()
    const timer = setInterval(sampleAll, WATCH_SAMPLE_MS)
    const localTimer = setInterval(() => { if (localPlaying) reportLocal(true) }, LOCAL_HEARTBEAT_MS)
    const leave = (): void => {
      for (const role of [...entries.keys()]) remove(role)
      reportLocal(false)
    }
    const pagehide = (): void => {
      leave()
      live = false
      clearInterval(timer)
      clearInterval(localTimer)
    }
    window.addEventListener('pagehide', pagehide)
    return () => {
      clearInterval(timer)
      clearInterval(localTimer)
      window.removeEventListener('pagehide', pagehide)
      leave()
      live = false
    }
  }, [session, room, sourceKey])
}
