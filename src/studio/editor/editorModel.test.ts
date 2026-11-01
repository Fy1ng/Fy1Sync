import { describe, expect, it } from 'vitest'
import { createEmptyHudStylePack, parseHudStylePack } from '../../core/hudStylePack'
import { packBitmap } from '../../core/bitmapCodec'
import { clockModel, fieldModel, fieldReadiness, patchClock, patchField, sizeEmptyClock } from './editorModel'

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

describe('score editor pack view', () => {
  it('shares digit samples while retaining independent score parameters and the rest of the pack', () => {
    const pack = createEmptyHudStylePack('test/pgl', 'PGL', { width: 3840, height: 2160 })
    const clock = structuredClone(pack.variants[0]!.fields.clock)
    const data = packBitmap(Uint8Array.from({ length: 1536 }, (_, index) => index % 3 === 0 ? 255 : 0))
    const left = patchField(pack, 'scoreLeft', { preprocess: { scale: 1, threshold: 75, invert: false },
      roi: { x: 1688 / 3840, y: 88 / 2160, w: 136 / 3840, h: 116 / 2160 },
      templates: { '8': [{ id: 'left-eight', data, createdAt: 0 }] } })
    const both = patchField(left, 'scoreRight', { preprocess: { scale: 1, threshold: 110, invert: false },
      segment: { minColumnInk: 2, minGlyphWidth: 3, minGapWidth: 2, minInkRatio: 0.1 } })
    expect(both.variants[0]!.fields.clock).toEqual(clock)
    expect(both.variants[0]!.fields.scoreLeft).toEqual(left.variants[0]!.fields.scoreLeft)
    expect(both.variants[0]!.fields.scoreLeft!.roi).toEqual({ x: 1688, y: 88, w: 136, h: 116 })
    expect(fieldModel(both, 'scoreLeft').templates['8']).toHaveLength(1)
    expect(fieldModel(both, 'scoreRight').templates['8']).toHaveLength(1)
    expect(fieldModel(both, 'scoreLeft').preprocess.threshold).toBe(75)
    expect(fieldModel(both, 'scoreRight').preprocess.threshold).toBe(110)
    expect(fieldModel(both, 'scoreRight').segment.minGapWidth).toBe(2)
    expect(fieldReadiness(both, 'scoreLeft')).toMatchObject({ sampleCount: 1, ready: false })
    expect(fieldReadiness(both, 'scoreRight')).toEqual(fieldReadiness(both, 'scoreLeft'))
    expect(both.variants[0]!.fields.scoreRight!.glyphs).toEqual(both.variants[0]!.fields.scoreLeft!.glyphs)
    expect(fieldReadiness(both, 'scoreLeft').missing).not.toContain(':')
    expect(parseHudStylePack(both).issues).toEqual([])
  })

  it('provides empty score views without changing the imported document', () => {
    const pack = createEmptyHudStylePack()
    const before = JSON.stringify(pack)
    expect(fieldModel(pack, 'scoreLeft').matchThreshold).toBe(0.9)
    expect(fieldModel(pack, 'scoreRight').templates).toEqual({})
    expect(JSON.stringify(pack)).toBe(before)
  })

  it('does not activate the other side until its region is explicitly configured', () => {
    const pack = createEmptyHudStylePack()
    const data = packBitmap(Uint8Array.from({ length: 1536 }, (_, index) => index % 3 === 0 ? 255 : 0))
    const left = patchField(pack, 'scoreLeft', { templates: { '8': [{ id: 'eight', data, createdAt: 0 }] } })
    expect(left.variants[0]!.fields.scoreRight).toBeNull()
    expect(fieldModel(left, 'scoreRight').templates['8']).toHaveLength(1)
    expect(left.variants[0]!.fields.scoreRight).toBeNull()
    const both = patchField(left, 'scoreRight', { roi: { x: 0.6, y: 0.1, w: 0.1, h: 0.1 } })
    expect(both.variants[0]!.fields.scoreRight!.glyphs['8']).toEqual(['eight'])
  })

  it('reads the union of legacy score glyphs once per ID without mixing clock or other layouts', () => {
    let pack = createEmptyHudStylePack('test/shared', 'Shared')
    pack = patchField(patchField(pack, 'scoreLeft', {}), 'scoreRight', {})
    const variant = pack.variants[0]!
    for (const [index, id] of ['common-eight', 'left-eight', 'right-eight', 'seven', 'clock-nine', 'other-nine'].entries()) {
      const pixels = new Uint8Array(1536)
      pixels[index] = 255
      pack.bitmaps[id] = { width: 32, height: 48, data: packBitmap(pixels) }
    }
    variant.fields.scoreLeft!.glyphs = { '8': ['common-eight', 'left-eight'] }
    variant.fields.scoreRight!.glyphs = { '8': ['common-eight', 'right-eight'], '7': ['seven'] }
    variant.fields.clock!.glyphs = { '9': ['clock-nine'] }
    const other = structuredClone(variant)
    other.id = 'other-layout'
    other.fields.scoreLeft!.glyphs = { '9': ['other-nine'] }
    other.fields.scoreRight!.glyphs = {}
    pack.variants.push(other)
    const before = JSON.stringify(pack)
    for (const fieldId of ['scoreLeft', 'scoreRight'] as const) {
      expect(fieldModel(pack, fieldId).templates['8']?.map(sample => sample.id)).toEqual(['common-eight', 'left-eight', 'right-eight'])
      expect(fieldModel(pack, fieldId).templates['7']).toHaveLength(1)
      expect(fieldModel(pack, fieldId).templates['9']).toBeUndefined()
      expect(fieldReadiness(pack, fieldId).sampleCount).toBe(4)
      expect(fieldReadiness(pack, fieldId, other.id).sampleCount).toBe(1)
    }
    expect(JSON.stringify(pack)).toBe(before)
    expect(parseHudStylePack(pack).issues).toEqual([])
  })

  it('adds or removes shared samples from either side while keeping both sets of color settings', () => {
    const data = packBitmap(Uint8Array.from({ length: 1536 }, (_, index) => index % 3 === 0 ? 255 : 0))
    let pack = patchField(createEmptyHudStylePack(), 'scoreLeft', { preprocess: { scale: 1, threshold: 75, invert: false } })
    pack = patchField(pack, 'scoreRight', { preprocess: { scale: 2, threshold: 190, invert: true } })
    const left = patchField(pack, 'scoreLeft', { templates: { '8': [{ id: 'eight', data, createdAt: 0 }] } })
    const both = patchField(left, 'scoreRight', { templates: {
      ...fieldModel(left, 'scoreRight').templates, '7': [{ id: 'seven', data, createdAt: 0 }],
    } })
    expect(both.variants[0]!.fields.scoreLeft!.glyphs).toEqual({ '8': ['eight'], '7': ['seven'] })
    expect(both.variants[0]!.fields.scoreRight!.glyphs).toEqual(both.variants[0]!.fields.scoreLeft!.glyphs)
    const kept = patchField(both, 'scoreRight', { templates: { '7': fieldModel(both, 'scoreRight').templates['7']! } })
    expect(fieldModel(kept, 'scoreLeft').templates['8']).toBeUndefined()
    expect(fieldModel(kept, 'scoreRight').templates['8']).toBeUndefined()
    expect(fieldModel(kept, 'scoreLeft').preprocess).toEqual({ scale: 1, threshold: 75, invert: false })
    expect(fieldModel(kept, 'scoreRight').preprocess).toEqual({ scale: 2, threshold: 190, invert: true })
    expect(kept.variants[0]!.fields.clock).toEqual(pack.variants[0]!.fields.clock)
    expect(parseHudStylePack(kept).issues).toEqual([])
  })
})
