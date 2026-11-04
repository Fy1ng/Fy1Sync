/** Anonymous HTTP fixtures traverse the real IPC, media gateway, FFmpeg and two player elements. */
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { fileURLToPath } from 'node:url'
import { test, expect, launchApplication, APP_ORIGIN, type RunningApplication } from './electron'
import { closeSourceDialog, fixturesReady, hlsFixtureReady, invoke, loadSource, mediaTimes, openPlayer, setPlaying, waitForBothReady } from './helpers'
import { locateTool } from '../electron/toolLocator'
import { serveStatic } from '../server/static'

const fixtureRoot = fileURLToPath(new URL('../public/test-sources/', import.meta.url))

async function fixtureServer() {
  const requests: Array<{ method: string; path: string; range: boolean }> = []
  const sockets = new Set<Socket>()
  const controllers = new Set<AbortController>()
  let connections = 0
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController()
    controllers.add(controller)
    const cancel = () => { if (!outgoing.writableFinished) controller.abort() }
    outgoing.once('close', cancel)
    void (async () => {
      let response: Response | null = null
      try {
        const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
        requests.push({ method: incoming.method ?? 'GET', path: url.pathname, range: Boolean(incoming.headers.range) })
        const headers = new Headers()
        for (const name of ['range', 'if-range', 'if-none-match']) {
          const value = incoming.headers[name]
          if (typeof value === 'string') headers.set(name, value)
        }
        response = await serveStatic(new Request(url, { method: incoming.method, headers, signal: controller.signal }), { root: fixtureRoot })
        if (!response) { outgoing.writeHead(404).end(); return }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        if (!response.body || incoming.method === 'HEAD') {
          await response.body?.cancel()
          outgoing.end()
        } else await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), outgoing, { signal: controller.signal })
      } catch {
        if (!outgoing.headersSent && !controller.signal.aborted) outgoing.writeHead(500).end()
        else outgoing.destroy()
        await response?.body?.cancel().catch(() => {})
      } finally {
        controllers.delete(controller)
        outgoing.removeListener('close', cancel)
      }
    })()
  })
  server.on('connection', socket => { connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture listener did not start')
  return {
    origin: `http://127.0.0.1:${address.port}`, requests,
    get connections() { return connections },
    async close() {
      for (const controller of controllers) controller.abort()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    },
  }
}

test.describe('真实 HTTP 双路媒体取流', () => {
  test.skip(!fixturesReady() || !hlsFixtureReady(), '缺少测试媒体, 请先运行 npm run fixtures.')
  test.beforeAll(async () => {
    for (const tool of ['ffmpeg', 'ffprobe'] as const) {
      try { await locateTool(tool) }
      catch { test.skip(true, `缺少 ${tool}, 请配置对应 STREAM_SYNC 工具路径或 PATH.`) }
    }
  })

  test('随机本机端口的 MP4 和 HLS 经实际取流后可双路播放及回退', async ({}, testInfo) => {
    test.setTimeout(180_000)
    const upstream = await fixtureServer()
    let running: RunningApplication | undefined
    try {
      running = await launchApplication('network-media-two-sources', { liveNetwork: true })
      expect(await running.application.evaluate(() => process.env.STREAM_SYNC_OFFLINE_E2E)).toBe('0')
      const page = running.page
      await openPlayer(page)
      await page.evaluate(() => {
        const probe = window as typeof window & { __httpMediaStates?: unknown[] }
        probe.__httpMediaStates = []
        const subscribe = window.streamSyncer!.subscribeBuffer
        if (!subscribe) throw new Error('Buffer event bridge is unavailable')
        subscribe(state => probe.__httpMediaStates!.push(state))
      })
      const inputs = [
        { role: 'official' as const, input: `${upstream.origin}/official.mp4?fixture=official` },
        { role: 'commentary' as const, input: `${upstream.origin}/commentary-hls/index.m3u8?fixture=commentary` },
      ]
      const resolved = await Promise.all(inputs.map(async source => {
        const result = await invoke(page, 'resolve', { input: source.input, platform: 'direct', role: source.role })
        if (!result.ok || !result.value.ok) {
          const failure = !result.ok ? { code: result.code, message: result.message } : result.value.ok ? null : result.value.failure
          const states = await page.evaluate(() => (window as typeof window & { __httpMediaStates?: unknown[] }).__httpMediaStates)
          const evidence = { role: source.role, failure, states, requests: upstream.requests, connections: upstream.connections }
          await testInfo.attach(`http-media-${source.role}-failure`, { body: JSON.stringify(evidence), contentType: 'application/json' })
          const requestCounts = upstream.requests.reduce<Record<string, number>>((counts, item) => {
            const key = `${item.method} ${item.path}`
            counts[key] = (counts[key] ?? 0) + 1
            return counts
          }, {})
          throw new Error(`HTTP 媒体取流未完成: ${JSON.stringify({ role: source.role, failure, requestCounts, lastStates: states?.slice(-5) })}`)
        }
        expect(result.value.stream.kind).toBe('hls')
        expect(result.value.stream.url.startsWith(APP_ORIGIN + '/buffer/')).toBe(true)
        return { role: source.role, url: result.value.stream.url }
      }))
      for (const source of resolved) {
        await expect.poll(() => page.evaluate(async url => {
          const response = await fetch(url, { cache: 'no-store' })
          if (!response.ok) return 0
          return [...(await response.text()).matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum, match) => sum + Number(match[1]), 0)
        }, source.url), { timeout: 30_000, message: `${source.role} 本地 HLS 至少应包含 4 秒可播放片段` }).toBeGreaterThanOrEqual(4)
        await loadSource(page, source.role, source.url.slice(APP_ORIGIN.length))
      }
      await closeSourceDialog(page)
      await waitForBothReady(page)
      await expect(page.locator('.theater-main video.media-element')).toHaveCount(1)
      await expect(page.locator('.pip-mount video.media-element')).toHaveCount(1)

      await setPlaying(page, false)
      for (const role of ['official', 'commentary']) {
        const video = page.locator(`video[data-role="${role}"]`)
        await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.seekable.length
          ? node.seekable.end(node.seekable.length - 1) - node.seekable.start(0) : 0), { timeout: 30_000 }).toBeGreaterThan(10)
        await video.evaluate((node: HTMLVideoElement) => { node.currentTime = node.seekable.start(0) + 8 })
        await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.seeking)).toBe(false)
      }
      await setPlaying(page, true)
      const before = await mediaTimes(page)
      await expect.poll(async () => {
        const current = await mediaTimes(page)
        return Math.min(current.official - before.official, current.commentary - before.commentary)
      }, { timeout: 15_000, message: '双路视频时间都应继续推进' }).toBeGreaterThan(1)
      await setPlaying(page, false)

      const official = page.locator('video[data-role="official"]')
      const rewound = await official.evaluate((node: HTMLVideoElement) => {
        const before = node.currentTime
        const target = before - 5
        if (target < node.seekable.start(0)) throw new Error('实际缓冲没有足够的回退空间')
        node.currentTime = target
        return { before, target }
      })
      await expect.poll(() => official.evaluate((node: HTMLVideoElement) => node.seeking)).toBe(false)
      expect(await official.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(rewound.target, 1)
      await setPlaying(page, true)
      await expect.poll(() => official.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 15_000 }).toBeGreaterThan(rewound.target + 1)
      expect(await official.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeLessThan(rewound.before - 2)

      expect(upstream.requests.some(item => item.path === '/official.mp4')).toBe(true)
      expect(upstream.requests.some(item => item.path === '/commentary-hls/index.m3u8')).toBe(true)
      expect(upstream.requests.some(item => /^\/commentary-hls\/seg-\d+\.ts$/.test(item.path))).toBe(true)
      await testInfo.attach('http-media-network-summary', { body: JSON.stringify({ connections: upstream.connections, requests: upstream.requests }), contentType: 'application/json' })
    } finally {
      try { await running?.close() }
      finally { await upstream.close() }
    }
  })
})
