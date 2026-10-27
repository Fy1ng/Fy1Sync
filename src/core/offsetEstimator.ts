import { MAX_OFFSET_SECONDS, MIN_SYNC_CONFIDENCE, OFFSET_DEADBAND_SECONDS, type ClockJumpEvent } from './types'

/**
 * Converts countdown jumps from both sources into a signed delay estimate.
 *
 * Two streams five seconds apart rarely show the same countdown number inside one
 * 2-3s window, so jumps are not paired by text. Each jump is instead converted into a
 * "countdown zero anchor": the wall-clock time at which that stream would reach 0:00.
 *
 *   anchorMs = wallTimeMs + toSeconds * 1000
 *   residual = (commentaryAnchor - officialAnchor) / 1000
 *
 * The anchor uses the browser's high-resolution clock because it is the only timeline
 * the two media elements share. A stalled or paused source makes its anchors diverge,
 * which the spread check below rejects.
 */

export type OffsetRejection =
  | 'no-official-jump'
  | 'no-commentary-jump'
  | 'unstable-official'
  | 'unstable-commentary'
  | 'low-confidence'
  | 'out-of-range'

export type OffsetEstimate = {
  status: 'ok'
  /** Additional offset needed on top of the offset already applied. */
  residualSeconds: number
  /** Total offset the player should carry after this estimate. */
  totalOffsetSeconds: number
  /** Which source should be rewound to reach `totalOffsetSeconds`. */
  direction: 'official' | 'commentary' | 'none'
  rewindSeconds: number
  confidence: number
  officialAnchorSpread: number
  commentaryAnchorSpread: number
  officialEvents: number
  commentaryEvents: number
}

export type OffsetResult = OffsetEstimate | { status: 'rejected'; reason: OffsetRejection }

export type EstimateOptions = {
  /** Offset already applied to the player, in seconds. */
  appliedOffsetSeconds?: number
  /** Maximum accepted anchor spread within one source, in seconds. */
  maxAnchorSpreadSeconds?: number
  minConfidence?: number
  maxOffsetSeconds?: number
  deadbandSeconds?: number
}

/** Wall-clock milliseconds at which a stream showing this jump reaches 0:00. */
export function clockAnchorMs(event: Pick<ClockJumpEvent, 'wallTime' | 'toSeconds'>): number {
  return event.wallTime + event.toSeconds * 1000
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

function spread(values: readonly number[]): number {
  if (values.length < 2) return 0
  let min = values[0]!
  let max = values[0]!
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return max - min
}

export function estimateOffset(
  officialEvents: readonly ClockJumpEvent[],
  commentaryEvents: readonly ClockJumpEvent[],
  options: EstimateOptions = {},
): OffsetResult {
  const applied = options.appliedOffsetSeconds ?? 0
  const maxSpread = options.maxAnchorSpreadSeconds ?? 0.35
  const minConfidence = options.minConfidence ?? MIN_SYNC_CONFIDENCE
  const maxOffset = options.maxOffsetSeconds ?? MAX_OFFSET_SECONDS
  const deadband = options.deadbandSeconds ?? OFFSET_DEADBAND_SECONDS

  if (officialEvents.length === 0) return { status: 'rejected', reason: 'no-official-jump' }
  if (commentaryEvents.length === 0) return { status: 'rejected', reason: 'no-commentary-jump' }

  const officialAnchors = officialEvents.map(clockAnchorMs)
  const commentaryAnchors = commentaryEvents.map(clockAnchorMs)
  const officialSpread = spread(officialAnchors) / 1000
  const commentarySpread = spread(commentaryAnchors) / 1000

  if (officialSpread > maxSpread) return { status: 'rejected', reason: 'unstable-official' }
  if (commentarySpread > maxSpread) return { status: 'rejected', reason: 'unstable-commentary' }

  const confidence = Math.min(
    Math.min(...officialEvents.map((event) => event.confidence)),
    Math.min(...commentaryEvents.map((event) => event.confidence)),
  )
  if (confidence < minConfidence) return { status: 'rejected', reason: 'low-confidence' }

  const residual = (median(commentaryAnchors) - median(officialAnchors)) / 1000
  const total = applied + residual
  if (Math.abs(total) > maxOffset) return { status: 'rejected', reason: 'out-of-range' }

  const aligned = Math.abs(total) <= deadband
  return {
    status: 'ok',
    residualSeconds: round(residual),
    totalOffsetSeconds: round(total),
    direction: aligned ? 'none' : total > 0 ? 'official' : 'commentary',
    rewindSeconds: aligned ? 0 : round(Math.abs(total)),
    confidence: round(confidence),
    officialAnchorSpread: round(officialSpread),
    commentaryAnchorSpread: round(commentarySpread),
    officialEvents: officialEvents.length,
    commentaryEvents: commentaryEvents.length,
  }
}

export const OFFSET_REJECTION_TEXT: Record<OffsetRejection, string> = {
  'no-official-jump': '官方源未捕获倒计时跳秒',
  'no-commentary-jump': '解说源未捕获倒计时跳秒',
  'unstable-official': '官方源跳秒时间不稳定',
  'unstable-commentary': '解说源跳秒时间不稳定',
  'low-confidence': '识别置信度过低',
  'out-of-range': '延迟差超出 ±60 秒范围',
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
