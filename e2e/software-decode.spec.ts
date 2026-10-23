import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@playwright/test'
import { parseHlsSegments } from '../electron/bufferManager'
import { expect, launchApplication } from './electron'
import { decodingStartup, selectSoftwareDecoding } from './decoderSettings'
import { decoderTelemetry } from './adaptiveTelemetry'
import { closeSourceDialog, loadSource, openPlayer, revealOverlay } from './helpers'

test.describe('opt-in persisted software decoding', () => {
  test.skip(process.env.STREAM_SYNC_SOFTWARE_DECODE_TESTS !== '1', '真实片段诊断需显式启用, 默认跳过.')

  for (const routes of [1, 2]) test(`${routes} route captured VP9 with persisted software mode`, async ({}, testInfo) => {
    const seconds = Number(process.env.STREAM_SYNC_SOFTWARE_DECODE_SECONDS ?? 30)
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 7200) throw new Error('诊断时长必须是10到7200之间的整数')
    if (seconds > 120 && process.env.STREAM_SYNC_SOFTWARE_DECODE_LONG !== '1') throw new Error('长测还需显式设置 STREAM_SYNC_SOFTWARE_DECODE_LONG=1')
    test.setTimeout((seconds + 150) * 1000)
    const capture = process.env.STREAM_SYNC_SOFTWARE_DECODE_CAPTURE
    if (!capture) throw new Error('需显式提供已授权的本地VP9片段目录')
    const source = path.resolve(capture)
    const allowed = path.resolve('.runtime-cache/resume-20261023/live/user-60-capture-results')
    if (!source.startsWith(allowed + path.sep) || path.basename(source) !== 'local-media') throw new Error('片段必须位于已授权的隔离捕获目录')
    const fixtureRoot = fileURLToPath(new URL('../dist/client/test-sources/', import.meta.url))
    const running = await launchApplication(`software-decode-${routes}`, { softwareVideo: false })
    let fixture = ''
    let decoder: Awaited<ReturnType<typeof decoderTelemetry>> | undefined
    const startup: unknown[] = []
    const samples: unknown[] = []
    let playbackSummary: { role: string | undefined; mediaSeconds: number; totalFrames: number; droppedFrames: number;
      droppedRatio: number; decodedFps: number; deliveredFps: number; wallLagSeconds: number }[] = []
    let complete = false
    let externalRequests = 0
    try {
      fixture = await mkdtemp(path.join(fixtureRoot, 'software-decode-'))
      const original = await readFile(path.join(source, 'index.m3u8'), 'utf8')
      const segments = parseHlsSegments(original).segments
      const duration = segments.reduce((sum, segment) => sum + segment.duration, 0)
      const names = [...new Set(segments.flatMap(segment => [segment.init!, segment.uri]))]
      if (duration < 5 || names.some(name => !/^(?:init_\d+\.mp4|segment_\d+_\d{9}\.m4s)$/.test(name))) throw new Error('片段清单或文件名无效')
      await Promise.all(names.map(name => copyFile(path.join(source, name), path.join(fixture, name))))
      const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
      for (let i = 0; i < Math.ceil((seconds + 30) / duration); i++) {
        if (i) lines.push('#EXT-X-DISCONTINUITY')
        lines.push(`#EXT-X-MAP:URI="${segments[0]!.init}"`)
        segments.forEach(segment => lines.push(`#EXTINF:${segment.duration},`, segment.uri))
      }
      lines.push('#EXT-X-ENDLIST')
      await writeFile(path.join(fixture, 'index.m3u8'), lines.join('\n') + '\n')
      await openPlayer(running.page)
      await selectSoftwareDecoding(running, true)
      startup.push(await decodingStartup(running))
      await running.restart()
      await openPlayer(running.page)
      running.page.on('request', request => { if (/^https?:/i.test(request.url())) externalRequests++ })
      startup.push(await decodingStartup(running))
      expect(startup[1]).toMatchObject({ preferences: { ok: true, value: { mode: 'software', effectiveMode: 'software', restartRequired: false, forcedByCommandLine: false } }, switches: { videoDisabled: true, gpuDisabled: false, gpuCompositingDisabled: false } })
      decoder = await decoderTelemetry(running.page, running.application)
      const url = `/test-sources/${path.basename(fixture)}/index.m3u8`
      for (const role of (routes === 1 ? ['official'] : ['official', 'commentary']) as ('official' | 'commentary')[]) await loadSource(running.page, role, url)
      await closeSourceDialog(running.page)
      await expect.poll(() => running.page.locator('video').evaluateAll(nodes => nodes.filter(node => (node as HTMLVideoElement).readyState >= 2).length)).toBe(routes)
      await revealOverlay(running.page)
      await running.page.locator('.play-button').click()
      const sample = async () => ({
        playback: await running.page.evaluate(() => ({
          wall: performance.now(), visibility: document.visibilityState, focused: document.hasFocus(),
          routes: [...document.querySelectorAll<HTMLVideoElement>('video[data-role]')].filter(video => video.currentSrc).map(video => {
            const quality = video.getVideoPlaybackQuality()
            return { role: video.dataset.role, time: video.currentTime, width: video.videoWidth, height: video.videoHeight, paused: video.paused,
              ready: video.readyState, rate: video.playbackRate, total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames, error: video.error?.code ?? null }
          }),
        })),
        resources: await running.application.evaluate(({ app }) => {
          const metrics = app.getAppMetrics()
          return { cpuPercentSum: metrics.reduce((sum, entry) => sum + entry.cpu.percentCPUUsage, 0),
            workingSetMiB: metrics.reduce((sum, entry) => sum + entry.memory.workingSetSize, 0) / 1024,
            processes: metrics.map(entry => ({ type: entry.type, cpuPercent: entry.cpu.percentCPUUsage, workingSetMiB: entry.memory.workingSetSize / 1024 })) }
        }),
      })
      const first = await sample()
      samples.push(first)
      let previous = first
      for (;;) {
        await running.page.waitForTimeout(5000)
        const current = await sample()
        samples.push(current)
        const elapsed = (current.playback.wall - first.playback.wall) / 1000
        playbackSummary = current.playback.routes.map(route => {
          const initial = first.playback.routes.find(item => item.role === route.role)!
          const mediaSeconds = route.time - initial.time
          const totalFrames = route.total - initial.total
          const droppedFrames = route.dropped - initial.dropped
          return { role: route.role, mediaSeconds, totalFrames, droppedFrames,
            droppedRatio: totalFrames > 0 ? droppedFrames / totalFrames : 0,
            decodedFps: mediaSeconds > 0 ? totalFrames / mediaSeconds : 0,
            deliveredFps: mediaSeconds > 0 ? (totalFrames - droppedFrames) / mediaSeconds : 0,
            wallLagSeconds: elapsed - mediaSeconds }
        })
        expect(current.playback.routes).toHaveLength(routes)
        for (const route of current.playback.routes) {
          expect(route).toMatchObject({ width: 2560, height: 1440, paused: false, rate: 1, error: null })
          expect(route.time - previous.playback.routes.find(item => item.role === route.role)!.time).toBeGreaterThan(0.1)
        }
        if (samples.length % 12 === 0) console.log('SOFTWARE_PROGRESS ' + JSON.stringify({ routes, elapsed, playback: current.playback.routes, summary: playbackSummary, resources: current.resources }))
        if (elapsed >= seconds) {
          current.playback.routes.forEach(route => expect(route.time - first.playback.routes.find(item => item.role === route.role)!.time).toBeGreaterThanOrEqual(seconds - 2))
          playbackSummary.forEach(route => expect(route.decodedFps).toBeGreaterThanOrEqual(57))
          break
        }
        previous = current
      }
      const players = Object.values(decoder.players).filter(player => player.decoder)
      expect(players).toHaveLength(routes)
      players.forEach(player => expect(player).toMatchObject({ codec: 'vp9', decoder: 'VpxVideoDecoder', platform: false }))
      expect(externalRequests).toBe(0)
      await running.page.screenshot({ path: testInfo.outputPath('software-playback.png'), fullPage: true })
      complete = true
    } finally {
      await mkdir(testInfo.outputDir, { recursive: true })
      await writeFile(testInfo.outputPath('software-playback.json'), JSON.stringify({ complete, routes, requestedSeconds: seconds, fixture: { source: 'authorized-local-captured-VP9', durationPerLoop: 'about60s', inputRoutes: routes, width: 2560, height: 1440, fps: 60 },
        startup, decoder: decoder?.info, players: Object.values(decoder?.players ?? {}).filter(player => player.decoder), externalRequests,
        minimumDecodedFps: 57, playbackSummary,
        resourceUnits: { cpuPercentSum: 'sum of Electron app.getAppMetrics cpu.percentCPUUsage, first sample excluded from summary', workingSetMiB: 'sum of Electron processes workingSetSize KiB / 1024; shared pages may be counted more than once' }, samples }, null, 2))
      await decoder?.close().catch(() => {})
      await running.close()
      if (fixture) {
        if (path.dirname(path.resolve(fixture)) !== path.resolve(fixtureRoot) || !path.basename(fixture).startsWith('software-decode-')) throw new Error('Invalid software fixture cleanup path')
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })
})
