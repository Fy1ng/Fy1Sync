import { mkdir, writeFile } from 'node:fs/promises'
import { test } from '@playwright/test'
import { CookieStore } from '../electron/cookies'
import { locateTool } from '../electron/toolLocator'
import { APP_ORIGIN, expect, launchApplication } from './electron'
import { invoke, loadSource, openPlayer, openSourcePanel, setCheckedByLabel, setPlaying } from './helpers'
import { decoderTelemetry, observeAdaptivePlayback, playbackObservationSeconds } from './adaptiveTelemetry'
import { decodingStartup, selectSoftwareDecoding } from './decoderSettings'
import { fixtureCookies } from './youtubeCookies'

const persistedSoftware = process.env.STREAM_SYNC_ADAPTIVE_PERSISTED_SOFTWARE === '1'

test.describe('opt-in real YouTube adaptive acquisition', () => {
  test.skip(process.env.STREAM_SYNC_LIVE_TESTS !== '1' || process.env.STREAM_SYNC_YOUTUBE_ADAPTIVE !== '1',
    '真实自适应测试默认关闭, 需同时设置 STREAM_SYNC_LIVE_TESTS=1 和 STREAM_SYNC_YOUTUBE_ADAPTIVE=1.')
  test.skip(!process.env.STREAM_SYNC_YOUTUBE_LIVE_URL, '需设置 STREAM_SYNC_YOUTUBE_LIVE_URL 为当前公开直播地址.')
  test.skip(!process.env.STREAM_SYNC_POT_PLUGIN_DIR || !process.env.STREAM_SYNC_POT_SERVER_HOME,
    '需显式设置 STREAM_SYNC_POT_PLUGIN_DIR 和 STREAM_SYNC_POT_SERVER_HOME, 使用脚本模式 token provider.')
  test.skip(!process.env.STREAM_SYNC_YOUTUBE_ADAPTIVE_COOKIE_FILE,
    '需显式设置 STREAM_SYNC_YOUTUBE_ADAPTIVE_COOKIE_FILE 为已授权的 Netscape 测试 cookie 文件.')

  test.beforeAll(async () => {
    for (const tool of ['ffmpeg', 'ffprobe', 'yt-dlp'] as const) {
      try { await locateTool(tool) }
      catch { test.skip(true, `缺少 ${tool}, 请先配置对应工具路径.`) }
    }
  })

  test(persistedSoftware ? '1440p live fMP4 with production persisted software mode' : 'buffers at least 30 seconds of 1440p fMP4 and decodes it in Electron', async ({}) => {
    const observationSeconds = playbackObservationSeconds()
    const expectedFps = Number(process.env.STREAM_SYNC_ADAPTIVE_EXPECT_FPS ?? 0)
    if (!Number.isInteger(expectedFps) || expectedFps < 0 || expectedFps > 240) throw new Error('期望帧率必须是0到240之间的整数')
    test.setTimeout(480_000 + observationSeconds * 1000)
    const running = await launchApplication('youtube-adaptive', persistedSoftware ? { softwareVideo: false } : {})
    const startup: unknown[] = []
    let decoder: Awaited<ReturnType<typeof decoderTelemetry>> | undefined
    try {
      if (persistedSoftware) {
        await openPlayer(running.page)
        startup.push(await decodingStartup(running))
        expect(startup[0]).toMatchObject({ preferences: { ok: true, value: { mode: 'auto', effectiveMode: 'auto', forcedByCommandLine: false } } })
        await selectSoftwareDecoding(running, true)
        startup.push(await decodingStartup(running))
        expect(startup[1]).toMatchObject({ preferences: { ok: true, value: { mode: 'software', effectiveMode: 'auto', restartRequired: true } } })
        await running.restart()
        startup.push(await decodingStartup(running))
        expect(startup[2]).toMatchObject({ preferences: { ok: true, value: { mode: 'software', effectiveMode: 'software', restartRequired: false, forcedByCommandLine: false } }, switches: { videoDisabled: true, gpuDisabled: false, gpuCompositingDisabled: false } })
      }
      const { page, application: electronApp } = running
      decoder = await decoderTelemetry(page, electronApp)
      // Cookie bytes stay in the test/main Node contexts and never cross renderer IPC.
      // CookieStore enforces the same private file permissions as normal login.
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      new CookieStore(userData).write('youtube', await fixtureCookies(process.env.STREAM_SYNC_YOUTUBE_ADAPTIVE_COOKIE_FILE!))
      test.info().annotations.push({ type: 'authentication', description: '显式测试 cookie 仅导入本场景可丢弃目录, 不复制日常浏览器资料.' })
      // Start with the normal HLS default, then choose exactly 1440p in the real menu.
      // A source may also offer 2160p; testing its automatic default is a different case.
      await page.evaluate(() => localStorage.setItem('stream-sync.settings.v1', JSON.stringify({ preferAdaptive: false })))
      await openPlayer(page)
      const login = await invoke(page, 'loginStatus', undefined)
      expect(login.ok && login.value.youtube.loggedIn, '显式测试 cookie 应包含未过期的登录凭据.').toBe(true)

      // Exercise the source form's actual YouTube resolution and session load. The
      // local capability is observed from hls.js requests, never submitted as input.
      let localBuffer = ''
      page.on('request', request => {
        const url = request.url()
        if (url.startsWith(APP_ORIGIN + '/buffer/') && url.endsWith('/index.m3u8')) localBuffer = url
      })
      await loadSource(page, 'official', process.env.STREAM_SYNC_YOUTUBE_LIVE_URL!, 240_000)
      const panel = await openSourcePanel(page, 'official')
      const quality = panel.getByRole('combobox', { name: '清晰度' })
      const choices = panel.getByRole('radiogroup', { name: '清晰度' })
      await expect.poll(async () => await quality.count() + await choices.count(), { timeout: 30_000 }).toBe(1)
      const nativeSelect = await quality.count() > 0
      const qualityFile = test.info().outputPath('available-qualities.json')
      await mkdir(test.info().outputDir, { recursive: true })
      await writeFile(qualityFile, JSON.stringify(await (nativeSelect ? quality.locator('option') : choices.locator('label')).allTextContents()))
      await test.info().attach('available-qualities', { path: qualityFile, contentType: 'application/json' })
      const targetName = expectedFps ? new RegExp(`^1440p${expectedFps > 30 ? expectedFps : ''}$`) : /^1440p(?:60)?$/
      const target = nativeSelect ? quality.getByRole('option', { name: targetName }) : choices.getByRole('radio', { name: targetName })
      await expect(target, '测试直播必须提供 1440p 档位, HLS 回退不能算作通过.').toHaveCount(1)
      const targetId = nativeSelect ? await target.getAttribute('value') : null
      if (nativeSelect && !targetId) throw new Error('当前直播未提供 1440p 自适应档位')
      if (nativeSelect ? await quality.inputValue() !== targetId : !(await target.isChecked())) {
        localBuffer = ''
        if (nativeSelect) await quality.selectOption(targetId!)
        else await setCheckedByLabel(target)
        await expect(nativeSelect ? quality : target).toBeEnabled({ timeout: 90_000 })
      }
      if (nativeSelect) await expect(quality).toHaveValue(targetId!)
      else await expect(target).toBeChecked()
      await expect.poll(() => localBuffer, { timeout: 30_000 }).toMatch(/^app:\/\/app\/buffer\//)
      const url = localBuffer

      await expect.poll(async () => page.evaluate(async url => {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) return 0
        const playlist = await response.text()
        const segments = playlist.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
        if (!/^#EXT-X-MAP:/m.test(playlist) || !segments.length || segments.some(segment => !segment.endsWith('.m4s'))) return 0
        return [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum, match) => sum + Number(match[1]), 0)
      }, url), { timeout: 120_000, intervals: [500, 1_000, 2_000], message: '1440p 应形成至少 30 秒含 EXT-X-MAP 的 fMP4 本地缓冲.' }).toBeGreaterThanOrEqual(30)
      if (nativeSelect) await expect(quality, '缓冲期间不能降档后仍算作 1440p 通过.').toHaveValue(targetId!)
      else await expect(target, '缓冲期间不能降档后仍算作 1440p 通过.').toBeChecked()

      await page.keyboard.press('Escape')
      const video = page.locator('video[data-role="official"]')
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.videoHeight), { timeout: 30_000 }).toBeGreaterThanOrEqual(1440)
      await setPlaying(page, true)
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false)
      const before = await video.evaluate((node: HTMLVideoElement) => ({
        time: node.currentTime, quality: node.getVideoPlaybackQuality().totalVideoFrames,
      }))
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 20_000 }).toBeGreaterThan(before.time + 3)
      expect(await video.evaluate((node: HTMLVideoElement) => node.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(before.quality)
      const stats = await video.evaluate((node: HTMLVideoElement) => {
        const quality = node.getVideoPlaybackQuality()
        return { width: node.videoWidth, height: node.videoHeight, total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames }
      })
      await test.info().attach('adaptive-playback-stats', { body: JSON.stringify(stats), contentType: 'application/json' })
      await observeAdaptivePlayback(page, url, observationSeconds, decoder.info, test.info(), expectedFps, electronApp)
      if (persistedSoftware) expect(decoder.info).toMatchObject({ codec: 'vp9', decoder: 'VpxVideoDecoder', platform: false, errors: [] })
      const continuity = await electronApp.evaluate(() => {
        const harness = (globalThis as typeof globalThis & { __streamSyncerTest?: { adaptiveStats(): unknown } }).__streamSyncerTest
        return harness?.adaptiveStats()
      })
      expect(continuity).toMatchObject({ rounds: 1, httpErrors: 0, reconnects: 0, fallback: false,
        video: { gaps: 0, repeated: 0 }, audio: { gaps: 0, repeated: 0 } })
    } finally {
      try {
      const diagnostics = await running.application.evaluate(() => {
        const harness = (globalThis as typeof globalThis & { __streamSyncerTest?: { youtubeDiagnostics(): unknown; bufferDiagnostics(): unknown; adaptiveStats(): unknown } }).__streamSyncerTest
        return { extraction: harness?.youtubeDiagnostics() ?? [], buffer: harness?.bufferDiagnostics() ?? [], adaptive: harness?.adaptiveStats() ?? null }
      }).catch(() => ({ unavailable: true }))
      await mkdir(test.info().outputDir, { recursive: true })
      const file = test.info().outputPath('youtube-diagnostics.json')
      await writeFile(file, JSON.stringify({ ...diagnostics, persistedSoftware, startup, decoder: decoder?.info }, null, 2))
      await test.info().attach('youtube-extraction-diagnostics', { path: file, contentType: 'application/json' })
      } finally {
        await decoder?.close().catch(() => {})
        await running.close()
      }
    }
  })
})
