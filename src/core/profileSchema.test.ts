import { describe, expect, it } from 'vitest'
import { countInk, packBitmap, unpackBitmap } from './bitmapCodec'
import {
  CLOCK_CHARS,
  TEMPLATE_PIXELS,
  createEmptyProfile,
  profileReadiness,
} from './profileSchema'

function sampleData(seed: number): string {
  const mask = new Uint8Array(TEMPLATE_PIXELS)
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = (index + seed) % 3 === 0 ? 255 : 0
  }
  return packBitmap(mask)
}

function fullTemplates(): Record<string, Array<{ id: string; data: string; createdAt: number }>> {
  const templates: Record<string, Array<{ id: string; data: string; createdAt: number }>> = {}
  CLOCK_CHARS.forEach((char, index) => {
    templates[char] = [{ id: `${char}-0`, data: sampleData(index), createdAt: 1 }]
  })
  return templates
}

describe('bitmapCodec', () => {
  it('round-trips a bitmap', () => {
    const mask = new Uint8Array(TEMPLATE_PIXELS)
    for (let index = 0; index < mask.length; index += 1) {
      mask[index] = index % 7 === 0 ? 255 : 0
    }
    const restored = unpackBitmap(packBitmap(mask), TEMPLATE_PIXELS)
    expect(Array.from(restored)).toEqual(Array.from(mask))
  })

  it('round-trips lengths that are not a multiple of 8 or 3', () => {
    for (const length of [1, 5, 7, 8, 9, 17, 100]) {
      const mask = new Uint8Array(length)
      for (let index = 0; index < length; index += 1) mask[index] = index % 2 === 0 ? 255 : 0
      const restored = unpackBitmap(packBitmap(mask), length)
      expect(Array.from(restored), `length ${length}`).toEqual(Array.from(mask))
    }
  })

  it('normalises any non-zero pixel to 255', () => {
    const mask = new Uint8Array([0, 1, 128, 255])
    expect(Array.from(unpackBitmap(packBitmap(mask), 4))).toEqual([0, 255, 255, 255])
  })

  it('counts ink pixels', () => {
    const mask = new Uint8Array([255, 0, 255, 255, 0, 0, 0, 0])
    expect(countInk(packBitmap(mask), 8)).toBe(3)
  })

  it('rejects malformed input', () => {
    expect(() => unpackBitmap('not*base64', 8)).toThrow(/invalid base64/u)
    expect(() => unpackBitmap('AA', 4096)).toThrow(/too short/u)
  })
})

describe('profileReadiness', () => {
  it('lists missing glyphs', () => {
    const profile = createEmptyProfile()
    const readiness = profileReadiness(profile)
    expect(readiness.ready).toBe(false)
    expect(readiness.missing).toEqual([...CLOCK_CHARS])
    expect(readiness.sampleCount).toBe(0)
  })

  it('is ready once every glyph has a sample', () => {
    const profile = { ...createEmptyProfile(), templates: fullTemplates() }
    const readiness = profileReadiness(profile)
    expect(readiness.ready).toBe(true)
    expect(readiness.sampleCount).toBe(CLOCK_CHARS.length)
  })

  it('does not require a colon for seconds-only clocks', () => {
    const templates = fullTemplates()
    delete templates[':']
    const profile = { ...createEmptyProfile(), clockFormat: 'ss' as const, templates }
    expect(profileReadiness(profile).ready).toBe(true)
  })
})
