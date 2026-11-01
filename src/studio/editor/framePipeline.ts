/** Canvas display helpers; all image analysis is produced by Rust/WASM. */
import type { HudAnalysis } from '../../core/hudWasm'
import { TEMPLATE_HEIGHT, TEMPLATE_WIDTH, type ClockChar, type TemplateSample } from '../../core/profileSchema'
export type FrameAnalysis = HudAnalysis

export function sampleFromPrepared(data: string, char: ClockChar, origin: string): TemplateSample {
  return { id: `${char === ':' ? 'colon' : char}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, data, createdAt: Date.now(), origin }
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
