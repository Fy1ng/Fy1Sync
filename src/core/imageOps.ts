/**
 * Frame preprocessing primitives. Pure functions over plain typed arrays so the
 * exact same code runs on the main thread (editor preview) and inside the
 * recognition worker (no DOM there).
 */

import { TEMPLATE_HEIGHT, TEMPLATE_PIXELS, TEMPLATE_WIDTH, type PreprocessSettings, type RoiRect } from './profileSchema'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface GrayImage {
  data: Uint8Array
  width: number
  height: number
}

export interface BinaryImage {
  /** 0 = background, 255 = ink. */
  data: Uint8Array
  width: number
  height: number
}

/**
 * The box a `object-fit: contain` video actually paints inside its element.
 * The editor needs this to translate mouse coordinates into ROI fractions:
 * without it, letterbox bars would shift every ROI.
 */
export function contentRect(
  videoWidth: number,
  videoHeight: number,
  elementWidth: number,
  elementHeight: number,
): Rect {
  if (videoWidth <= 0 || videoHeight <= 0 || elementWidth <= 0 || elementHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(0, elementWidth), height: Math.max(0, elementHeight) }
  }
  const scale = Math.min(elementWidth / videoWidth, elementHeight / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return { x: (elementWidth - width) / 2, y: (elementHeight - height) / 2, width, height }
}

/** Element-space point -> ROI fraction (clamped to the painted picture). */
export function pointToFraction(
  point: { x: number; y: number },
  content: Rect,
): { x: number; y: number } {
  if (content.width <= 0 || content.height <= 0) return { x: 0, y: 0 }
  return {
    x: clamp01((point.x - content.x) / content.width),
    y: clamp01((point.y - content.y) / content.height),
  }
}

/** ROI fraction rect -> integer pixel rect inside a frame of the given size. */
export function roiToPixels(roi: RoiRect, frameWidth: number, frameHeight: number): Rect {
  const x = Math.max(0, Math.min(frameWidth - 1, Math.round(roi.x * frameWidth)))
  const y = Math.max(0, Math.min(frameHeight - 1, Math.round(roi.y * frameHeight)))
  const width = Math.max(1, Math.min(frameWidth - x, Math.round(roi.w * frameWidth)))
  const height = Math.max(1, Math.min(frameHeight - y, Math.round(roi.h * frameHeight)))
  return { x, y, width, height }
}

export function normalizeRoi(roi: RoiRect): RoiRect {
  const x = clamp01(Math.min(roi.x, roi.x + roi.w))
  const y = clamp01(Math.min(roi.y, roi.y + roi.h))
  const w = clamp01(Math.abs(roi.w))
  const h = clamp01(Math.abs(roi.h))
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) }
}

/** BT.601 luma from packed RGBA. */
export function toGrayscale(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const pixels = width * height
  const data = new Uint8Array(pixels)
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4
    const r = rgba[offset] ?? 0
    const g = rgba[offset + 1] ?? 0
    const b = rgba[offset + 2] ?? 0
    data[index] = (r * 77 + g * 150 + b * 29) >> 8
  }
  return { data, width, height }
}

/**
 * Contrast-scale around mid grey, then threshold.
 *
 * Ink must end up as 255 either way, because segmentation and matching both count 255 as
 * the glyph. A bright clock on a dark scoreboard — the common case — is already that way
 * round, so it wants `invert: false`. `invert: true` is for the opposite polarity, a dark
 * clock on a light plate, where the pixels *below* the threshold are the ink.
 */
export function binarize(image: GrayImage, settings: PreprocessSettings): BinaryImage {
  const { scale, threshold, invert } = settings
  const data = new Uint8Array(image.data.length)
  for (let index = 0; index < image.data.length; index += 1) {
    const value = (image.data[index] ?? 0) - 128
    const boosted = Math.max(0, Math.min(255, Math.round(value * scale + 128)))
    const isInk = invert ? boosted <= threshold : boosted >= threshold
    data[index] = isInk ? 255 : 0
  }
  return { data, width: image.width, height: image.height }
}

export function inkRatio(image: BinaryImage): number {
  if (image.data.length === 0) return 0
  let ink = 0
  for (let index = 0; index < image.data.length; index += 1) {
    if (image.data[index] !== 0) ink += 1
  }
  return ink / image.data.length
}

/** Tight box around ink pixels, or `null` for a blank image. */
export function boundingBox(image: BinaryImage): Rect | null {
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < image.height; y += 1) {
    const row = y * image.width
    for (let x = 0; x < image.width; x += 1) {
      if ((image.data[row + x] ?? 0) !== 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

export function cropBinary(image: BinaryImage, rect: Rect): BinaryImage {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const width = Math.max(1, Math.min(image.width - x0, Math.floor(rect.width)))
  const height = Math.max(1, Math.min(image.height - y0, Math.floor(rect.height)))
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const source = (y0 + y) * image.width + x0
    data.set(image.data.subarray(source, source + width), y * width)
  }
  return { data, width, height }
}

/**
 * Fit a glyph into the canonical box, keeping per-pixel ink *coverage*.
 *
 * Aspect ratio is preserved (up to the box width) and the result centred, so a `1`
 * (narrow) and a `0` (wide) keep their distinguishing shape instead of both being
 * stretched to fill the box. Each output pixel is the fraction of its source area
 * that was inked, scaled to 0..255 — no threshold is applied here.
 *
 * Keeping the fraction is what makes matching survive a real decode. The tight
 * bounding box of the same glyph moves by a pixel between frames (chroma
 * subsampling and ringing shift the outermost column in and out), which changes
 * the target size by a row — a 42-row glyph lands in 46 rows at one width and 45
 * at the next. Thresholded, every boundary pixel flips 1 -> 0 and the ring of a
 * `0` loses a fifth of its overlap; as coverage it degrades 1.0 -> 0.6 instead.
 *
 * Each output pixel averages the source over a footprint of at least one source
 * pixel, with fractional weights at the edges. The minimum width matters: a clock
 * glyph is smaller than the 32x48 box, so this is an *upscale*, and a footprint
 * narrower than one pixel would sit entirely inside a single source pixel and
 * reduce to nearest-neighbour — which is what made the score jump by 0.19 for a
 * one-row difference. Clamped to one pixel and centred on the footprint, it
 * straddles two source pixels instead, so a sub-pixel shift of the sampling grid
 * moves the weights a little rather than flipping the pixel.
 *
 * The scale comes from the height alone, and the width follows it. Fitting the
 * box by `min(w, h)` lets whichever axis saturates pick the scale, and for a
 * clock digit that is the width — the noisy axis, since 4:2:0 chroma and encoder
 * ringing move the outermost column in and out between frames while the height
 * stays put. A one-pixel wider box then resampled a 42-row glyph into 45 rows
 * instead of 46 and cost 0.19 of score. Driving everything from the stable axis
 * keeps the vertical grid identical across frames; a glyph too wide to fit is
 * squeezed horizontally, which is a far smaller error than regridding both axes.
 */
export function normalizeGlyphCoverage(glyph: BinaryImage): Uint8Array {
  const out = new Uint8Array(TEMPLATE_PIXELS)
  const box = boundingBox(glyph)
  if (!box) return out
  const tight = cropBinary(glyph, box)

  const scale = TEMPLATE_HEIGHT / tight.height
  const targetWidth = Math.max(1, Math.min(TEMPLATE_WIDTH, Math.round(tight.width * scale)))
  const targetHeight = TEMPLATE_HEIGHT
  const offsetX = Math.floor((TEMPLATE_WIDTH - targetWidth) / 2)
  const offsetY = 0

  const stepX = tight.width / targetWidth
  const stepY = tight.height / targetHeight
  const spanX = Math.max(1, stepX)
  const spanY = Math.max(1, stepY)

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const centerY = (ty + 0.5) * stepY
    const y0 = Math.max(0, centerY - spanY / 2)
    const y1 = Math.min(tight.height, centerY + spanY / 2)
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const centerX = (tx + 0.5) * stepX
      const x0 = Math.max(0, centerX - spanX / 2)
      const x1 = Math.min(tight.width, centerX + spanX / 2)

      let ink = 0
      let total = 0
      for (let sy = Math.floor(y0); sy < y1; sy += 1) {
        const weightY = Math.min(sy + 1, y1) - Math.max(sy, y0)
        if (weightY <= 0) continue
        const row = sy * tight.width
        for (let sx = Math.floor(x0); sx < x1; sx += 1) {
          const weight = weightY * (Math.min(sx + 1, x1) - Math.max(sx, x0))
          if (weight <= 0) continue
          total += weight
          if ((tight.data[row + sx] ?? 0) !== 0) ink += weight
        }
      }
      if (total > 0) {
        out[(offsetY + ty) * TEMPLATE_WIDTH + (offsetX + tx)] = Math.round((ink / total) * 255)
      }
    }
  }
  return out
}

/**
 * The same normalisation, thresholded at 50% coverage — the storable form.
 *
 * Templates persist as one bit per pixel, so what gets taught has to be binary.
 * Deriving it from the coverage mask keeps a single implementation of the
 * geometry: a preview built from a second copy could disagree with what
 * recognition sees.
 */
export function normalizeGlyph(glyph: BinaryImage): Uint8Array {
  return thresholdCoverage(normalizeGlyphCoverage(glyph))
}

/** Round a coverage mask to 0/255 at the halfway point. */
export function thresholdCoverage(coverage: Uint8Array): Uint8Array {
  const out = new Uint8Array(coverage.length)
  for (let index = 0; index < coverage.length; index += 1) {
    out[index] = (coverage[index] ?? 0) >= 128 ? 255 : 0
  }
  return out
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}
