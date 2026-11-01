import { createHudPreprocess } from '../../core/hudPreprocess'
import { describe, expect, it } from 'vitest'
import { createEmptyHudStylePack, parseHudStylePack } from '../../core/hudStylePack'
import { packBitmap, unpackBitmap } from '../../core/bitmapCodec'
import '../../wasm/test-helpers'
import { recognize_hud_frame } from '../../wasm/pkg/stream_syncer_wasm.js'
import { addLayout, generateScaledLayout, removeLayout, renameLayout } from './layoutModel'
import { fieldModel, patchField } from './editorModel'
import { cueModel, editorCue, patchCue } from './cueModel'

describe('editor layouts', () => {
  it('copies same-size fields, glyph references, cues and states without organizer, then edits each layout independently', () => {
    const original = createEmptyHudStylePack()
    const top = original.variants[0]!
    top.cues.replay = editorCue(original, 'replay')
    top.states.replay = [[{ kind: 'cue', cue: 'replay', present: true }]]
    top.organizer = editorCue(original, 'organizer')
    const added = addLayout(original, top.id, top.nativeSize)
    expect(added.pack.variants[1]).toEqual({ ...top, id: added.id, organizer: null })
    expect(added.pack.variants[1]!.fields).not.toBe(top.fields)
    expect(added.pack.variants[1]!.cues).not.toBe(top.cues)
    const numeric = patchField(added.pack, 'clock', { preprocess: createHudPreprocess({ scale: 1, threshold: 123, invert: false }) }, added.id)
    const changed = patchCue(numeric, 'replay', { roi: { x: 0.1, y: 0.8, w: 0.1, h: 0.1 } }, undefined, added.id)
    expect(changed.variants[0]).toEqual(top)
    expect(fieldModel(changed, 'clock', added.id).preprocess.threshold).toBe(123)
    expect(cueModel(changed, 'replay', added.id).roi.y).toBe(0.8)
    expect(changed.bitmaps).toEqual(original.bitmaps)
  })

  it('creates a differently sized empty layout and retains at least one layout', () => {
    const pack = createEmptyHudStylePack()
    const frame = { width: 1280, height: 720, pixels: new Uint8Array(), mediaTime: 245 }
    const added = addLayout(pack, pack.variants[0]!.id, frame)
    expect(added.pack.variants[1]).toEqual({ id: added.id, nativeSize: { width: 1280, height: 720 },
      fields: { clock: null, scoreLeft: null, scoreRight: null }, cues: {}, states: {}, organizer: null })
    expect(removeLayout(pack, pack.variants[0]!.id)).toBe(pack)
    expect(removeLayout(added.pack, added.id).variants).toEqual(pack.variants)
  })

  it('reuses pack ID validation and rejects duplicate IDs in either layout position', () => {
    const pack = createEmptyHudStylePack()
    const added = addLayout(pack, pack.variants[0]!.id, pack.variants[0]!.nativeSize).pack
    expect(renameLayout(added, added.variants[0]!.id, 'BAD ID').error).toBe('标识格式无效')
    expect(renameLayout(added, added.variants[0]!.id, added.variants[1]!.id).error).toBe('布局 ID 重复')
    expect(renameLayout(added, added.variants[1]!.id, added.variants[0]!.id).error).toBe('布局 ID 重复')
    const renamed = renameLayout(added, added.variants[1]!.id, 'pgl/bottom-1080')
    expect(renamed.error).toBeNull()
    expect(renamed.pack.variants.map(variant => variant.id)).toEqual([added.variants[0]!.id, 'pgl/bottom-1080'])
  })
})

function scalablePack() {
  const pack = createEmptyHudStylePack('custom/scaled', '低档换算', { width: 3840, height: 2160 })
  const variant = pack.variants[0]!
  const clock = variant.fields.clock!
  clock.roi = { x: 101, y: 53, w: 11, h: 9 }
  clock.segment = { minColumnInk: 1, minGlyphWidth: 5, minGapWidth: 3, minInkRatio: 0.12 }
  clock.preprocess = createHudPreprocess({ scale: 1.8, threshold: 139, invert: true })
  pack.bitmaps.glyph = { width: 32, height: 48, data: packBitmap(Uint8Array.from({ length: 32 * 48 }, (_, i) => i === 0 ? 255 : 0)) }
  clock.glyphs['1'] = ['glyph']
  pack.bitmaps.mark = { width: 4, height: 4, data: packBitmap(Uint8Array.of(0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255)) }
  variant.cues.replay = { enabled: true, roi: { x: 100, y: 50, w: 4, h: 4 }, preprocess: createHudPreprocess({ scale: 2.1, threshold: 151, invert: false }), templates: ['mark'], minScore: 0.91 }
  variant.organizer = structuredClone(variant.cues.replay)
  variant.states.replay = [[{ kind: 'cue', cue: 'replay', present: true }]]
  return pack
}

describe('generated lower resolution layouts', () => {
  it.each([1440, 1080] as const)('rounds ROI edges at %ip, scales pixel settings and preserves recognition settings', height => {
    const original = scalablePack()
    const before = structuredClone(original)
    const source = original.variants[0]!
    const result = generateScaledLayout(original, source.id, height)
    const scaled = result.pack.variants[1]!
    expect(scaled.nativeSize).toEqual({ width: height === 1440 ? 2560 : 1920, height })
    expect(scaled.fields.clock!.roi).toEqual(height === 1440 ? { x: 67, y: 35, w: 8, h: 6 } : { x: 51, y: 27, w: 5, h: 4 })
    expect(scaled.fields.clock!.segment).toEqual({ minColumnInk: 1, minGlyphWidth: 3, minGapWidth: 2, minInkRatio: 0.12 })
    expect(scaled.fields.clock!.preprocess).toEqual(source.fields.clock!.preprocess)
    expect(scaled.fields.clock!.glyphs).toEqual(source.fields.clock!.glyphs)
    expect(scaled.fields.clock!.match).toEqual(source.fields.clock!.match)
    expect(scaled.fields.clock!.grammar).toEqual(source.fields.clock!.grammar)
    expect(scaled.states).toEqual(source.states)
    expect(scaled.organizer).not.toBeNull()
    for (const cue of [scaled.cues.replay!, scaled.organizer!]) {
      expect(cue.preprocess).toEqual(source.cues.replay!.preprocess)
      expect(cue.minScore).toBe(source.cues.replay!.minScore)
      expect(cue.templates).toHaveLength(1)
      expect(cue.templates[0]).not.toBe('mark')
      expect(result.pack.bitmaps[cue.templates[0]!]!).toMatchObject({ width: cue.roi.w, height: cue.roi.h })
    }
    expect(result.pack.revision).toBe(original.revision + 1)
    expect(original).toEqual(before)
    expect(result.pack.variants[0]).toEqual(source)
    expect(result.pack.bitmaps.mark).toEqual(original.bitmaps.mark)
    expect(result.pack.bitmaps.glyph).toEqual(original.bitmaps.glyph)
    expect(result.pack.schemaVersion).toBe(1)
    expect(parseHudStylePack(result.pack).issues).toEqual([])
    const recognized = JSON.parse(recognize_hud_frame(new Uint8Array(scaled.nativeSize.width * height * 4), scaled.nativeSize.width, height, JSON.stringify(result.pack), scaled.id))
    expect(recognized.variantId).toBe(scaled.id)
  })

  it('uses nearest pixel centers for templates and leaves glyph references independent from scaled templates', () => {
    const original = scalablePack()
    const result = generateScaledLayout(original, original.variants[0]!.id, 1080)
    const scaled = result.pack.variants[1]!
    const cueId = scaled.cues.replay!.templates[0]!
    expect(unpackBitmap(result.pack.bitmaps[cueId]!.data, 4)).toEqual(Uint8Array.of(255, 0, 0, 255))
    scaled.fields.clock!.glyphs['1']!.push('another-sample')
    expect(original.variants[0]!.fields.clock!.glyphs['1']).toEqual(['glyph'])
    expect(scaled.cues.replay!.templates).not.toEqual(scaled.organizer!.templates)
  })

  it('scales adaptive windows to an odd native size while retaining color ranges', () => {
    const original = scalablePack()
    const variant = original.variants[0]!
    variant.fields.clock!.preprocess.mode = 'adaptive'
    variant.fields.clock!.preprocess.adaptive = { windowSize: 31, offset: 11 }
    variant.cues.replay!.preprocess.mode = 'adaptive'
    variant.cues.replay!.preprocess.adaptive = { windowSize: 5, offset: 8 }
    variant.organizer!.preprocess.mode = 'hsv'
    variant.organizer!.preprocess.hsv.hue = 358
    const result = generateScaledLayout(original, variant.id, 1080).pack.variants[1]!
    expect(result.fields.clock!.preprocess.adaptive).toEqual({ windowSize: 17, offset: 11 })
    expect(result.cues.replay!.preprocess.adaptive).toEqual({ windowSize: 3, offset: 8 })
    expect(result.organizer!.preprocess.hsv).toEqual(variant.organizer!.preprocess.hsv)
    expect(variant.fields.clock!.preprocess.adaptive.windowSize).toBe(31)
  })

  it.each([1440, 1080] as const)('keeps one-pixel edge regions inside the %ip frame and pixel settings at least one', height => {
    const pack = createEmptyHudStylePack('custom/tiny', '边界', { width: 3840, height: 2160 })
    pack.variants[0]!.fields.clock!.roi = { x: 3839, y: 2159, w: 1, h: 1 }
    pack.variants[0]!.fields.clock!.segment = { minColumnInk: 1, minGlyphWidth: 1, minGapWidth: 1, minInkRatio: 0.08 }
    const result = generateScaledLayout(pack, pack.variants[0]!.id, height)
    const scaled = result.pack.variants[1]!
    expect(scaled.fields.clock!.roi).toEqual({ x: scaled.nativeSize.width - 1, y: height - 1, w: 1, h: 1 })
    expect(scaled.fields.clock!.segment).toEqual(pack.variants[0]!.fields.clock!.segment)
    expect(parseHudStylePack(result.pack).issues).toEqual([])
  })

  it('appends independent layouts and never overwrites existing layout or bitmap IDs', () => {
    const original = scalablePack()
    original.bitmaps['mark-1440'] = original.bitmaps.mark!
    const first = generateScaledLayout(original, original.variants[0]!.id, 1440)
    const second = generateScaledLayout(first.pack, original.variants[0]!.id, 1440)
    expect(first.id).toBe(`${original.variants[0]!.id}-1440`)
    expect(second.id).toBe(`${first.id}-2`)
    expect(second.pack.variants).toHaveLength(3)
    expect(second.pack.variants[1]).toEqual(first.pack.variants[1])
    expect(second.pack.bitmaps['mark-1440']).toEqual(original.bitmaps.mark)
    expect(second.pack.variants[2]!.cues.replay!.templates).not.toEqual(first.pack.variants[1]!.cues.replay!.templates)
    expect(parseHudStylePack(second.pack).issues).toEqual([])
  })

  it('keeps maximum-length source IDs valid after adding resolution and collision suffixes', () => {
    const original = scalablePack()
    original.variants[0]!.id = 'a'.repeat(127) + 'b'
    const first = generateScaledLayout(original, original.variants[0]!.id, 1440)
    const second = generateScaledLayout(first.pack, original.variants[0]!.id, 1440)
    expect(first.id).toHaveLength(128)
    expect(second.id).toHaveLength(128)
    expect(second.id).not.toBe(first.id)
    expect(parseHudStylePack(second.pack).issues).toEqual([])
  })

  it('rejects non-2160p sources and templates that collapse to an invalid solid bitmap without altering the pack', () => {
    const small = createEmptyHudStylePack()
    expect(() => generateScaledLayout(small, small.variants[0]!.id, 1440)).toThrow('只能从 3840x2160 布局')
    const original = scalablePack()
    original.bitmaps.mark = { width: 2, height: 2, data: packBitmap(Uint8Array.of(0, 255, 0, 0)) }
    original.variants[0]!.cues.replay!.roi = { x: 100, y: 50, w: 2, h: 2 }
    original.variants[0]!.organizer = null
    const before = structuredClone(original)
    expect(() => generateScaledLayout(original, original.variants[0]!.id, 1080)).toThrow('位图不能全空或全满')
    expect(original).toEqual(before)
  })
})
