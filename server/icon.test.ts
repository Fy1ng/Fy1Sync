import { readFile } from 'node:fs/promises'
import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

function png(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  let cursor = 8
  const chunks: Array<{ type: string; bytes: Buffer }> = []
  while (cursor < bytes.length) {
    const length = bytes.readUInt32BE(cursor), end = cursor + length + 12
    expect(end).toBeLessThanOrEqual(bytes.length)
    const type = bytes.toString('ascii', cursor + 4, cursor + 8)
    expect(bytes.readUInt32BE(end - 4)).toBe(crc32(bytes.subarray(cursor + 4, end - 4)))
    chunks.push({ type, bytes: bytes.subarray(cursor + 8, end - 4) })
    cursor = end
  }
  expect(chunks[0]?.type).toBe('IHDR')
  expect(chunks.at(-1)?.type).toBe('IEND')
  expect(chunks.filter(chunk => ['caBX', 'eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(chunk.type))).toEqual([])
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), color: bytes[25], chunks }
}

describe('release artwork', () => {
  it('ships the supplied square artwork without private PNG metadata', async () => {
    const source = png(await readFile('packaging/icon-source.png'))
    expect(source.width).toBe(1254)
    expect(source.height).toBe(1254)
    expect(source.color).toBe(2)
    expect(source.chunks.map(chunk => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const pixels = inflateSync(Buffer.concat(source.chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.bytes)))
    expect(pixels.length).toBe(1254 * (1254 * 3 + 1))
  })

  it('provides all Windows shell resolutions and uses the same largest PNG at runtime', async () => {
    const ico = await readFile('packaging/icon.ico'), runtime = await readFile('packaging/icon.png')
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(sizes.length)
    let nextOffset = 6 + sizes.length * 16
    for (const [index, size] of sizes.entries()) {
      const entry = 6 + index * 16
      expect(ico[entry] || 256).toBe(size)
      expect(ico[entry + 1] || 256).toBe(size)
      expect(ico.readUInt16LE(entry + 4)).toBe(1)
      expect(ico.readUInt16LE(entry + 6)).toBe(32)
      expect(ico.readUInt32LE(entry + 12)).toBe(nextOffset)
      const length = ico.readUInt32LE(entry + 8), image = ico.subarray(nextOffset, nextOffset + length)
      const decoded = png(image)
      expect([decoded.width, decoded.height]).toEqual([size, size])
      if (size === 256) expect(image).toEqual(runtime)
      nextOffset += length
    }
    expect(nextOffset).toBe(ico.length)
  })

  it('does not couple OS artwork to the in-app title-bar mark', async () => {
    const titlebar = await readFile('src/studio/TitleBar.tsx', 'utf8')
    const css = await readFile('src/studio/titlebar.css', 'utf8')
    expect(titlebar).toContain('titlebar-mark')
    expect(titlebar).not.toMatch(/icon(?:-source)?\.(?:png|ico)/)
    expect(css).toContain('linear-gradient')
  })
})
