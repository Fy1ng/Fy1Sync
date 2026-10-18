/**
 * Character segmentation by vertical projection.
 *
 * A clock ROI is a single line of glyphs on a flat background, so column ink
 * counts are enough: runs of inked columns are glyphs, gaps between them are
 * separators. The projection profile is returned as well because the profile
 * editor draws it in the debug panel — when segmentation goes wrong, seeing the
 * histogram is what tells you whether to move the ROI or change the threshold.
 */

import { boundingBox, cropBinary, type BinaryImage, type Rect } from './imageOps'

export interface SegmentOptions {
  /** Columns with fewer ink pixels than this count as empty. */
  minColumnInk?: number
  /** Minimum inked columns for a run to be a glyph. */
  minGlyphWidth?: number
  /** Runs separated by fewer empty columns than this are joined. */
  minGapWidth?: number
  /** Drop runs whose ink is below this fraction of the tallest run's ink. */
  minInkRatio?: number
}

export interface GlyphBox extends Rect {
  /** Ink pixels inside the box. */
  ink: number
}

export interface SegmentResult {
  boxes: GlyphBox[]
  /** Ink count per column of the input image. */
  projection: number[]
  /** Threshold actually used, after adapting to image height. */
  columnThreshold: number
}

const DEFAULTS: Required<SegmentOptions> = {
  minColumnInk: 1,
  minGlyphWidth: 2,
  minGapWidth: 1,
  minInkRatio: 0.08,
}

export function columnProjection(image: BinaryImage): number[] {
  const projection = new Array<number>(image.width).fill(0)
  for (let y = 0; y < image.height; y += 1) {
    const row = y * image.width
    for (let x = 0; x < image.width; x += 1) {
      if ((image.data[row + x] ?? 0) !== 0) projection[x] = (projection[x] ?? 0) + 1
    }
  }
  return projection
}

export function segmentGlyphs(image: BinaryImage, options: SegmentOptions = {}): SegmentResult {
  const config = { ...DEFAULTS, ...options }
  const projection = columnProjection(image)
  const columnThreshold = Math.max(1, config.minColumnInk)

  const runs: Array<{ start: number; end: number }> = []
  let start = -1
  let gap = 0
  for (let x = 0; x < projection.length; x += 1) {
    const inked = (projection[x] ?? 0) >= columnThreshold
    if (inked) {
      if (start < 0) {
        start = x
      } else if (gap > 0 && gap >= config.minGapWidth) {
        runs.push({ start, end: x - gap - 1 })
        start = x
      }
      gap = 0
    } else if (start >= 0) {
      gap += 1
    }
  }
  if (start >= 0) {
    const end = projection.length - 1 - (gap >= config.minGapWidth ? gap : 0)
    if (end >= start) runs.push({ start, end })
  }

  const candidates: GlyphBox[] = []
  for (const run of runs) {
    const width = run.end - run.start + 1
    if (width < config.minGlyphWidth) continue
    const slice = cropBinary(image, { x: run.start, y: 0, width, height: image.height })
    const box = boundingBox(slice)
    if (!box) continue
    let ink = 0
    for (let index = 0; index < slice.data.length; index += 1) {
      if (slice.data[index] !== 0) ink += 1
    }
    candidates.push({ x: run.start + box.x, y: box.y, width: box.width, height: box.height, ink })
  }

  const maxInk = candidates.reduce((max, box) => Math.max(max, box.ink), 0)
  const boxes = candidates.filter((box) => maxInk === 0 || box.ink >= maxInk * config.minInkRatio)

  return { boxes, projection, columnThreshold }
}

/** Merge a contiguous index range into one box (e.g. a colon split in two). */
export function mergeGlyphBoxes(boxes: GlyphBox[], from: number, to: number): GlyphBox[] {
  const low = Math.max(0, Math.min(from, to))
  const high = Math.min(boxes.length - 1, Math.max(from, to))
  if (high <= low) return [...boxes]
  const slice = boxes.slice(low, high + 1)
  const merged = slice.slice(1).reduce<GlyphBox>(
    (acc, box) => {
      const x = Math.min(acc.x, box.x)
      const y = Math.min(acc.y, box.y)
      const right = Math.max(acc.x + acc.width, box.x + box.width)
      const bottom = Math.max(acc.y + acc.height, box.y + box.height)
      return { x, y, width: right - x, height: bottom - y, ink: acc.ink + box.ink }
    },
    { ...(slice[0] as GlyphBox) },
  )
  return [...boxes.slice(0, low), merged, ...boxes.slice(high + 1)]
}

/** Split one box at an absolute x coordinate. */
export function splitGlyphBox(boxes: GlyphBox[], index: number, atX: number): GlyphBox[] {
  const box = boxes[index]
  if (!box) return [...boxes]
  const cut = Math.round(atX)
  if (cut <= box.x || cut >= box.x + box.width) return [...boxes]
  const leftWidth = cut - box.x
  const rightWidth = box.width - leftWidth
  const leftShare = leftWidth / box.width
  const left: GlyphBox = { ...box, width: leftWidth, ink: Math.round(box.ink * leftShare) }
  const right: GlyphBox = {
    ...box,
    x: cut,
    width: rightWidth,
    ink: box.ink - left.ink,
  }
  return [...boxes.slice(0, index), left, right, ...boxes.slice(index + 1)]
}

export function excludeGlyphBox(boxes: GlyphBox[], index: number): GlyphBox[] {
  if (index < 0 || index >= boxes.length) return [...boxes]
  return [...boxes.slice(0, index), ...boxes.slice(index + 1)]
}

/** Nudge one edge of a box, keeping it inside the image and at least 1px wide. */
export function adjustGlyphBox(
  boxes: GlyphBox[],
  index: number,
  edge: 'left' | 'right' | 'top' | 'bottom',
  delta: number,
  bounds: { width: number; height: number },
): GlyphBox[] {
  const box = boxes[index]
  if (!box) return [...boxes]
  const next = { ...box }
  if (edge === 'left') {
    const x = Math.max(0, Math.min(box.x + box.width - 1, box.x + delta))
    next.width = box.x + box.width - x
    next.x = x
  } else if (edge === 'right') {
    const right = Math.max(box.x + 1, Math.min(bounds.width, box.x + box.width + delta))
    next.width = right - box.x
  } else if (edge === 'top') {
    const y = Math.max(0, Math.min(box.y + box.height - 1, box.y + delta))
    next.height = box.y + box.height - y
    next.y = y
  } else {
    const bottom = Math.max(box.y + 1, Math.min(bounds.height, box.y + box.height + delta))
    next.height = bottom - box.y
  }
  return [...boxes.slice(0, index), next, ...boxes.slice(index + 1)]
}
