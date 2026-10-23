import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BufferManager, buildFfmpegArgs, parseHlsSegments, type BufferClock, type BufferState, type BufferInput } from './bufferManager'
import { AdaptivePullError } from './adaptivePuller'

const source = { videoUrl: 'https://rr1.googlevideo.com/v?sig=PRIVATE_VIDEO', audioUrl: 'https://rr1.googlevideo.com/a?sig=PRIVATE_AUDIO', videoContainer: 'webm' as const, height: 1440 }
const input: BufferInput = { url: 'https://rr1.googlevideo.com/hls?sig=PRIVATE_HLS', adaptive: source }
class Child extends EventEmitter {
  stdin = new PassThrough()
  stderr = new PassThrough()
  stdio = [this.stdin, null, this.stderr, new PassThrough()]
  kill() { this.emit('close', 1); return true }
}
async function settle(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { timeout: 2000, interval: 5 }) }
const fixtures: { root: string; manager: BufferManager }[] = []
async function fixture(retainSeconds = 180) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer-adaptive-'))
  const states: BufferState[] = [], children: Child[] = [], args: string[][] = []
  const timers = new Map<number, () => void>()
  let serial = 0, time = 0
  const clock: BufferClock = { now: () => time, setTimeout: fn => { timers.set(++serial, fn); return serial }, clearTimeout: id => { timers.delete(id as number) } }
  const advance = async () => {
    const callbacks = [...timers.values()]; timers.clear(); time += 1000
    callbacks.forEach(fn => fn())
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  const pulls: { fail: (error: Error) => void; signal: AbortSignal }[] = []
  const close = vi.fn()
  const manager = new BufferManager({ userDataDir: root, ffmpegPath: 'ffmpeg', clock, retainSeconds, deleteGraceMs: 0,
    adaptiveTransport: async () => ({ audioInput: 'pipe:3', extraPipe: true, close }),
    spawn: (_file, command) => { const child = new Child(); children.push(child); args.push(command); return child },
    pullAdaptive: async (_source, options) => new Promise<void>((_resolve, reject) => {
      pulls.push({ fail: reject, signal: options.signal })
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }), killTree: async child => { child.kill() },
  })
  manager.subscribe(state => states.push(state))
  const current = () => states.filter(item => item.role === 'official').at(-1)!
  const f = { root, manager, states, children, args, advance, pulls, close, current }
  fixtures.push(f)
  return f
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.manager.dispose(); await rm(f.root, { recursive: true, force: true }) } })
async function manifest(f: Awaited<ReturnType<typeof fixture>>, run: number, durations = [2, 2]) {
  const directory = path.dirname(f.args[run]!.at(-1)!)
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-MAP:URI="init_${run}.mp4"`, '#EXT-X-MEDIA-SEQUENCE:0']
  await writeFile(path.join(directory, `init_${run}.mp4`), 'init')
  for (let n = 0; n < durations.length; n++) {
    const uri = `segment_${run}_${String(n).padStart(9, '0')}.m4s`
    await writeFile(path.join(directory, uri), 'fragment')
    lines.push(`#EXTINF:${durations[n]},`, uri)
  }
  await writeFile(path.join(directory, `raw_${run}.m3u8`), lines.join('\n') + '\n')
  return directory
}

describe('adaptive producer in the existing buffer state machine', () => {
  it('re-resolves after expiry then automatically falls back after two failures without changing its capability', async () => {
    const f = await fixture()
    const resolve = vi.fn(async (hlsOnly?: boolean) => hlsOnly ? { url: input.url, qualityHeight: 1080 } : input)
    const { url } = await f.manager.start('official', resolve)
    await settle(() => f.pulls.length === 1)
    await manifest(f, 0)
    await f.advance(); await settle(() => f.current().seconds === 4)
    f.pulls[0]!.fail(new AdaptivePullError('adaptive-expired', 403))
    await settle(() => f.current().state === 'reconnecting')
    await f.advance(); await settle(() => f.pulls.length === 2)
    expect(resolve.mock.calls.map(call => call[0])).toEqual([false, false])
    await manifest(f, 1)
    await f.advance(); await settle(() => f.current().seconds === 8)
    f.children[1]!.emit('close', 1)
    await settle(() => f.current().state === 'reconnecting')
    await f.advance(); await settle(() => f.children.length === 3)
    expect(resolve.mock.calls.map(call => call[0])).toEqual([false, false, true])
    expect(f.args[2]).toContain('-hls_segment_type')
    await manifest(f, 2)
    await f.advance(); await settle(() => f.current().seconds === 12)
    expect(f.current()).toMatchObject({ state: 'ready', notice: { code: 'youtube-adaptive-fallback', fromHeight: 1440, toHeight: 1080 } })
    const body = await (await f.manager.handle(new Request(url))).text()
    expect(body.match(/#EXT-X-DISCONTINUITY\n/g)).toHaveLength(2)
    expect(body.match(/#EXT-X-MAP:/g)).toHaveLength(3)
    expect(JSON.stringify(f.states)).not.toMatch(/PRIVATE|googlevideo|Cookie|pipe:3/)
  })

  it('retains fMP4 by EXTINF sum and removes an init only after its last fragment leaves the window', async () => {
    const f = await fixture(8)
    const { url } = await f.manager.start('official', async () => input)
    await settle(() => f.children.length === 1)
    const directory = await manifest(f, 0, [3, 3, 3])
    await f.advance(); await settle(() => f.current().seconds === 9)
    f.children[0]!.emit('close', 1)
    await settle(() => f.current().state === 'reconnecting')
    await f.advance(); await settle(() => f.children.length === 2)
    await manifest(f, 1, [2])
    await f.advance(); await settle(() => f.current().seconds === 8)
    expect(await readFile(path.join(directory, 'init_0.mp4'), 'utf8')).toBe('init')
    await manifest(f, 1, [2, 2, 2, 2])
    await f.advance()
    await settle(() => f.current().seconds === 8)
    await settle(() => f.states.at(-1)?.state === 'ready')
    await vi.waitFor(async () => expect(await readdir(directory)).not.toContain('init_0.mp4'))
    const body = await (await f.manager.handle(new Request(url))).text()
    expect(body).toContain('#EXT-X-VERSION:7')
    expect(body).toContain('#EXT-X-MAP:URI="init_1.mp4"')
    expect(body).not.toContain('init_0.mp4')
    expect(parseHlsSegments(body).segments).toHaveLength(4)
    const init = await f.manager.handle(new Request(url.replace('index.m3u8', 'init_1.mp4')))
    expect(init.headers.get('content-type')).toBe('video/mp4')
    const segment = await f.manager.handle(new Request(url.replace('index.m3u8', 'segment_1_000000000.m4s'), { headers: { range: 'bytes=0-3' } }))
    expect(segment.status).toBe(206)
    expect(await segment.text()).toBe('frag')
  })

  it('aborts the puller and closes the local transport on stop', async () => {
    const f = await fixture()
    await f.manager.start('official', async () => input)
    await settle(() => f.pulls.length === 1)
    await f.manager.stop('official')
    expect(f.pulls[0]!.signal.aborted).toBe(true)
    expect(f.close).toHaveBeenCalled()
    await f.advance()
    expect(f.children).toHaveLength(1)
    expect(f.current().state).toBe('stopped')
  })

  it('counts token re-resolution failures toward the same fallback budget', async () => {
    const f = await fixture()
    let attempts = 0
    await f.manager.start('official', async hlsOnly => {
      if (hlsOnly) return { url: input.url, qualityHeight: 720 }
      if (attempts++ > 0) throw new Error('PRIVATE token provider failure')
      return input
    })
    await settle(() => f.pulls.length === 1)
    f.pulls[0]!.fail(new AdaptivePullError('adaptive-expired', 403))
    await settle(() => f.current().state === 'reconnecting')
    await f.advance(); await settle(() => f.current().retryInMs === 0)
    await f.advance(); await settle(() => f.children.length === 2)
    expect(f.current().notice).toEqual({ code: 'youtube-adaptive-fallback', fromHeight: 1440, toHeight: 720 })
  })
})

describe('adaptive mux boundaries', () => {
  it.each(['webm', 'mp4'] as const)('feeds concatenated %s video and MP4 audio via distinct inputs without signed URLs', videoContainer => {
    const args = buildFfmpegArgs({ ...input, adaptive: { ...source, videoContainer } }, '/buffer', 1)
    expect(args.filter(value => value === '-i')).toHaveLength(2)
    expect(args).toContain('pipe:0'); expect(args).toContain('pipe:3')
    expect(args).toContain('fmp4'); expect(args).toContain('copy')
    expect(args.join(' ')).not.toMatch(/PRIVATE|concat|googlevideo/)
  })
  it('supports only a generated Windows local audio pipe', () => {
    const pipe = '\\\\.\\pipe\\stream-syncer-aabb-1234'
    expect(buildFfmpegArgs(input, '/buffer', 0, pipe)).toContain(pipe)
    expect(() => buildFfmpegArgs(input, '/buffer', 0, 'https://evil.example/audio')).toThrow()
  })
  it.each(['../init_0.mp4', 'https://evil.example/init.mp4', 'init_0.mp4?secret', 'raw_0.m3u8'])('rejects unowned fMP4 init URI %s', init => {
    expect(() => parseHlsSegments(`#EXTM3U\n#EXT-X-MAP:URI="${init}"\n#EXTINF:2,\nsegment_0_000000000.m4s\n`)).toThrow()
  })
  it('requires an initialization section for fragmented MP4', () => {
    expect(() => parseHlsSegments('#EXTM3U\n#EXTINF:2,\nsegment_0_000000000.m4s\n')).toThrow()
  })
})

describe('adaptive mux with local generated media', () => {
  const ffmpeg = process.env.STREAM_SYNC_FFMPEG || 'ffmpeg'
  const ffprobe = process.env.STREAM_SYNC_FFPROBE || 'ffprobe'
  const available = [ffmpeg, ffprobe].every(tool => {
    try { execFileSync(tool, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }); return true }
    catch { return false }
  })

  it.skipIf(!available)('remuxes VP9 and AAC from the production transport into readable fMP4 without network access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'syncer-adaptive-local-'))
    let manager: BufferManager | undefined
    const run = (tool: string, args: string[]) => execFileSync(tool, args, { cwd: root, windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30',
        '-t', '4.5', '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '60', 'video.webm'])
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '4.5', '-vn', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'audio.mp4'])
      const [videoBytes, audioBytes] = await Promise.all([readFile(path.join(root, 'video.webm')), readFile(path.join(root, 'audio.mp4'))])
      const states: BufferState[] = []
      manager = new BufferManager({ userDataDir: root, ffmpegPath: ffmpeg, readySeconds: 2, pollIntervalMs: 20, maxReconnects: 0,
        // Only media acquisition is replaced: ffmpeg, its dual-input transport,
        // playlist publication and capability reads all use the production path.
        pullAdaptive: async (_source, options) => new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('fixture stopped')), { once: true })
          // Live producers keep their inputs open. Requiring output before EOF
          // catches probing deadlocks that an offline .end() fixture would hide.
          options.video.write(videoBytes)
          options.audio.write(audioBytes)
        }),
      })
      manager.subscribe(state => states.push(state))
      const { url } = await manager.start('official', async () => input)
      await vi.waitFor(() => expect(states.some(state => state.seconds >= 4)).toBe(true), { timeout: 15_000, interval: 25 })
      const playlist = await (await manager.handle(new Request(url))).text()
      const segments = parseHlsSegments(playlist).segments
      expect(segments.length).toBeGreaterThanOrEqual(2)
      expect(segments.every(segment => segment.init && segment.uri.endsWith('.m4s'))).toBe(true)
      const first = segments[0]!
      const base = url.slice(0, url.lastIndexOf('/') + 1)
      const init = await manager.handle(new Request(base + first.init!))
      const fragment = await manager.handle(new Request(base + first.uri))
      expect(init.status).toBe(200)
      expect(fragment.status).toBe(200)
      await writeFile(path.join(root, 'sample.mp4'), Buffer.concat([
        Buffer.from(await init.arrayBuffer()), Buffer.from(await fragment.arrayBuffer()),
      ]))
      const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', 'sample.mp4']).toString()) as {
        streams: { codec_type: string; codec_name: string }[]
      }
      expect(probe.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ codec_type: 'video', codec_name: 'vp9' }),
        expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
      ]))
    } finally {
      await manager?.dispose()
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('syncer-adaptive-local-')) throw new Error('Invalid fixture cleanup path')
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)
})
