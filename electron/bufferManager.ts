import { spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Writable } from 'node:stream'
import { BufferRoute, type BufferRole } from './bufferRoute'
import { locateTool, ToolError } from './toolLocator'
import { pullAdaptive, type AdaptiveSource } from './adaptivePuller'
import { adaptiveTransport, type AdaptiveTransport } from './adaptiveTransport'
import { isStreamId } from './streamIdentity'

export type Role = BufferRole
export interface BufferInput { url: string; headers?: Record<string, string>; realtime?: boolean; adaptive?: AdaptiveSource; qualityHeight?: number; fallbackFromHeight?: number }
export interface BufferNotice { code: 'youtube-adaptive-fallback'; fromHeight: number; toHeight: number }
export type BufferPhase = 'starting' | 'buffering' | 'ready' | 'stalled' | 'reconnecting' | 'failed' | 'stopped'
export interface BufferState { role: Role; state: BufferPhase; seconds: number; attempt?: number; retryInMs?: number; reason?: string; notice?: BufferNotice }
export interface BufferChild {
  pid?: number
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
  stderr?: { resume(): unknown } | null
  stdin?: Writable | null
  stdio?: (unknown | null)[]
}
export interface BufferClock { now(): number; setTimeout(callback: () => void, delay: number): unknown; clearTimeout(handle: unknown): void }
export interface BufferManagerOptions {
  userDataDir: string
  ffmpegPath?: string | (() => Promise<string>)
  spawn?: (file: string, args: string[], options: SpawnOptions) => BufferChild
  killTree?: (child: BufferChild) => Promise<void>
  clock?: BufferClock
  retainSeconds?: number
  readySeconds?: number
  pollIntervalMs?: number
  stallTimeoutMs?: number
  backoffMs?: number[]
  maxReconnects?: number
  deleteGraceMs?: number
  adaptiveFailures?: number
  pullAdaptive?: typeof pullAdaptive
  adaptiveTransport?: typeof adaptiveTransport
}
export interface HlsSegment { uri: string; duration: number; programDateTime?: string; discontinuity?: boolean; init?: string }
interface Segment extends HlsSegment { sequence: number }
interface Run {
  id: number; child?: BufferChild; exited: boolean; finishing: boolean; lastSequence: number
  poll?: unknown; refresh?: Promise<void>; finishTask?: Promise<void>; lastProgress: number; firstProgress?: number
  abort?: AbortController; transport?: AdaptiveTransport; pulling?: Promise<void>
}
interface RoleSession {
  role: Role; generation: string; directory: string; resolve: (hlsOnly?: boolean) => Promise<BufferInput>; cancelled: boolean
  run?: Run; nextRun: number; nextSequence: number; removedDiscontinuities: number; segments: Segment[]
  discarded: { uri: string; deleteAfter: number }[]; attempts: number; retry?: unknown
  adaptiveHeight?: number; adaptiveAttempts: number; hlsOnly: boolean; notice?: BufferNotice
}
const defaultClock: BufferClock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
const ROLES: Role[] = ['official', 'commentary']
const SEGMENT = /^segment_\d+_\d{9}\.(?:ts|m4s)$/
const INIT = /^init_\d+\.mp4$/
// This limits ffmpeg's private manifest memory only. The published window is
// independently selected by summed EXTINF durations, never by this count.
const RAW_MANIFEST_SEGMENTS = 8192
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export class BufferManager {
  private readonly sessionId = randomUUID()
  private readonly sessionRoot: string
  private readonly route: BufferRoute
  private readonly roles = new Map<Role, RoleSession>()
  private readonly listeners = new Set<(state: BufferState) => void>()
  private readonly kills = new WeakMap<BufferChild, Promise<void>>()
  private readonly states = new Map<Role, BufferState>()
  private readonly transitions = new Map<Role, Promise<unknown>>()
  private readonly clock: BufferClock
  private readonly retention: number
  private readonly ready: number
  private readonly pollMs: number
  private readonly stallMs: number
  private readonly backoff: number[]
  private readonly maxReconnects: number
  private readonly deleteGraceMs: number
  private readonly adaptiveFailures: number
  private disposed = false
  private disposal?: Promise<void>

  constructor(private readonly options: BufferManagerOptions) {
    this.sessionRoot = path.resolve(options.userDataDir, 'buffer', this.sessionId)
    this.route = new BufferRoute(this.sessionId, this.sessionRoot)
    this.clock = options.clock ?? defaultClock
    this.retention = positive(options.retainSeconds ?? 180)
    this.ready = positive(options.readySeconds ?? 4)
    this.pollMs = positive(options.pollIntervalMs ?? 500)
    this.stallMs = positive(options.stallTimeoutMs ?? 25_000)
    this.backoff = [...(options.backoffMs ?? [1000, 2000, 5000, 10_000, 15_000])]
    if (!this.backoff.length || this.backoff.some(ms => !Number.isFinite(ms) || ms < 0)) throw new Error('invalid buffer backoff')
    this.maxReconnects = options.maxReconnects ?? this.backoff.length
    if (!Number.isSafeInteger(this.maxReconnects) || this.maxReconnects < 0) throw new Error('invalid buffer retry limit')
    this.deleteGraceMs = options.deleteGraceMs ?? 10_000
    if (!Number.isFinite(this.deleteGraceMs) || this.deleteGraceMs < 0) throw new Error('invalid buffer deletion grace')
    this.adaptiveFailures = options.adaptiveFailures ?? 2
    if (!Number.isSafeInteger(this.adaptiveFailures) || this.adaptiveFailures < 2) throw new Error('invalid adaptive failure limit')
    for (const role of ROLES) this.states.set(role, { role, state: 'stopped', seconds: 0 })
  }

  /** Resolving and buffering continue asynchronously; events report readiness. */
  async start(role: Role, resolve: (hlsOnly?: boolean) => Promise<BufferInput>): Promise<{ url: string }> {
    assertRole(role)
    if (this.disposed) throw new Error('缓冲管理器已关闭')
    const previous = this.roles.get(role)
    if (previous) this.cancel(previous)
    const session: RoleSession = {
      role, generation: randomUUID(), directory: path.join(this.sessionRoot, role), resolve, cancelled: false,
      nextRun: 0, nextSequence: 0, removedDiscontinuities: 0, segments: [], discarded: [], attempts: 0, adaptiveAttempts: 0, hlsOnly: false,
    }
    this.roles.set(role, session)
    this.emit(session, 'starting')
    return await this.transition(role, async () => {
      if (previous) await this.cleanup(previous)
      if (!this.current(session)) throw new Error('缓冲操作已取消')
      await mkdir(session.directory, { recursive: true, mode: 0o700 })
      if (!this.current(session)) throw new Error('缓冲操作已取消')
      const url = this.route.activate(role, session.generation, session.directory)
      await this.publish(session)
      void this.launch(session)
      return { url }
    }).catch(error => {
      if (this.current(session)) this.fail(session, 'buffer-write-failed')
      throw error
    })
  }

  async stop(role: Role): Promise<void> {
    assertRole(role)
    const session = this.roles.get(role)
    if (session) { this.cancel(session); this.roles.delete(role) }
    await this.transition(role, async () => {
      if (session) await this.cleanup(session)
      // A newer start must keep its own starting state.
      if (!this.roles.has(role)) this.notify({ role, state: 'stopped', seconds: 0 })
    })
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.disposal = (async () => {
      await Promise.all([...new Set([...ROLES, ...this.roles.keys(), ...this.transitions.keys()])].map(role => this.stop(role)))
      this.route.clear()
      await rm(this.sessionRoot, { recursive: true, force: true })
      this.listeners.clear()
    })()
    return this.disposal
  }
  subscribe(listener: (state: BufferState) => void): () => void {
    this.listeners.add(listener)
    for (const state of this.states.values()) { try { listener({ ...state }) } catch { /* Observers cannot stop buffering. */ } }
    return () => { this.listeners.delete(listener) }
  }
  handle(request: Request): Promise<Response> { return this.route.handle(request) }

  private transition<T>(role: Role, operation: () => Promise<T>): Promise<T> {
    const result = (this.transitions.get(role) ?? Promise.resolve()).then(operation)
    const tail = result.then(() => {}, () => {})
    this.transitions.set(role, tail)
    void tail.then(() => {
      if (this.transitions.get(role) === tail) this.transitions.delete(role)
      if (!this.roles.has(role) && !ROLES.includes(role)) this.states.delete(role)
    })
    return result
  }
  private current(session: RoleSession, run?: Run): boolean {
    return !session.cancelled && this.roles.get(session.role) === session && (!run || session.run === run)
  }
  private emit(session: RoleSession, state: BufferPhase, extra: Partial<BufferState> = {}): void {
    if (!this.current(session)) return
    this.notify({ role: session.role, state, seconds: duration(session.segments), ...(session.notice ? { notice: session.notice } : {}), ...extra })
  }
  private notify(state: BufferState): void {
    if (JSON.stringify(this.states.get(state.role)) === JSON.stringify(state)) return
    this.states.set(state.role, state)
    for (const listener of this.listeners) { try { listener({ ...state }) } catch { /* Isolate observers. */ } }
  }
  private cancel(session: RoleSession): void {
    session.cancelled = true
    this.route.deactivate(session.role)
    if (session.retry !== undefined) this.clock.clearTimeout(session.retry)
    if (session.run?.poll !== undefined) this.clock.clearTimeout(session.run.poll)
    session.run?.abort?.abort()
    session.run?.transport?.close()
  }

  private async launch(session: RoleSession): Promise<void> {
    if (!this.current(session)) return
    const run: Run = { id: session.nextRun++, exited: false, finishing: false, lastSequence: -1, lastProgress: this.clock.now() }
    session.run = run
    try {
      const tool = typeof this.options.ffmpegPath === 'function' ? await this.options.ffmpegPath() : this.options.ffmpegPath ?? await locateTool('ffmpeg')
      if (!this.current(session, run)) return
      let input: BufferInput
      try { input = await session.resolve(session.hlsOnly) } catch { await this.finish(session, run, 'source-resolve-failed'); return }
      if (!this.current(session, run)) return
      session.adaptiveHeight ??= input.fallbackFromHeight
      if (session.adaptiveHeight && !input.adaptive && !session.notice) {
        session.hlsOnly = true
        session.attempts = 0
        session.notice = { code: 'youtube-adaptive-fallback', fromHeight: session.adaptiveHeight, toHeight: input.qualityHeight ?? 1080 }
      }
      if (input.adaptive) {
        session.adaptiveHeight = input.adaptive.height
        run.abort = new AbortController()
        run.transport = await (this.options.adaptiveTransport ?? adaptiveTransport)(run.abort.signal)
        if (!this.current(session, run)) { run.transport.close(); return }
      }
      let args: string[]
      try { args = buildFfmpegArgs(input, session.directory, run.id, run.transport?.audioInput, Boolean(session.adaptiveHeight)) } catch {
        if (input.adaptive) await this.finish(session, run, 'invalid-buffer-input')
        else this.fail(session, 'invalid-buffer-input')
        return
      }
      run.lastProgress = this.clock.now()
      const child: BufferChild = (this.options.spawn ?? spawn)(tool, args, {
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: input.adaptive ? ['pipe', 'ignore', 'pipe', ...(run.transport?.extraPipe ? ['pipe' as const] : [])] : ['ignore', 'ignore', 'pipe'],
      })
      run.child = child
      child.once('error', () => { void this.finish(session, run, 'ffmpeg-launch-failed') })
      child.once('close', () => { run.exited = true; void this.finish(session, run, 'upstream-ended') })
      // ffmpeg diagnostics can contain signed URLs, cookies and headers. Drain
      // them without keeping or forwarding any bytes to logs or the renderer.
      child.stderr?.resume()
      if (input.adaptive) {
        const video = child.stdin
        const audio = run.transport?.audio ?? child.stdio?.[3] as Writable | undefined
        if (!video || !audio) { await this.finish(session, run, 'adaptive-pipe-failed'); return }
        // Pending OS writes can report EPIPE after cancellation has released the puller.
        video.on('error', () => {})
        audio.on('error', () => {})
        run.pulling = (this.options.pullAdaptive ?? pullAdaptive)(input.adaptive, { video, audio, signal: run.abort!.signal })
          .then(() => this.finish(session, run, 'adaptive-ended'), () => this.finish(session, run, 'adaptive-pull-failed'))
      }
      this.emit(session, duration(session.segments) >= this.ready ? 'ready' : 'buffering')
      this.schedulePoll(session, run)
    } catch (error) {
      if (!this.current(session, run)) return
      if (error instanceof ToolError) this.fail(session, error.code)
      else await this.finish(session, run, 'ffmpeg-launch-failed')
    }
  }

  private schedulePoll(session: RoleSession, run: Run): void {
    if (!this.current(session, run) || run.finishing) return
    run.poll = this.clock.setTimeout(() => { void this.poll(session, run) }, this.pollMs)
  }
  private async poll(session: RoleSession, run: Run): Promise<void> {
    if (!this.current(session, run) || run.finishing) return
    try {
      await this.refresh(session, run)
      if (!this.current(session, run) || run.finishing) return
      if (this.clock.now() - run.lastProgress >= this.stallMs) {
        this.emit(session, 'stalled')
        await this.finish(session, run, 'upstream-stalled')
      } else this.schedulePoll(session, run)
    } catch { this.fail(session, 'buffer-write-failed') }
  }
  private refresh(session: RoleSession, run: Run): Promise<void> {
    if (run.refresh) return run.refresh
    run.refresh = this.readAndPublish(session, run).finally(() => { run.refresh = undefined })
    return run.refresh
  }
  private async readAndPublish(session: RoleSession, run: Run): Promise<void> {
    if (!this.current(session, run)) return
    const manifest = path.join(session.directory, `raw_${run.id}.m3u8`)
    let raw: string
    try {
      if ((await stat(manifest)).size > MAX_MANIFEST_BYTES) throw new Error('manifest too large')
      raw = await readFile(manifest, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!this.current(session, run)) return
    const parsed = parseHlsSegments(raw)
    let added = false
    for (let index = 0; index < parsed.segments.length; index++) {
      const sourceSequence = parsed.sequence + index
      if (sourceSequence <= run.lastSequence) continue
      const segment = parsed.segments[index]!
      if (!segment.uri.startsWith(`segment_${run.id}_`)) throw new Error('unexpected segment generation')
      if (segment.init && segment.init !== `init_${run.id}.mp4`) throw new Error('unexpected init generation')
      session.segments.push({ ...segment, sequence: session.nextSequence++, discontinuity: segment.discontinuity || (run.lastSequence < 0 && session.nextSequence > 1) })
      run.lastSequence = sourceSequence
      added = true
    }
    if (added) {
      const now = this.clock.now()
      run.lastProgress = now
      run.firstProgress ??= now
      // A genuinely stable run resets the consecutive-failure budget. A brief
      // successful reconnect must not create an endless rapid restart loop.
      if (now - run.firstProgress >= 30_000) { session.attempts = 0; session.adaptiveAttempts = 0 }
      let seconds = duration(session.segments)
      while (session.segments.length > 1 && seconds - session.segments[0]!.duration >= this.retention) {
        const removed = session.segments.shift()!
        seconds -= removed.duration
        if (removed.discontinuity) session.removedDiscontinuities++
        session.discarded.push({ uri: removed.uri, deleteAfter: now + this.deleteGraceMs })
        if (removed.init && !session.segments.some(item => item.init === removed.init)
          && !session.discarded.some(item => item.uri === removed.init)) {
          session.discarded.push({ uri: removed.init, deleteAfter: now + this.deleteGraceMs })
        }
      }
      await this.publish(session)
      if (!run.finishing) this.emit(session, seconds >= this.ready ? 'ready' : 'buffering')
    }
    const discarded = session.discarded.filter(item => item.deleteAfter <= this.clock.now())
    session.discarded = session.discarded.filter(item => item.deleteAfter > this.clock.now())
    await Promise.all(discarded.map(item => rm(path.join(session.directory, item.uri), { force: true })))
  }
  private async publish(session: RoleSession): Promise<void> {
    if (!this.current(session)) return
    const target = Math.max(2, ...session.segments.map(segment => Math.ceil(segment.duration)))
    const lines = ['#EXTM3U', `#EXT-X-VERSION:${session.segments.some(item => item.init) ? 7 : 3}`, `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${session.segments[0]?.sequence ?? session.nextSequence}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${session.removedDiscontinuities}`]
    let init: string | undefined
    for (const segment of session.segments) {
      if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
      if (segment.init && segment.init !== init) { lines.push(`#EXT-X-MAP:URI="${segment.init}"`); init = segment.init }
      if (segment.programDateTime) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${segment.programDateTime}`)
      lines.push(`#EXTINF:${segment.duration.toFixed(6)},`, segment.uri)
    }
    const temporary = path.join(session.directory, 'index.m3u8.tmp')
    await writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600 })
    if (!this.current(session)) return
    await rename(temporary, path.join(session.directory, 'index.m3u8'))
  }

  private finish(session: RoleSession, run: Run, reason: string): Promise<void> {
    if (!this.current(session, run) || run.finishing) return Promise.resolve()
    run.finishing = true
    run.abort?.abort()
    run.transport?.close()
    if (run.poll !== undefined) this.clock.clearTimeout(run.poll)
    run.finishTask = this.finishRun(session, run, reason)
    return run.finishTask
  }
  private async finishRun(session: RoleSession, run: Run, reason: string): Promise<void> {
    try {
      await this.refresh(session, run)
      if (run.child && !run.exited) await this.kill(run.child)
      if (!this.current(session, run)) return
      await rm(path.join(session.directory, `raw_${run.id}.m3u8`), { force: true })
    } catch { this.fail(session, 'buffer-write-failed'); return }
    if (!this.current(session, run)) return
    if (session.adaptiveHeight && !session.hlsOnly) {
      session.adaptiveAttempts++
      if (session.adaptiveAttempts >= this.adaptiveFailures) {
        session.hlsOnly = true
        session.attempts = 0
        this.emit(session, 'reconnecting', { attempt: 0, retryInMs: 0 })
        session.retry = this.clock.setTimeout(() => { session.retry = undefined; void this.launch(session) }, 0)
        return
      }
    }
    if ((!session.adaptiveHeight || session.hlsOnly) && session.attempts >= this.maxReconnects) { this.emit(session, 'failed', { reason }); return }
    const delay = this.backoff[Math.min(session.attempts, this.backoff.length - 1)]!
    session.attempts++
    this.emit(session, 'reconnecting', { attempt: session.attempts, retryInMs: delay })
    session.retry = this.clock.setTimeout(() => { session.retry = undefined; void this.launch(session) }, delay)
  }
  private fail(session: RoleSession, reason: string): void {
    if (!this.current(session)) return
    if (session.retry !== undefined) this.clock.clearTimeout(session.retry)
    if (session.run?.poll !== undefined) this.clock.clearTimeout(session.run.poll)
    if (session.run) session.run.finishing = true
    session.run?.abort?.abort()
    session.run?.transport?.close()
    this.emit(session, 'failed', { reason })
    if (session.run?.child && !session.run.exited) void this.kill(session.run.child).catch(() => {})
  }
  private kill(child: BufferChild): Promise<void> {
    const existing = this.kills.get(child)
    if (existing) return existing
    const result = Promise.resolve().then(() => (this.options.killTree ?? killProcessTree)(child))
    this.kills.set(child, result)
    void result.catch(() => { this.kills.delete(child) })
    return result
  }
  private async cleanup(session: RoleSession): Promise<void> {
    session.run?.abort?.abort()
    session.run?.transport?.close()
    if (session.run?.child && !session.run.exited) await this.kill(session.run.child)
    await session.run?.finishTask?.catch(() => {})
    await session.run?.refresh?.catch(() => {})
    await rm(session.directory, { recursive: true, force: true })
  }
}

export function parseHlsSegments(text: string): { sequence: number; segments: HlsSegment[] } {
  if (!text.startsWith('#EXTM3U')) throw new Error('invalid HLS manifest')
  const sequence = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/m.exec(text)?.[1] ?? 0)
  if (!Number.isSafeInteger(sequence)) throw new Error('invalid HLS sequence')
  const segments: HlsSegment[] = []
  let pending: number | undefined
  let programDateTime: string | undefined
  let discontinuity = false
  let init: string | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXTINF:')) {
      pending = Number(line.slice(8).split(',')[0])
      if (!Number.isFinite(pending) || pending <= 0 || pending > 86_400) throw new Error('invalid segment duration')
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const value = line.slice(25)
      if (!/^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid program date')
      programDateTime = value
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const match = /^#EXT-X-MAP:URI="(init_\d+\.mp4)"$/.exec(line)
      if (!match || !INIT.test(match[1]!)) throw new Error('invalid init URI')
      init = match[1]
    } else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true
    else if (line && !line.startsWith('#')) {
      if (pending === undefined || !SEGMENT.test(line)) throw new Error('invalid segment URI')
      if (line.endsWith('.m4s') && !init) throw new Error('missing init URI')
      segments.push({ uri: line, duration: pending, programDateTime, discontinuity, ...(init ? { init } : {}) })
      pending = undefined; programDateTime = undefined; discontinuity = false
    }
  }
  if (pending !== undefined) throw new Error('incomplete segment')
  return { sequence, segments }
}

export function buildFfmpegArgs(input: BufferInput, directory: string, runId: number, audioInput = 'pipe:3', forceFmp4 = false): string[] {
  if (input.adaptive) {
    if (!['webm', 'mp4'].includes(input.adaptive.videoContainer)) throw new Error('invalid adaptive input')
    if (audioInput !== 'pipe:3' && !/^\\\\\.\\pipe\\stream-syncer-[a-f0-9-]+$/.test(audioInput)) throw new Error('invalid audio pipe')
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'pipe', '-thread_queue_size', '512', '-analyzeduration', '1000000', '-probesize', '1048576',
      '-f', input.adaptive.videoContainer === 'webm' ? 'matroska' : 'mov', '-i', 'pipe:0',
      '-protocol_whitelist', audioInput === 'pipe:3' ? 'pipe' : 'file', '-thread_queue_size', '512',
      '-analyzeduration', '1000000', '-probesize', '1048576', '-f', 'mov', '-i', audioInput,
      '-map', '0:v:0', '-map', '1:a:0', ...hlsOutput(directory, runId, true)]
  }
  const url = new URL(input.url)
  const local = url.protocol === 'file:' && input.realtime === true
  if ((!local && !['http:', 'https:'].includes(url.protocol)) || url.username || url.password || /[\r\n\0]/.test(input.url)) throw new Error('invalid input')
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
  if (input.realtime) args.push('-re')
  // ffmpeg honours http_proxy/https_proxy from the environment and then tunnels through its
  // `httpproxy` protocol. Leaving it off the whitelist fails every remote input at open on
  // any machine with a system proxy, which is the common setup for reaching YouTube.
  args.push('-protocol_whitelist', local ? 'file,crypto' : 'http,https,tcp,tls,crypto,httpproxy')
  // Do not enable ffmpeg HTTP reconnect options: a signed Huya FLV URL is single-use.
  // EOF and stalls return to launch(), which asks acquisition for a newly signed URL.
  if (!local) args.push('-rw_timeout', '20000000')
  if (input.headers) {
    const headers = Object.entries(input.headers).map(([name, value]) => {
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n\0]/.test(value)) throw new Error('invalid input header')
      return `${name}: ${value}\r\n`
    }).join('')
    if (headers.length > 65_536 || local) throw new Error('invalid input headers')
    if (headers) args.push('-headers', headers)
  }
  args.push('-i', local ? fileURLToPath(url) : input.url, '-map', '0:v:0?', '-map', '0:a:0?', ...hlsOutput(directory, runId, forceFmp4))
  return args
}
function hlsOutput(directory: string, runId: number, fmp4: boolean): string[] {
  // ffmpeg's hls muxer finds the directory of the init segment by searching the playlist path
  // for '/' only. With Windows backslashes it finds none and writes init_<n>.mp4 into the
  // process working directory instead of the buffer, and the player can never load it.
  // Forward slashes are valid Windows paths and keep every output next to the playlist.
  const dir = process.platform === 'win32' ? directory.replace(/\\/g, '/') : directory
  return ['-c', 'copy', '-sn', '-dn',
    ...(fmp4 ? ['-bsf:a', 'aac_adtstoasc'] : []),
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', String(RAW_MANIFEST_SEGMENTS), '-hls_flags', 'temp_file+program_date_time+omit_endlist',
    ...(fmp4 ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `init_${runId}.mp4`] : []),
    '-hls_segment_filename', path.posix.join(dir, `segment_${runId}_%09d.${fmp4 ? 'm4s' : 'ts'}`), path.posix.join(dir, `raw_${runId}.m3u8`)]
}
function duration(segments: HlsSegment[]): number { return Math.round(segments.reduce((total, segment) => total + segment.duration, 0) * 1_000_000) / 1_000_000 }
function positive(value: number): number { if (!Number.isFinite(value) || value <= 0) throw new Error('invalid buffer timing'); return value }
function assertRole(role: Role): void { if (!isStreamId(role)) throw new Error('无效的播放会话') }

/** ffmpeg is detached on POSIX, so the process group is the whole child tree. */
export async function killProcessTree(child: BufferChild): Promise<void> {
  if (!child.pid) { child.kill('SIGKILL'); return }
  let closeTimer: ReturnType<typeof setTimeout>
  let hasClosed = false
  const closed = new Promise<void>((resolve, reject) => {
    closeTimer = setTimeout(() => reject(new Error('child termination timed out')), 10_000)
    child.once('close', () => { hasClosed = true; clearTimeout(closeTimer); resolve() })
  })
  void closed.catch(() => {})
  try {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      const killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); reject(new Error('process tree termination timed out')) }, 5000)
      killer.once('error', () => { clearTimeout(timer); child.kill('SIGKILL'); reject(new Error('process tree termination failed')) })
      killer.once('close', (code) => {
        clearTimeout(timer)
        if (code !== 0 && !hasClosed) { child.kill('SIGKILL'); reject(new Error('process tree termination failed')) }
        else resolve()
      })
    })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  await closed
  } finally { clearTimeout(closeTimer!) }
}
