import { describe, expect, it } from 'vitest'
import { clockText, pairReading } from './reading'

describe('pairReading', () => {
  it('pairs a whole reading with the boxes left to right', () => {
    expect(pairReading('1:23', 4)).toEqual({ ok: true, chars: ['1', ':', '2', '3'] })
    expect(pairReading(' 0 : 0 9 ', 4)).toEqual({ ok: true, chars: ['0', ':', '0', '9'] })
  })

  it('refuses a reading that does not fit the boxes, saying what to fix', () => {
    const fewer = pairReading('1:23', 3)
    expect(fewer.ok).toBe(false)
    if (!fewer.ok) expect(fewer.reason).toContain('4 个字符，切出了 3 个字符框')
    expect(pairReading('1:23', 0)).toMatchObject({ ok: false, reason: expect.stringContaining('没有切出字符框') })
  })

  it('refuses characters a countdown does not have', () => {
    expect(pairReading('1.23', 4)).toMatchObject({ ok: false, reason: expect.stringContaining('「.」') })
    expect(pairReading('', 4)).toMatchObject({ ok: false, reason: expect.stringContaining('完整读数') })
  })
})

describe('clockText', () => {
  it('writes the countdown the way the HUD draws it', () => {
    expect(clockText(83, 'm:ss')).toBe('1:23')
    expect(clockText(9, 'm:ss')).toBe('0:09')
    expect(clockText(83, 'mm:ss')).toBe('01:23')
    expect(clockText(7, 'ss')).toBe('7')
    expect(clockText(-2, 'm:ss')).toBe('0:00')
  })
})

describe('score reading', () => {
  it('pairs one or two digits and rejects leading zeros and clock punctuation', () => {
    expect(pairReading('0', 1, 'scoreLeft')).toEqual({ ok: true, chars: ['0'] })
    expect(pairReading('99', 2, 'scoreRight')).toEqual({ ok: true, chars: ['9', '9'] })
    for (const text of ['00', '01', '100', '-1', '1:2']) expect(pairReading(text, text.length, 'scoreLeft').ok).toBe(false)
    expect(pairReading('10', 1, 'scoreRight').ok).toBe(false)
  })
})
