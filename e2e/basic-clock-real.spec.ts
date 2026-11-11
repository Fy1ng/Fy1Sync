/** Optional real-recording regression. Both roles use the same recording, within one round. */
import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron'
import { openAlignOptions, openPlayer, revealOverlay, seekBoth, setPlaying, waitForBothReady } from './helpers'

// Optional source-relative crop isolates glyph recognition from automatic discovery.
const fixedRoi = process.env.STREAM_SYNC_REAL_CLOCK_ROI ? JSON.parse(process.env.STREAM_SYNC_REAL_CLOCK_ROI) : null

for (const [officialStart, commentaryStart] of [[10, 5], [5, 0]] as const) {
test(`真实录像从 ${officialStart}/${commentaryStart} 秒识别跳秒并对齐已知5秒偏差`, async ({ page }) => {
  test.skip(!process.env.STREAM_SYNC_REAL_CLOCK_VIDEO, '未指定隔离目录中的真实录像片段')
  test.setTimeout(90_000)
  await page.addInitScript(roi => {
    const state = window as any
    if (roi) {
      const settings = JSON.parse(localStorage.getItem('stream-sync.settings.v1') || '{}')
      localStorage.setItem('stream-sync.settings.v1', JSON.stringify({ ...settings, basicClockRoi: roi }))
    }
    state.clockResults = []; state.clockCaptures = []; state.clockErrors = []; state.clockFrames = []
    const captured = new Set<string>()
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker
      if (String(args[0]).includes('recognition.worker')) {
        worker.addEventListener('error', event => state.clockErrors.push(event.message))
        worker.addEventListener('message', event => {
          const result = event.data
          if (result.type === 'error') state.clockErrors.push(result.message)
          if (result.type === 'result') state.clockResults.push({ role: result.role, outcome: result.outcome,
            basic: result.basic ? { ...result.basic, preview: undefined } : undefined,
            elapsedMs: result.elapsedMs, tickMoment: result.tickMoment })
        })
        const post = worker.postMessage.bind(worker)
        worker.postMessage = ((message: any, transfer?: Transferable[]) => {
          if (message.type === 'frame') {
            state.clockCaptures.push({ width: message.width, height: message.height })
            const key = `${message.role}:${Math.floor(message.mediaTime)}`
            if (roi && !captured.has(key)) {
              captured.add(key)
              const left = Math.floor(roi.x * message.width), top = Math.floor(roi.y * message.height)
              const width = Math.ceil((roi.x + roi.w) * message.width) - left
              const height = Math.ceil((roi.y + roi.h) * message.height) - top
              const pixels = new Uint8Array(message.pixels), crop = new Uint8Array(width * height * 4)
              for (let y = 0; y < height; y++) {
                const start = ((top + y) * message.width + left) * 4
                crop.set(pixels.subarray(start, start + width * 4), y * width * 4)
              }
              state.clockFrames.push({ role: message.role, mediaTime: message.mediaTime, width, height, pixels: [...crop] })
            }
          }
          post(message, transfer ?? [])
        }) as Worker['postMessage']
      }
      return worker
    } })
  }, fixedRoi)
  await openPlayer(page)
  for (const role of ['official', 'commentary'] as const) {
    // Moving away guarantees a fresh mouse event when the dock has auto-hidden.
    await page.mouse.move(1, 1)
    await revealOverlay(page)
    await page.locator(`.chip[data-role="${role}"]`).click()
    const panel = page.getByRole('dialog', { name: role === 'official' ? '画面片源' : '解说片源', exact: true })
    await panel.locator('input[type="file"]').setInputFiles(role === 'commentary'
      ? process.env.STREAM_SYNC_REAL_CLOCK_COMMENTARY_VIDEO || process.env.STREAM_SYNC_REAL_CLOCK_VIDEO!
      : process.env.STREAM_SYNC_REAL_CLOCK_VIDEO!)
    await expect(panel).toBeHidden()
  }
  await waitForBothReady(page)
  await setPlaying(page, false)
  await seekBoth(page, officialStart, commentaryStart)
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')]
    .every(video => !video.seeking && video.readyState >= 2))
  await setPlaying(page, true)
  const before = await page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')]
    .map(video => {
      const quality = video.getVideoPlaybackQuality()
      return { role: video.dataset.role, quality: { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames } }
    }))
  const started = Date.now()
  await page.keyboard.press('a')
  await expect(page.locator('.align-main.is-running')).toHaveCount(1)
  await expect(page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 60_000 })
  const options = await openAlignOptions(page)
  const result = await options.locator('.menu-meta').last().innerText()
  const telemetry = await page.evaluate(() => ({ results: (window as any).clockResults, captures: (window as any).clockCaptures,
    errors: (window as any).clockErrors, frames: (window as any).clockFrames }))
  const playback = await page.evaluate(previous => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')].map(video => {
    const old = previous.find(item => item.role === video.dataset.role)!.quality
    const quality = video.getVideoPlaybackQuality()
    return { role: video.dataset.role, totalFrames: quality.totalVideoFrames - old.totalVideoFrames,
      droppedFrames: quality.droppedVideoFrames - old.droppedVideoFrames, currentTime: video.currentTime }
  }), before)
  const reportPath = test.info().outputPath('real-clock-results.json')
  await writeFile(reportPath, JSON.stringify({ result, elapsedMs: Date.now() - started, playback, ...telemetry }))
  await test.info().attach('real-clock-results', { path: reportPath, contentType: 'application/json' })
  await page.screenshot({ path: test.info().outputPath('real-clock-result.png') })
  expect(telemetry.errors).toEqual([])
  for (const role of ['official', 'commentary']) {
    expect(telemetry.results.some((entry: any) => entry.role === role && entry.outcome.status === 'success')).toBe(true)
    expect(telemetry.results.some((entry: any) => entry.role === role && entry.tickMoment)).toBe(true)
  }
  expect(result).toContain('上次测得偏差')
  const estimate = Number(/上次测得偏差\s+([\d.+-]+)/.exec(result)?.[1])
  expect(Math.abs(estimate - 5), result).toBeLessThanOrEqual(.25)
  expect(telemetry.captures.length).toBeGreaterThan(0)
  // Reverification opens additional windows, still capped at 15 fps per role.
  expect(telemetry.captures.length).toBeLessThanOrEqual(Math.ceil((Date.now() - started) / 1000 * 30) + 16)
  expect(Math.max(...telemetry.captures.map((frame: { width: number }) => frame.width))).toBeLessThanOrEqual(1920)
  for (const video of playback) expect(video.droppedFrames / Math.max(1, video.totalFrames)).toBeLessThan(.05)
  const official = playback.find(video => video.role === 'official')!
  const commentary = playback.find(video => video.role === 'commentary')!
  expect(Math.abs(official.currentTime - commentary.currentTime)).toBeLessThan(.55)
})
}
