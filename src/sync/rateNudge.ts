import type { SourceRole } from '../core/types'

export interface RateNudgeOptions {
  seekThresholdSeconds?: number
  deadbandSeconds?: number
}

export type RateNudgeAction =
  | { kind: 'aligned'; rate: 1 }
  | { kind: 'seek'; rate: 1 }
  | { kind: 'rate'; role: SourceRole; rate: number }

/** A bounded proportional controller. Its input is measured media-time error. */
export function rateNudgeAction(
  errorSeconds: number,
  role: SourceRole,
  options: RateNudgeOptions = {},
): RateNudgeAction {
  if (Math.abs(errorSeconds) <= (options.deadbandSeconds ?? 0.1)) {
    return { kind: 'aligned', rate: 1 }
  }
  if (Math.abs(errorSeconds) > (options.seekThresholdSeconds ?? 1.5)) {
    return { kind: 'seek', rate: 1 }
  }
  // Keep controlling the original role after a small overshoot, rather than
  // accumulating needless rewind on both sources by changing roles each poll.
  const direction = role === 'official' ? 1 : -1
  const adjustment = Math.max(-0.05, Math.min(0.05, errorSeconds * direction * 0.25))
  return { kind: 'rate', role, rate: Math.max(0.95, Math.min(1.05, 1 - adjustment)) }
}
