import { describe, expect, it } from 'vitest'
import {
  availableRewind,
  clampOffset,
  describeOffset,
  isAligned,
  offsetFromRewind,
  planIsComplete,
  planOffsetChange,
  rewindForOffset,
  snapOffset,
} from './syncPlan'
import { NO_REWIND, type MediaSnapshot, type SourceRole } from './types'

function vod(role: SourceRole, currentTime: number, duration = 600): MediaSnapshot {
  return { role, currentTime, ready: true, timebase: { kind: 'vod', duration } }
}

function live(
  role: SourceRole,
  currentTime: number,
  seekableStart: number,
  seekableEnd: number,
): MediaSnapshot {
  return { role, currentTime, ready: true, timebase: { kind: 'live', seekableStart, seekableEnd } }
}

describe('rewindForOffset', () => {
  it('rewinds the official source for positive offsets', () => {
    expect(rewindForOffset(5)).toEqual({ official: 5, commentary: 0 })
  })

  it('rewinds the commentary source for negative offsets', () => {
    expect(rewindForOffset(-2.5)).toEqual({ official: 0, commentary: 2.5 })
  })

  it('round-trips through offsetFromRewind', () => {
    expect(offsetFromRewind(rewindForOffset(3.25))).toBe(3.25)
    expect(offsetFromRewind(rewindForOffset(-3.25))).toBe(-3.25)
  })
})

describe('planOffsetChange', () => {
  it('moves only the official source back for a positive offset', () => {
    const plan = planOffsetChange({
      nextOffset: 5,
      applied: NO_REWIND,
      snapshots: { official: vod('official', 100), commentary: vod('commentary', 100) },
    })
    expect(plan.seeks).toHaveLength(1)
    expect(plan.seeks[0]).toMatchObject({ role: 'official', from: 100, to: 95, clamped: false })
    expect(plan.effectiveOffset).toBe(5)
    expect(plan.rewindAfter).toEqual({ official: 5, commentary: 0 })
    expect(planIsComplete(plan)).toBe(true)
  })

  it('moves only the commentary source back for a negative offset', () => {
    const plan = planOffsetChange({
      nextOffset: -4,
      applied: NO_REWIND,
      snapshots: { official: vod('official', 50), commentary: vod('commentary', 50) },
    })
    expect(plan.seeks).toHaveLength(1)
    expect(plan.seeks[0]).toMatchObject({ role: 'commentary', from: 50, to: 46 })
    expect(plan.effectiveOffset).toBe(-4)
  })

  it('is a no-op for a first 0 -> 0 change so user-chosen positions survive', () => {
    const plan = planOffsetChange({
      nextOffset: 0,
      applied: NO_REWIND,
      snapshots: { official: vod('official', 12), commentary: vod('commentary', 88) },
    })
    expect(plan.seeks).toEqual([])
    expect(plan.effectiveOffset).toBe(0)
  })

  it('restores the previously undelayed source when returning to zero', () => {
    // Official carries a 3s rewind; commentary was never delayed.
    const plan = planOffsetChange({
      nextOffset: 0,
      applied: { official: 3, commentary: 0 },
      snapshots: { official: vod('official', 97), commentary: vod('commentary', 100) },
    })
    expect(plan.seeks).toHaveLength(1)
    // Official moves forward 3s to rejoin the commentary baseline.
    expect(plan.seeks[0]).toMatchObject({ role: 'official', from: 97, to: 100 })
    expect(plan.rewindAfter).toEqual({ official: 0, commentary: 0 })
  })

  it('restores the baseline before applying the opposite direction', () => {
    const plan = planOffsetChange({
      nextOffset: -2,
      applied: { official: 3, commentary: 0 },
      snapshots: { official: vod('official', 97), commentary: vod('commentary', 100) },
    })
    const byRole = Object.fromEntries(plan.seeks.map((seek) => [seek.role, seek]))
    expect(byRole.official).toMatchObject({ from: 97, to: 100 })
    expect(byRole.commentary).toMatchObject({ from: 100, to: 98 })
    expect(plan.effectiveOffset).toBe(-2)
    expect(plan.rewindAfter).toEqual({ official: 0, commentary: 2 })
  })

  it('does not accumulate rewind when the same offset is re-applied', () => {
    const plan = planOffsetChange({
      nextOffset: 5,
      applied: { official: 5, commentary: 0 },
      snapshots: { official: vod('official', 95), commentary: vod('commentary', 100) },
    })
    expect(plan.seeks).toEqual([])
    expect(plan.effectiveOffset).toBe(5)
  })

  it('maps live sources through their own seekable range', () => {
    const plan = planOffsetChange({
      nextOffset: 6,
      applied: NO_REWIND,
      snapshots: {
        official: live('official', 1_000, 940, 1_002),
        commentary: live('commentary', 500, 440, 502),
      },
    })
    expect(plan.seeks[0]).toMatchObject({ role: 'official', from: 1_000, to: 994, clamped: false })
    expect(plan.limited).toBe(false)
  })

  it('clamps to the seekable start and reports the shortfall', () => {
    const plan = planOffsetChange({
      nextOffset: 30,
      applied: NO_REWIND,
      snapshots: {
        official: live('official', 1_000, 990, 1_002),
        commentary: live('commentary', 500, 440, 502),
      },
    })
    expect(plan.seeks[0]).toMatchObject({ to: 990, requested: 970, clamped: true, shortfall: 20 })
    expect(plan.limited).toBe(true)
    expect(plan.limitReason).toBe('buffer-limit')
    expect(plan.effectiveOffset).toBe(10)
    expect(planIsComplete(plan)).toBe(false)
  })

  it('flags a missing source instead of planning an impossible seek', () => {
    const plan = planOffsetChange({
      nextOffset: 4,
      applied: NO_REWIND,
      snapshots: { commentary: vod('commentary', 30) },
    })
    expect(plan.seeks).toEqual([])
    expect(plan.missingRoles).toEqual(['official'])
    expect(plan.limitReason).toBe('not-ready')
    expect(plan.effectiveOffset).toBe(0)
  })

  it('clamps requested offsets to the +/-60s manual range', () => {
    const plan = planOffsetChange({
      nextOffset: 90,
      applied: NO_REWIND,
      snapshots: { official: vod('official', 300), commentary: vod('commentary', 300) },
    })
    expect(plan.requestedOffset).toBe(60)
    expect(plan.seeks[0]?.to).toBe(240)
  })
})

describe('helpers', () => {
  it('clamps and snaps slider values', () => {
    expect(clampOffset(120)).toBe(60)
    expect(clampOffset(-120)).toBe(-60)
    expect(clampOffset(Number.NaN)).toBe(0)
    expect(snapOffset(3.26, 0.5)).toBe(3.5)
    expect(snapOffset(3.26, 0.05)).toBe(3.25)
  })

  it('reports available rewind head-room', () => {
    expect(availableRewind(live('official', 1_000, 940, 1_002))).toBe(60)
    expect(availableRewind(vod('official', 4))).toBe(4)
  })

  it('treats small offsets as aligned', () => {
    expect(isAligned(0.08)).toBe(true)
    expect(isAligned(-0.08)).toBe(true)
    expect(isAligned(0.2)).toBe(false)
  })

  it('describes offsets without exposing the algorithm', () => {
    expect(describeOffset(3.42)).toBe('让官方画面后退 3.42 秒')
    expect(describeOffset(-1.18)).toBe('让国内解说后退 1.18 秒')
    expect(describeOffset(0.05)).toBe('两路已对齐')
  })
})
