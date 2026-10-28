import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFfmpegArgs, parseHlsSegments } from '../electron/bufferManager'
import { locateTool } from '../electron/toolLocator'
import { decoderTelemetry } from './adaptiveTelemetry'
import { expect, test } from './electron'
import { closeSourceDialog, loadSource, openPlayer, setPlaying } from './helpers'

test.describe('opt-in local adaptive decode comparison', () => {
  test.skip(process.env.STREAM_SYNC_ADAPTIVE_LOCAL_TESTS !== '1', '本地解码诊断需显式启用, 默认跳过.')

  test('replays captured or synthetic VP9 fMP4 with no upstream network', async ({ page, electronApp }) => {
    const seconds = Number(process.env.STREAM_SYNC_ADAPTIVE_LOCAL_SECONDS ?? 300)
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 1200) throw new Error('本地诊断时长无效')
    test.setTimeout((seconds + 180) * 1000)
    const fixtureBase = fileURLToPath(new URL('../dist/client/test-sources/', import.meta.url))
    const directory = await mkdtemp(path.join(fixtureBase, 'adaptive-local-'))
    const media = path.join(directory, 'buffer')
    await mkdir(media)
    const decoder = await decoderTelemetry(page, electronApp)
    try {
      const captured = process.env.STREAM_SYNC_ADAPTIVE_LOCAL_CAPTURE
      let source = media
      if (captured) {
        const candidate = path.resolve(captured)
        const allowed = path.resolve('.runtime-cache/resume-20261023/live')
        if (!candidate.startsWith(allowed + path.sep)) throw new Error('捕获片段必须位于本轮隔离诊断目录')
        source = candidate
      } else {
        const ffmpeg = await locateTool('ffmpeg', { ffmpegPath: process.env.STREAM_SYNC_FIXTURE_FFMPEG })
        const args = buildFfmpegArgs({ url: 'https://fixture.invalid/live.m3u8' }, media, 0, 'pipe:3', true)
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=60',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '8M', '-g', '120', '-c:a', 'aac',
          ...args.slice(args.indexOf('-c') + 2)], { cwd: media, windowsHide: true, timeout: 120_000, stdio: 'pipe' })
      }
      const original = await readFile(path.join(source, captured ? 'index.m3u8' : 'raw_0.m3u8'), 'utf8')
      const segments = parseHlsSegments(original).segments
      const duration = segments.reduce((sum, segment) => sum + segment.duration, 0)
      if (duration < 5) throw new Error('本地诊断片段不足5秒')
      const names = [...new Set(segments.flatMap(segment => [segment.init!, segment.uri]))]
      if (captured) await Promise.all(names.map(name => copyFile(path.join(source, name), path.join(media, name))))
      const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
      const repeats = Math.ceil((seconds + 30) / duration)
      for (let repeat = 0; repeat < repeats; repeat++) {
        if (repeat) lines.push('#EXT-X-DISCONTINUITY')
        lines.push(`#EXT-X-MAP:URI="${segments[0]!.init}"`)
        segments.forEach(segment => lines.push(`#EXTINF:${segment.duration},`, segment.uri))
      }
      lines.push('#EXT-X-ENDLIST')
      await writeFile(path.join(media, 'index.m3u8'), lines.join('\n') + '\n')
      await openPlayer(page)
      await loadSource(page, 'official', `/test-sources/${path.basename(directory)}/buffer/index.m3u8`)
      await closeSourceDialog(page)
      const video = page.locator('video[data-role="official"]')
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2)
      await setPlaying(page, true)
      const sample = () => video.evaluate((node: HTMLVideoElement) => {
        const quality = node.getVideoPlaybackQuality()
        const bufferedEnd = node.buffered.length ? node.buffered.end(node.buffered.length - 1) : 0
        return { wall: performance.now(), time: node.currentTime, height: node.videoHeight, total: quality.totalVideoFrames,
          dropped: quality.droppedVideoFrames, ready: node.readyState, ahead: bufferedEnd - node.currentTime,
          error: node.error?.code ?? null, rate: node.playbackRate, visibility: document.visibilityState }
      })
      const first = await sample()
      const samples = [first]
      let complete = false
      try {
        for (;;) {
          await page.waitForTimeout(5000)
          const current = await sample()
          samples.push(current)
          expect(current.height).toBe(1440)
          expect(current.error).toBeNull()
          if (samples.length % 12 === 0) console.log('LOCAL_PROGRESS ' + JSON.stringify({
            source: captured ? 'captured' : 'synthetic', elapsed: (current.wall - first.wall) / 1000, media: current.time - first.time,
            dropped: current.dropped - first.dropped, ahead: current.ahead, ready: current.ready,
          }))
          if (current.time <= samples.at(-2)!.time + 0.1) throw new Error('本地片段回放在采样间隔内停顿')
          if ((current.wall - first.wall) / 1000 >= seconds) {
            if (current.time - first.time < seconds - 2) throw new Error('本地片段回放未覆盖指定实际时长')
            complete = true; break
          }
        }
      } finally {
        const last = samples.at(-1)!
        const file = test.info().outputPath('local-playback-observation.json')
        await mkdir(test.info().outputDir, { recursive: true })
        await writeFile(file, JSON.stringify({ complete, source: captured ? 'captured' : 'synthetic', elapsed: (last.wall - first.wall) / 1000,
          media: last.time - first.time, total: last.total - first.total, dropped: last.dropped - first.dropped, decoder: decoder.info, samples }, null, 2))
        await test.info().attach('local-playback-observation', { path: file, contentType: 'application/json' })
      }
    } finally {
      await decoder.close()
      if (path.dirname(directory) !== path.resolve(fixtureBase) || !path.basename(directory).startsWith('adaptive-local-')) throw new Error('Invalid local fixture cleanup path')
      await rm(directory, { recursive: true, force: true })
    }
  })
})
