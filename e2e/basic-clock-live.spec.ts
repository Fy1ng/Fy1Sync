/** Live HLS/MSE regression with real fragment recovery, not a seekable-file substitute. */
import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron'
import { loadSource, openAlignOptions, openPlayer, seekBoth, setPlaying, waitForBothReady } from './helpers'
import { startLiveClockFixture } from './liveClockFixture'

for (const fault of [
  { name: '补片延迟', delayMs: 1000, failOnce: false },
  { name: '补片短暂失败并重试', delayMs: 350, failOnce: true },
]) {
test(`滚动 HLS 在${fault.name}后重新读取两路跳秒并校正`, async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    const settings = JSON.parse(localStorage.getItem('stream-sync.settings.v1') || '{}')
    localStorage.setItem('stream-sync.settings.v1', JSON.stringify({ ...settings, recognitionMode: 'basic',
      basicClockRoi: { x: .40, y: .055, w: .24, h: .18 } }))
    const observed = window as any
    observed.liveClock = { events: [], results: [], errors: [], mediaSources: [], evictions: [], presented: {} }
    const original = MediaSource.prototype.addSourceBuffer
    MediaSource.prototype.addSourceBuffer = function(type: string) {
      const buffer = original.call(this, type)
      let entry = observed.liveClock.mediaSources.find((item: any) => item.source === this)
      if (!entry) { entry = { source: this, buffers: [] }; observed.liveClock.mediaSources.push(entry) }
      entry.buffers.push(buffer)
      return buffer
    }
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker
      if (String(args[0]).includes('recognition.worker')) {
        worker.addEventListener('error', event => observed.liveClock.errors.push(event.message))
        worker.addEventListener('message', event => {
          const result = event.data
          if (result.type === 'error') observed.liveClock.errors.push(result.message)
          if (result.type === 'result') observed.liveClock.results.push({ at: performance.now(), role: result.role,
            outcome: result.outcome, tickMoment: result.tickMoment })
        })
      }
      return worker
    } })
    for (const type of ['seeking', 'seeked', 'waiting', 'playing', 'stalled', 'ratechange']) {
      document.addEventListener(type, event => {
        const video = event.target
        if (!(video instanceof HTMLVideoElement) || !video.dataset.role) return
        observed.liveClock.events.push({ type, at: performance.now(), role: video.dataset.role,
          time: video.currentTime, readyState: video.readyState, rate: video.playbackRate })
      }, true)
    }
  })
  const fixture = await startLiveClockFixture(page)
  try {
    await openPlayer(page)
    for (const role of ['official', 'commentary'] as const) {
      await page.mouse.move(1, 1)
      await loadSource(page, role, `/test-sources/live-clock/${role}/index.m3u8`)
    }
    await waitForBothReady(page)
    await setPlaying(page, false)
    await seekBoth(page, 18, 13)
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')]
      .every(video => !video.seeking && video.readyState >= 3))
    await page.evaluate(() => {
      const observed = (window as any).liveClock
      for (const video of document.querySelectorAll<HTMLVideoElement>('video.media-element')) {
        const capture: VideoFrameRequestCallback = (_now, metadata) => {
          observed.presented[video.dataset.role!] = { mediaTime: metadata.mediaTime, at: metadata.expectedDisplayTime }
          video.requestVideoFrameCallback(capture)
        }
        video.requestVideoFrameCallback(capture)
      }
      observed.startedAt = performance.now()
    })
    await setPlaying(page, true)
    await page.keyboard.press('a')
    await expect(page.locator('.align-main.is-running')).toHaveCount(1)

    // Evict real old MSE data during measurement so the ensuing five-second rewind
    // has to fetch a fragment again. No media clock/readiness property is mocked.
    await page.waitForTimeout(4000)
    const maximumSequence = await page.evaluate(async () => {
      const observed = (window as any).liveClock
      const video = document.querySelector<HTMLVideoElement>('video[data-role="official"]')!
      const until = video.currentTime - 2
      const source = observed.mediaSources[0]
      if (!source?.buffers.length) throw new Error('No real MSE SourceBuffer was observed')
      for (const buffer of source.buffers as SourceBuffer[]) {
        if (buffer.updating) await new Promise<void>(resolve => buffer.addEventListener('updateend', () => resolve(), { once: true }))
        const before = Array.from({ length: buffer.buffered.length }, (_, index) => [buffer.buffered.start(index), buffer.buffered.end(index)])
        await new Promise<void>((resolve, reject) => {
          buffer.addEventListener('updateend', () => resolve(), { once: true })
          buffer.addEventListener('error', () => reject(new Error('MSE fixture eviction failed')), { once: true })
          buffer.remove(0, until)
        })
        observed.evictions.push({ at: performance.now(), until, before,
          after: Array.from({ length: buffer.buffered.length }, (_, index) => [buffer.buffered.start(index), buffer.buffered.end(index)]) })
      }
      return Math.floor(video.currentTime / 2)
    })
    fixture.armRewindFault(maximumSequence, fault.delayMs, fault.failOnce)

    await expect(page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 110_000 })
    const result = await (await openAlignOptions(page)).locator('.menu-meta').last().innerText()
    const report = await page.evaluate(() => {
      const state = (window as any).liveClock
      return { events: state.events, results: state.results, errors: state.errors, evictions: state.evictions,
        startedAt: state.startedAt, finishedAt: performance.now(), presented: state.presented,
        videos: [...document.querySelectorAll<HTMLVideoElement>('video.media-element')].map(video => ({
          role: video.dataset.role, time: video.currentTime, readyState: video.readyState, rate: video.playbackRate,
          seekable: Array.from({ length: video.seekable.length }, (_, index) => [video.seekable.start(index), video.seekable.end(index)]),
        })) }
    })
    const reportPath = test.info().outputPath('live-clock-report.json')
    await writeFile(reportPath, JSON.stringify({ result, network: fixture.requests, ...report }, null, 2))
    await test.info().attach('live-clock-report', { path: reportPath, contentType: 'application/json' })
    await page.screenshot({ path: test.info().outputPath('live-clock-result.png') })
    expect(report.errors).toEqual([])
    expect(fixture.requests.some(request => request.delayMs >= fault.delayMs)).toBe(true)
    if (fault.failOnce) expect(fixture.requests.some(request => request.status === 503)).toBe(true)
    const playlists = fixture.requests.filter(request => request.playlistEnd !== undefined)
    expect(new Set(playlists.map(request => request.playlistEnd)).size).toBeGreaterThan(2)
    expect(playlists.some(request => request.playlistStart! > 0)).toBe(true)
    expect(report.evictions).toHaveLength(1)
    const seeks = report.events.filter((event: any) => event.at > report.startedAt && event.role === 'official' && event.type === 'seeking')
    expect(seeks.length).toBeGreaterThan(0)
    expect(report.events.some((event: any) => event.at > report.startedAt && event.role === 'official' && event.type === 'waiting')).toBe(true)
    expect(result).toContain('复核误差')
    const divergence = Number(/复核误差\s+([\d.+-]+)/.exec(result)?.[1])
    expect(divergence, result).toBeLessThanOrEqual(.25)
    const official = report.videos.find((video: any) => video.role === 'official')!
    const commentary = report.videos.find((video: any) => video.role === 'commentary')!
    expect(Math.abs(official.time - commentary.time)).toBeLessThanOrEqual(.30)
    expect(Math.abs(report.presented.official.mediaTime - report.presented.commentary.mediaTime)).toBeLessThanOrEqual(.30)
    for (const role of ['official', 'commentary']) {
      const reread = report.results.filter((entry: any) => entry.role === role && entry.at > seeks[0].at
        && entry.outcome.status === 'success' && entry.tickMoment)
      expect(new Set(reread.map((entry: any) => entry.outcome.reading.seconds)).size).toBeGreaterThanOrEqual(2)
    }
    expect(official.rate).toBe(1)
    expect(commentary.rate).toBe(1)
  } finally { await fixture.close() }
})
}
