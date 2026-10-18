/**
 * The editor preview against the recogniser it claims to mirror.
 *
 * `framePipeline` exists so the editor can show each intermediate step, and it recomputes
 * them from the same primitives rather than reusing `recognizeFrame`'s debug output. That
 * only stays honest if the two agree: an ROI or threshold that looks right in the editor
 * but segments differently in the player would send the user off tuning a preset against
 * a preview nothing else sees. These tests hold the two paths against each other.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeFrame, drawGray, drawMask, sampleFromBox, TEMPLATE_SIZE } from './framePipeline'
import { unpackBitmap } from '../../core/bitmapCodec'
import { normalizeGlyph, cropBinary } from '../../core/imageOps'
import {
  TEMPLATE_HEIGHT,
  TEMPLATE_PIXELS,
  TEMPLATE_WIDTH,
  createEmptyProfile,
  validateProfile,
  type RecognitionProfile,
} from '../../core/profileSchema'
import { compileTemplates, recognizeFrame } from '../../core/templateMatch'
import { packBitmap } from '../../core/bitmapCodec'
import { CLOCK_GLYPHS, createFrame, drawText, renderGlyphMask } from '../../test/glyphFont'

const PREPROCESS = { scale: 1.6, threshold: 120, invert: false }

/** A clock drawn into a 640x360 frame, with an ROI padded around it. */
function clockFrame(text: string, scale = 6) {
  const frame = createFrame(640, 360)
  const box = drawText(frame, text, 280, 20, { scale, tracking: 1 })
  const pad = 6
  return {
    frame: { pixels: frame.data, width: frame.width, height: frame.height },
    raw: frame,
    roi: {
      x: (box.x - pad) / frame.width,
      y: (box.y - pad) / frame.height,
      w: (box.width + pad * 2) / frame.width,
      h: (box.height + pad * 2) / frame.height,
    },
  }
}

function buildProfile(roi: RecognitionProfile['roi'], scale = 6): RecognitionProfile {
  const templates: Record<string, Array<{ id: string; data: string; createdAt: number }>> = {}
  for (const char of CLOCK_GLYPHS) {
    templates[char] = [
      { id: `${char}-0`, data: packBitmap(normalizeGlyph(renderGlyphMask(char, scale))), createdAt: 1 },
    ]
  }
  const { profile, issues } = validateProfile({
    ...createEmptyProfile('cs2/test', '测试场景'),
    roi,
    preprocess: PREPROCESS,
    templates,
  })
  if (!profile) throw new Error(`invalid test profile: ${JSON.stringify(issues)}`)
  return profile
}

describe('analyzeFrame', () => {
  it('agrees with the recogniser on every step it previews', () => {
    const { frame, raw, roi } = clockFrame('1:30')
    const profile = buildProfile(roi)

    const preview = analyzeFrame(frame, roi, PREPROCESS)
    const { debug } = recognizeFrame(
      { data: raw.data, width: raw.width, height: raw.height },
      profile,
      compileTemplates(profile),
      { mediaTime: 0, wallTime: 0, frameIndex: 0 },
    )

    expect(debug).not.toBeNull()
    // Same crop, same threshold, same cuts, same ink. A drift in any one of these is a
    // preview that teaches the user something the player will not reproduce.
    expect(preview.roiPixels).toEqual(debug?.roiPixels)
    expect(preview.projection).toEqual(debug?.projection)
    expect(preview.boxes).toEqual(debug?.boxes)
    expect(preview.inkRatio).toBeCloseTo(debug?.inkRatio ?? -1, 12)
    expect(Array.from(preview.binary.data)).toEqual(Array.from(debug?.binary.data ?? []))
    expect(preview.binary.width).toBe(debug?.binary.width)
    expect(preview.binary.height).toBe(debug?.binary.height)
  })

  it('previews the grey crop at the ROI size, not the frame size', () => {
    const { frame, roi } = clockFrame('1:30')

    const { gray, roiPixels, binary } = analyzeFrame(frame, roi, PREPROCESS)

    // The editor draws grey and binary side by side, so they have to line up pixel for
    // pixel; a full-frame grey next to a cropped binary reads as a broken ROI.
    expect(gray.width).toBe(roiPixels.width)
    expect(gray.height).toBe(roiPixels.height)
    expect(binary.width).toBe(gray.width)
    expect(binary.height).toBe(gray.height)
    expect(gray.data.length).toBe(roiPixels.width * roiPixels.height)
  })

  it('finds one box per drawn character', () => {
    const { frame, roi } = clockFrame('1:30')

    const { boxes, inkRatio: ratio } = analyzeFrame(frame, roi, PREPROCESS)

    expect(boxes).toHaveLength(4)
    expect(ratio).toBeGreaterThan(0)
    expect(ratio).toBeLessThan(1)
  })

  it('reports an empty region as empty rather than throwing', () => {
    const frame = createFrame(320, 180)
    const roi = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }

    const analysis = analyzeFrame(
      { pixels: frame.data, width: frame.width, height: frame.height },
      roi,
      PREPROCESS,
    )

    // A user drags the ROI over blank scoreboard constantly. It has to come back clean.
    expect(analysis.boxes).toEqual([])
    expect(analysis.inkRatio).toBe(0)
    expect(analysis.projection.every((column) => column === 0)).toBe(true)
  })
})

describe('sampleFromBox', () => {
  it('stores a mask the server will accept and recognition can compile', () => {
    const { frame, roi } = clockFrame('1:30')
    const { binary, boxes } = analyzeFrame(frame, roi, PREPROCESS)
    const box = boxes[0]
    expect(box).toBeDefined()
    if (!box) return

    const sample = sampleFromBox(binary, box, '1', 'editor')

    // The schema fixes the template size, and it is the server's gate too: a sample of
    // any other size comes back as `invalid-profile`, which the user sees as a save that
    // failed for no visible reason. Validate the way the server does.
    const { profile: accepted, issues } = validateProfile({
      ...createEmptyProfile('cs2/test', '测试场景'),
      roi,
      preprocess: PREPROCESS,
      templates: { '1': [sample] },
    })
    expect(issues).toEqual([])
    expect(accepted).not.toBeNull()

    const mask = unpackBitmap(sample.data, TEMPLATE_PIXELS)
    expect(TEMPLATE_SIZE).toEqual({ width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT })
    expect(sample.origin).toBe('editor')
    expect(sample.createdAt).toBeGreaterThan(0)
    expect(mask.some((value) => value !== 0)).toBe(true)
  })

  it('normalises the same way the recogniser does before matching', () => {
    const { frame, roi } = clockFrame('1:30')
    const { binary, boxes } = analyzeFrame(frame, roi, PREPROCESS)
    const box = boxes[0]
    if (!box) throw new Error('expected a segmented box')

    const sample = sampleFromBox(binary, box, '1', 'editor')

    // Stored samples are compared against `normalizeGlyph` output at match time, so the
    // editor has to store that and not the raw crop.
    expect(Array.from(unpackBitmap(sample.data, TEMPLATE_PIXELS))).toEqual(
      Array.from(normalizeGlyph(cropBinary(binary, box))),
    )
  })

  it('gives two samples of one character distinct ids', () => {
    const { frame, roi } = clockFrame('1:30')
    const { binary, boxes } = analyzeFrame(frame, roi, PREPROCESS)
    const box = boxes[0]
    if (!box) throw new Error('expected a segmented box')

    const ids = new Set(
      Array.from({ length: 25 }, () => sampleFromBox(binary, box, '1', 'editor').id),
    )

    // Samples accumulate under one character key; a collision silently overwrites the
    // user's earlier capture.
    expect(ids.size).toBe(25)
    expect([...ids].every((id) => id.startsWith('1-'))).toBe(true)
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
