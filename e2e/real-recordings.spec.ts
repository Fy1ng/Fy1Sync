/** Explicit local-only acceptance. The recordings are not fixtures and never enter Git/packages. */
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, launchApplication, test } from './electron'
import { loadSource, openPlayer, seekBoth, setPlaying, revealOverlay, openAlignOptions } from './helpers'
import { decoderTelemetry } from './adaptiveTelemetry'

test.describe('opt-in real recording acceptance', () => {
  test.skip(process.env.STREAM_SYNC_REAL_RECORDINGS !== '1', '需要显式启用本机同场录像验收')
  const playbackOnly = process.env.STREAM_SYNC_REAL_PLAYBACK_ONLY === '1'
  for (const group of [
    { name: '1080p-pair', directory: '2026-10-18T20-19-14-448Z', official: 'official-youtube.ts', from: 300, start: [48, 84], height: 1080 },
    { name: '1440p-pair', directory: '2026-10-18T21-02-39Z-max', official: 'official-youtube-1440.mkv', from: 0, start: [12, 12], height: 1440 },
  ]) test(group.name + (playbackOnly ? ' playback and resource observation' : ' native ROI learning and playback'), async ({}, testInfo) => {
    test.setTimeout(240_000)
    const root = process.cwd()
    const evidence = path.resolve(root, '.runtime-cache', 'fy1sync-20261027', playbackOnly ? 'real-playback-only' : 'real-playback', group.name)
    await mkdir(evidence, { recursive: true })
    const fixtureRoot = path.resolve(root, 'dist/client/test-sources')
    const fixture = await mkdtemp(path.join(fixtureRoot, 'real-recording-'))
    const running = await launchApplication('real-' + group.name + '-' + randomUUID())
    const decoder = await decoderTelemetry(running.page, running.application)
    const errors: string[] = [], diagnostics: string[] = [], prompts: Record<string, string> = {}, samples: unknown[] = []
    let result = '', completed = false, externalRequests = 0
    try {
      running.page.on('pageerror', e => errors.push(e.message))
      running.page.on('console', message => { if (message.type() === 'error' && diagnostics.length < 30) diagnostics.push(message.text()) })
      running.page.on('requestfailed', request => { if (diagnostics.length < 30) diagnostics.push(request.url() + ': ' + request.failure()?.errorText) })
      running.page.on('response', response => { if (response.status() >= 400 && diagnostics.length < 30) diagnostics.push(response.status() + ' ' + response.url()) })
      await running.page.addInitScript(() => {
        const logs: unknown[] = [], frames: unknown[] = []
        Object.assign(window, { __recordingWorkers: logs, __recordingFrames: frames })
        const Native = window.Worker
        let workerId = 0
        window.Worker = class extends Native {
          readonly traceId = ++workerId
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options)
            this.addEventListener('message', event => {
              const data = event.data
              if (data?.type === 'located' || data?.type === 'learned') logs.push({ worker: this.traceId, ...data })
            })
          }
          override postMessage(data: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
            const request = data as { type?: string; frames?: Array<{ pixels: ArrayBuffer; width: number; height: number; mediaTime: number }> }
            if (request?.type === 'learn' && frames.length < 4) frames.push({ worker: this.traceId, frames: request.frames?.map(frame => ({
              width: frame.width, height: frame.height, mediaTime: frame.mediaTime, pixels: Array.from(new Uint8Array(frame.pixels)),
            })) })
            super.postMessage(data, transfer as Transferable[])
          }
        }
      })
      running.page.on('request', req => { if (/^https?:/.test(req.url())) externalRequests++ })
      const ffmpeg = process.env.STREAM_SYNC_FFMPEG || 'ffmpeg'
      for (const role of ['official', 'commentary'] as const) {
        const target = path.join(evidence, role)
        await mkdir(target, { recursive: true })
        const input = path.resolve(root, 'prototype/.media', group.directory, role === 'official' ? group.official : 'commentary-douyu.ts')
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(group.from), '-i', input,
          '-t', '180', '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-avoid_negative_ts', 'make_zero',
          '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_time', '2', '-hls_playlist_type', 'vod',
          '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(target, 'part-%03d.m4s'), path.join(target, 'index.m3u8')],
        { cwd: target, windowsHide: true, timeout: 30_000, stdio: 'pipe' })
        const served = path.join(fixture, role)
        await mkdir(served)
        for (const name of await readdir(target)) await copyFile(path.join(target, name), path.join(served, name))
      }
      await openPlayer(running.page)
      for (const role of ['official', 'commentary'] as const) {
        await loadSource(running.page, role, `/test-sources/${path.basename(fixture)}/${role}/index.m3u8`)
        await expect.poll(() => running.page.locator(`video[data-role="${role}"]`).evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
      }
      await seekBoth(running.page, group.start[0]!, group.start[1]!)
      await setPlaying(running.page, true)
      await expect.poll(() => running.page.locator('video.media-element').evaluateAll(nodes => nodes.every(node => {
        const video = node as HTMLVideoElement
        return !video.seeking && !video.paused && video.readyState >= 2 && video.videoWidth > 0
      })), { timeout: 20_000 }).toBe(true)
      const sample = async () => ({
        media: await running.page.locator('video.media-element').evaluateAll(nodes => nodes.map(node => {
          const video = node as HTMLVideoElement, q = video.getVideoPlaybackQuality()
          return { role: video.dataset.role, time: video.currentTime, width: video.videoWidth, height: video.videoHeight,
            ready: video.readyState, paused: video.paused, frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, error: video.error?.code ?? null }
        })),
        resources: await running.application.evaluate(({ app }) => {
          const metrics = app.getAppMetrics()
          return { at: Date.now(), cpuPercent: metrics.reduce((n, p) => n + p.cpu.percentCPUUsage, 0), workingSetMiB: metrics.reduce((n, p) => n + p.memory.workingSetSize, 0) / 1024 }
        }),
      })
      samples.push(await sample())
      if (!playbackOnly) {
      await revealOverlay(running.page)
      await running.page.getByRole('button', { name: '自动对齐', exact: true }).click()
      for (const role of ['official', 'commentary'] as const) {
        const card = running.page.locator(`.prompt[data-role="${role}"]`)
        await expect(card).toContainText('已识别比赛倒计时', { timeout: 65_000 })
        prompts[role] = await card.innerText()
        await revealOverlay(running.page)
        await card.getByRole('button', { name: '使用', exact: true }).click()
      }
      const options = await openAlignOptions(running.page)
      await expect(running.page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 45_000 })
      result = await options.locator('.menu-meta').innerText()
      await running.page.screenshot({ path: path.join(evidence, 'aligned.png') })
      await running.page.keyboard.press('Escape')
      }
      for (let i = 0; i < 6; i++) {
        await running.page.waitForTimeout(5000)
        samples.push(await sample())
      }
      const last = (samples.at(-1) as Awaited<ReturnType<typeof sample>>).media
      expect(last.find(m => m.role === 'official')?.height).toBe(group.height)
      expect(last.every(m => m.ready >= 2 && !m.error && m.frames > 1200)).toBe(true)
      expect(errors).toEqual([])
      expect(externalRequests).toBe(0)
      if (!playbackOnly) expect(result).toContain('上次测得偏差')
      completed = true
    } finally {
      if (!completed) {
        await running.page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
        if (!result) result = await running.page.locator('.prompt-stack').innerText().catch(() => result)
      }
      await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ group, playbackOnly, completed, result, prompts, samples, decoder: decoder.players, errors, diagnostics, externalRequests }, null, 2))
      const workers = await running.page.evaluate(() => ({ logs: (window as unknown as { __recordingWorkers?: unknown }).__recordingWorkers,
        frames: (window as unknown as { __recordingFrames?: unknown }).__recordingFrames })).catch(() => ({}))
      await writeFile(path.join(evidence, 'workers.json'), JSON.stringify(workers))
      await testInfo.attach('recording-report', { path: path.join(evidence, 'report.json'), contentType: 'application/json' })
      await decoder.close()
      await running.close()
      if (path.dirname(fixture) !== fixtureRoot || !path.basename(fixture).startsWith('real-recording-')) throw new Error('Invalid disposable fixture path')
      await rm(fixture, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
