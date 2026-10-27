import { MIN_SYNC_CONFIDENCE, type ClockJumpEvent, type ClockReading, type RecognitionOutcome, type SourceRole } from './types'

/**
 * Turns a stream of per-frame countdown readings into confirmed `n -> n-1` jump events.
 *
 * Only strictly decreasing single-second transitions count. Round resets, loop
 * wrap-arounds, paused clocks, skipped seconds and low-confidence frames are dropped
 * rather than smoothed over, because a wrong jump would move the user's playhead.
 */

export type CountdownFormat = 'm:ss' | 'mm:ss' | 'ss' | 'auto'

const COUNTDOWN_PATTERN = /^(\d{1,2}):([0-5]\d)$/
const SECONDS_ONLY_PATTERN = /^(\d{1,2})$/

/** Parse countdown text into seconds. Returns null for anything malformed. */
export function parseCountdown(text: string, format: CountdownFormat = 'auto'): number | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  const clock = COUNTDOWN_PATTERN.exec(trimmed)
  if (clock) {
    if (format === 'ss') return null
    const minutes = Number(clock[1])
    const seconds = Number(clock[2])
    if (format === 'm:ss' && clock[1]!.length !== 1) return null
    if (format === 'mm:ss' && clock[1]!.length !== 2) return null
    return minutes * 60 + seconds
  }

  const bare = SECONDS_ONLY_PATTERN.exec(trimmed)
  if (bare && (format === 'ss' || format === 'auto')) {
    const seconds = Number(bare[1])
    return seconds <= 59 ? seconds : null
  }
  return null
}

export type ClockJumpOptions = {
  /** Minimum per-frame confidence for a reading to take part in detection. */
  minConfidence?: number
  /** Consecutive matching frames required before a value is trusted. */
  stableFrames?: number
  /** Accepted media-time distance between consecutive jumps, in seconds. */
  jumpIntervalRange?: readonly [number, number]
  format?: CountdownFormat
}

export type DroppedJumpReason =
  | 'not-decrement'
  | 'abnormal-interval'
  | 'low-confidence'
  | 'unparsable'

export type PushResult = {
  event: ClockJumpEvent | null
  /** Set when a value change was observed but deliberately not turned into an event. */
  dropped?: DroppedJumpReason
}

type Candidate = {
  text: string
  seconds: number
  count: number
  /** Frame where this value was first seen; the jump happens here. */
  first: ClockReading
  bestConfidence: number
}

export class ClockJumpDetector {
  private readonly minConfidence: number
  private readonly stableFrames: number
  private readonly jumpIntervalRange: readonly [number, number]
  private readonly format: CountdownFormat

  private candidate: Candidate | null = null
  private confirmed: { text: string; seconds: number } | null = null
  private lastJumpMediaTime: number | null = null

  constructor(
    private readonly source: SourceRole,
    options: ClockJumpOptions = {},
  ) {
    this.minConfidence = options.minConfidence ?? MIN_SYNC_CONFIDENCE
    this.stableFrames = Math.max(1, options.stableFrames ?? 2)
    this.jumpIntervalRange = options.jumpIntervalRange ?? [0.4, 2.5]
    this.format = options.format ?? 'auto'
  }

  reset(): void {
    this.candidate = null
    this.confirmed = null
    this.lastJumpMediaTime = null
  }

  /** Feed one recognition outcome. Failed frames are ignored, not treated as changes. */
  push(outcome: RecognitionOutcome): PushResult {
    if (outcome.status !== 'success') return { event: null }
    const reading = outcome.reading
    if (reading.confidence < this.minConfidence) return { event: null, dropped: 'low-confidence' }

    const seconds = parseCountdown(reading.text, this.format)
    if (seconds === null || seconds !== reading.seconds) {
      return { event: null, dropped: 'unparsable' }
    }

    if (this.candidate && this.candidate.text === reading.text) {
      this.candidate.count += 1
      this.candidate.bestConfidence = Math.max(this.candidate.bestConfidence, reading.confidence)
    } else {
      this.candidate = {
        text: reading.text,
        seconds,
        count: 1,
        first: reading,
        bestConfidence: reading.confidence,
      }
    }

    if (this.candidate.count < this.stableFrames) return { event: null }
    if (this.confirmed && this.confirmed.text === this.candidate.text) return { event: null }

    const previous = this.confirmed
    const candidate = this.candidate
    this.confirmed = { text: candidate.text, seconds: candidate.seconds }

    if (!previous) return { event: null }
    if (previous.seconds - candidate.seconds !== 1) {
      // Round reset, loop wrap, skipped second or a paused-then-resumed clock.
      this.lastJumpMediaTime = null
      return { event: null, dropped: 'not-decrement' }
    }

    const mediaTime = candidate.first.mediaTime
    if (this.lastJumpMediaTime !== null) {
      const interval = mediaTime - this.lastJumpMediaTime
      const [min, max] = this.jumpIntervalRange
      if (interval < min || interval > max) {
        this.lastJumpMediaTime = mediaTime
        return { event: null, dropped: 'abnormal-interval' }
      }
    }
    this.lastJumpMediaTime = mediaTime

    return {
      event: {
        source: this.source,
        from: previous.text,
        to: candidate.text,
        toSeconds: candidate.seconds,
        mediaTime,
        wallTime: candidate.first.wallTime,
        confidence: candidate.bestConfidence,
        frameIndex: candidate.first.frameIndex,
      },
    }
  }
}
