import { createHudPreprocess } from '../../core/hudPreprocess'
/** Rust owns the editor preview and the stored glyph preparation. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import init from '../../wasm/pkg/stream_syncer_wasm.js'
import { drawGray, drawMask, sampleFromPrepared, TEMPLATE_SIZE } from './framePipeline'
import { prepareHudGlyphs, recognizeHudFrame } from '../../core/hudWasm'
import { createEmptyHudStylePack, parseHudStylePack } from '../../core/hudStylePack'
import { unpackBitmap, packBitmap } from '../../core/bitmapCodec'
import { normalizeGlyph } from '../../core/imageOps'
import { TEMPLATE_HEIGHT, TEMPLATE_PIXELS, TEMPLATE_WIDTH, type ClockChar } from '../../core/profileSchema'
import { CLOCK_GLYPHS, createFrame, drawText, renderGlyphMask } from '../../test/glyphFont'

const PREPROCESS = createHudPreprocess({ scale: 1.6, threshold: 120, invert: false })
beforeAll(async () => {
  await init({ module_or_path: Uint8Array.from(readFileSync(resolve('src/wasm/pkg/stream_syncer_wasm_bg.wasm'))) })
})
function clockFrame(text: string, scale = 6) {
  const raw = createFrame(640, 360)
  const box = drawText(raw, text, 280, 20, { scale, tracking: 1 })
  const pack = createEmptyHudStylePack('cs2/test', '测试场景', { width: raw.width, height: raw.height })
  const clock = pack.variants[0]!.fields.clock!
  clock.roi = { x: box.x - 6, y: box.y - 6, w: box.width + 12, h: box.height + 12 }
  clock.preprocess = PREPROCESS
  for (const char of CLOCK_GLYPHS) {
    const id = char === ':' ? 'colon' : char
    pack.bitmaps[id] = { width: 32, height: 48, data: packBitmap(normalizeGlyph(renderGlyphMask(char, scale))) }
    clock.glyphs[char as ClockChar] = [id]
  }
  return { frame: { pixels: raw.data, width: raw.width, height: raw.height }, pack }
}

describe('Rust frame analysis', () => {
  it('agrees with the recogniser on every step it previews', async () => {
    const { frame, pack } = clockFrame('1:30')
    const preview = await prepareHudGlyphs(frame, pack)
    const { debug } = (await recognizeHudFrame(frame, pack)).fields.clock
    expect(debug).not.toBeNull()
    expect(preview.roiPixels).toEqual(debug?.roiPixels)
    expect(preview.gray).toEqual(debug?.gray)
    expect(preview.binary).toEqual(debug?.binary)
    expect(preview.boxes).toEqual(debug?.boxes)
    expect(preview.projection).toEqual(debug?.projection)
    expect(preview.inkRatio).toBeCloseTo(debug?.inkRatio ?? -1, 12)
  })
  it('previews the grey crop at the ROI size, not the frame size', async () => {
    const { frame, pack } = clockFrame('1:30')
    const { gray, roiPixels, binary } = await prepareHudGlyphs(frame, pack)
    expect(gray.width).toBe(roiPixels.width)
    expect(gray.height).toBe(roiPixels.height)
    expect(binary.width).toBe(gray.width)
    expect(binary.height).toBe(gray.height)
    expect(gray.data.length).toBe(roiPixels.width * roiPixels.height)
  })
  it('finds one box per drawn character', async () => {
    const { frame, pack } = clockFrame('1:30')
    const { boxes, bitmaps, inkRatio } = await prepareHudGlyphs(frame, pack)
    expect(boxes).toHaveLength(4)
    expect(bitmaps).toHaveLength(4)
    expect(inkRatio).toBeGreaterThan(0)
    expect(inkRatio).toBeLessThan(1)
  })
  it('reports an empty region as empty rather than throwing', async () => {
    const { frame, pack } = clockFrame('1:30')
    frame.pixels.fill(0)
    const analysis = await prepareHudGlyphs(frame, pack)
    expect(analysis.boxes).toEqual([])
    expect(analysis.inkRatio).toBe(0)
    expect(analysis.projection.every(column => column === 0)).toBe(true)
  })
})

describe('prepared glyph samples', () => {
  it('stores a Rust-prepared mask the server accepts', async () => {
    const { frame, pack } = clockFrame('1:30')
    const analysis = await prepareHudGlyphs(frame, pack)
    const sample = sampleFromPrepared(analysis.bitmaps[0]!, '1', 'editor')
    pack.bitmaps[sample.id] = { width: 32, height: 48, data: sample.data }
    pack.variants[0]!.fields.clock!.glyphs['1'] = [sample.id]
    expect(parseHudStylePack(pack).issues).toEqual([])
    expect(sample.origin).toBe('editor')
    expect(sample.createdAt).toBeGreaterThan(0)
    expect(unpackBitmap(sample.data, TEMPLATE_PIXELS).some(value => value !== 0)).toBe(true)
    expect(TEMPLATE_SIZE).toEqual({ width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT })
  })
  it('keeps Rust normalisation and honors manually adjusted boxes', async () => {
    const { frame, pack } = clockFrame('1:30')
    const automatic = await prepareHudGlyphs(frame, pack)
    const manual = await prepareHudGlyphs(frame, pack, undefined, [automatic.boxes[0]!])
    const sample = sampleFromPrepared(manual.bitmaps[0]!, '1', 'editor')
    expect(manual.boxes).toHaveLength(1)
    expect(sample.data).toBe(automatic.bitmaps[0])
    expect(unpackBitmap(sample.data, TEMPLATE_PIXELS)).toEqual(manual.normalized[0])
  })
  it('gives two samples of one character distinct ids', async () => {
    const { frame, pack } = clockFrame('1:30')
    const { bitmaps } = await prepareHudGlyphs(frame, pack)
    const ids = new Set(Array.from({ length: 25 }, () => sampleFromPrepared(bitmaps[0]!, '1', 'editor').id))
    expect(ids.size).toBe(25)
    expect([...ids].every(id => id.startsWith('1-'))).toBe(true)
  })
})

describe('canvas painters', () => {
  function canvasOf(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }

  /**
   * jsdom has no 2D context, so without this the painters return at the `!context` guard
   * and the pixel loops never run. Returns what was handed to `putImageData`.
   */
  function stubContext(): { painted: () => Uint8ClampedArray | null } {
    let painted: Uint8ClampedArray | null = null
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: (image: { data: Uint8ClampedArray }) => {
        painted = image.data
      },
    } as unknown as CanvasRenderingContext2D)
    return { painted: () => painted }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resizes the canvas to the image it is given', () => {
    const canvas = canvasOf(8, 8)

    drawMask(canvas, { data: new Uint8Array(6 * 4), width: 6, height: 4 })

    expect([canvas.width, canvas.height]).toEqual([6, 4])
  })

  it('paints ink light on dark and fills every alpha byte', () => {
    const context = stubContext()
    // Ink at 0 and 3, blank at 1 and 2.
    const mask = new Uint8Array([255, 0, 0, 255])

    drawMask(canvasOf(2, 2), { data: mask, width: 2, height: 2 })

    const painted = context.painted()
    expect(painted).not.toBeNull()
    // Ink light on near-black, not black on white: the editor panel is dark, and an
    // inverted thumbnail there reads as a broken preview rather than a captured glyph.
    expect(Array.from(painted?.slice(0, 4) ?? [])).toEqual([245, 245, 245, 255])
    expect(Array.from(painted?.slice(4, 8) ?? [])).toEqual([18, 18, 18, 255])
    expect(Array.from(painted?.slice(12, 16) ?? [])).toEqual([245, 245, 245, 255])
    // A missed alpha byte leaves the canvas transparent, which shows as nothing at all.
    for (let index = 3; index < (painted?.length ?? 0); index += 4) {
      expect(painted?.[index]).toBe(255)
    }
  })

  it('passes grey levels through instead of thresholding them', () => {
    const context = stubContext()

    drawGray(canvasOf(3, 1), { data: new Uint8Array([0, 130, 255]), width: 3, height: 1 })

    const painted = context.painted()
    // Thresholding here would make the grey panel a duplicate of the binary one, and the
    // pair exists precisely so the user can see what the threshold is doing.
    expect(Array.from(painted?.slice(0, 12) ?? [])).toEqual([
      0, 0, 0, 255, 130, 130, 130, 255, 255, 255, 255, 255,
    ])
  })

  it('survives a null canvas and an empty image', () => {
    // Both happen on a normal render: refs are null on the first pass, and the panels
    // paint before a frame has been grabbed.
    expect(() => drawMask(null, { data: new Uint8Array(0), width: 0, height: 0 })).not.toThrow()
    expect(() => drawGray(null, { data: new Uint8Array(0), width: 0, height: 0 })).not.toThrow()
    expect(() =>
      drawMask(canvasOf(4, 4), { data: new Uint8Array(0), width: 0, height: 4 }),
    ).not.toThrow()
    expect(() =>
      drawGray(canvasOf(4, 4), { data: new Uint8Array(0), width: 4, height: 0 }),
    ).not.toThrow()
  })

  it('leaves a zero-sized image on the canvas it found', () => {
    const canvas = canvasOf(8, 8)

    drawGray(canvas, { data: new Uint8Array(0), width: 0, height: 0 })

    // Setting width to 0 would blank a canvas that still has the previous preview on it.
    expect([canvas.width, canvas.height]).toEqual([8, 8])
  })
})
