/**
 * Draw the app icon: the title bar's mark (`.titlebar-mark` in src/studio/titlebar.css), a
 * rounded square split corner to corner, chalk over the lock green. Writes packaging/icon.ico
 * with the sizes Windows asks for (shell, taskbar, installer) and packaging/icon.png.
 *
 *   node scripts/make-icon.mjs
 *
 * No image library: each size is rasterised here with 4x4 supersampling and stored as PNG
 * inside the ICO, which Windows Vista and later read.
 */

import { writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

const CHALK = [0xf3, 0xf0, 0xea]
const LOCK = [0x6f, 0xd3, 0xa8]
// The CSS mark is 10px with a 2px radius; keep the proportion, with a small margin.
const RADIUS = 0.2
const MARGIN = 0.0625
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

function inside(x, y) {
  const lo = MARGIN, hi = 1 - MARGIN, r = RADIUS * (hi - lo)
  if (x < lo || x > hi || y < lo || y > hi) return false
  const cx = Math.min(Math.max(x, lo + r), hi - r)
  const cy = Math.min(Math.max(y, lo + r), hi - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const n = 4
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0, chalk = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (px + (sx + 0.5) / n) / size
          const y = (py + (sy + 0.5) / n) / size
          if (!inside(x, y)) continue
          hits++
          // 135deg linear-gradient, 50% hard stop: the top-left half is chalk.
          if (x + y < 1) chalk++
        }
      }
      const at = (py * size + px) * 4
      if (hits === 0) continue
      const mix = chalk / hits
      for (let c = 0; c < 3; c++) pixels[at + c] = Math.round(CHALK[c] * mix + LOCK[c] * (1 - mix))
      pixels[at + 3] = Math.round(255 * hits / (n * n))
    }
  }
  return pixels
}

const CRC = new Uint32Array(256).map((_, i) => {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}
function png(size) {
  const rgba = render(size)
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

const images = SIZES.map(png)
const directory = Buffer.alloc(6 + 16 * images.length)
directory.writeUInt16LE(0, 0)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(images.length, 4)
let offset = directory.length
images.forEach((image, index) => {
  const at = 6 + 16 * index
  const size = SIZES[index]
  directory.writeUInt8(size >= 256 ? 0 : size, at)
  directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
  directory.writeUInt16LE(1, at + 4)
  directory.writeUInt16LE(32, at + 6)
  directory.writeUInt32LE(image.length, at + 8)
  directory.writeUInt32LE(offset, at + 12)
  offset += image.length
})
const root = new URL('../packaging/', import.meta.url)
await writeFile(new URL('icon.ico', root), Buffer.concat([directory, ...images]))
await writeFile(new URL('icon.png', root), images[images.length - 1])
console.log(`packaging/icon.ico (${SIZES.join(', ')}) and packaging/icon.png written`)
