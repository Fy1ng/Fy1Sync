import { describe, expect, it } from 'vitest'
import cases from '../../tests/fixtures/hud-style-pack/cases.json'
import { createEmptyHudStylePack, hudPackReadiness, parseHudStylePack } from './hudStylePack'

describe('HudStylePack shared validation vectors', () => {
  for (const vector of cases) it(vector.name, () => {
    const result = parseHudStylePack(vector.value)
    expect(result.pack !== null).toBe(vector.valid)
    for (const path of vector.paths) expect(result.issues.map(issue => issue.path)).toContain(path)
    if (vector.valid) expect(result.pack).toEqual(vector.value)
  })
})

describe('HudStylePack', () => {
  it('creates an editable, valid pack without pretending its glyphs are ready', () => {
    const pack = createEmptyHudStylePack()
    expect(parseHudStylePack(pack)).toEqual({ pack, issues: [] })
    expect(hudPackReadiness(pack)).toMatchObject({ ready: false, sampleCount: 0 })
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite numbers (%s)', number => {
    const pack = createEmptyHudStylePack()
    pack.variants[0]!.fields.clock!.preprocess.scale = number
    const result = parseHudStylePack(pack)
    expect(result.pack).toBeNull()
    expect(result.issues.map(issue => issue.path)).toContain('variants[0].fields.clock.preprocess.scale')
  })

  it('preserves names and pixel coordinates exactly', () => {
    const pack = createEmptyHudStylePack('cs2/pgl', '  PGL  ', { width: 3840, height: 2160 })
    pack.variants[0]!.fields.clock!.roi = { x: 1854, y: 98, w: 116, h: 64 }
    expect(parseHudStylePack(pack).pack).toBe(pack)
  })
})
