import { describe, expect, it } from 'vitest'
import { createEmptyHudStylePack, parseHudStylePack } from '../core/hudStylePack'
import { createHudPreprocess } from '../core/hudPreprocess'
import { prepareHudCue, prepareHudGlyphs, recognizeHudFrame, recommendHudPreprocess } from '../core/hudWasm'
import { createFrame, drawText } from '../test/glyphFont'
import { WasmRecognitionEngine } from '../wasm/test-helpers'

describe('HUD production preprocessing through WASM', () => {
  it('extracts a dark red icon from equally dark blue and preserves its settings in a strict round trip', async () => {
    const engine = new WasmRecognitionEngine()
    try {
      // Both colors have luma 18 under the production integer RGB coefficients.
      const frame = createFrame(80, 50, [0, 0, 160])
      const set = (x: number, y: number) => frame.data.set([60, 0, 0, 255], (y * frame.width + x) * 4)
      for (let y = 16; y < 30; y++) for (let x = 25; x < 40; x++) if (x < 31 || y < 21) set(x, y)
      const pack = createEmptyHudStylePack('test/red-icon', '图标', { width: frame.width, height: frame.height })
      const variant = pack.variants[0]!
      variant.cues.bomb = { enabled: true, roi: { x: 20, y: 10, w: 30, h: 30 }, preprocess: createHudPreprocess({ scale: 1 }), templates: [], minScore: 0.95 }
      const input = { pixels: frame.data, width: frame.width, height: frame.height }
      const gray = await prepareHudCue(input, pack, 'bomb')
      expect(new Set(gray.gray.data).size).toBe(1)
      expect(gray.binary.data.every(pixel => pixel === 0)).toBe(true)
      const recommendation = await recommendHudPreprocess(input, pack, variant.id, 'bomb', { kind: 'hsv', x: 27, y: 18 })
      expect(recommendation.reason).toBeNull()
      variant.cues.bomb.preprocess = recommendation.settings!
      expect(variant.cues.bomb.preprocess.mode).toBe('hsv')
      const prepared = await prepareHudCue(input, pack, 'bomb')
      expect(prepared.binary.data.some(pixel => pixel === 255)).toBe(true)
      expect(prepared.binary.data.some(pixel => pixel === 0)).toBe(true)
      pack.bitmaps.red = { width: 30, height: 30, data: prepared.bitmap }
      variant.cues.bomb.templates = ['red']
      const imported = parseHudStylePack(JSON.parse(JSON.stringify(pack))).pack!
      expect(imported).toBeDefined()
      const recognized = await recognizeHudFrame(input, imported, variant.id)
      expect(recognized.cues.bomb?.status).toBe('matched')
      expect(recognized.cues.bomb?.debug?.binary).toEqual(prepared.binary)
      const blank = createFrame(80, 50, [0, 0, 160])
      const absent = await recognizeHudFrame({ pixels: blank.data, width: 80, height: 50 }, imported, variant.id)
      expect(absent.cues.bomb?.status).toBe('not-matched')
      await expect(recommendHudPreprocess(input, pack, variant.id, 'bomb', { kind: 'hsv', x: 0, y: 0 })).rejects.toBeDefined()
    } finally { engine.free() }
  })

  it.each(['adaptive', 'hsv'] as const)('uses the same %s mask for score preparation and player recognition', async mode => {
    const engine = new WasmRecognitionEngine()
    try {
      const frame = createFrame(240, 110, mode === 'hsv' ? [0, 0, 160] : [20, 20, 20])
      drawText(frame, '18', 70, 35, { scale: 6, ink: mode === 'hsv' ? [60, 0, 0] : [240, 240, 240] })
      const pack = createEmptyHudStylePack('test/preprocess-score', '比分', { width: 240, height: 110 })
      const variant = pack.variants[0]!
      const preprocess = createHudPreprocess({ mode, scale: 1 })
      preprocess.adaptive = { windowSize: 51, offset: 5 }
      preprocess.hsv = { hue: 359, tolerance: 15, saturationMin: 0.8, saturationMax: 1, valueMin: 0.1, valueMax: 0.5 }
      variant.fields.scoreLeft = { ...structuredClone(variant.fields.clock!), roi: { x: 60, y: 25, w: 80, h: 62 },
        preprocess, grammar: { kind: 'integer', min: 0, max: 99 } }
      const input = { pixels: frame.data, width: frame.width, height: frame.height }
      const prepared = await prepareHudGlyphs(input, pack, variant.id, undefined, 'scoreLeft')
      expect(prepared.boxes).toHaveLength(2)
      for (const [index, char] of (['1', '8'] as const).entries()) {
        pack.bitmaps[`score-${char}`] = { width: 32, height: 48, data: prepared.bitmaps[index]! }
        variant.fields.scoreLeft.glyphs[char] = [`score-${char}`]
      }
      const result = await recognizeHudFrame(input, pack)
      expect(result.fields.scoreLeft).toMatchObject({ status: 'read', reading: { text: '18' } })
      expect(result.fields.scoreLeft.debug?.binary).toEqual(prepared.binary)
      expect(result.fields.scoreLeft.debug?.boxes).toEqual(prepared.boxes)
    } finally { engine.free() }
  })

  it('recommends dark-on-light polarity once and refuses an uninformative frame', async () => {
    const engine = new WasmRecognitionEngine()
    try {
      const frame = createFrame(180, 90, [220, 220, 220])
      drawText(frame, '8', 70, 24, { scale: 5, ink: [24, 24, 24] })
      const pack = createEmptyHudStylePack('test/polarity', '反相', { width: 180, height: 90 })
      pack.variants[0]!.fields.clock!.roi = { x: 45, y: 10, w: 80, h: 62 }
      const source = { pixels: frame.data, width: 180, height: 90 }
      const result = await recommendHudPreprocess(source, pack, pack.variants[0]!.id, 'clock', { kind: 'threshold' })
      expect(result.settings?.invert).toBe(true)
      expect(pack.variants[0]!.fields.clock!.preprocess.invert).toBe(false)
      const blank = createFrame(180, 90, [80, 80, 80])
      expect(await recommendHudPreprocess({ pixels: blank.data, width: 180, height: 90 }, pack, pack.variants[0]!.id,
        'clock', { kind: 'threshold' })).toEqual({ settings: null, reason: 'low-contrast' })
    } finally { engine.free() }
  })
})
