/** The file/blob route must play smoothly before recognition is explicitly requested. */
import { fileURLToPath } from 'node:url'
import { expect, test } from './electron'
import { openAlignOptions, openPlayer, revealOverlay, seekBoth, setCheckedByLabel, setPlaying, waitForBothReady } from './helpers'

test('本地文件在两种识别模式空闲时均正常播放, 不启动识别 Worker', async ({ page, electronApp }) => {
  test.setTimeout(90_000)
  const recognitionWorkers: string[] = []
  page.on('worker', worker => { if (worker.url().includes('recognition.worker')) recognitionWorkers.push(worker.url()) })
  await openPlayer(page)
  for (const role of ['official', 'commentary'] as const) {
    await revealOverlay(page)
    await page.locator(`.chip[data-role="${role}"]`).click()
    const panel = page.getByRole('dialog', { name: role === 'official' ? '画面片源' : '解说片源', exact: true })
    const file = (role === 'official' ? process.env.STREAM_SYNC_PLAYBACK_OFFICIAL : process.env.STREAM_SYNC_PLAYBACK_COMMENTARY)
      || fileURLToPath(new URL(`../public/test-sources/auto-${role}.mp4`, import.meta.url))
    await panel.locator('input[type="file"]').setInputFiles(file)
    await expect(panel).toBeHidden()
  }
  await waitForBothReady(page)
  await seekBoth(page, 8, 8)
  await setPlaying(page, true)
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')]
    .every(video => !video.seeking && video.readyState >= 3)), { timeout: 20_000 }).toBe(true)
  const gpu = await electronApp.evaluate(({ app }) => app.getGPUFeatureStatus())
  const media = await page.context().newCDPSession(page)
  const decoderProperties: unknown[] = []
  media.on('Media.playerPropertiesChanged', event => decoderProperties.push(event))
  await media.send('Media.enable')
  const reports = []
  for (const mode of ['基础模式', '样式包模式']) {
    const options = await openAlignOptions(page)
    await setCheckedByLabel(options.getByRole('radio', { name: mode, exact: true }))
    await page.keyboard.press('Escape')
    const measurements = await page.evaluate(async () => {
      const videos = [...document.querySelectorAll<HTMLVideoElement>('video.media-element')]
      const before = videos.map(video => ({ role: video.dataset.role, time: video.currentTime, quality: video.getVideoPlaybackQuality() }))
      const longTasks: number[] = []
      const observer = new PerformanceObserver(list => { longTasks.push(...list.getEntries().map(entry => entry.duration)) })
      observer.observe({ type: 'longtask' })
      const startedAt = performance.now()
      await new Promise(resolve => setTimeout(resolve, 4000))
      observer.disconnect()
      const elapsed = (performance.now() - startedAt) / 1000
      return { elapsed, longTasks, videos: videos.map((video, index) => {
        const quality = video.getVideoPlaybackQuality()
        return { role: video.dataset.role, width: video.videoWidth, height: video.videoHeight,
          advanced: video.currentTime - before[index]!.time, beforeTime: before[index]!.time, afterTime: video.currentTime,
          paused: video.paused, seeking: video.seeking, rate: video.playbackRate, readyState: video.readyState,
          totalFrames: quality.totalVideoFrames - before[index]!.quality.totalVideoFrames,
          droppedFrames: quality.droppedVideoFrames - before[index]!.quality.droppedVideoFrames }
      }) }
    })
    reports.push({ mode, ...measurements })
    expect(recognitionWorkers).toHaveLength(0)
  }
  await test.info().attach('local-file-playback', { body: JSON.stringify({ gpu, decoderProperties, reports }, null, 2), contentType: 'application/json' })
  for (const report of reports) for (const video of report.videos) {
    expect(video.advanced, JSON.stringify(report)).toBeGreaterThan(3.5)
    expect(video.totalFrames - video.droppedFrames, JSON.stringify(report)).toBeGreaterThan(75)
    expect(video.droppedFrames / Math.max(1, video.totalFrames), JSON.stringify(report)).toBeLessThan(.05)
  }
})
