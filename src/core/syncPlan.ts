import {
  MAX_OFFSET_SECONDS,
  OFFSET_DEADBAND_SECONDS,
  SOURCE_ROLES,
  type AppliedRewind,
  type MediaSnapshot,
  type SourceRole,
  type Timebase,
} from './types'

/**
 * Offset semantics (sync design):
 *
 *   offset > 0  official is ahead -> rewind the official source by `offset`
 *   offset < 0  commentary is ahead -> rewind the commentary source by `abs(offset)`
 *   offset = 0  both sources aligned
 *
 * Offsets are applied *incrementally*: each source only moves by the difference
 * between the rewind it should carry and the rewind it already carries. That makes
 * "back to zero" restore the previously undelayed source as the common baseline,
 * makes sign flips restore the baseline before applying the new direction, and makes
 * a first `0 -> 0` change a no-op instead of overwriting user-chosen positions.
 */

export type SeekPlanEntry = {
  role: SourceRole
  from: number
  /** Target after clamping to the source's real seekable range. */
  to: number
  /** Target before clamping. */
  requested: number
  clamped: boolean
  /** Seconds of the requested move that the seekable range could not absorb. */
  shortfall: number
}

export type PlanLimit = 'buffer-limit' | 'not-ready'

export type OffsetPlan = {
  requestedOffset: number
  /** Offset actually achieved once every seek is clamped to real ranges. */
  effectiveOffset: number
  seeks: SeekPlanEntry[]
  rewindAfter: AppliedRewind
  limited: boolean
  limitReason?: PlanLimit
  /** Roles that needed to move but had no loaded media. */
  missingRoles: SourceRole[]
}

export type PlanInput = {
  nextOffset: number
  applied: AppliedRewind
  snapshots: Partial<Record<SourceRole, MediaSnapshot>>
  /** Ignore moves smaller than this many seconds. Defaults to 1ms. */
  epsilon?: number
}

export function clampOffset(offset: number, max = MAX_OFFSET_SECONDS): number {
  if (!Number.isFinite(offset)) return 0
  return Math.min(max, Math.max(-max, offset))
}

/** Rewind each source must carry for a given offset. */
export function rewindForOffset(offset: number): AppliedRewind {
  return {
    official: Math.max(offset, 0),
    commentary: Math.max(-offset, 0),
  }
}

export function offsetFromRewind(rewind: AppliedRewind): number {
  return round(rewind.official - rewind.commentary)
}

export function seekableRange(timebase: Timebase): { start: number; end: number } {
  if (timebase.kind === 'vod') {
    const end = Number.isFinite(timebase.duration) ? Math.max(timebase.duration, 0) : 0
    return { start: 0, end }
  }
  const start = Math.max(timebase.seekableStart, 0)
  const end = Math.max(timebase.seekableEnd, start)
  return { start, end }
}

/** Seconds of rewind head-room a source still has. */
export function availableRewind(snapshot: MediaSnapshot): number {
  const { start } = seekableRange(snapshot.timebase)
  return Math.max(snapshot.currentTime - start, 0)
}

export function planOffsetChange(input: PlanInput): OffsetPlan {
  const epsilon = input.epsilon ?? 0.001
  const requestedOffset = clampOffset(input.nextOffset)
  const desired = rewindForOffset(requestedOffset)

  const seeks: SeekPlanEntry[] = []
  const rewindAfter: AppliedRewind = { ...input.applied }
  const missingRoles: SourceRole[] = []
  let clampedAnywhere = false

  for (const role of SOURCE_ROLES) {
    const currentRewind = input.applied[role]
    const targetRewind = desired[role]
    const move = targetRewind - currentRewind
    if (Math.abs(move) < epsilon) {
      rewindAfter[role] = currentRewind
      continue
    }

    const snapshot = input.snapshots[role]
    if (!snapshot || !snapshot.ready) {
      missingRoles.push(role)
      // Nothing loaded: the rewind cannot be carried by this source.
      rewindAfter[role] = 0
      continue
    }

    const range = seekableRange(snapshot.timebase)
    const requested = snapshot.currentTime - move
    const to = Math.min(range.end, Math.max(range.start, requested))
    const clamped = Math.abs(to - requested) > epsilon
    if (clamped) clampedAnywhere = true

    seeks.push({
      role,
      from: round(snapshot.currentTime),
      to: round(to),
      requested: round(requested),
      clamped,
      shortfall: round(Math.abs(requested - to)),
    })

    // Whatever the range absorbed becomes the rewind this source now carries.
    rewindAfter[role] = round(Math.max(currentRewind + (snapshot.currentTime - to), 0))
  }

  const effectiveOffset = offsetFromRewind(rewindAfter)
  const limited = clampedAnywhere || missingRoles.length > 0
  const plan: OffsetPlan = {
    requestedOffset: round(requestedOffset),
    effectiveOffset,
    seeks,
    rewindAfter,
    limited,
    missingRoles,
  }
  if (missingRoles.length > 0) plan.limitReason = 'not-ready'
  else if (clampedAnywhere) plan.limitReason = 'buffer-limit'
  return plan
}

/** True when a plan reaches the requested offset without clamping. */
export function planIsComplete(plan: OffsetPlan, tolerance = 0.05): boolean {
  return !plan.limited && Math.abs(plan.effectiveOffset - plan.requestedOffset) <= tolerance
}

export function isAligned(offset: number, deadband = OFFSET_DEADBAND_SECONDS): boolean {
  return Math.abs(offset) <= deadband
}

/** UI copy that avoids exposing the algorithm, per the sync design. */
export function describeOffset(offset: number, deadband = OFFSET_DEADBAND_SECONDS): string {
  if (isAligned(offset, deadband)) return '两路已对齐'
  const seconds = Math.abs(offset).toFixed(2)
  return offset > 0 ? `让官方画面后退 ${seconds} 秒` : `让国内解说后退 ${seconds} 秒`
}

/** Snap a raw slider value onto the active step grid. */
export function snapOffset(value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return 0
  return round(clampOffset(Math.round(value / step) * step))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
