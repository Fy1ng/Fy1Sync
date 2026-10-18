/**
 * Tiny 5x7 bitmap font used by the recognition tests to synthesise clock frames
 * and matching templates. Keeping it in the test tree means the recognition
 * pipeline can be exercised end to end (crop -> binarize -> segment -> normalise
 * -> match -> parse) without shipping fixture images.
 */

const FONT: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
}

export const GLYPH_WIDTH = 5
export const GLYPH_HEIGHT = 7

export interface RenderOptions {
  /** Pixels per font pixel. */
  scale?: number
  /** Font pixels between glyphs. */
  tracking?: number
  /** Ink colour (bright clock on dark scoreboard by default). */
  ink?: [number, number, number]
  background?: [number, number, number]
}

export interface RgbaFrame {
  data: Uint8ClampedArray
  width: number
  height: number
}

export function createFrame(
  width: number,
  height: number,
  background: [number, number, number] = [12, 14, 18],
): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    data[offset] = background[0]
    data[offset + 1] = background[1]
    data[offset + 2] = background[2]
    data[offset + 3] = 255
  }
  return { data, width, height }
}

/** Draw `text` with its top-left corner at (x, y). Returns the drawn box. */
export function drawText(
  frame: RgbaFrame,
  text: string,
  x: number,
  y: number,
  options: RenderOptions = {},
): { x: number; y: number; width: number; height: number } {
  const scale = options.scale ?? 4
  const tracking = options.tracking ?? 1
  const ink = options.ink ?? [235, 238, 245]
  let cursor = x
  for (const char of text) {
    const glyph = FONT[char]
    if (!glyph) throw new Error(`no glyph for "${char}"`)
    for (let row = 0; row < glyph.length; row += 1) {
      const line = glyph[row] as string
      for (let column = 0; column < line.length; column += 1) {
        if (line[column] !== '1') continue
        fillRect(frame, cursor + column * scale, y + row * scale, scale, scale, ink)
      }
    }
    cursor += (GLYPH_WIDTH + tracking) * scale
  }
  const width = cursor - x - tracking * scale
  return { x, y, width, height: GLYPH_HEIGHT * scale }
}

function fillRect(
  frame: RgbaFrame,
  x: number,
  y: number,
  width: number,
  height: number,
  color: [number, number, number],
): void {
  for (let py = y; py < y + height; py += 1) {
    if (py < 0 || py >= frame.height) continue
    for (let px = x; px < x + width; px += 1) {
      if (px < 0 || px >= frame.width) continue
      const offset = (py * frame.width + px) * 4
      frame.data[offset] = color[0]
      frame.data[offset + 1] = color[1]
      frame.data[offset + 2] = color[2]
      frame.data[offset + 3] = 255
    }
  }
}

/** Render one character as an isolated binary mask, for template building. */
export function renderGlyphMask(
  char: string,
  scale = 6,
): { data: Uint8Array; width: number; height: number } {
  const glyph = FONT[char]
  if (!glyph) throw new Error(`no glyph for "${char}"`)
  const width = GLYPH_WIDTH * scale
  const height = GLYPH_HEIGHT * scale
  const data = new Uint8Array(width * height)
  for (let row = 0; row < glyph.length; row += 1) {
    const line = glyph[row] as string
    for (let column = 0; column < line.length; column += 1) {
      if (line[column] !== '1') continue
      for (let py = row * scale; py < (row + 1) * scale; py += 1) {
        for (let px = column * scale; px < (column + 1) * scale; px += 1) {
          data[py * width + px] = 255
        }
      }
    }
  }
  return { data, width, height }
}

export const CLOCK_GLYPHS = Object.keys(FONT)
