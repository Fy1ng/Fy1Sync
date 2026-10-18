/** Shared domain types for Stream Sync Player. */

/** The two media roles the app aligns. */
export type SourceRole = 'official' | 'commentary'

export const SOURCE_ROLES: readonly SourceRole[] = ['official', 'commentary']

/** How a media URL should be handed to the player. */
export type MediaKind = 'progressive' | 'hls' | 'file' | 'test'

/** A resolved, playable media descriptor. */
export type MediaDescriptor = {
  kind: MediaKind
  /** URL actually given to the <video> element or hls.js. */
  url: string
  /** Raw user input, kept for display and diagnostics. */
  input: string
  label: string
  /** Built-in test sources loop so long sessions stay usable. */
  loop: boolean
  /** True when `url` points at this app's own media proxy. */
  viaProxy: boolean
  /** Platform that produced this descriptor, when it came from an adapter. */
  platform?: PlatformId
}

export type PlatformId = 'twitch' | 'douyu' | 'direct' | 'file' | 'test'

/** Whether a media element behaves as a fixed recording or a moving live edge. */
export type Timebase =
  | { kind: 'vod'; duration: number }
  | { kind: 'live'; seekableStart: number; seekableEnd: number }

/** A snapshot of one media element, used by the sync planner. */
export type MediaSnapshot = {
  role: SourceRole
  /** Current playhead in media time. */
  currentTime: number
  timebase: Timebase
  /** False when no media is loaded; planner skips the source. */
  ready: boolean
}

/** Rewind currently applied to each source, in seconds. */
export type AppliedRewind = Record<SourceRole, number>

export const NO_REWIND: AppliedRewind = { official: 0, commentary: 0 }

/** Manual sync limits from docs/sync-design.md. */
export const MAX_OFFSET_SECONDS = 60
export const COARSE_STEP_SECONDS = 0.5
export const FINE_STEP_SECONDS = 0.05
/** Below this absolute offset the two sources count as aligned. */
export const OFFSET_DEADBAND_SECONDS = 0.1

/** One countdown reading produced by the recognition pipeline. */
export type ClockReading = {
  /** Recognised countdown text, e.g. `00:45`. */
  text: string
  /** Countdown value in seconds, parsed from `text`. */
  seconds: number
  /** Per-character match scores. */
  scores: number[]
  /** Combined confidence in [0, 1]. */
  confidence: number
  /** Media time of the sampled frame. */
  mediaTime: number
  /** High-resolution browser timestamp of the sampled frame. */
  wallTime: number
  frameIndex: number
}

/** A confirmed `n -> n-1` countdown transition. */
export type ClockJumpEvent = {
  source: SourceRole
  from: string
  to: string
  /** Countdown seconds after the jump. */
  toSeconds: number
  /** Media time at which the new value first appeared. */
  mediaTime: number
  wallTime: number
  confidence: number
  frameIndex: number
}

/** Structured recognition failure reasons surfaced to the UI. */
export type RecognitionFailure =
  | 'no-profile'
  | 'profile-incomplete'
  | 'insufficient-templates'
  | 'blank-frame'
  | 'no-candidates'
  | 'low-confidence'
  | 'invalid-format'
  | 'decode-failed'
  | 'canvas-tainted'
  | 'no-video-frame'

export type RecognitionOutcome =
  | { status: 'success'; reading: ClockReading }
  | { status: 'failed'; reason: RecognitionFailure; detail?: string }
