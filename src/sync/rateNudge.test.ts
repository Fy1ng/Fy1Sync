import { describe, expect, it } from 'vitest'
import { rateNudgeAction } from './rateNudge'

describe('rateNudgeAction', () => {
  it('hands over to seek only strictly above the configured threshold', () => {
    expect(rateNudgeAction(1.5, 'official').kind).toBe('rate')
    expect(rateNudgeAction(-1.5, 'commentary').kind).toBe('rate')
    expect(rateNudgeAction(1.501, 'official')).toEqual({ kind: 'seek', rate: 1 })
    expect(rateNudgeAction(-1.501, 'commentary')).toEqual({ kind: 'seek', rate: 1 })
    expect(rateNudgeAction(0.6, 'official', { seekThresholdSeconds: 0.5 }).kind).toBe('seek')
  })

  it('restores normal speed inside the inclusive 0.1 second deadband', () => {
    for (const error of [-0.1, 0, 0.1]) {
      expect(rateNudgeAction(error, 'official')).toEqual({ kind: 'aligned', rate: 1 })
    }
  })

  it('never leaves 0.95 through 1.05 and reverses on an overshoot', () => {
    for (const role of ['official', 'commentary'] as const) {
      for (let error = -1.5; error <= 1.5; error += 0.01) {
        const action = rateNudgeAction(error, role)
        expect(action.rate).toBeGreaterThanOrEqual(0.95)
        expect(action.rate).toBeLessThanOrEqual(1.05)
      }
    }
    expect(rateNudgeAction(0.5, 'official').rate).toBe(0.95)
    expect(rateNudgeAction(-0.5, 'official').rate).toBe(1.05)
    expect(rateNudgeAction(-0.5, 'commentary').rate).toBe(0.95)
  })
})
