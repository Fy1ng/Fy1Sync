import { describe, expect, it } from 'vitest'
import { clockAnchorMs, estimateOffset, median } from './offsetEstimator'
import type { ClockJumpEvent, SourceRole } from './types'

function jump(
  source: SourceRole,
  toSeconds: number,
  wallTimeSeconds: number,
  confidence = 0.95,
): ClockJumpEvent {
  return {
    source,
    from: `0:${String(toSeconds + 1).padStart(2, '0')}`,
    to: `0:${String(toSeconds).padStart(2, '0')}`,
    toSeconds,
    mediaTime: wallTimeSeconds,
    wallTime: wallTimeSeconds * 1000,
    confidence,
    frameIndex: Math.round(wallTimeSeconds * 30),
  }
}

describe('clockAnchorMs', () => {
  it('projects a jump onto the wall time at which the countdown hits zero', () => {
    expect(clockAnchorMs({ wallTime: 10_000, toSeconds: 45 })).toBe(55_000)
  })

  it('gives the same anchor for consecutive jumps of one stream', () => {
    expect(clockAnchorMs(jump('official', 45, 10))).toBe(clockAnchorMs(jump('official', 44, 11)))
  })
})

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(Number.isNaN(median([]))).toBe(true)
  })
})

describe('estimateOffset', () => {
  it('detects a commentary stream that lags 5 seconds behind', () => {
    // Official shows 0:45 at t=10s. Commentary is 5s behind, so at t=10s it still
    // shows 0:50 and only reaches 0:45 at t=15s.
    const official = [jump('official', 45, 10), jump('official', 44, 11)]
    const commentary = [jump('commentary', 45, 15), jump('commentary', 44, 16)]

    const result = estimateOffset(official, commentary)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.residualSeconds).toBeCloseTo(5, 3)
    expect(result.totalOffsetSeconds).toBeCloseTo(5, 3)
    expect(result.direction).toBe('official')
    expect(result.rewindSeconds).toBeCloseTo(5, 3)
  })

  it('detects an official stream that lags 5 seconds behind', () => {
    const official = [jump('official', 45, 15)]
    const commentary = [jump('commentary', 45, 10)]

    const result = estimateOffset(official, commentary)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.residualSeconds).toBeCloseTo(-5, 3)
    expect(result.direction).toBe('commentary')
    expect(result.rewindSeconds).toBeCloseTo(5, 3)
  })

  it('works when the two sources never show the same countdown number', () => {
    // Official at 0:30, commentary still at 0:37 seven seconds behind.
    const official = [jump('official', 30, 20)]
    const commentary = [jump('commentary', 37, 20)]

    const result = estimateOffset(official, commentary)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.residualSeconds).toBeCloseTo(7, 3)
    expect(result.direction).toBe('official')
  })

  it('reports alignment inside the deadband without asking for a seek', () => {
    const result = estimateOffset([jump('official', 45, 10)], [jump('commentary', 45, 10.06)])
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.direction).toBe('none')
    expect(result.rewindSeconds).toBe(0)
  })

  it('adds the residual on top of an already applied offset', () => {
    // 3s already applied to the official source; 2s of residual delay remains.
    const result = estimateOffset([jump('official', 45, 10)], [jump('commentary', 45, 12)], {
      appliedOffsetSeconds: 3,
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.residualSeconds).toBeCloseTo(2, 3)
    expect(result.totalOffsetSeconds).toBeCloseTo(5, 3)
    expect(result.direction).toBe('official')
  })

  it('can flip direction when the residual overshoots the applied offset', () => {
    const result = estimateOffset([jump('official', 45, 12)], [jump('commentary', 45, 10)], {
      appliedOffsetSeconds: 1,
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.totalOffsetSeconds).toBeCloseTo(-1, 3)
    expect(result.direction).toBe('commentary')
  })

  it('rejects single-sided windows', () => {
    expect(estimateOffset([], [jump('commentary', 45, 10)])).toEqual({
      status: 'rejected',
      reason: 'no-official-jump',
    })
    expect(estimateOffset([jump('official', 45, 10)], [])).toEqual({
      status: 'rejected',
      reason: 'no-commentary-jump',
    })
  })

  it('rejects a source whose anchors disagree, e.g. a stalled stream', () => {
    const official = [jump('official', 45, 10), jump('official', 44, 12.5)]
    const result = estimateOffset(official, [jump('commentary', 45, 10)])
    expect(result).toEqual({ status: 'rejected', reason: 'unstable-official' })
  })

  it('rejects low-confidence windows', () => {
    const result = estimateOffset(
      [jump('official', 45, 10, 0.6)],
      [jump('commentary', 45, 15, 0.95)],
      { minConfidence: 0.82 },
    )
    expect(result).toEqual({ status: 'rejected', reason: 'low-confidence' })
  })

  it('rejects offsets beyond the supported range', () => {
    const result = estimateOffset([jump('official', 10, 10)], [jump('commentary', 45, 100)])
    expect(result).toEqual({ status: 'rejected', reason: 'out-of-range' })
  })

  it('uses the median anchor when a window holds several jumps', () => {
    const official = [jump('official', 45, 10), jump('official', 44, 11), jump('official', 43, 12)]
    const commentary = [
      jump('commentary', 45, 12),
      jump('commentary', 44, 13.05),
      jump('commentary', 43, 14),
    ]
    const result = estimateOffset(official, commentary)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.residualSeconds).toBeCloseTo(2, 2)
    expect(result.officialEvents).toBe(3)
    expect(result.commentaryAnchorSpread).toBeGreaterThan(0)
  })
})
