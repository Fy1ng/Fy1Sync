import { describe, expect, it } from 'vitest'
import { createEmptyHudStylePack, parseHudStylePack } from '../../core/hudStylePack'
import { packBitmap } from '../../core/bitmapCodec'
import { clockModel, patchClock, sizeEmptyClock } from './editorModel'

describe('clock editor pack view', () => {
  it('preserves other fields, layouts, cues, states and organizer through an edit and JSON round trip', () => {
    const pack = createEmptyHudStylePack('test/pgl', 'PGL', { width: 3840, height: 2160 })
    const variant = pack.variants[0]!
    const clock = variant.fields.clock!
    const data = packBitmap(Uint8Array.from({ length: 1536 }, (_, index) => index % 3 === 0 ? 255 : 0))
    pack.bitmaps.digit = { width: 32, height: 48, data }
    clock.glyphs['1'] = ['digit']
    variant.fields.scoreLeft = { ...structuredClone(clock), grammar: { kind: 'integer', min: 0, max: 99 } }
    variant.cues.replay = { roi: { x: 0, y: 0, w: 32, h: 48 }, preprocess: { ...clock.preprocess }, templates: ['digit'], minScore: 0.8 }
    variant.states.replay = [[{ kind: 'cue', cue: 'replay', present: true }]]
    variant.organizer = structuredClone(variant.cues.replay)
    pack.variants.push({ ...structuredClone(variant), id: 'official-bottom-2160' })
    const changed = patchClock(pack, { name: 'PGL edited', preprocess: { ...clock.preprocess, threshold: 123 } })
    const imported = parseHudStylePack(JSON.parse(JSON.stringify(changed))).pack!
    expect(imported.name).toBe('PGL edited')
    expect(imported.variants[0]!.fields.clock!.preprocess.threshold).toBe(123)
    expect(imported.variants[0]!.fields.scoreLeft).toEqual(variant.fields.scoreLeft)
    expect(imported.variants[0]!.cues).toEqual(variant.cues)
    expect(imported.variants[0]!.states).toEqual(variant.states)
    expect(imported.variants[0]!.organizer).toEqual(variant.organizer)
    expect(imported.variants[1]).toEqual(pack.variants[1])
    expect(imported.bitmaps).toEqual(pack.bitmaps)
  })
  it('writes ROI coordinates as native integer pixels', () => {
    const pack = createEmptyHudStylePack('test/pgl', 'PGL', { width: 3840, height: 2160 })
    const changed = patchClock(pack, { roi: { x: 1854 / 3840, y: 98 / 2160, w: 116 / 3840, h: 64 / 2160 } })
    expect(changed.variants[0]!.fields.clock!.roi).toEqual({ x: 1854, y: 98, w: 116, h: 64 })
    expect(clockModel(changed).roi).toEqual({ x: 1854 / 3840, y: 98 / 2160, w: 116 / 3840, h: 64 / 2160 })
    expect(parseHudStylePack(changed).issues).toEqual([])
  })
  it('keeps a dragged ROI inside the native picture after rounding', () => {
    const pack = createEmptyHudStylePack('test/pgl', 'PGL', { width: 101, height: 101 })
    const changed = patchClock(pack, { roi: { x: 0.555, y: 0.555, w: 0.445, h: 0.445 } })
    const roi = changed.variants[0]!.fields.clock!.roi
    expect(roi.x + roi.w).toBeLessThanOrEqual(101)
    expect(roi.y + roi.h).toBeLessThanOrEqual(101)
    expect(parseHudStylePack(changed).issues).toEqual([])
  })
  it('adopts footage dimensions only before any templates have been made', () => {
    const pack = createEmptyHudStylePack()
    const sized = sizeEmptyClock(pack, 3840, 2160)
    expect(sized.variants[0]!.nativeSize).toEqual({ width: 3840, height: 2160 })
    expect(sized.variants[0]!.id).toBe('official-top-2160')
    sized.bitmaps.digit = { width: 32, height: 48, data: 'data' }
    expect(sizeEmptyClock(sized, 1280, 720)).toBe(sized)
  })
  it('keeps populated non-clock fields and states at their declared native size', () => {
    const pack = createEmptyHudStylePack()
    pack.variants[0]!.fields.scoreLeft = { ...structuredClone(pack.variants[0]!.fields.clock!), grammar: { kind: 'integer', min: 0, max: 99 } }
    expect(sizeEmptyClock(pack, 3840, 2160)).toBe(pack)
    pack.variants[0]!.fields.scoreLeft = null
    pack.variants[0]!.states.hasClock = [[{ kind: 'field', field: 'clock', present: true }]]
    expect(sizeEmptyClock(pack, 3840, 2160)).toBe(pack)
  })
})
