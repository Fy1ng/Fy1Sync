import { describe, expect, it } from 'vitest'
import cases from '../../tests/fixtures/hud-style-pack/cases.json'
import { createEmptyHudStylePack, hudPackReadiness, parseHudStylePack } from './hudStylePack'
import { createHudPreprocess } from './hudPreprocess'

describe('HudStylePack shared validation vectors', () => {
  for (const vector of cases) it(vector.name, () => {
    const result = parseHudStylePack(vector.value)
    expect(result.pack !== null).toBe(vector.valid)
    for (const path of vector.paths) expect(result.issues.map(issue => issue.path)).toContain(path)
    if (vector.valid) expect(result.pack).toEqual(vector.value)
  })
})

describe('HudStylePack', () => {
  it('accepts independent timeout regions and rule references without requiring both sides', () => {
    const pack = createEmptyHudStylePack()
    const variant = pack.variants[0]!
    variant.cues.timeoutRight = { enabled: true, roi: { x: 1500, y: 100, w: 100, h: 30 },
      preprocess: createHudPreprocess({ mode: 'hsv' }), templates: [], minScore: 0.9 }
    variant.states.paused = [[{ kind: 'cue', cue: 'timeoutRight', present: true }]]
    expect(parseHudStylePack(pack).issues).toEqual([])
    variant.cues.timeout = { ...structuredClone(variant.cues.timeoutRight), roi: { x: 300, y: 100, w: 100, h: 30 }, enabled: false }
    const imported = parseHudStylePack(JSON.parse(JSON.stringify(pack))).pack!
    expect(imported).toEqual(pack)
    expect(imported.variants[0]!.cues.timeoutRight!.enabled).toBe(true)
    expect(imported.variants[0]!.cues.timeout!.enabled).toBe(false)
  })

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
