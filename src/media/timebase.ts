/**
 * Timebase reading and seek clamping.
 *
 * Manual sync rewinds a source by up to 60 s, which only works if we know how far
 * back that source can actually go. VODs answer with `duration`; live streams
 * answer with the last `seekable` range, whose start creeps forward as segments
 * expire. Every seek target is clamped against that range, so a rewind request
 * larger than the DVR window is reported as a partial move instead of silently
 * snapping to the window edge and reporting success.
 */

import type { Timebase } from '../core/types'

/** Live streams report Infinity, but some report a very large finite duration. */
const LIVE_DURATION_THRESHOLD = 4 * 3600
/** Seeks land within a fragment boundary; anything closer counts as "there". */
export const SEEK_TOLERANCE_SECONDS = 0.05
/** How close to the seekable end still counts as watching live. */
export const LIVE_EDGE_TOLERANCE_SECONDS = 1.5

export interface TimebaseSource {
  duration: number
  seekable: TimeRanges
}

export function lastSeekableRange(
  seekable: TimeRanges,
): { start: number; end: number } | null {
  if (seekable.length === 0) return null
  const index = seekable.length - 1
  const start = seekable.start(index)
  const end = seekable.end(index)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start, end }
}

/**
 * Classify a media element. `isLiveHint` comes from hls.js, which knows from the
 * playlist whether the stream is live before `duration` settles.
 */
export function readTimebase(source: TimebaseSource, isLiveHint?: boolean): Timebase | null {
  const range = lastSeekableRange(source.seekable)
  const duration = source.duration
  const looksLive =
    isLiveHint ?? (!Number.isFinite(duration) || duration > LIVE_DURATION_THRESHOLD)

  if (looksLive) {
    if (!range) return null
    return { kind: 'live', seekableStart: range.start, seekableEnd: range.end }
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    // Metadata has not arrived yet; a seekable range is still better than nothing.
    return range ? { kind: 'live', seekableStart: range.start, seekableEnd: range.end } : null
  }
  return { kind: 'vod', duration }
}

/** Earliest reachable media time. */
export function seekFloor(timebase: Timebase): number {
  return timebase.kind === 'vod' ? 0 : timebase.seekableStart
}

/** Latest reachable media time. */
export function seekCeiling(timebase: Timebase): number {
  return timebase.kind === 'vod' ? timebase.duration : timebase.seekableEnd
}

/** Media time that means "live" for this source. */
export function liveEdge(timebase: Timebase): number {
  return seekCeiling(timebase)
}

export function isNearLiveEdge(
  currentTime: number,
  timebase: Timebase,
  tolerance = LIVE_EDGE_TOLERANCE_SECONDS,
): boolean {
  return liveEdge(timebase) - currentTime <= tolerance
}

export interface ClampedSeek {
  target: number
  /** True when the request had to be trimmed to fit the window. */
  clamped: boolean
  /** Seconds that could not be honoured (always >= 0). */
  shortfall: number
}

/** Clamp an absolute seek target into the reachable window. */
export function clampSeek(target: number, timebase: Timebase): ClampedSeek {
  const floor = seekFloor(timebase)
  const ceiling = seekCeiling(timebase)
  if (target < floor) return { target: floor, clamped: true, shortfall: floor - target }
  if (target > ceiling) return { target: ceiling, clamped: true, shortfall: target - ceiling }
  return { target, clamped: false, shortfall: 0 }
}

/**
 * Behind the newest segment when hls.js has no sync point and no buffered range is known.
 */
const LIVE_FALLBACK_BEHIND_SECONDS = 6
/** Safety margin kept ahead of the playhead when syncing to the buffered live tail. */
export const LIVE_SYNC_MARGIN_SECONDS = 0.5
/** Gaps up to this threshold catch up smoothly via playbackRate instead of flushing the decoder. */
export const LIVE_SMOOTH_CATCHUP_MAX_SECONDS = 4
/** Playback rate used during smooth live catch-up. */
export const LIVE_SMOOTH_CATCHUP_RATE = 1.25

export interface LiveSyncTargetOptions {
  bufferedEnd?: number | null
  livePosition?: number | null
  currentTime?: number | null
  localBuffer?: boolean
  marginSeconds?: number
}

/**
 * Where conservative headless live playback rejoins when no buffered range is supplied.
 */
export function latestPlayableTime(timebase: Timebase, livePosition: number | null = null): number | null {
  if (timebase.kind !== 'live') return null
  const target = livePosition !== null && Number.isFinite(livePosition) ? Math.min(livePosition, timebase.seekableEnd)
    : timebase.seekableEnd - LIVE_FALLBACK_BEHIND_SECONDS
  return Math.max(timebase.seekableStart, target)
}

/**
 * Target media time for DouyuEx-style "同步时间": lands near the real buffered tail
 * (or the local buffer's sealed live edge) and never moves backwards behind `currentTime`.
 */
export function liveSyncTarget(timebase: Timebase, options: LiveSyncTargetOptions = {}): number | null {
  if (timebase.kind !== 'live') return null
  const margin = options.marginSeconds ?? LIVE_SYNC_MARGIN_SECONDS
  const { seekableStart, seekableEnd } = timebase
  const hasBuffered = options.bufferedEnd != null && Number.isFinite(options.bufferedEnd)
    && options.bufferedEnd > seekableStart
  const bufferedTarget = hasBuffered ? Math.min(seekableEnd, options.bufferedEnd! - margin) : null
  const edgeTarget = seekableEnd - margin

  let target: number
  if (options.localBuffer) {
    target = bufferedTarget !== null && seekableEnd - options.bufferedEnd! <= 4
      ? bufferedTarget
      : edgeTarget
  } else if (bufferedTarget !== null
    && (options.currentTime == null || !Number.isFinite(options.currentTime) || options.bufferedEnd! > options.currentTime + margin)) {
    const fallback = latestPlayableTime(timebase, options.livePosition ?? null) ?? edgeTarget
    target = seekableEnd - options.bufferedEnd! <= 4 ? bufferedTarget : Math.max(bufferedTarget, fallback)
  } else {
    target = options.livePosition != null && Number.isFinite(options.livePosition)
      ? Math.min(options.livePosition, seekableEnd)
      : edgeTarget
  }

  const bounded = Math.max(seekableStart, Math.min(seekableEnd, target))
  if (options.currentTime != null && Number.isFinite(options.currentTime) && bounded < options.currentTime) {
    return Math.min(seekableEnd, options.currentTime)
  }
  return bounded
}

/**
 * Clamp an explicit user seek on the timeline. Unlike conservative startup sync, the user may
 * seek freely into any already-buffered region on the right without being snapped backwards.
 */
export function clampLiveUserSeek(
  target: number,
  timebase: Timebase,
  options: LiveSyncTargetOptions = {},
): ClampedSeek {
  const next = clampSeek(target, timebase)
  if (timebase.kind !== 'live') return next
  const syncCeiling = liveSyncTarget(timebase, { ...options, marginSeconds: Math.min(options.marginSeconds ?? 0.25, LIVE_SYNC_MARGIN_SECONDS) }) ?? timebase.seekableEnd
  const ceiling = options.currentTime != null && Number.isFinite(options.currentTime)
    ? Math.min(timebase.seekableEnd, Math.max(syncCeiling, options.currentTime))
    : syncCeiling
  if (next.target <= ceiling) return next
  return { target: ceiling, clamped: true, shortfall: next.shortfall + next.target - ceiling }
}

/**
 * Legacy helper kept for headless callers that do not pass buffered state.
 */
export function clampPlayableSeek(target: number, timebase: Timebase, livePosition: number | null = null): ClampedSeek {
  const next = clampSeek(target, timebase)
  const ceiling = latestPlayableTime(timebase, livePosition)
  if (ceiling === null || next.target <= ceiling) return next
  return { target: ceiling, clamped: true, shortfall: next.shortfall + next.target - ceiling }
}

/**
 * Plan a rewind of `seconds` from `from`. Positive `seconds` moves backwards.
 * The shortfall is what the caller reports as "DVR window too short".
 */
export function planRewind(from: number, seconds: number, timebase: Timebase): ClampedSeek {
  return clampSeek(from - seconds, timebase)
}

export function seekReached(currentTime: number, target: number, tolerance = SEEK_TOLERANCE_SECONDS): boolean {
  return Math.abs(currentTime - target) <= tolerance
}

/** Seconds the playhead sits behind live; 0 for VODs. */
export function latencyBehindEdge(currentTime: number, timebase: Timebase): number {
  if (timebase.kind === 'vod') return 0
  return Math.max(0, timebase.seekableEnd - currentTime)
}

/** Length of the reachable window, i.e. the maximum possible rewind. */
export function windowSeconds(timebase: Timebase): number {
  return Math.max(0, seekCeiling(timebase) - seekFloor(timebase))
}
