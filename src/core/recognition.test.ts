import { describe, expect, it } from 'vitest'
import { packBitmap } from './bitmapCodec'
import {
  binarize,
  boundingBox,
  contentRect,
  cropBinary,
  inkRatio,
  normalizeGlyph,
  normalizeGlyphCoverage,
  normalizeRoi,
  pointToFraction,
  roiToPixels,
  toGrayscale,
} from './imageOps'
import { TEMPLATE_HEIGHT, TEMPLATE_PIXELS, TEMPLATE_WIDTH, createEmptyProfile, validateProfile, type RecognitionProfile } from './profileSchema'
import { adjustGlyphBox, columnProjection, excludeGlyphBox, mergeGlyphBoxes, segmentGlyphs, splitGlyphBox } from './segmentation'
import { compileTemplates, matchGlyph, recognizeFrame, scoreCoverage, scoreMasks } from './templateMatch'
import { CLOCK_GLYPHS, createFrame, drawText, renderGlyphMask, type RgbaFrame } from '../test/glyphFont'

const PREPROCESS = { scale: 1.6, threshold: 120, invert: false }

function buildProfile(scale: number, roi: RecognitionProfile['roi']): RecognitionProfile {
  const templates: Record<string, Array<{ id: string; data: string; createdAt: number }>> = {}
  for (const char of CLOCK_GLYPHS) {
    const glyph = renderGlyphMask(char, scale)
    templates[char] = [
      { id: `${char}-0`, data: packBitmap(normalizeGlyph(glyph)), createdAt: 1 },
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

/** Draw a clock into a 640x360 frame and return the frame plus its ROI. */
function clockFrame(text: string, scale = 6): { frame: RgbaFrame; roi: RecognitionProfile['roi'] } {
  const frame = createFrame(640, 360)
  const box = drawText(frame, text, 280, 20, { scale, tracking: 1 })
  const pad = 6
  return {
    frame,
    roi: {
      x: (box.x - pad) / frame.width,
      y: (box.y - pad) / frame.height,
      w: (box.width + pad * 2) / frame.width,
      h: (box.height + pad * 2) / frame.height,
    },
  }
}

describe('contentRect', () => {
  it('letterboxes a 16:9 video in a 4:3 element', () => {
    expect(contentRect(1920, 1080, 800, 800)).toEqual({ x: 0, y: 175, width: 800, height: 450 })
  })

  it('pillarboxes a 4:3 video in a wide element', () => {
    const rect = contentRect(640, 480, 1000, 500)
    expect(rect.width).toBeCloseTo(2000 / 3, 6)
    expect(rect.height).toBeCloseTo(500, 6)
    expect(rect.x).toBeCloseTo((1000 - 2000 / 3) / 2, 6)
    expect(rect.y).toBeCloseTo(0, 6)
  })

  it('degrades gracefully before metadata arrives', () => {
    expect(contentRect(0, 0, 300, 200)).toEqual({ x: 0, y: 0, width: 300, height: 200 })
  })
})

describe('pointToFraction', () => {
  const content = { x: 100, y: 50, width: 400, height: 200 }

  it('maps a point inside the picture', () => {
    expect(pointToFraction({ x: 300, y: 150 }, content)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('clamps points in the letterbox bars', () => {
    expect(pointToFraction({ x: 0, y: 0 }, content)).toEqual({ x: 0, y: 0 })
    expect(pointToFraction({ x: 9999, y: 9999 }, content)).toEqual({ x: 1, y: 1 })
  })
})

describe('roiToPixels / normalizeRoi', () => {
  it('converts fractions to integer pixels', () => {
    expect(roiToPixels({ x: 0.5, y: 0.25, w: 0.1, h: 0.2 }, 1920, 1080)).toEqual({
      x: 960,
      y: 270,
      width: 192,
      height: 216,
    })
  })

  it('never leaves the frame', () => {
    const rect = roiToPixels({ x: 0.99, y: 0.99, w: 0.5, h: 0.5 }, 100, 100)
    expect(rect.x + rect.width).toBeLessThanOrEqual(100)
    expect(rect.y + rect.height).toBeLessThanOrEqual(100)
  })

  it('normalises a drag made right-to-left', () => {
    const roi = normalizeRoi({ x: 0.6, y: 0.5, w: -0.2, h: -0.1 })
    expect(roi.x).toBeCloseTo(0.4, 6)
    expect(roi.y).toBeCloseTo(0.4, 6)
    expect(roi.w).toBeCloseTo(0.2, 6)
    expect(roi.h).toBeCloseTo(0.1, 6)
  })
})

describe('binarize', () => {
  it('separates bright ink from a dark background', () => {
    const frame = createFrame(20, 10)
    drawText(frame, '1', 2, 1, { scale: 1, tracking: 1 })
    const binary = binarize(toGrayscale(frame.data, frame.width, frame.height), PREPROCESS)
    expect(inkRatio(binary)).toBeGreaterThan(0)
    expect(inkRatio(binary)).toBeLessThan(0.5)
  })

  it('inverts for dark ink on a bright background', () => {
    const frame = createFrame(20, 10, [240, 240, 240])
    drawText(frame, '1', 2, 1, { scale: 1, tracking: 1, ink: [10, 10, 10] })
    const gray = toGrayscale(frame.data, frame.width, frame.height)
    const straight = binarize(gray, { scale: 1, threshold: 120, invert: false })
    const inverted = binarize(gray, { scale: 1, threshold: 120, invert: true })
    expect(inkRatio(straight)).toBeGreaterThan(0.5)
    expect(inkRatio(inverted)).toBeLessThan(0.5)
  })
})

describe('normalizeGlyph', () => {
  it('produces a canonical 32x48 mask', () => {
    const mask = normalizeGlyph({ ...renderGlyphMask('7', 3) })
    expect(mask).toHaveLength(TEMPLATE_PIXELS)
    const box = boundingBox({ data: mask, width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT })
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThanOrEqual(TEMPLATE_WIDTH)
    expect(box!.height).toBeLessThanOrEqual(TEMPLATE_HEIGHT)
  })

  it('is scale invariant', () => {
    const small = normalizeGlyph(renderGlyphMask('3', 2))
    const large = normalizeGlyph(renderGlyphMask('3', 11))
    expect(scoreMasks(small, large)).toBeGreaterThan(0.8)
  })

  it('keeps a narrow glyph narrow instead of stretching it', () => {
    const one = normalizeGlyph(renderGlyphMask('1', 6))
    const zero = normalizeGlyph(renderGlyphMask('0', 6))
    expect(scoreMasks(one, zero)).toBeLessThan(0.6)
  })

  it('returns an empty mask for a blank input', () => {
    const mask = normalizeGlyph({ data: new Uint8Array(100), width: 10, height: 10 })
    expect(mask.every((value) => value === 0)).toBe(true)
  })

  /**
   * A real decode moves the tight bounding box by a pixel between frames — 4:2:0 chroma
   * and encoder ringing push the outermost column in and out while the height holds
   * steady. This pads one column onto a glyph to imitate that, and asks that the score
   * stay usable. It used to drop to 0.81 against a 0.82 threshold: the width picked the
   * scale, so one extra column resampled a 42-row glyph into 45 rows instead of 46 and
   * every boundary pixel flipped.
   */
  it('survives a one-pixel wider bounding box', () => {
    const glyph = renderGlyphMask('0', 6)
    const padded = { data: new Uint8Array((glyph.width + 1) * glyph.height), width: glyph.width + 1, height: glyph.height }
    for (let y = 0; y < glyph.height; y += 1) {
      for (let x = 0; x < glyph.width; x += 1) {
        padded.data[y * padded.width + x] = glyph.data[y * glyph.width + x] ?? 0
      }
    }
    // Ink in the new column, so it lands inside the bounding box rather than being trimmed.
    padded.data[Math.floor(glyph.height / 2) * padded.width + glyph.width] = 255

    const template = normalizeGlyph(glyph)
    expect(scoreCoverage(normalizeGlyphCoverage(padded), template)).toBeGreaterThan(0.82)
  })

  it('scores a coverage mask the same as a binary one when it has no partial pixels', () => {
    const glyph = renderGlyphMask('5', 6)
    const binary = normalizeGlyph(glyph)
    // sum(min)/sum(max) collapses to intersection-over-union for two binary masks.
    expect(scoreCoverage(binary, binary)).toBeCloseTo(scoreMasks(binary, binary), 10)
  })
})

describe('segmentGlyphs', () => {
  it('splits m:ss into four boxes', () => {
    const { frame, roi } = clockFrame('1:37')
    const rect = roiToPixels(roi, frame.width, frame.height)
    const gray = toGrayscale(frame.data, frame.width, frame.height)
    const binary = binarize(cropBinary({ ...gray }, rect), PREPROCESS)
    const result = segmentGlyphs(binary)
    expect(result.boxes).toHaveLength(4)
    expect(result.projection).toHaveLength(binary.width)
    // Boxes come out left to right and never overlap.
    for (let index = 1; index < result.boxes.length; index += 1) {
      const previous = result.boxes[index - 1]!
      const current = result.boxes[index]!
      expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width)
    }
  })

  it('reports no boxes for an empty region', () => {
    const blank = { data: new Uint8Array(400), width: 20, height: 20 }
    expect(segmentGlyphs(blank).boxes).toEqual([])
  })

  it('projects ink per column', () => {
    const image = { data: new Uint8Array([255, 0, 255, 255, 0, 0]), width: 3, height: 2 }
    expect(columnProjection(image)).toEqual([2, 0, 1])
  })
})

describe('glyph box editing', () => {
  const boxes = [
    { x: 0, y: 0, width: 10, height: 20, ink: 40 },
    { x: 12, y: 0, width: 4, height: 20, ink: 8 },
    { x: 20, y: 0, width: 10, height: 20, ink: 42 },
  ]

  it('merges a range into one box', () => {
    const merged = mergeGlyphBoxes(boxes, 0, 1)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ x: 0, width: 16, ink: 48 })
  })

  it('splits a box at an x coordinate', () => {
    const split = splitGlyphBox(boxes, 0, 4)
    expect(split).toHaveLength(4)
    expect(split[0]).toMatchObject({ x: 0, width: 4 })
    expect(split[1]).toMatchObject({ x: 4, width: 6 })
    expect((split[0]!.ink + split[1]!.ink)).toBe(40)
  })

  it('ignores a split outside the box', () => {
    expect(splitGlyphBox(boxes, 0, 40)).toHaveLength(3)
  })

  it('excludes a box', () => {
    expect(excludeGlyphBox(boxes, 1).map((box) => box.x)).toEqual([0, 20])
  })

  it('adjusts edges without collapsing or leaving bounds', () => {
    const bounds = { width: 30, height: 20 }
    expect(adjustGlyphBox(boxes, 0, 'left', 3, bounds)[0]).toMatchObject({ x: 3, width: 7 })
    expect(adjustGlyphBox(boxes, 0, 'right', 5, bounds)[0]).toMatchObject({ x: 0, width: 15 })
    expect(adjustGlyphBox(boxes, 0, 'right', 999, bounds)[0]).toMatchObject({ width: 30 })
    expect(adjustGlyphBox(boxes, 0, 'left', 999, bounds)[0]).toMatchObject({ x: 9, width: 1 })
    expect(adjustGlyphBox(boxes, 0, 'top', -999, bounds)[0]).toMatchObject({ y: 0, height: 20 })
  })
})

describe('matchGlyph', () => {
  it('picks the right character with a clear margin', () => {
    const profile = buildProfile(6, { x: 0, y: 0, w: 1, h: 1 })
    const templates = compileTemplates(profile)
    for (const char of CLOCK_GLYPHS) {
      const mask = normalizeGlyph(renderGlyphMask(char, 6))
      const match = matchGlyph(mask, templates)
      expect(match.char, `char ${char}`).toBe(char)
      expect(match.score).toBeCloseTo(1, 5)
      expect(match.score - match.runnerUpScore).toBeGreaterThan(0.05)
    }
  })

  it('returns no character when there are no templates', () => {
    const empty = compileTemplates(createEmptyProfile())
    expect(matchGlyph(normalizeGlyph(renderGlyphMask('4', 6)), empty).char).toBeNull()
  })

  it('skips corrupt samples instead of failing the profile', () => {
    const profile = buildProfile(6, { x: 0, y: 0, w: 1, h: 1 })
    const broken: RecognitionProfile = {
      ...profile,
      templates: {
        ...profile.templates,
        '4': [
          { id: 'bad', data: '!!!!not base64!!!!', createdAt: 0 },
          ...(profile.templates['4'] ?? []),
        ],
      },
    }
    const templates = compileTemplates(broken)
    expect(templates.masks.get('4')).toHaveLength(1)
    expect(matchGlyph(normalizeGlyph(renderGlyphMask('4', 6)), templates).char).toBe('4')
  })
})

describe('recognizeFrame', () => {
  const meta = { mediaTime: 12.5, wallTime: 1000, frameIndex: 7 }

  it('reads a clock end to end', () => {
    const { frame, roi } = clockFrame('1:37')
    const profile = buildProfile(6, roi)
    const result = recognizeFrame(frame, profile, compileTemplates(profile), meta)
    expect(result.outcome.status).toBe('success')
    if (result.outcome.status !== 'success') return
    expect(result.outcome.reading.text).toBe('1:37')
    expect(result.outcome.reading.seconds).toBe(97)
    expect(result.outcome.reading.confidence).toBeGreaterThan(0.9)
    expect(result.outcome.reading.scores).toHaveLength(4)
    expect(result.outcome.reading.mediaTime).toBe(12.5)
    expect(result.outcome.reading.frameIndex).toBe(7)
  })

  it('reads a clock rendered at a different size than the templates', () => {
    const { frame, roi } = clockFrame('0:45', 9)
    const profile = { ...buildProfile(4, roi), matchThreshold: 0.7 }
    const result = recognizeFrame(frame, profile, compileTemplates(profile), meta)
    expect(result.outcome.status).toBe('success')
    if (result.outcome.status !== 'success') return
    expect(result.outcome.reading.text).toBe('0:45')
    expect(result.outcome.reading.seconds).toBe(45)
  })

  it('fails with insufficient-templates before touching pixels', () => {
    const { frame, roi } = clockFrame('1:00')
    const profile = { ...createEmptyProfile(), roi }
    const result = recognizeFrame(frame, profile, compileTemplates(profile), meta)
    expect(result.outcome).toMatchObject({ status: 'failed', reason: 'insufficient-templates' })
    expect(result.debug).toBeNull()
  })

  it('reports blank-frame when the ROI has no clock', () => {
    const { roi } = clockFrame('1:00')
    const profile = buildProfile(6, roi)
    const blank = createFrame(640, 360)
    const result = recognizeFrame(blank, profile, compileTemplates(profile), meta)
    expect(result.outcome).toMatchObject({ status: 'failed', reason: 'blank-frame' })
    expect(result.debug?.inkRatio).toBe(0)
  })

  it('reports blank-frame when the ROI is flooded with ink', () => {
    const { roi } = clockFrame('1:00')
    const profile = buildProfile(6, roi)
    const flooded = createFrame(640, 360, [255, 255, 255])
    const result = recognizeFrame(flooded, profile, compileTemplates(profile), meta)
    expect(result.outcome).toMatchObject({ status: 'failed', reason: 'blank-frame' })
  })

  it('reports invalid-format when the ROI holds something that is not a clock', () => {
    const frame = createFrame(640, 360)
    const box = drawText(frame, '789', 280, 20, { scale: 6, tracking: 1 })
    const roi = {
      x: (box.x - 6) / frame.width,
      y: (box.y - 6) / frame.height,
      w: (box.width + 12) / frame.width,
      h: (box.height + 12) / frame.height,
    }
    const profile = buildProfile(6, roi)
    const result = recognizeFrame(frame, profile, compileTemplates(profile), meta)
    expect(result.outcome).toMatchObject({ status: 'failed', reason: 'invalid-format' })
  })

  it('reports low-confidence when no template really fits a glyph', () => {
    // Templates built at a wildly different aspect than the rendered clock:
    // every glyph still finds a "best" match, but none of them fits.
    const { frame, roi } = clockFrame('1:37')
    const profile = buildProfile(6, roi)
    const templates = compileTemplates(profile)
    // Overwrite every template with noise so nothing can score above threshold.
    for (const char of templates.chars) {
      const noise = new Uint8Array(TEMPLATE_PIXELS)
      for (let index = 0; index < noise.length; index += 1) {
        noise[index] = (index * 7 + char.charCodeAt(0)) % 5 === 0 ? 255 : 0
      }
      templates.masks.set(char, [noise])
    }
    const result = recognizeFrame(frame, profile, templates, meta)
    expect(result.outcome).toMatchObject({ status: 'failed', reason: 'low-confidence' })
  })

  it('honours matchThreshold: the same frame passes at 0.7 and fails at 0.99', () => {
    // Templates at scale 4 vs a clock rendered at scale 9: a good but imperfect
    // match, which is exactly what the threshold is there to gate.
    const { frame, roi } = clockFrame('0:45', 9)
    const base = buildProfile(4, roi)
    const templates = compileTemplates(base)
    expect(recognizeFrame(frame, { ...base, matchThreshold: 0.7 }, templates, meta).outcome.status).toBe(
      'success',
    )
    expect(
      recognizeFrame(frame, { ...base, matchThreshold: 0.99 }, templates, meta).outcome,
    ).toMatchObject({ status: 'failed', reason: 'low-confidence' })
  })

  it('exposes debug data for the editor', () => {
    const { frame, roi } = clockFrame('2:15')
    const profile = buildProfile(6, roi)
    const result = recognizeFrame(frame, profile, compileTemplates(profile), meta)
    expect(result.debug?.boxes).toHaveLength(4)
    expect(result.debug?.matches.map((match) => match.char)).toEqual(['2', ':', '1', '5'])
    expect(result.debug?.normalized[0]).toHaveLength(TEMPLATE_PIXELS)
    expect(result.debug?.projection.length).toBeGreaterThan(0)
  })
})
