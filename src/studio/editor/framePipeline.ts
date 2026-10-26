/**
 * The editor's view of the recognition pipeline.
 *
 * `recognizeFrame` runs the same steps internally, but the editor has to *show* each
 * intermediate: the grey crop, the binary image, the column projection, the glyph boxes.
 * Recomputing them here from the same primitives keeps the editor honest — a preview
 * built from different code could disagree with what recognition actually sees.
 */

import {
  binarize,
  cropBinary,
  inkRatio,
  normalizeGlyph,
  roiToPixels,
  toGrayscale,
  type BinaryImage,
  type Rect,
} from '../../core/imageOps'
import { packBitmap } from '../../core/bitmapCodec'
import { segmentGlyphs, type GlyphBox } from '../../core/segmentation'
import {
  TEMPLATE_HEIGHT,
  TEMPLATE_WIDTH,
  type ClockChar,
  type PreprocessSettings,
  type RoiRect,
  type TemplateSample,
} from '../../core/profileSchema'
import type { GrabbedFrame } from '../../recognition/frameGrabber'

export interface FrameAnalysis {
  /** Pixel rect the ROI maps to inside the frame. */
  roiPixels: Rect
  /** Grey crop, before thresholding. Shown next to the binary one for comparison. */
  gray: BinaryImage
  binary: BinaryImage
  boxes: GlyphBox[]
  projection: number[]
  inkRatio: number
}

/**
 * Crop + threshold + segment one grabbed frame.
 *
 * `cropBinary` is used on the grey image on purpose: `GrayImage` and `BinaryImage` have
 * the same shape and the crop is a plain byte copy, so there is no second implementation
 * to keep in step.
 */
export function analyzeFrame(
  frame: Pick<GrabbedFrame, 'pixels' | 'width' | 'height'>,
  roi: RoiRect,
  preprocess: PreprocessSettings,
): FrameAnalysis {
  const roiPixels = roiToPixels(roi, frame.width, frame.height)
  const gray = toGrayscale(frame.pixels, frame.width, frame.height)
  const grayCrop = cropBinary(gray, roiPixels)
  const binary = binarize(grayCrop, preprocess)
  const segmented = segmentGlyphs(binary)
  return {
    roiPixels,
    gray: grayCrop,
    binary,
    boxes: segmented.boxes,
    projection: segmented.projection,
    inkRatio: inkRatio(binary),
  }
}

/** Normalise one glyph box into a storable template sample. */
export function sampleFromBox(
  binary: BinaryImage,
  box: GlyphBox,
  char: ClockChar,
  origin: string,
): TemplateSample {
  const mask = normalizeGlyph(cropBinary(binary, box))
  return {
    // Random enough to never collide within a profile, readable enough to debug.
    id: `${char}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    data: packBitmap(mask),
    createdAt: Date.now(),
    origin,
  }
}

/**
 * Paint a mask into a canvas at 1 device pixel per mask pixel.
 *
 * Ink is drawn white on near-black rather than the other way round: the editor is dark,
 * and a white-background thumbnail in a dark panel reads as a broken image.
 */
export function drawMask(
  canvas: HTMLCanvasElement | null,
  mask: { data: Uint8Array; width: number; height: number },
): void {
  if (!canvas || mask.width <= 0 || mask.height <= 0) return
  canvas.width = mask.width
  canvas.height = mask.height
  const context = canvas.getContext('2d')
  if (!context) return
  const image = context.createImageData(mask.width, mask.height)
  for (let index = 0; index < mask.data.length; index += 1) {
    const value = (mask.data[index] ?? 0) !== 0 ? 245 : 18
    const offset = index * 4
    image.data[offset] = value
    image.data[offset + 1] = value
    image.data[offset + 2] = value
    image.data[offset + 3] = 255
  }
  context.putImageData(image, 0, 0)
}

/** Same, but for a grey image: values pass through instead of being thresholded. */
export function drawGray(
  canvas: HTMLCanvasElement | null,
  image: { data: Uint8Array; width: number; height: number },
): void {
  if (!canvas || image.width <= 0 || image.height <= 0) return
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) return
  const bitmap = context.createImageData(image.width, image.height)
  for (let index = 0; index < image.data.length; index += 1) {
    const value = image.data[index] ?? 0
    const offset = index * 4
    bitmap.data[offset] = value
    bitmap.data[offset + 1] = value
    bitmap.data[offset + 2] = value
    bitmap.data[offset + 3] = 255
  }
  context.putImageData(bitmap, 0, 0)
}

/** Unpacked-sample dimensions, so callers do not re-derive them from two constants. */
export const TEMPLATE_SIZE = { width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT } as const
