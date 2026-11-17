import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError, invoke, revealOverlay, sourceDialog } from './helpers'
import { CookieStore } from '../electron/cookies'
import { fixtureCookies } from './youtubeCookies'
import { observeAdaptivePlayback } from './adaptiveTelemetry'

test.skip(process.env.STREAM_SYNC_YOUTUBE_STARTUP !== '1' || process.env.STREAM_SYNC_LIVE_TESTS !== '1', '真实首播计时默认关闭')
test.skip(!process.env.STREAM_SYNC_YOUTUBE_LIVE_URL, '需要当前公开 YouTube 直播地址')

test('真实 YouTube 解析与首播分阶段计时', async ({ page, electronApp }) => {
  test.setTimeout(240_000)
  const label = (process.env.STREAM_SYNC_YOUTUBE_STARTUP_LABEL ?? 'measurement').replace(/[^a-zA-Z0-9_-]/g, '_')
  const output = path.resolve('.runtime-cache/youtube-startup')
  await mkdir(output, { recursive: true })
  if (process.env.STREAM_SYNC_YOUTUBE_STARTUP_COOKIE_FILE) {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    new CookieStore(userData).write('youtube', await fixtureCookies(process.env.STREAM_SYNC_YOUTUBE_STARTUP_COOKIE_FILE))
  }
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/')
  await page.evaluate(preferAdaptive => localStorage.setItem('stream-sync.settings.v1', JSON.stringify({ preferAdaptive })),
    process.env.STREAM_SYNC_YOUTUBE_STARTUP_ADAPTIVE !== '0')
  await page.reload()
  await expect(sourceDialog(page)).toBeVisible()
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video[data-role="official"]')!
    const timing = { submittedAt: null as number | null, firstFrameAt: null as number | null,
      firstLocalRequestAt: null as number | null,
      events: [] as Array<{ at: number; state: string; seconds: number; hasVideo: boolean; completeSegments: number }> }
    Object.assign(window, { __youtubeStartupTiming: timing })
    window.streamSyncer!.subscribeBuffer!(state => {
      if (state.role === 'official') timing.events.push({ at: Date.now(), state: state.state, seconds: state.seconds,
        hasVideo: state.hasVideo === true, completeSegments: state.completeSegments ?? 0 })
    })
    document.addEventListener('submit', () => { timing.submittedAt ??= Date.now() }, { once: true, capture: true })
    const frame = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) timing.firstFrameAt ??= Date.now()
      else video.requestVideoFrameCallback(frame)
    }
    video.requestVideoFrameCallback(frame)
  })
  let localBuffer: string | null = null
  const manifests: Array<{ at: number; kind: string; target: number; segments: number; seconds: number }> = []
  page.on('response', response => {
    if (!response.url().startsWith(APP_ORIGIN + '/buffer/') || !response.url().endsWith('/index.m3u8')) return
    const at = Date.now(), kind = response.request().resourceType()
    void response.text().then(text => {
      const durations = [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].map(match => Number(match[1]))
      manifests.push({ at, kind, target: Number(text.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] ?? 0),
        segments: durations.length, seconds: durations.reduce((sum, value) => sum + value, 0) })
    }).catch(() => {})
  })
  page.on('request', request => {
    if (!request.url().startsWith(APP_ORIGIN + '/buffer/')) return
    if (request.url().endsWith('/index.m3u8')) localBuffer = request.url()
    void page.evaluate(() => {
      const timing = (window as unknown as { __youtubeStartupTiming: { firstLocalRequestAt: number | null } }).__youtubeStartupTiming
      timing.firstLocalRequestAt ??= Date.now()
    }).catch(() => {})
  })
  let failure: string | null = null
  let failureDetail: string | null = null
  let playback: { width: number; height: number; readyState: number; paused: boolean; qualities: string[] } | null = null
  let observedSeconds: number | null = null
  try {
    const intake = sourceDialog(page)
    await intake.getByRole('radiogroup', { name: '添加到' }).getByRole('radio', { name: /^画面/ }).click()
    await intake.getByRole('textbox', { name: '直播间链接' }).fill(process.env.STREAM_SYNC_YOUTUBE_LIVE_URL!)
    await intake.getByRole('textbox', { name: '直播间链接' }).press('Enter')
    await page.waitForFunction(() =>
      (window as unknown as { __youtubeStartupTiming: { firstFrameAt: number | null } }).__youtubeStartupTiming.firstFrameAt !== null
      || document.querySelector('.intake-error') !== null, undefined, { timeout: 210_000, polling: 250 })
    const issue = page.locator('.intake-error')
    expect(await page.evaluate(() =>
      (window as unknown as { __youtubeStartupTiming: { firstFrameAt: number | null } }).__youtubeStartupTiming.firstFrameAt),
    await issue.count() ? (await issue.textContent() ?? '真实直播应显示首帧') : '真实直播应显示首帧').not.toBeNull()
    await expect(sourceDialog(page)).toBeHidden()
    const video = page.locator('video[data-role="official"]')
    const firstTime = await video.evaluate((node: HTMLVideoElement) => node.currentTime)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 20_000 }).toBeGreaterThan(firstTime + 3)
    await revealOverlay(page)
    await page.getByRole('button', { name: '画面清晰度', exact: true }).click()
    const qualityMenu = page.getByRole('dialog', { name: '画面清晰度', exact: true })
    await expect(qualityMenu.getByRole('menuitemradio').first()).toBeVisible()
    const qualities = await qualityMenu.getByRole('menuitemradio').allTextContents()
    playback = await video.evaluate((node: HTMLVideoElement, qualities) => ({ width: node.videoWidth, height: node.videoHeight,
      readyState: node.readyState, paused: node.paused, qualities }), qualities.map(value => value.trim()))
    const expectedHeight = Number(process.env.STREAM_SYNC_YOUTUBE_STARTUP_EXPECT_HEIGHT ?? 0)
    if (expectedHeight > 0) {
      expect(Math.max(...qualities.map(value => Number.parseInt(value, 10) || 0))).toBeGreaterThanOrEqual(expectedHeight)
      if (process.env.STREAM_SYNC_YOUTUBE_STARTUP_ADAPTIVE !== '0') expect(playback.height).toBeGreaterThanOrEqual(expectedHeight)
    }
    await page.keyboard.press('Escape')
    await page.screenshot({ path: path.join(output, `${label}-first-playback.png`) })
    const observation = Number(process.env.STREAM_SYNC_YOUTUBE_STARTUP_OBSERVE_SECONDS ?? 0)
    if (observation > 0) {
      if (!Number.isInteger(observation) || observation < 10 || observation > 60 || !localBuffer) throw new Error('首播连续观察参数无效')
      await observeAdaptivePlayback(page, localBuffer, observation, {}, test.info(), 0, electronApp)
      observedSeconds = observation
    }
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown-error'
    const details = page.locator('.intake-error').getByRole('button', { name: '查看原始错误', exact: true })
    if (await details.count()) {
      await details.click()
      failureDetail = await page.locator('.error-details-panel').textContent().catch(() => null)
    }
    throw error
  } finally {
    const timing = await page.evaluate(() => (window as unknown as { __youtubeStartupTiming: {
      submittedAt: number | null; firstFrameAt: number | null; firstLocalRequestAt: number | null;
      events: Array<{ at: number; state: string; seconds: number; hasVideo: boolean; completeSegments: number }>
    } }).__youtubeStartupTiming)
    const diagnostics = await invoke(page, 'getAcquisitionDiagnostics', undefined).catch(() => null)
    const buffer = await electronApp.evaluate(() => {
      const harness = (globalThis as typeof globalThis & { __streamSyncerTest?: { bufferDiagnostics(): unknown; adaptiveStats(): unknown } }).__streamSyncerTest
      return { events: harness?.bufferDiagnostics(), adaptive: harness?.adaptiveStats() }
    })
    const acquisition = diagnostics?.ok ? diagnostics.value : null
    const attempt = acquisition?.attempts[0]
    const elapsed = (at: number | null | undefined) => at != null && timing.submittedAt != null ? at - timing.submittedAt : null
    const stageDuration = (stage: 'hls' | 'adaptive' | 'hls-fallback') => {
      const events = attempt?.events.filter(event => event.stage === stage) ?? []
      const start = events.find(event => event.status === 'started')
      const end = events.find(event => event.status === 'resolved' || event.status === 'failed')
      return start && end ? end.at - start.at : null
    }
    const milestones = { resolveMs: attempt && attempt.endedAt !== null ? elapsed(attempt.endedAt) : null,
      hlsExtractionMs: stageDuration('hls'), adaptiveExtractionMs: stageDuration('adaptive'), hlsFallbackMs: stageDuration('hls-fallback'),
      firstVideoProgressMs: elapsed(timing.events.find(event => event.hasVideo)?.at),
      firstCompleteSegmentMs: elapsed(timing.events.find(event => event.hasVideo && event.completeSegments > 0)?.at),
      firstLocalFetchMs: elapsed(timing.firstLocalRequestAt), firstFrameMs: elapsed(timing.firstFrameAt) }
    const report = { label, capturedAt: new Date().toISOString(), url: process.env.STREAM_SYNC_YOUTUBE_LIVE_URL,
      authentication: process.env.STREAM_SYNC_YOUTUBE_STARTUP_COOKIE_FILE ? 'reused-temporary-fixture' : 'anonymous',
      preferAdaptive: process.env.STREAM_SYNC_YOUTUBE_STARTUP_ADAPTIVE !== '0', failure, failureDetail, timing,
      milestones, playback, manifests, observedSeconds, acquisition: acquisition ?? diagnostics, buffer }
    const file = path.join(output, `${label}.json`)
    await writeFile(file, JSON.stringify(report, null, 2))
    const observation = await readFile(test.info().outputPath('adaptive-playback-observation.json')).catch(() => null)
    if (observation) await writeFile(path.join(output, `${label}-playback.json`), observation)
    await test.info().attach('youtube-startup-timing', { path: file, contentType: 'application/json' })
    console.log(JSON.stringify({ label, failure, milestones, playback, observedSeconds, file }))
  }
})
