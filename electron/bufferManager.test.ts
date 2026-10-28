import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BufferManager, buildFfmpegArgs, parseHlsSegments, type BufferClock, type BufferState, type BufferManagerOptions } from './bufferManager'
import { ToolError } from './toolLocator'

class FakeChild extends EventEmitter {
  pid = 12345
  stderr = new PassThrough()
  kill = vi.fn(() => { this.emit('close', null, 'SIGKILL'); return true })
}
class FakeClock implements BufferClock {
  time = 0
  serial = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  now = () => this.time
  setTimeout = (callback: () => void, delay: number) => { const id = ++this.serial; this.timers.set(id, { at: this.time + delay, callback }); return id }
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number) }
  async advance(ms: number) {
    const target = this.time + ms
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target)
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
      await drain()
    }
    this.time = target
    await drain()
  }
}
async function drain() { for (let n = 0; n < 30; n++) await new Promise<void>(resolve => setImmediate(resolve)) }
async function until(predicate: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('condition did not settle')
}
const fixtures: { root: string; manager: BufferManager }[] = []
async function fixture(options: Partial<BufferManagerOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer-buffer-'))
  const clock = new FakeClock()
  const children: FakeChild[] = [], commands: { file: string; args: string[]; options: unknown }[] = [], states: BufferState[] = []
  const spawn = vi.fn((file: string, args: string[], options: unknown) => {
    const child = new FakeChild()
    children.push(child); commands.push({ file, args, options }); return child
  })
  const killTree = vi.fn(async child => { child.kill('SIGKILL') })
  const manager = new BufferManager({ userDataDir: root, ffmpegPath: 'fake-ffmpeg', spawn, killTree, clock, pollIntervalMs: 100, stallTimeoutMs: 10_000, backoffMs: [1000, 2000], maxReconnects: 2, deleteGraceMs: 0, ...options })
  manager.subscribe(state => states.push(state))
  const f = { root, manager, clock, spawn, killTree, children, commands, states, current: () => states.filter(state => state.role === 'official').at(-1)! }
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.manager.dispose(); await rm(f.root, { recursive: true, force: true }) }
})
async function writeManifest(f: Awaited<ReturnType<typeof fixture>>, commandIndex: number, durations: number[], sequence = 0) {
  const command = f.commands[commandIndex]!, manifest = command.args.at(-1)!, directory = path.dirname(manifest)
  const run = /raw_(\d+)\.m3u8$/.exec(manifest)![1]
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:60', `#EXT-X-MEDIA-SEQUENCE:${sequence}`]
  for (let index = 0; index < durations.length; index++) {
    const filename = `segment_${run}_${String(sequence + index).padStart(9, '0')}.ts`
    await writeFile(path.join(directory, filename), `segment ${index}`)
    lines.push(`#EXTINF:${durations[index]},`, filename)
  }
  await writeFile(manifest, lines.join('\n') + '\n')
  return directory
}
async function start(f: Awaited<ReturnType<typeof fixture>>, resolve = vi.fn(async () => ({ url: 'https://cdn.example/live.m3u8?private-token=hidden' }))) {
  const result = await f.manager.start('official', resolve)
  await until(() => f.children.length > 0 || f.current().state === 'failed')
  return { ...result, resolve }
}

describe('BufferManager', () => {
  it('runs one shell-free copy mux child per role and never publishes inputs or stderr', async () => {
    const f = await fixture(), { url } = await start(f)
    await f.manager.start('commentary', async () => ({ url: 'https://cdn.example/commentary.flv', headers: { Referer: 'https://www.douyu.com/' } }))
    await until(() => f.children.length === 2)
    expect(url).toMatch(/^app:\/\/app\/buffer\/[\w-]+\/official\/[\w-]+\/index.m3u8$/)
    expect(f.commands[0]!.options).toMatchObject({ shell: false, windowsHide: true })
    expect(f.commands[0]!.args).toContain('copy')
    expect(f.commands[1]!.args).toContain('Referer: https://www.douyu.com/\r\n')
    f.children[0]!.stderr.write('Cookie: private-cookie-value https://signed.example/?token=hidden')
    expect(JSON.stringify(f.states)).not.toMatch(/private-token|private-cookie|cdn\.example|syncer-buffer|signed\.example/)
    expect(f.current()).toMatchObject({ state: 'buffering', seconds: 0 })
  })
  it('moves from buffering to ready using actual durations', async () => {
    const f = await fixture(), { url } = await start(f)
    await writeManifest(f, 0, [1.5])
    await f.clock.advance(100)
    await until(() => f.current().seconds === 1.5)
    expect(f.current().state).toBe('buffering')
    await writeManifest(f, 0, [1.5, 3])
    await f.clock.advance(100)
    await until(() => f.current().state === 'ready')
    expect(f.current().seconds).toBe(4.5)
    expect(await (await f.manager.handle(new Request(url))).text()).toContain('#EXTINF:3.000000,')
  })
  it('keeps a partial retained buffer below the ready threshold while its producer restarts', async () => {
    const f = await fixture(), { url } = await start(f)
    await writeManifest(f, 0, [0.033333])
    await f.clock.advance(100)
    await until(() => f.current().seconds === 0.033333)
    f.children[0]!.emit('close', 1)
    await until(() => f.current().state === 'reconnecting')
    await f.clock.advance(1000)
    await until(() => f.children.length === 2)
    expect(f.current()).toMatchObject({ state: 'buffering', seconds: 0.033333 })
    expect(f.states.some(state => state.state === 'ready' && state.seconds < 4)).toBe(false)
    await writeManifest(f, 1, [2, 2])
    await f.clock.advance(100)
    await until(() => f.current().state === 'ready')
    expect(f.current().seconds).toBeCloseTo(4.033333)
    expect((await f.manager.handle(new Request(url))).status).toBe(200)
  })
  it('retains at least 180 seconds by EXTINF sum even with long irregular segments', async () => {
    const f = await fixture(), { url } = await start(f)
    const directory = await writeManifest(f, 0, [5, 45, 60, 61, 59, 20])
    await f.clock.advance(100)
    await until(() => f.current().seconds === 200)
    const response = await f.manager.handle(new Request(url)), body = await response.text()
    expect(parseHlsSegments(body).segments.map(segment => segment.duration)).toEqual([60, 61, 59, 20])
    expect(body).toContain('#EXT-X-MEDIA-SEQUENCE:2')
    await until(() => f.current().state === 'ready')
    expect((await readdir(directory)).filter(name => name.endsWith('.ts'))).toHaveLength(4)
  })
  it('bounds the published playlist when ffmpeg uses more than 90 short segments', async () => {
    const f = await fixture(), { url } = await start(f)
    await writeManifest(f, 0, Array(200).fill(1))
    await f.clock.advance(100)
    await until(() => f.current().seconds === 180)
    const body = await (await f.manager.handle(new Request(url))).text()
    expect(parseHlsSegments(body).segments).toHaveLength(180)
    expect(body).toContain('#EXT-X-MEDIA-SEQUENCE:20')
  })
  it('re-resolves after EOF, preserves the local URL and marks discontinuity', async () => {
    const f = await fixture(), { url, resolve } = await start(f)
    await writeManifest(f, 0, [2, 2])
    await f.clock.advance(100)
    await until(() => f.current().seconds === 4)
    f.children[0]!.emit('close', 0)
    await until(() => f.current().state === 'reconnecting')
    expect(f.current()).toMatchObject({ attempt: 1, retryInMs: 1000 })
    await f.clock.advance(999)
    expect(resolve).toHaveBeenCalledTimes(1)
    await f.clock.advance(1)
    await until(() => f.children.length === 2)
    expect(resolve).toHaveBeenCalledTimes(2)
    await writeManifest(f, 1, [2, 2])
    await f.clock.advance(100)
    await until(() => f.current().seconds === 8)
    const body = await (await f.manager.handle(new Request(url))).text()
    expect(body.match(/#EXT-X-DISCONTINUITY\n/g)).toHaveLength(1)
    expect(body).toContain('segment_1_000000000.ts')
  })
  it('opens each Huya FLV signature once and obtains a new line and signature after EOF or a stall', async () => {
    const f = await fixture({ stallTimeoutMs: 200 })
    let sequence = 0
    const resolve = vi.fn(async () => ({
      url: `https://line-${++sequence}.example/live.flv?wsSecret=PRIVATE_${sequence}&codec=264&ratio=0`,
      headers: { Referer: 'https://www.huya.com/' },
    }))
    const { url } = await start(f, resolve)
    f.children[0]!.emit('close', 0)
    await until(() => f.current().state === 'reconnecting')
    await f.clock.advance(1000)
    await until(() => f.children.length === 2)
    await f.clock.advance(200)
    await until(() => f.current().state === 'reconnecting')
    expect(f.killTree).toHaveBeenCalledWith(f.children[1])
    await f.clock.advance(2000)
    await until(() => f.children.length === 3)
    expect(resolve).toHaveBeenCalledTimes(3)
    const inputs = f.commands.map(command => command.args[command.args.indexOf('-i') + 1])
    expect(inputs).toEqual([1, 2, 3].map(index => `https://line-${index}.example/live.flv?wsSecret=PRIVATE_${index}&codec=264&ratio=0`))
    for (const command of f.commands) {
      expect(command.args.filter(arg => arg === '-i')).toHaveLength(1)
      expect(command.args.some(arg => arg.startsWith('-reconnect'))).toBe(false)
      expect(command.args).toContain('Referer: https://www.huya.com/\r\n')
      expect(command.args).toContain('copy')
    }
    expect((await f.manager.handle(new Request(url))).status).toBe(200)
    expect(JSON.stringify(f.states)).not.toMatch(/PRIVATE|line-[123]\.example/)
  })
  it('stops retrying after the bounded consecutive failure budget', async () => {
    const f = await fixture(), { resolve } = await start(f)
    f.children[0]!.emit('close', 1)
    await until(() => f.current().state === 'reconnecting')
    await f.clock.advance(1000)
    await until(() => f.children.length === 2)
    f.children[1]!.emit('close', 1)
    await until(() => f.current().attempt === 2)
    expect(f.current().retryInMs).toBe(2000)
    await f.clock.advance(2000)
    await until(() => f.children.length === 3)
    f.children[2]!.emit('close', 1)
    await until(() => f.current().state === 'failed')
    await f.clock.advance(10_000)
    expect(resolve).toHaveBeenCalledTimes(3)
    expect(f.current().reason).toBe('upstream-ended')
  })
  it('kills a stalled child before scheduling a fresh resolver attempt', async () => {
    const f = await fixture({ stallTimeoutMs: 200 }), { resolve } = await start(f)
    await f.clock.advance(200)
    await until(() => f.current().state === 'reconnecting')
    expect(f.states.some(state => state.state === 'stalled')).toBe(true)
    expect(f.killTree).toHaveBeenCalledWith(f.children[0])
    await f.clock.advance(1000)
    await until(() => resolve.mock.calls.length === 2)
  })
  it('stops a role without touching the other role, cancels retries and deletes its directory', async () => {
    const f = await fixture(), { url } = await start(f)
    await f.manager.start('commentary', async () => ({ url: 'https://cdn.example/commentary.flv' }))
    await until(() => f.children.length === 2)
    const directory = path.dirname(f.commands[0]!.args.at(-1)!)
    await f.manager.stop('official')
    expect(f.current().state).toBe('stopped')
    expect((await f.manager.handle(new Request(url))).status).toBe(404)
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.children[1]!.kill).not.toHaveBeenCalled()
    await f.clock.advance(1000)
    expect(f.children).toHaveLength(2)
  })
  it('restarts with a distinct capability so stale renderer requests cannot read new content', async () => {
    const f = await fixture(), first = await start(f)
    const second = await f.manager.start('official', async () => ({ url: 'https://cdn.example/new.flv' }))
    await until(() => f.children.length === 2)
    expect(second.url).not.toBe(first.url)
    expect((await f.manager.handle(new Request(first.url))).status).toBe(404)
    expect(f.killTree).toHaveBeenCalledTimes(1)
  })
  it('can stop while source resolution is pending without launching an orphan child', async () => {
    const f = await fixture()
    let complete!: (value: { url: string }) => void
    const resolving = new Promise<{ url: string }>(resolve => { complete = resolve })
    await f.manager.start('official', () => resolving)
    await f.manager.stop('official')
    complete({ url: 'https://cdn.example/late.flv' })
    await drain()
    expect(f.children).toHaveLength(0)
    expect(f.current().state).toBe('stopped')
  })
  it('reports missing tools without leaking the exception or retrying', async () => {
    const f = await fixture({ ffmpegPath: async () => { throw new ToolError('tool-missing', 'ffmpeg') } })
    await f.manager.start('official', async () => ({ url: 'https://cdn.example/live.flv' }))
    await until(() => f.current().state === 'failed')
    expect(f.current().reason).toBe('tool-missing')
    expect(f.children).toHaveLength(0)
    expect(f.clock.timers.size).toBe(0)
  })
  it('retries resolver failures without forwarding private errors', async () => {
    const f = await fixture({ maxReconnects: 0 })
    await f.manager.start('official', async () => { throw new Error('Cookie: secret-source-error') })
    await until(() => f.current().state === 'failed')
    expect(f.current().reason).toBe('source-resolve-failed')
    expect(JSON.stringify(f.states)).not.toContain('secret-source-error')
  })
  it('disposes idempotently and removes the entire session', async () => {
    const f = await fixture()
    await start(f)
    const session = path.dirname(path.dirname(f.commands[0]!.args.at(-1)!))
    await f.manager.dispose()
    await f.manager.dispose()
    await expect(readdir(session)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.clock.timers.size).toBe(0)
    await expect(f.manager.start('official', async () => ({ url: 'https://example.com' }))).rejects.toThrow('已关闭')
  })
})

describe('ffmpeg argument and manifest boundaries', () => {
  it('allows an explicit realtime local fixture without enabling file access for remote media', () => {
    const directory = path.resolve('fixture'), input = pathToFileURL(path.join(directory, 'test.m3u8')).toString()
    const remote = buildFfmpegArgs({ url: 'https://cdn.example/live.m3u8' }, directory, 0)
    expect(remote[remote.indexOf('-protocol_whitelist') + 1]).not.toContain('file')
    // ffmpeg tunnels through a system http_proxy with its `httpproxy` protocol; without it on
    // the whitelist every remote input fails to open on a machine that has a proxy set.
    expect(remote[remote.indexOf('-protocol_whitelist') + 1]!.split(',')).toContain('httpproxy')
    expect(() => buildFfmpegArgs({ url: input }, directory, 0)).toThrow()
    const local = buildFfmpegArgs({ url: input, realtime: true }, directory, 0)
    expect(local).toContain('-re')
    expect(local).toContain(path.join(directory, 'test.m3u8'))
  })
  it.each(['ftp://example.com/a', 'http://user:password@example.com/a', 'https://example.com/a\n-bad'])('rejects an unsafe input: %s', url => {
    expect(() => buildFfmpegArgs({ url }, '/buffer', 0)).toThrow()
  })
  it('rejects header injection', () => {
    expect(() => buildFfmpegArgs({ url: 'https://cdn.example/live', headers: { Referer: 'https://example.com/\r\nCookie: injected' } }, '/buffer', 0)).toThrow()
    expect(() => buildFfmpegArgs({ url: 'https://cdn.example/live', headers: { 'Bad\nName': 'value' } }, '/buffer', 0)).toThrow()
  })
  it('parses fractional durations and program timestamps', () => {
    expect(parseHlsSegments('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-PROGRAM-DATE-TIME:2026-10-19T00:00:00.000+00:00\n#EXTINF:2.125,\nsegment_1_000000010.ts\n')).toMatchObject({ sequence: 10, segments: [{ duration: 2.125, programDateTime: '2026-10-19T00:00:00.000+00:00' }] })
  })
  it.each(['../private.ts', 'file:///secret.ts', 'https://evil.example/segment.ts', 'segment_0_000000000.ts?secret', 'other.ts'])('rejects unowned segment references: %s', uri => {
    expect(() => parseHlsSegments(`#EXTM3U\n#EXTINF:2,\n${uri}\n`)).toThrow()
  })
  it.each(['NaN', '-1', '0', 'Infinity', '99999999'])('rejects invalid EXTINF duration: %s', value => {
    expect(() => parseHlsSegments(`#EXTM3U\n#EXTINF:${value},\nsegment_0_000000000.ts\n`)).toThrow()
  })
})

describe('fMP4 output on the real ffmpeg', () => {
  const ffmpeg = process.env.STREAM_SYNC_FFMPEG || 'ffmpeg'
  const fixtureFfmpeg = process.env.STREAM_SYNC_FIXTURE_FFMPEG || ffmpeg
  const available = [fixtureFfmpeg, ffmpeg].every(tool => {
    try { execFileSync(tool, ['-version'], { stdio: 'ignore' }); return true } catch { return false }
  })

  it.skipIf(!available)('remuxes fallback HLS/TS AAC into MP4 instead of failing after its first video frame', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncer-fmp4-aac-'))
    try {
      const input = path.join(directory, 'input.ts')
      execFileSync(fixtureFfmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4.5', '-c:v', 'libx264', '-g', '60', '-c:a', 'aac', '-f', 'mpegts', input],
      { cwd: directory, windowsHide: true, timeout: 15_000, stdio: 'pipe' })
      const args = buildFfmpegArgs({ url: pathToFileURL(input).href, realtime: true }, directory, 3, 'pipe:3', true).filter(arg => arg !== '-re')
      execFileSync(ffmpeg, args, { cwd: directory, windowsHide: true, timeout: 15_000, stdio: 'pipe' })
      const playlist = parseHlsSegments(await readFile(path.join(directory, 'raw_3.m3u8'), 'utf8'))
      expect(playlist.segments.reduce((sum, segment) => sum + segment.duration, 0)).toBeGreaterThanOrEqual(4)
      expect(playlist.segments.every(segment => segment.init === 'init_3.mp4')).toBe(true)
    } finally {
      if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('syncer-fmp4-aac-')) throw new Error('Invalid fixture cleanup path')
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!available)('writes the init segment next to the playlist, not into the working directory', async () => {
    // ffmpeg looks for '/' in the playlist path to place init_<n>.mp4; a Windows path with
    // backslashes made it fall back to the process cwd, so the player could never load it.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncer-fmp4-'))
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'syncer-cwd-'))
    try {
      const input = path.join(directory, 'input.mp4')
      execFileSync(fixtureFfmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', '2.5',
        '-c:v', 'libx264', input], { cwd: directory, windowsHide: true, timeout: 15_000, stdio: 'pipe' })
      const args = buildFfmpegArgs({ url: 'https://cdn.example/live.m3u8' }, directory, 7, 'pipe:3', true)
      const output = args.slice(args.indexOf('-c'))
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', input, ...output],
        { cwd: elsewhere, windowsHide: true, timeout: 15_000, stdio: 'pipe' })
      expect(await readdir(elsewhere)).toEqual([])
      const written = await readdir(directory)
      expect(written).toContain('init_7.mp4')
      expect(written).toContain('raw_7.m3u8')
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})
