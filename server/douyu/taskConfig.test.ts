import { describe, expect, it, vi } from 'vitest'
import { readMessageSchedule } from './taskConfig'
import type { DouyuMessageSchedule } from './types'

const SCHEDULE: DouyuMessageSchedule = {
  text: '  SYNTHETIC_LOOP_TEXT  ', colors: [6, 2, 0], intervalSeconds: 60, initialDelaySeconds: 0, maxRuns: 10,
}

describe('plain Douyu message schedule parsing', () => {
  it('preserves text and color order while isolating both directions of mutation', () => {
    const raw = { ...SCHEDULE, colors: [...SCHEDULE.colors] }
    const result = readMessageSchedule(raw)!
    expect(result).toEqual(SCHEDULE)
    expect(result).not.toBe(raw)
    expect(result.colors).not.toBe(raw.colors)
    raw.text = 'changed'
    raw.colors[0] = 1
    expect(result).toEqual(SCHEDULE)
    result.colors.push(5)
    expect(raw.colors).toEqual([1, 2, 0])
  })

  it('accepts all bounded endpoints and a null-prototype data object', () => {
    expect(readMessageSchedule({ ...SCHEDULE, colors: [0], intervalSeconds: 1, initialDelaySeconds: 0, maxRuns: 1 }))
      .toMatchObject({ colors: [0], intervalSeconds: 1, initialDelaySeconds: 0, maxRuns: 1 })
    const raw = Object.assign(Object.create(null), { ...SCHEDULE, text: '\uD83D\uDE00'.repeat(250),
      colors: [6, 5, 4, 3, 2, 1, 0], intervalSeconds: 86_400, initialDelaySeconds: 86_400, maxRuns: 1_000 }) as DouyuMessageSchedule
    expect(readMessageSchedule(raw)).toEqual(raw)
    expect(readMessageSchedule({ ...SCHEDULE, maxRuns: null })?.maxRuns).toBeNull()
  })

  it.each([
    null, [], {}, Object.assign(Object.create({ inherited: true }), SCHEDULE),
    { ...SCHEDULE, extra: true }, { ...SCHEDULE, [Symbol('extra')]: true },
    { text: 'x', colors: [0], intervalSeconds: 1, initialDelaySeconds: 0 },
    { ...SCHEDULE, text: '' }, { ...SCHEDULE, text: '   ' }, { ...SCHEDULE, text: 1 },
    { ...SCHEDULE, text: 'x'.repeat(501) }, { ...SCHEDULE, text: '\uD83D\uDE00'.repeat(251) },
    { ...SCHEDULE, text: 'bad\ntext' }, { ...SCHEDULE, text: 'bad\x85text' },
    { ...SCHEDULE, text: 'bad\u2028text' }, { ...SCHEDULE, text: 'bad\u2029text' },
    { ...SCHEDULE, text: 'bad\uD800' }, { ...SCHEDULE, text: '\uDC00bad' },
    { ...SCHEDULE, colors: [] }, { ...SCHEDULE, colors: [1, 1] }, { ...SCHEDULE, colors: new Array<number>(1) },
    { ...SCHEDULE, colors: Array.from({ length: 8 }, (_, index) => index) },
    { ...SCHEDULE, colors: [-1] }, { ...SCHEDULE, colors: [7] }, { ...SCHEDULE, colors: [0.5] },
    { ...SCHEDULE, colors: [NaN] }, { ...SCHEDULE, colors: ['1'] }, { ...SCHEDULE, colors: new Uint8Array([1]) },
    { ...SCHEDULE, colors: Object.assign([1], { extra: true }) },
    { ...SCHEDULE, intervalSeconds: 0 }, { ...SCHEDULE, intervalSeconds: 86_401 },
    { ...SCHEDULE, intervalSeconds: 1.5 }, { ...SCHEDULE, intervalSeconds: Infinity },
    { ...SCHEDULE, initialDelaySeconds: -1 }, { ...SCHEDULE, initialDelaySeconds: 86_401 },
    { ...SCHEDULE, initialDelaySeconds: 0.5 }, { ...SCHEDULE, initialDelaySeconds: '1' },
    { ...SCHEDULE, maxRuns: 0 }, { ...SCHEDULE, maxRuns: 1_001 },
    { ...SCHEDULE, maxRuns: 1.5 }, { ...SCHEDULE, maxRuns: undefined }, { ...SCHEDULE, maxRuns: Infinity },
  ])('refuses malformed configuration without throwing: %#', raw => {
    expect(readMessageSchedule(raw)).toBeNull()
  })

  it('never invokes schedule or array accessors and catches hostile reflection', () => {
    const text = vi.fn(() => 'SYNTHETIC_SECRET')
    const color = vi.fn(() => 1)
    const raw = Object.defineProperty({ ...SCHEDULE }, 'text', { enumerable: true, get: text })
    const colors = Object.defineProperty([1], '0', { enumerable: true, get: color })
    expect(readMessageSchedule(raw)).toBeNull()
    expect(readMessageSchedule({ ...SCHEDULE, colors })).toBeNull()
    expect(text).not.toHaveBeenCalled()
    expect(color).not.toHaveBeenCalled()
    expect(readMessageSchedule(new Proxy({ ...SCHEDULE }, { getPrototypeOf() { throw new Error('SYNTHETIC_SECRET') } }))).toBeNull()
    class Colors extends Array<number> {}
    expect(readMessageSchedule({ ...SCHEDULE, colors: new Colors(0, 1) })).toBeNull()
  })
})
