import { describe, expect, it } from 'vitest'
import { packBitmap, unpackBitmap } from '../core/bitmapCodec'
import { CLOCK_CHARS, TEMPLATE_PIXELS } from '../core/profileSchema'
import { scoreMasks } from '../core/templateMatch'
import glyphPriors from './basicGlyphPriors.json'

describe('基础数字先验', () => {
  it('全部字符符合 Rust 位图契约', () => {
    expect(Object.keys(glyphPriors).sort()).toEqual([...CLOCK_CHARS].sort())
    for (const char of CLOCK_CHARS) {
      const samples = glyphPriors[char]
      expect(samples.length).toBeGreaterThan(0)
      expect(samples.length).toBeLessThanOrEqual(16)
      expect(new Set(samples).size).toBe(samples.length)
      for (const encoded of samples) {
        expect(encoded).toHaveLength(256)
        const mask = unpackBitmap(encoded, TEMPLATE_PIXELS)
        const ink = mask.filter(value => value !== 0).length
        expect(ink).toBeGreaterThanOrEqual(12)
        expect(ink).toBeLessThan(1500)
        expect(packBitmap(mask)).toBe(encoded)
      }
    }
  })

  it('不同字符没有破坏最小匹配分差的近似重复字形', () => {
    const masks = CLOCK_CHARS.map(char => ({ char, masks: glyphPriors[char].map(sample => unpackBitmap(sample, TEMPLATE_PIXELS)) }))
    for (let left = 0; left < masks.length; left++) for (let right = left + 1; right < masks.length; right++) {
      let closest = 0
      for (const a of masks[left]!.masks) for (const b of masks[right]!.masks) closest = Math.max(closest, scoreMasks(a, b))
      expect(closest, `${masks[left]!.char}/${masks[right]!.char}`).toBeLessThan(.965)
    }
  })
})
