import { describe, expect, it } from 'vitest'
import { formatMsAsSeconds, parseSecondsToMs } from './durationSeconds'

describe('Douyu duration input', () => {
  it.each([
    ['0', 0, '0'],
    ['.001', 1, '0.001'],
    ['0.29', 290, '0.29'],
    [' 0.500 ', 500, '0.5'],
    ['1.000', 1_000, '1'],
    ['1.001', 1_001, '1.001'],
    ['59.999', 59_999, '59.999'],
    ['60', 60_000, '60'],
    ['60.000', 60_000, '60'],
  ])('converts %j to %i ms and formats it as %s', (input, milliseconds, seconds) => {
    expect(parseSecondsToMs(input)).toBe(milliseconds)
    expect(formatMsAsSeconds(milliseconds)).toBe(seconds)
  })

  it.each(['-0.001', '60.001', '61', '0.0001', '1.0000', '', ' ', 'abc', '1e-3', '0x10', 'Infinity'])(
    'rejects %j', (input) => expect(parseSecondsToMs(input)).toBeNull(),
  )
})
