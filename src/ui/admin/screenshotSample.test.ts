import { describe, expect, it } from 'vitest'
import {
  checkScreenshotFile,
  checkScreenshotSize,
  decodeScreenshot,
  imageFromClipboard,
  MAX_SCREENSHOT_BYTES,
} from './screenshotSample'

describe('screenshot samples', () => {
  it.each([
    ['image/png', 10, true], ['image/jpeg', 10, true], ['image/webp', 10, true],
    ['image/gif', 10, false], ['image/svg+xml', 10, false], ['video/mp4', 10, false], ['', 10, false],
    ['image/png', 0, false], ['image/png', MAX_SCREENSHOT_BYTES + 1, false],
  ])('type %s size %d accepted=%s', (type, size, ok) => {
    expect(checkScreenshotFile({ type, size }).ok).toBe(ok)
  })

  it('rejects thumbnails and absurd sizes with a Chinese reason', () => {
    expect(checkScreenshotSize(1920, 1080)).toEqual({ ok: true })
    expect(checkScreenshotSize(120, 80)).toEqual({ ok: false, message: '截图太小（120×80），请截完整画面' })
    expect(checkScreenshotSize(9000, 4000).ok).toBe(false)
  })

  it('picks the first supported image off the clipboard', () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/gif', getAsFile: () => new File([], 'a.gif', { type: 'image/gif' }) },
      { kind: 'file', type: 'image/png', getAsFile: () => png },
    ]
    expect(imageFromClipboard({ items } as unknown as DataTransfer)).toBe(png)
    expect(imageFromClipboard(null)).toBeNull()
  })

  it('reports an undecodable file instead of throwing, and never touches the network', async () => {
    const fetchSpy = globalThis.fetch
    globalThis.fetch = (() => { throw new Error('network used') }) as typeof fetch
    try {
      const file = new File([new Uint8Array([0, 1, 2])], 'broken.png', { type: 'image/png' })
      const result = await decodeScreenshot(file, () => 0, async () => { throw new Error('bad image') })
      expect(result).toEqual({ ok: false, message: '无法解码这张截图' })
      expect((await decodeScreenshot(new File([new Uint8Array([1])], 'x.gif', { type: 'image/gif' }))).ok).toBe(false)
    } finally {
      globalThis.fetch = fetchSpy
    }
  })

  it('checks decoded dimensions before reading pixels', async () => {
    let closed = false
    const tiny = { width: 64, height: 36, close: () => { closed = true } } as unknown as ImageBitmap
    const file = new File([new Uint8Array([1])], 'tiny.png', { type: 'image/png' })
    const result = await decodeScreenshot(file, () => 0, async () => tiny)
    expect(result.ok).toBe(false)
    expect(closed).toBe(true)
  })
})
