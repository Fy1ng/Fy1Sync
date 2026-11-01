import type { SourceRole } from '../core/types'

type BufferPhase = 'starting' | 'buffering' | 'ready' | 'stalled' | 'reconnecting' | 'failed' | 'stopped'
type FragmentPhase = 'loading' | 'loaded' | 'buffered'
export type PlaybackDiagnosticCategory = 'production' | 'fetch' | 'playback' | 'thread' | 'unknown'

export interface PlaybackDiagnosticInput {
  at: number
  currentTime: number
  paused: boolean
  seeking: boolean
  ended: boolean
  readyState: number
  buffered: number[][]
  seekableStart?: number | null
  seekableEnd: number | null
  playlistStart?: number | null
  playlistEnd: number | null
  fragment: { phase: FragmentPhase; elapsedMs: number; start?: number; end?: number; loadMs?: number | null } | null
  error: { type: string; details: string; ageMs?: number } | null
  droppedFrames: number | null
  timerLateMs: number
  localBuffer: { state: BufferPhase; seconds: number; completeSegments?: number } | null
  observing: boolean
}

export interface PlaybackDiagnosticSnapshot {
  at: number
  intervalMs: number | null
  currentTime: number
  mediaProgress: number | null
  paused: boolean
  seeking: boolean
  ended: boolean
  readyState: number
  observing: boolean
  bufferAhead: number
  bufferedStart: number | null
  bufferedEnd: number | null
  nextBufferedStart: number | null
  seekableStart: number | null
  seekableEnd: number | null
  seekableUnchangedMs: number | null
  playlistStart: number | null
  playlistEnd: number | null
  playlistUnchangedMs: number | null
  fragment: { phase: FragmentPhase; elapsedMs: number; start: number | null; end: number | null; loadMs: number | null } | null
  error: { type: string | null; details: string | null; ageMs: number } | null
  droppedFramesDelta: number | null
  timerLateMs: number
  localBuffer: { state: BufferPhase; seconds: number; completeSegments: number | null } | null
}

export interface PlaybackStallSummary {
  durationMs: number
  category: PlaybackDiagnosticCategory
  hint: string
  ongoing: boolean
}

interface Stall extends PlaybackStallSummary {
  start: PlaybackDiagnosticSnapshot
  end: PlaybackDiagnosticSnapshot | null
}

interface RoleDiagnostics {
  samples: PlaybackDiagnosticSnapshot[]
  latest: PlaybackDiagnosticSnapshot | null
  droppedFrames: number | null
  seekableChangedAt: number | null
  playlistChangedAt: number | null
  lastStall: Stall | null
  recoveryStart: PlaybackDiagnosticSnapshot | null
}

const BUFFER_PHASES = new Set(['starting', 'buffering', 'ready', 'stalled', 'reconnecting', 'failed', 'stopped'])
const FRAGMENT_PHASES = new Set(['loading', 'loaded', 'buffered'])
const ERROR_TYPES = new Set(['networkError', 'mediaError', 'keySystemError', 'muxError', 'otherError'])
const ERROR_DETAILS = new Set([
  'manifestLoadError', 'manifestLoadTimeOut', 'manifestParsingError', 'manifestIncompatibleCodecsError',
  'levelEmptyError', 'levelLoadError', 'levelLoadTimeOut', 'levelParsingError', 'levelSwitchError',
  'audioTrackLoadError', 'audioTrackLoadTimeOut', 'subtitleTrackLoadError', 'subtitleTrackLoadTimeOut',
  'fragLoadError', 'fragLoadTimeOut', 'fragDecryptError', 'fragParsingError', 'fragGap', 'remuxAllocError',
  'keyLoadError', 'keyLoadTimeOut', 'bufferAddCodecError', 'bufferIncompatibleCodecsError',
  'bufferAppendError', 'bufferAppendingError', 'bufferStalledError', 'bufferFullError', 'bufferSeekOverHole',
  'bufferNudgeOnStall', 'assetListLoadError', 'assetListLoadTimeout', 'assetListParsingError',
  'interstitialAssetItemError', 'internalException', 'aborted', 'attachMediaError', 'unknown',
])
const HINTS: Record<PlaybackDiagnosticCategory, string> = {
  production: '本地产片没推进, 播放列表末端暂未增长',
  fetch: '本地有数据但播放器没拉到, 拉片尚未完成',
  playback: '数据已到但画面不动, 请检查追加或播放进展',
  thread: '界面线程繁忙, 此段观测不完整',
  unknown: '证据不足, 暂时无法判断卡顿位置',
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const nonnegative = (value: number | null | undefined): number | null => {
  const number = finite(value)
  return number === null ? null : Math.max(0, number)
}
const emptyRole = (): RoleDiagnostics => ({ samples: [], latest: null, droppedFrames: null,
  seekableChangedAt: null, playlistChangedAt: null, lastStall: null, recoveryStart: null })

/** Distant ranges do not count as data available at the playhead. */
export function playbackBufferAt(buffered: number[][], currentTime: number): {
  bufferAhead: number; bufferedStart: number | null; bufferedEnd: number | null; nextBufferedStart: number | null
} {
  let bufferedStart: number | null = null
  let bufferedEnd: number | null = null
  let nextBufferedStart: number | null = null
  for (const range of buffered) {
    const start = finite(range[0])
    const end = finite(range[1])
    if (start === null || end === null || end < start) continue
    if (currentTime >= start && currentTime <= end) { bufferedStart = start; bufferedEnd = end }
    if (start > currentTime && (nextBufferedStart === null || start < nextBufferedStart)) nextBufferedStart = start
  }
  return { bufferAhead: Math.max(0, (bufferedEnd ?? currentTime) - currentTime),
    bufferedStart, bufferedEnd, nextBufferedStart }
}

export function classifyPlaybackStall(snapshot: PlaybackDiagnosticSnapshot): PlaybackDiagnosticCategory {
  if (snapshot.timerLateMs >= 1000) return 'thread'
  if (!snapshot.observing || snapshot.paused || snapshot.seeking || snapshot.ended) return 'unknown'
  const stopped = snapshot.mediaProgress !== null && snapshot.mediaProgress < 0.1
  if (!stopped) return 'unknown'
  const fragment = snapshot.fragment
  const atFragment = fragment?.start !== null && fragment?.start !== undefined && fragment.end !== null
    && snapshot.currentTime >= fragment.start && snapshot.currentTime <= fragment.end
  if (snapshot.bufferAhead >= 0.5 || (atFragment && fragment?.phase === 'loaded' && fragment.elapsedMs >= 1500)) return 'playback'
  if (!snapshot.localBuffer) return 'unknown'
  const edge = Math.max(snapshot.seekableEnd ?? -Infinity, snapshot.playlistEnd ?? -Infinity)
  const start = Math.max(snapshot.seekableStart ?? -Infinity, snapshot.playlistStart ?? -Infinity)
  const inWindow = snapshot.currentTime >= start
  const requestPending = fragment?.phase === 'loading' && fragment.elapsedMs >= 1500
    && (atFragment || (fragment.start === null && fragment.end === null))
  const requestFailed = snapshot.error?.type === 'networkError'
    && snapshot.error.ageMs <= 5000 && fragment?.phase !== 'buffered'
    && (snapshot.error.details === 'fragLoadError' || snapshot.error.details === 'fragLoadTimeOut')
  if (inWindow && edge > snapshot.currentTime + 0.5 && (requestPending || requestFailed)) return 'fetch'
  const ages = [snapshot.seekableUnchangedMs, snapshot.playlistUnchangedMs].filter((age): age is number => age !== null)
  if (inWindow && ages.length > 0 && ages.every(age => age >= 1500) && edge <= snapshot.currentTime + 0.5) return 'production'
  return 'unknown'
}

/** Bounded renderer-only evidence. Incoming third-party objects are never retained. */
export class PlaybackDiagnostics {
  private readonly roles: Record<SourceRole, RoleDiagnostics> = { official: emptyRole(), commentary: emptyRole() }
  private origin: number | null = null

  record(role: SourceRole, input: PlaybackDiagnosticInput): void {
    if (!Number.isFinite(input.at) || !Number.isFinite(input.currentTime)) return
    this.origin ??= input.at
    const state = this.roles[role]
    const at = Math.max(0, input.at - this.origin)
    const previous = state.latest
    if (previous && at <= previous.at) return
    const seekableEnd = finite(input.seekableEnd)
    const playlistEnd = finite(input.playlistEnd)
    if (seekableEnd === null) state.seekableChangedAt = null
    else if (state.seekableChangedAt === null || previous?.seekableEnd === null || seekableEnd > (previous?.seekableEnd ?? -Infinity) + 0.01) state.seekableChangedAt = at
    if (playlistEnd === null) state.playlistChangedAt = null
    else if (state.playlistChangedAt === null || previous?.playlistEnd === null || playlistEnd > (previous?.playlistEnd ?? -Infinity) + 0.01) state.playlistChangedAt = at
    const dropped = nonnegative(input.droppedFrames)
    const snapshot: PlaybackDiagnosticSnapshot = {
      at, intervalMs: previous ? at - previous.at : null,
      currentTime: input.currentTime,
      mediaProgress: previous ? input.currentTime - previous.currentTime : null,
      paused: input.paused === true, seeking: input.seeking === true, ended: input.ended === true,
      readyState: Math.min(4, Math.max(0, finite(input.readyState) ?? 0)), observing: input.observing === true,
      ...playbackBufferAt(input.buffered, input.currentTime),
      seekableStart: finite(input.seekableStart), seekableEnd,
      seekableUnchangedMs: state.seekableChangedAt === null ? null : at - state.seekableChangedAt,
      playlistStart: finite(input.playlistStart), playlistEnd,
      playlistUnchangedMs: state.playlistChangedAt === null ? null : at - state.playlistChangedAt,
      fragment: input.fragment && FRAGMENT_PHASES.has(input.fragment.phase)
        ? { phase: input.fragment.phase, elapsedMs: nonnegative(input.fragment.elapsedMs) ?? 0,
          start: finite(input.fragment.start), end: finite(input.fragment.end), loadMs: nonnegative(input.fragment.loadMs) } : null,
      error: input.error ? { type: ERROR_TYPES.has(input.error.type) ? input.error.type : null,
        details: ERROR_DETAILS.has(input.error.details) ? input.error.details : null, ageMs: nonnegative(input.error.ageMs) ?? 0 } : null,
      droppedFramesDelta: dropped !== null && state.droppedFrames !== null ? Math.max(0, dropped - state.droppedFrames) : null,
      timerLateMs: nonnegative(input.timerLateMs) ?? 0,
      localBuffer: input.localBuffer && BUFFER_PHASES.has(input.localBuffer.state)
        ? { state: input.localBuffer.state, seconds: nonnegative(input.localBuffer.seconds) ?? 0,
          completeSegments: nonnegative(input.localBuffer.completeSegments) } : null,
    }
    state.latest = snapshot
    state.droppedFrames = dropped
    const last = state.samples.at(-1)
    if (!last || at - last.at >= 1000) {
      state.samples.push(snapshot)
      if (state.samples.length > 120) state.samples.shift()
    }
    // Also expire old samples after a scheduling gap, without fabricating missing seconds.
    while (state.samples.length && at - state.samples[0]!.at >= 120_000) state.samples.shift()
    if (state.lastStall?.ongoing) {
      if (snapshot.mediaProgress !== null && snapshot.mediaProgress >= 0.1 && snapshot.observing
        && !snapshot.paused && !snapshot.seeking && !snapshot.ended) state.recoveryStart ??= snapshot
      else state.recoveryStart = null
      state.lastStall.durationMs = (state.recoveryStart ?? snapshot).at - state.lastStall.start.at
      this.updateEvidence(state.lastStall, snapshot)
    }
  }

  startStall(role: SourceRole): void {
    const state = this.roles[role]
    if (!state.latest || state.lastStall?.ongoing) return
    // Detection confirms a preceding no-progress window, so preserve that window's baseline.
    let start = state.latest
    for (let index = state.samples.length - 1; index >= 0; index--) {
      const sample = state.samples[index]!
      if (state.latest.at - sample.at > 1500 || Math.abs(sample.currentTime - state.latest.currentTime) >= 0.1) break
      start = sample
    }
    const category = classifyPlaybackStall(state.latest)
    state.recoveryStart = null
    state.lastStall = { start, end: null, durationMs: state.latest.at - start.at, category, hint: HINTS[category], ongoing: true }
  }

  endStall(role: SourceRole): void {
    const state = this.roles[role]
    const stall = state.lastStall
    if (!stall?.ongoing || !state.latest) return
    this.updateEvidence(stall, state.latest)
    stall.end = state.recoveryStart ?? state.latest
    stall.durationMs = Math.max(0, stall.end.at - stall.start.at)
    stall.ongoing = false
    state.recoveryStart = null
  }

  private updateEvidence(stall: Stall, snapshot: PlaybackDiagnosticSnapshot): void {
    const category = classifyPlaybackStall(snapshot)
    if (category === 'thread' || stall.category === 'unknown') {
      stall.category = category
      stall.hint = HINTS[category]
    }
  }

  reset(role: SourceRole): void { this.roles[role] = emptyRole() }

  summary(role: SourceRole): PlaybackStallSummary | null {
    const stall = this.roles[role].lastStall
    return stall ? { durationMs: stall.durationMs, category: stall.category, hint: stall.hint, ongoing: stall.ongoing } : null
  }

  export(): { version: 1; official: { samples: PlaybackDiagnosticSnapshot[]; lastStall: Stall | null }; commentary: { samples: PlaybackDiagnosticSnapshot[]; lastStall: Stall | null } } {
    // All stored properties were picked explicitly in record; return an independent copy.
    return JSON.parse(JSON.stringify({ version: 1,
      official: { samples: this.roles.official.samples, lastStall: this.roles.official.lastStall },
      commentary: { samples: this.roles.commentary.samples, lastStall: this.roles.commentary.lastStall },
    }))
  }
}
