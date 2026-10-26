import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { locateTool } from '../electron/toolLocator'
import { APP_ORIGIN, expect, test } from './electron'
import { closeSourceDialog, hlsFixtureReady, loadSource, openPlayer, setPlaying } from './helpers'

const builtFixture = fileURLToPath(new URL('../dist/client/test-sources/commentary-hls/index.m3u8', import.meta.url))

test.describe('main-process local rolling HLS buffer', () => {
  test.skip(!hlsFixtureReady() || !existsSync(builtFixture), '缺少构建后的 HLS 测试源, 请先 npm run fixtures 和 npm run build.')
  test.beforeAll(async () => {
    try { await locateTool('ffmpeg') }
    catch { test.skip(true, '缺少可执行 ffmpeg, 请设置 STREAM_SYNC_FFMPEG 或将 ffmpeg 加入 PATH.') }
  })

  test('real ffmpeg output plays through app:// and remains rewound after a five-second seek', async ({ page, electronApp }) => {
    test.setTimeout(120_000)
    await openPlayer(page)
    const { url } = await electronApp.evaluate(async () => {
      const harness = (globalThis as typeof globalThis & {
        __streamSyncerTest?: { bufferFixture(): Promise<{ url: string }> }
      }).__streamSyncerTest
      if (!harness) throw new Error('Main-process E2E buffer hook is unavailable')
      return await harness.bufferFixture()
    })
    expect(url.startsWith(APP_ORIGIN + '/buffer/')).toBe(true)

    // Wait for measured media duration, rather than assuming a segment count or clock delay.
    await expect.poll(async () => page.evaluate(async playlist => {
      const response = await fetch(playlist, { cache: 'no-store' })
      if (!response.ok) return 0
      const text = await response.text()
      return [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum, match) => sum + Number(match[1]), 0)
    }, url), { timeout: 70_000, intervals: [250, 500, 1_000], message: '真实 ffmpeg 本地缓冲应包含至少 20 秒媒体.' }).toBeGreaterThanOrEqual(20)

    // The ordinary source form accepts same-origin relative paths; it never accepts file paths.
    await loadSource(page, 'official', url.slice(APP_ORIGIN.length))
    await closeSourceDialog(page)
    const video = page.locator('video[data-role="official"]')
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => {
      return node.seekable.length ? node.seekable.end(node.seekable.length - 1) - node.seekable.start(0) : 0
    }), { timeout: 20_000 }).toBeGreaterThan(10)

    await setPlaying(page, true)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false)
    const startedAt = await video.evaluate((node: HTMLVideoElement) => node.currentTime)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 15_000 }).toBeGreaterThan(startedAt + 0.6)

    await setPlaying(page, false)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true)
    const seek = await video.evaluate((node: HTMLVideoElement) => {
      const before = node.currentTime
      const target = before - 5
      const start = node.seekable.start(0)
      if (target < start + 0.25) throw new Error('本地缓冲没有足够的 5 秒回退空间.')
      node.currentTime = target
      return { before, target }
    })
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.seeking), { timeout: 15_000 }).toBe(false)
    const landedAt = await video.evaluate((node: HTMLVideoElement) => node.currentTime)
    expect(Math.abs(landedAt - seek.target)).toBeLessThanOrEqual(0.35)
    expect(seek.before - landedAt).toBeGreaterThanOrEqual(4.65)

    await setPlaying(page, true)
    const resumed = await video.evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, wall: performance.now() }))
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 15_000 }).toBeGreaterThan(resumed.time + 1.5)
    const later = await video.evaluate((node: HTMLVideoElement) => ({
      time: node.currentTime, wall: performance.now(), paused: node.paused,
      liveEnd: node.seekable.end(node.seekable.length - 1),
    }))
    expect(later.paused).toBe(false)
    // A jump to live would advance much more than ordinary elapsed playback time.
    expect(later.time - resumed.time).toBeLessThanOrEqual((later.wall - resumed.wall) / 1_000 + 0.75)
    expect(later.liveEnd - later.time).toBeGreaterThan(3)

    const readablePixelCount = await video.evaluate((node: HTMLVideoElement) => {
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context is unavailable')
      context.drawImage(node, 0, 0, 2, 2)
      return context.getImageData(0, 0, 2, 2).data.length
    })
    expect(readablePixelCount).toBe(16)
  })
})
