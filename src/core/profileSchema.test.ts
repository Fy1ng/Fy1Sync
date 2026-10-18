import { describe, expect, it } from 'vitest'
import { countInk, packBitmap, unpackBitmap } from './bitmapCodec'
import {
  CLOCK_CHARS,
  TEMPLATE_PIXELS,
  createEmptyProfile,
  parseProfile,
  profileReadiness,
  validateProfile,
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

describe('validateProfile', () => {
  it('accepts a complete profile', () => {
    const input = { ...createEmptyProfile('cs2/iem', 'CS2 IEM'), templates: fullTemplates() }
    const { profile, issues } = validateProfile(input)
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(profile?.id).toBe('cs2/iem')
    expect(profile?.templates[':']).toHaveLength(1)
  })

  it('rejects a bad id', () => {
    const { profile, issues } = validateProfile({ ...createEmptyProfile('CS2 IEM') })
    expect(profile).toBeNull()
    expect(issues.some((issue) => issue.path === 'id')).toBe(true)
  })

  it('rejects an ROI that leaves the frame', () => {
    const { profile, issues } = validateProfile({
      ...createEmptyProfile(),
      roi: { x: 0.9, y: 0.1, w: 0.3, h: 0.1 },
    })
    expect(profile).toBeNull()
    expect(issues.some((issue) => issue.message.includes('超出画面'))).toBe(true)
  })

  it('rejects a zero-size ROI', () => {
    const { profile } = validateProfile({
      ...createEmptyProfile(),
      roi: { x: 0.1, y: 0.1, w: 0, h: 0.1 },
    })
    expect(profile).toBeNull()
  })

  it('rejects out-of-range numbers', () => {
    const { profile, issues } = validateProfile({ ...createEmptyProfile(), sampleFps: 240 })
    expect(profile).toBeNull()
    expect(issues.some((issue) => issue.path === 'sampleFps')).toBe(true)
  })

  it('warns and ignores unsupported template characters', () => {
    const { profile, issues } = validateProfile({
      ...createEmptyProfile(),
      templates: { ...fullTemplates(), X: [{ id: 'x', data: sampleData(1), createdAt: 0 }] },
    })
    expect(profile?.templates).not.toHaveProperty('X')
    expect(issues.some((issue) => issue.severity === 'warning' && issue.path === 'templates.X')).toBe(true)
  })

  it('rejects truncated bitmap data', () => {
    const { profile, issues } = validateProfile({
      ...createEmptyProfile(),
      templates: { '0': [{ id: '0-0', data: 'AAAA', createdAt: 0 }] },
    })
    expect(profile).toBeNull()
    expect(issues.some((issue) => issue.message.includes('长度不足'))).toBe(true)
  })

  it('falls back to m:ss on an unknown clock format', () => {
    const { profile, issues } = validateProfile({ ...createEmptyProfile(), clockFormat: 'h:mm:ss' })
    expect(profile?.clockFormat).toBe('m:ss')
    expect(issues.some((issue) => issue.path === 'clockFormat')).toBe(true)
  })
})

describe('parseProfile migration', () => {
  it('migrates a v1 profile with single templates', () => {
    const v1 = {
      id: 'cs2/legacy',
      name: 'Legacy',
      roi: { x: 0.4, y: 0.02, w: 0.2, h: 0.08 },
      clockFormat: 'm:ss',
      detectWindowSeconds: 3,
      sampleFps: 30,
      matchThreshold: 0.8,
      threshold: 180,
      scale: 1.2,
      invert: true,
      templates: Object.fromEntries(
        CLOCK_CHARS.map((char, index) => [char, { data: sampleData(index) }]),
      ),
    }
    const { profile, issues } = parseProfile(v1)
    expect(profile?.schemaVersion).toBe(2)
    expect(profile?.templates['0']).toHaveLength(1)
    expect(profile?.templates['0']?.[0]?.origin).toBe('v1')
    expect(profile?.preprocess).toEqual({ scale: 1.2, threshold: 180, invert: true })
    expect(issues.some((issue) => issue.message.includes('迁移'))).toBe(true)
  })

  it('passes v2 profiles through untouched', () => {
    const v2 = { ...createEmptyProfile('cs2/iem'), templates: fullTemplates(), updatedAt: 99 }
    const { profile, issues } = parseProfile(v2)
    expect(profile?.updatedAt).toBe(99)
    expect(issues.filter((issue) => issue.severity === 'warning')).toEqual([])
  })

  it('refuses a future schema version', () => {
    const { profile, issues } = parseProfile({ ...createEmptyProfile(), schemaVersion: 3 })
    expect(profile).toBeNull()
    expect(issues[0]?.path).toBe('schemaVersion')
  })

  it('rejects non-objects', () => {
    expect(parseProfile(null).profile).toBeNull()
    expect(parseProfile('nope').profile).toBeNull()
    expect(parseProfile([]).profile).toBeNull()
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
    const parsed = validateProfile({ ...createEmptyProfile(), templates: fullTemplates() })
    const readiness = profileReadiness(parsed.profile!)
    expect(readiness.ready).toBe(true)
    expect(readiness.sampleCount).toBe(CLOCK_CHARS.length)
  })

  it('does not require a colon for seconds-only clocks', () => {
    const templates = fullTemplates()
    delete templates[':']
    const parsed = validateProfile({
      ...createEmptyProfile(),
      clockFormat: 'ss',
      templates,
    })
    expect(profileReadiness(parsed.profile!).ready).toBe(true)
  })
})
