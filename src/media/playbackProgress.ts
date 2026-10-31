import { SOURCE_ROLES, type SourceRole } from '../core/types'

export interface PlaybackProgressSample {
  currentTime: number
  paused: boolean
  seeking: boolean
  ended: boolean
}

export interface PlaybackProgressObservation {
  at: number
  official: PlaybackProgressSample
  commentary: PlaybackProgressSample
}

interface ProgressEpisode {
  baseline: PlaybackProgressObservation
  stableSince: number | null
}

export interface PlaybackProgressState {
  samples: PlaybackProgressObservation[]
  stalled: Record<SourceRole, boolean>
  advancingSince: Record<SourceRole, number | null>
  episode: ProgressEpisode | null
}

export interface PlaybackProgressResult {
  state: PlaybackProgressState
  started: SourceRole[]
  ended: SourceRole[]
  recovery: { driftSeconds: number } | null
}

const STALL_WINDOW_MS = 1500
const MIN_PROGRESS_SECONDS = 0.1
const RECOVERY_WINDOW_MS = 1000
const MIN_DRIFT_SECONDS = 0.5

export function createPlaybackProgress(): PlaybackProgressState {
  return {
    samples: [],
    stalled: { official: false, commentary: false },
    advancingSince: { official: null, commentary: null },
    episode: null,
  }
}

function copyObservation(sample: PlaybackProgressObservation): PlaybackProgressObservation {
  return { at: sample.at, official: { ...sample.official }, commentary: { ...sample.commentary } }
}

/** Media increments only flag suspect alignment; they never become a seek correction. */
export function observePlaybackProgress(
  previous: PlaybackProgressState,
  observation: PlaybackProgressObservation,
  enabled = true,
): PlaybackProgressResult {
  const result: PlaybackProgressResult = { state: createPlaybackProgress(), started: [], ended: [], recovery: null }
  if (!enabled || !Number.isFinite(observation.at) || SOURCE_ROLES.some(role => {
    const sample = observation[role]
    return sample.paused || sample.seeking || sample.ended || !Number.isFinite(sample.currentTime)
  })) return result

  const sample = copyObservation(observation)
  const last = previous.samples.at(-1)
  // A scheduling gap cannot tell a stall from a busy renderer. Start a fresh interval.
  if (!last || sample.at <= last.at || sample.at - last.at > STALL_WINDOW_MS
    || SOURCE_ROLES.some(role => sample[role].currentTime < last[role].currentTime)) {
    result.state.samples = [sample]
    return result
  }

  const samples = [...previous.samples, sample]
  while (samples.length > 1 && samples[1]!.at <= sample.at - STALL_WINDOW_MS) samples.shift()
  const baseline = samples[0]!
  const state: PlaybackProgressState = {
    samples,
    stalled: { ...previous.stalled },
    advancingSince: { ...previous.advancingSince },
    episode: previous.episode ? { ...previous.episode } : null,
  }
  result.state = state

  const advancing = { official: false, commentary: false }
  for (const role of SOURCE_ROLES) {
    advancing[role] = sample[role].currentTime - last[role].currentTime >= MIN_PROGRESS_SECONDS
    state.advancingSince[role] = advancing[role] ? previous.advancingSince[role] ?? last.at : null
    const stopped = sample.at - baseline.at >= STALL_WINDOW_MS
      && sample[role].currentTime - baseline[role].currentTime < MIN_PROGRESS_SECONDS
    if (stopped && !state.stalled[role]) {
      state.stalled[role] = true
      result.started.push(role)
      // Include the confirmation window: otherwise a short stall would lose its drift.
      state.episode ??= { baseline, stableSince: null }
    }
    const since = state.advancingSince[role]
    if (state.stalled[role] && since !== null && sample.at - since >= RECOVERY_WINDOW_MS) {
      state.stalled[role] = false
      result.ended.push(role)
    }
  }

  if (state.episode) {
    const bothAdvancing = advancing.official && advancing.commentary
    state.episode.stableSince = bothAdvancing ? state.episode.stableSince ?? last.at : null
    const since = state.episode.stableSince
    if (since !== null && sample.at - since >= RECOVERY_WINDOW_MS) {
      const start = state.episode.baseline
      const driftSeconds = Math.abs((sample.official.currentTime - start.official.currentTime)
        - (sample.commentary.currentTime - start.commentary.currentTime))
      if (driftSeconds >= MIN_DRIFT_SECONDS) result.recovery = { driftSeconds }
      state.episode = null
    }
  }
  return result
}
