import { describe, expect, it } from 'vitest'
import { RhythmSampler } from './rhythm'

describe('RhythmSampler', () => {
  it('samples every presented frame until two confirmed ticks establish a period', () => {
    const rhythm = new RhythmSampler()
    expect(rhythm.shouldSample(0)).toBe(true)
    expect(rhythm.shouldSample(0.03)).toBe(true)
    rhythm.confirmTick(0)
    expect(rhythm.mode).toBe('dense')
    expect(rhythm.shouldSample(0.06)).toBe(true)
    rhythm.confirmTick(1)
    expect(rhythm.mode).toBe('predicted')
    expect(rhythm.nextTick).toBe(2)
  })

  it('samples at 4 fps outside the predicted window and every frame within 150 ms', () => {
    const rhythm = new RhythmSampler()
    rhythm.confirmTick(0)
    rhythm.confirmTick(1)
    const sampled: number[] = []
    for (let frame = 0; frame <= 33; frame += 1) {
      const time = 1 + frame / 30
      if (rhythm.shouldSample(time)) sampled.push(time)
    }
    expect(sampled.filter((time) => time < 1.85)).toHaveLength(4)
    expect(sampled.filter((time) => time >= 1.85)).toHaveLength(8)
    expect(rhythm.mode).toBe('predicted')
  })

  it('updates the next window from confirmed media timestamps', () => {
    const rhythm = new RhythmSampler()
    rhythm.confirmTick(12.01)
    rhythm.confirmTick(13.03)
    expect(rhythm.nextTick).toBeCloseTo(14.05)
    rhythm.confirmTick(14.02)
    expect(rhythm.nextTick).toBeCloseTo(15.01)
  })

  it('returns to dense sampling when a predicted tick is missed', () => {
    const rhythm = new RhythmSampler()
    rhythm.confirmTick(0)
    rhythm.confirmTick(1)
    rhythm.shouldSample(2.1)
    expect(rhythm.shouldSample(2.16)).toBe(true)
    expect(rhythm.mode).toBe('dense')
    expect(rhythm.shouldSample(2.18)).toBe(true)
  })

  it('drops prediction after a seek or large frame-time discontinuity', () => {
    for (const destination of [0.5, 10]) {
      const rhythm = new RhythmSampler()
      rhythm.confirmTick(0)
      rhythm.confirmTick(1)
      rhythm.shouldSample(1.2)
      expect(rhythm.shouldSample(destination)).toBe(true)
      expect(rhythm.mode).toBe('dense')
    }
  })

  it('requires two fresh ticks after an explicit source or lost-clock reset', () => {
    const rhythm = new RhythmSampler()
    rhythm.confirmTick(0)
    rhythm.confirmTick(1)
    rhythm.reset()
    expect(rhythm.mode).toBe('dense')
    rhythm.confirmTick(20)
    expect(rhythm.mode).toBe('dense')
    rhythm.confirmTick(21)
    expect(rhythm.nextTick).toBe(22)
  })

  it('rejects skipped ticks, duplicates and nonfinite timestamps', () => {
    const rhythm = new RhythmSampler()
    rhythm.confirmTick(0)
    rhythm.confirmTick(2)
    expect(rhythm.mode).toBe('dense')
    rhythm.confirmTick(2)
    expect(rhythm.mode).toBe('dense')
    rhythm.confirmTick(Number.NaN)
    expect(rhythm.nextTick).toBeNull()
    expect(rhythm.shouldSample(Number.NaN)).toBe(false)
    expect(rhythm.shouldSample(3)).toBe(true)
    expect(rhythm.shouldSample(3)).toBe(false)
  })
})
