import { describe, expect, it } from 'vitest'
import { createHudPreprocess } from '../core/hudPreprocess'
import { packBitmap } from '../core/bitmapCodec'
import { normalizeGlyph } from '../core/imageOps'
import { CLOCK_CHARS } from '../core/profileSchema'
import { createEmptyHudStylePack, parseHudStylePack } from '../core/hudStylePack'
import { hudRoiAtSize } from '../core/hudGeometry'
import { prepareHudCue, prepareHudGlyphs, recognizeHudFrame } from '../core/hudWasm'
import { createFrame, drawText, renderGlyphMask, type RgbaFrame } from '../test/glyphFont'
import { patchCue } from '../studio/editor/cueModel'
import { WasmRecognitionEngine } from '../wasm/test-helpers'
import { recognize_hud_frame } from '../wasm/pkg/stream_syncer_wasm.js'
import { WasmWorkerEngine } from './backend'
import type { ResultMessage } from './protocol'

function fixture() {
  const source = createFrame(640, 360)
  drawText(source, '1:37', 240, 32, { scale: 8 })
  for (let y = 204; y < 212; y++) for (let x = 524; x < 532; x++) {
    source.data.set([245, 245, 245, 255], (y * source.width + x) * 4)
  }
  const pack = createEmptyHudStylePack('test/reference-resolution', '参考尺寸', { width: source.width, height: source.height })
  const variant = pack.variants[0]!
  const clock = variant.fields.clock!
  clock.roi = { x: 232, y: 24, w: 208, h: 72 }
  clock.preprocess = createHudPreprocess({ scale: 1, threshold: 120 })
  for (const char of CLOCK_CHARS) {
    const id = `glyph-${char === ':' ? 'colon' : char}`
    pack.bitmaps[id] = { width: 32, height: 48, data: packBitmap(normalizeGlyph(renderGlyphMask(char, 8))) }
    clock.glyphs[char] = [id]
  }
  pack.bitmaps.timeout = { width: 16, height: 16,
    data: packBitmap(Uint8Array.from({ length: 256 }, (_, index) => index % 16 >= 4 && index % 16 < 12 && index >= 64 && index < 192 ? 255 : 0)) }
  variant.cues.timeoutRight = { enabled: true, roi: { x: 520, y: 200, w: 16, h: 16 },
    preprocess: createHudPreprocess({ scale: 1, threshold: 120 }), templates: ['timeout'], minScore: 0.9 }
  return { source, pack, variant }
}

function resize(source: RgbaFrame, width: number, height: number): RgbaFrame {
  const target = createFrame(width, height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (Math.min(source.height - 1, Math.floor(y * source.height / height)) * source.width
      + Math.min(source.width - 1, Math.floor(x * source.width / width))) * 4
    target.data.set(source.data.subarray(from, from + 4), (y * width + x) * 4)
  }
  return target
}

describe('HUD reference-resolution recognition across clients', () => {
  it.each([[320, 180], [640, 360], [1280, 720], [960, 360]])('shares %sx%s numeric and cue recognition between editor and player', async (width, height) => {
    const { source, pack, variant } = fixture()
    const snapshot = JSON.stringify(pack)
    const frame = resize(source, width, height)
    const rgba = { width, height, pixels: frame.data }
    const editor = await recognizeHudFrame(rgba, pack, variant.id)
    const automatic = await recognizeHudFrame(rgba, pack)
    expect(automatic).toEqual(editor)
    expect(editor).toMatchObject({ variantId: variant.id, selectionReason: null, phase: 'paused',
      fields: { clock: { status: 'read', reading: { text: '1:37', value: 97 } } }, cues: { timeoutRight: { status: 'matched' } } })
    if (editor.fields.clock.status !== 'read') throw new Error('Expected a reference-scaled clock reading')
    const scores = editor.fields.clock.reading.scores
    expect(scores).toHaveLength(4)
    expect(editor.fields.clock.reading.confidence).toBe(Math.min(scores[0]!, scores[2]!, scores[3]!))

    const core = new WasmRecognitionEngine()
    const engine = new WasmWorkerEngine({ configure: text => core.configure(text), recognize: (...args) => core.recognize(...args), recognizeHud: recognize_hud_frame }, () => 0)
    try {
      engine.handle({ type: 'configure', generation: 1, profile: pack })
      const result = engine.handle({ type: 'frame', generation: 1, role: 'official', frameIndex: 1, mediaTime: 10, wallTime: 1000,
        width, height, pixels: frame.data.slice().buffer, wantDebug: true }) as ResultMessage
      expect(result.hud).toEqual(editor)
      expect(result.outcome).toMatchObject({ status: 'success', reading: { text: '1:37', confidence: editor.fields.clock.reading.confidence } })
    } finally { core.free() }

    const glyphs = await prepareHudGlyphs(rgba, pack, variant.id)
    const actualRoi = hudRoiAtSize(variant.fields.clock!.roi, variant.nativeSize, frame)
    expect(glyphs.roiPixels).toEqual({ x: actualRoi.x, y: actualRoi.y, width: actualRoi.w, height: actualRoi.h })
    expect(glyphs.binary).toMatchObject({ width: 208, height: 72 })
    const prepared = await prepareHudCue(rgba, pack, 'timeoutRight', variant.id)
    expect(prepared.binary).toMatchObject({ width: 16, height: 16 })
    const saved = patchCue(pack, 'timeoutRight', {}, prepared, variant.id)
    expect(parseHudStylePack(saved).issues).toEqual([])
    expect(JSON.stringify(pack)).toBe(snapshot)
  })
})
