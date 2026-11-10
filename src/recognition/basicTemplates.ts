/** Combine generic, font-derived figures with locally rasterized system fonts. */
import { packBitmap } from '../core/bitmapCodec'
import { normalizeGlyph } from '../core/imageOps'
import { CLOCK_CHARS } from '../core/profileSchema'
import glyphPriors from './basicGlyphPriors.json'

let cached: Record<string, string[]> | null = null

/** Shared normalization keeps the generated priors identical to the Rust bitmap contract. */
export function createBasicClockTemplates(): Record<string, string[]> {
  if (cached) return cached
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(192, 160)
    : typeof document !== 'undefined' ? document.createElement('canvas') : null
  if (!canvas) throw new Error('基础识别需要本地字体绘制能力')
  canvas.width = 192
  canvas.height = 160
  const context = canvas.getContext('2d', { willReadFrequently: true }) as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!context) throw new Error('基础识别无法生成数字字形')
  const templates = Object.fromEntries(CLOCK_CHARS.map(char => [char, new Set<string>(glyphPriors[char])]))
  const families = ['Arial, sans-serif', '"Segoe UI", sans-serif', 'Consolas, monospace', '"Arial Narrow", sans-serif']
  const faces = families.flatMap(family => [400, 700].map(weight => ({ family, weight, stretch: 1, outline: 0, sizes: [48, 72], thresholds: [128, 176] })))
  // Condensed DIN-like figures need their own priors, rather than a lower matching threshold.
  faces.push(...[500, 700].flatMap(weight => [.9, 1, 1.1].map(stretch => ({ family: 'Bahnschrift, sans-serif', weight, stretch, outline: 0, sizes: [48, 72], thresholds: [128, 176] }))))
  // Optical-weight variants cover heavy broadcast figures without learning a recording's pixels.
  faces.push(...[0, 1.5, 2.5].map(outline => ({ family: 'Bahnschrift, sans-serif', weight: 700, stretch: .8, outline, sizes: [48, 72], thresholds: [128, 176] })))
  // Small priors preserve the rasterization seen after the capture's width limit.
  faces.push(...[500, 700].flatMap(weight => [.8, .9, 1.1].flatMap(stretch => [0, .8].map(outline => ({ family: 'Bahnschrift, sans-serif', weight, stretch, outline, sizes: [24], thresholds: [128] })))))
  for (const { family, weight, stretch, outline, sizes, thresholds } of faces) for (const size of sizes) {
    context.font = `${weight} ${size}px ${family}`
    context.textBaseline = 'alphabetic'
    for (const char of CLOCK_CHARS) {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.fillStyle = '#000'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.setTransform(stretch, 0, 0, 1, 0, 0)
      context.fillStyle = '#fff'
      if (outline > 0) {
        context.strokeStyle = '#fff'
        context.lineWidth = outline
        context.lineJoin = 'round'
        context.strokeText(char, 32, 112)
      }
      context.fillText(char, 32, 112)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      for (const threshold of thresholds) {
        const data = new Uint8Array(canvas.width * canvas.height)
        for (let index = 0; index < data.length; index++) data[index] = pixels[index * 4]! >= threshold ? 255 : 0
        const normalized = normalizeGlyph({ data, width: canvas.width, height: canvas.height })
        if (!normalized.some(value => value !== 0)) throw new Error(`基础识别无法绘制字符 ${char}`)
        templates[char]!.add(packBitmap(normalized))
      }
    }
  }
  cached = Object.fromEntries(CLOCK_CHARS.map(char => [char, [...templates[char]!]]))
  return cached
}
