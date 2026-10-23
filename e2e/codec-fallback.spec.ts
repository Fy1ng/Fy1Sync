import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFfmpegArgs, parseHlsSegments } from '../electron/bufferManager'
import { locateTool } from '../electron/toolLocator'
import { expect, test } from './electron'
import { closeSourceDialog, loadSource, openPlayer, revealOverlay } from './helpers'

const fixtureBase = fileURLToPath(new URL('../dist/client/test-sources/', import.meta.url))

test('decodes a VP9 to H264 fMP4 discontinuity without replacing the video element', async ({ page, electronApp }) => {
  let ffmpeg: string
  try { ffmpeg = await locateTool('ffmpeg') }
  catch { test.skip(true, '缺少ffmpeg, 无法生成codec切换fixture.'); return }
  const directory = await mkdtemp(path.join(fixtureBase, 'codec-switch-'))
  const codecs = new Set<string>()
  const cdp = await electronApp.context().newCDPSession(page)
  cdp.on('Media.playerPropertiesChanged', (event: { properties: { name: string; value: string }[] }) => {
    for (const property of event.properties) {
      if (property.name !== 'kVideoTracks') continue
      const codec = /\b(vp9|vp09|h264|avc1)\b/i.exec(property.value)?.[1]
      if (codec) codecs.add(codec.toLowerCase() === 'avc1' ? 'h264' : codec.toLowerCase())
    }
  })
  await cdp.send('Media.enable')
  try {
    for (const [run, codec] of ['libvpx-vp9', 'libx264'].entries()) {
      const args = buildFfmpegArgs({ url: 'https://fixture.invalid/live.m3u8' }, directory, run, 'pipe:3', true)
      const output = args.slice(args.indexOf('-c') + 2)
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', `testsrc2=size=${run === 0 ? '320x180' : '480x270'}:rate=30`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', codec, ...(run === 0 ? ['-deadline', 'realtime', '-cpu-used', '8'] : ['-preset', 'ultrafast']),
        '-g', '60', '-c:a', 'aac', ...output], { cwd: directory, windowsHide: true, timeout: 15_000, stdio: 'pipe' })
    }
    const first = parseHlsSegments(await readFile(path.join(directory, 'raw_0.m3u8'), 'utf8')).segments
    const second = parseHlsSegments(await readFile(path.join(directory, 'raw_1.m3u8'), 'utf8')).segments
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:3', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
    for (const [run, segments] of [first, second].entries()) {
      if (run) lines.push('#EXT-X-DISCONTINUITY')
      lines.push(`#EXT-X-MAP:URI="init_${run}.mp4"`)
      segments.forEach(segment => lines.push(`#EXTINF:${segment.duration},`, segment.uri))
    }
    lines.push('#EXT-X-ENDLIST')
    await writeFile(path.join(directory, 'index.m3u8'), lines.join('\n') + '\n')
    await openPlayer(page)
    await loadSource(page, 'official', `/test-sources/${path.basename(directory)}/index.m3u8`)
    await closeSourceDialog(page)
    const video = page.locator('video[data-role="official"]')
    const original = await video.elementHandle()
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2)
    expect(await video.evaluate((node: HTMLVideoElement) => node.videoHeight)).toBe(180)
    await revealOverlay(page)
    await page.locator('.play-button').click()
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 25_000 }).toBeGreaterThan(12)
    expect(await video.evaluate((node: HTMLVideoElement) => node.error?.code ?? null)).toBeNull()
    expect(await video.evaluate((node: HTMLVideoElement) => node.videoHeight)).toBe(270)
    expect(await video.evaluate((node, before) => node === before, original)).toBe(true)
    // Chromium may keep its initial track properties across changeType; the
    // distinct H264 dimensions prove that frames from the second init decoded.
    expect([...codecs]).toContain('vp9')
    await test.info().attach('codec-fallback-result', { body: JSON.stringify({ reportedCodecs: [...codecs], encodedCodecs: ['vp9', 'h264'], decodedHeights: [180, 270], passedTransitionSeconds: 8 }), contentType: 'application/json' })
  } finally {
    await cdp.detach()
    if (path.dirname(directory) !== path.resolve(fixtureBase) || !path.basename(directory).startsWith('codec-switch-')) throw new Error('Invalid codec fixture cleanup path')
    await rm(directory, { recursive: true, force: true })
  }
})
