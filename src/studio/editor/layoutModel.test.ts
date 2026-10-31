import { describe, expect, it } from 'vitest'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import { addLayout, removeLayout, renameLayout } from './layoutModel'
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
    const numeric = patchField(added.pack, 'clock', { preprocess: { scale: 1, threshold: 123, invert: false } }, added.id)
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
