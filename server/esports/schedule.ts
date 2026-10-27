import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { metadataUserAgent } from '../appIdentity'
import { metadataConfig } from '../config'
import { FeatureApiError } from '../featureApi'
import { PinnedDispatcherPool, safeFetch, type Resolver } from '../safeFetch'
import { currentMatches, parseSchedule, ScheduleFormatError, validChannel } from './parser'
import type { Cs2Match, Cs2Schedule, StreamTitle, StreamTitleInput } from './types'

export const SCHEDULE_URL = 'https://liquipedia.net/counterstrike/api.php?action=parse&page=Liquipedia:Matches&format=json&prop=text'
export const ATTRIBUTION = '赛程数据来自 Liquipedia (CC-BY-SA 3.0)'
export const SCHEDULE_TTL_MS = 300_000
export const PARSE_INTERVAL_MS = 30_000
export const TITLE_TTL_MS = 120_000
const MAX_BODY_BYTES = 2_000_000
const UNAVAILABLE = '赛程暂时无法读取, 请稍后重试'
class RateLimited extends Error {}

interface CachedSchedule { fetchedAt: number; matches: Cs2Match[] }
interface Dependencies {
  userDataDir: string
  version: string
  now?: () => number
  request?: typeof fetch
  resolve?: Resolver
  log?: (message: string) => void
}

function readBounded(file: string): string {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BODY_BYTES) throw new Error('Invalid metadata cache')
  return readFileSync(file, 'utf8')
}
function atomicJson(directory: string, name: string, value: unknown): void {
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, join(directory, name))
  } finally { try { unlinkSync(temporary) } catch { /* Already renamed, or never created. */ } }
}

/** Shared by windows and durable across restarts. The short disk mutex protects the request reservation. */
class ScheduleDisk {
  readonly directory: string
  constructor(root: string) { this.directory = join(resolve(root), 'events') }
  load(): CachedSchedule | null {
    try {
      const value = JSON.parse(readBounded(join(this.directory, 'liquipedia.json'))) as { schema?: unknown; fetchedAt?: unknown; payload?: unknown }
      if (value.schema !== 1 || !Number.isSafeInteger(value.fetchedAt) || Number(value.fetchedAt) < 0) return null
      return { fetchedAt: Number(value.fetchedAt), matches: parseSchedule(value.payload) }
    } catch { return null }
  }
  save(payload: unknown, fetchedAt: number): void { atomicJson(this.directory, 'liquipedia.json', { schema: 1, fetchedAt, payload }) }
  reserve(now: number): boolean {
    mkdirSync(this.directory, { recursive: true })
    const lock = join(this.directory, 'liquipedia.lock')
    let fd: number
    try { fd = openSync(lock, 'wx', 0o600) } catch {
      // Never steal from a live process. An interrupted reservation can be retried after
      // a full interval, once its process is known to have exited.
      try {
        const stat = lstatSync(lock)
        const owner = JSON.parse(readBounded(lock)) as { pid?: unknown }
        if (now - stat.mtimeMs < 2 * PARSE_INTERVAL_MS || !Number.isSafeInteger(owner.pid)) return false
        let dead = false
        try { process.kill(Number(owner.pid), 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        if (!dead) return false
        unlinkSync(lock)
        fd = openSync(lock, 'wx', 0o600)
      } catch { return false }
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }))
      const attempts = join(this.directory, 'liquipedia-attempt.json')
      if (existsSync(attempts)) {
        const last = JSON.parse(readBounded(attempts)) as { at?: unknown }
        // Corruption or a clock moving backwards cannot turn off the limit.
        if (!Number.isSafeInteger(last.at) || Number(last.at) < 0 || now - Number(last.at) < PARSE_INTERVAL_MS) return false
      }
      atomicJson(this.directory, 'liquipedia-attempt.json', { at: now })
      return true
    } finally { closeSync(fd); unlinkSync(lock) }
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status !== 200 || response.redirected || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Metadata response unavailable')
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_BODY_BYTES) throw new Error('Metadata response too large')
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}

// A single budget covers concurrent calls from every service/window in this process.
let titleActive = 0
const titleWaiters: Array<() => void> = []
async function titleSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (titleActive >= 4) await new Promise<void>(resolve => titleWaiters.push(resolve))
  else titleActive++
  try { signal.throwIfAborted(); return await run() }
  finally {
    const next = titleWaiters.shift()
    if (next) next()
    else titleActive--
  }
}

export function titleStage(title: string): string | null {
  const markers = new Set<string>()
  const bracket = /^\s*\[([A-D])\](?:\s|$)/i.exec(title)
  if (bracket) markers.add(bracket[1]!.toUpperCase())
  for (const match of title.matchAll(/\b(?:stream|stage)\s+([A-D])\b|\b([A-D])\s+(?:stream|stage)\b/gi)) markers.add((match[1] ?? match[2])!.toUpperCase())
  if (/\bmain\s+(?:stream|stage)\b|主舞台/i.test(title)) markers.add('主舞台')
  if (/\bsecondary\s+(?:stream|stage)\b|副舞台/i.test(title)) markers.add('副舞台')
  return markers.size === 1 ? [...markers][0]! : null
}
function cleanTitle(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() && raw.length <= 2_000 && !/[\x00-\x1f\x7f]/.test(raw) ? raw.trim() : null
}
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const invalid = (): never => { throw new FeatureApiError('invalid-arguments') }

export function scheduleArguments(raw: unknown): { refresh?: boolean } | undefined {
  if (raw === undefined) return undefined
  if (!object(raw) || Object.keys(raw).some(k => k !== 'refresh') || (raw.refresh !== undefined && typeof raw.refresh !== 'boolean')) return invalid()
  return raw as { refresh?: boolean }
}
export function streamTitleArguments(raw: unknown): { streams: StreamTitleInput[] } {
  if (!object(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.streams) || raw.streams.length > 12) return invalid()
  const streams = raw.streams.map(value => {
    if (!object(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'videoId')
      || (value.platform !== 'youtube' && value.platform !== 'twitch') || !validChannel(value.platform, value.channel)
      || (value.videoId !== null && (typeof value.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId)))
      || (value.platform === 'twitch' && value.videoId !== null)) return invalid()
    return { platform: value.platform, channel: value.channel, videoId: value.videoId } as StreamTitleInput
  })
  return { streams }
}

export class EsportsService {
  private readonly now: () => number
  private readonly disk: ScheduleDisk
  private readonly pool = new PinnedDispatcherPool()
  private readonly lifetime = new AbortController()
  private cache: CachedSchedule | null = null
  private flight: Promise<Cs2Schedule> | undefined
  private booted = false
  private readonly titles = new Map<string, { at: number; value: StreamTitle }>()
  private readonly titleFlights = new Map<string, Promise<StreamTitle>>()
  constructor(private readonly options: Dependencies) {
    this.now = options.now ?? Date.now
    this.disk = new ScheduleDisk(options.userDataDir)
  }
  private snapshot(error?: string): Cs2Schedule {
    const now = this.now()
    return { fetchedAt: this.cache?.fetchedAt ?? 0, source: 'liquipedia', attribution: ATTRIBUTION,
      stale: !!error || !this.cache || now - this.cache.fetchedAt >= SCHEDULE_TTL_MS || now < this.cache.fetchedAt,
      ...(error ? { error } : {}), matches: structuredClone(currentMatches(this.cache?.matches ?? [], now)) }
  }
  getCs2Schedule(raw?: { refresh?: boolean }): Promise<Cs2Schedule> {
    const args = scheduleArguments(raw)
    this.lifetime.signal.throwIfAborted()
    if (this.flight) return this.flight.then(value => structuredClone(value))
    const fromDisk = this.disk.load()
    if (fromDisk && (!this.cache || fromDisk.fetchedAt > this.cache.fetchedAt)) this.cache = fromDisk
    const first = !this.booted
    this.booted = true
    if (!args?.refresh && this.cache && !this.snapshot().stale) return Promise.resolve(this.snapshot())
    const work = this.refresh().finally(() => { if (this.flight === work) this.flight = undefined })
    this.flight = work
    // Cold starts can paint old data immediately. A later read joins the same refresh.
    if (first && this.cache && !args?.refresh) { void work; return Promise.resolve(this.snapshot()) }
    return work.then(value => structuredClone(value))
  }
  private async refresh(): Promise<Cs2Schedule> {
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
      const result = await safeFetch(SCHEDULE_URL, metadataConfig(), {
        signal, resolve: this.options.resolve, dispatcherPool: this.pool,
        headers: { 'User-Agent': metadataUserAgent(this.options.version), 'Accept-Encoding': 'gzip', Accept: 'application/json' },
        fetchImpl: (input, init) => {
          // Reserve after DNS validation, immediately before the only actual request.
          if (!this.disk.reserve(this.now())) throw new RateLimited()
          return (this.options.request ?? fetch)(input, init)
        },
      })
      const payload = await readJson(result.response)
      const matches = parseSchedule(payload), fetchedAt = this.now()
      this.disk.save(payload, fetchedAt)
      this.cache = { fetchedAt, matches }
      return this.snapshot()
    } catch (error) {
      if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
      if (error instanceof ScheduleFormatError) {
        ;(this.options.log ?? console.warn)(`Liquipedia selector failed: ${error.selector}`)
        return this.snapshot(error.message)
      }
      if (error instanceof RateLimited && this.cache) return this.snapshot()
      return this.snapshot(UNAVAILABLE)
    }
  }
  async getStreamTitles(raw: { streams: StreamTitleInput[] }): Promise<StreamTitle[]> {
    const { streams } = streamTitleArguments(raw)
    this.lifetime.signal.throwIfAborted()
    const unique = new Map(streams.map(stream => [JSON.stringify([stream.platform, stream.channel, stream.videoId]), stream]))
    return Promise.all([...unique].map(async ([key, stream]) => {
      const cached = this.titles.get(key), now = this.now()
      if (cached && now >= cached.at && now - cached.at < TITLE_TTL_MS) return structuredClone(cached.value)
      let work = this.titleFlights.get(key)
      if (!work) {
        work = titleSlot(this.lifetime.signal, () => this.fetchTitle(stream)).then(value => {
          if (this.titles.size >= 256) this.titles.delete(this.titles.keys().next().value!)
          this.titles.set(key, { at: this.now(), value }); return value
        }).finally(() => { this.titleFlights.delete(key) })
        this.titleFlights.set(key, work)
      }
      return structuredClone(await work)
    }))
  }
  private async fetchTitle(stream: StreamTitleInput): Promise<StreamTitle> {
    const fallback: StreamTitle = { ...stream, title: null, stage: null, live: null }
    // oEmbed cannot resolve a channel's current live video or its live state.
    if (stream.platform === 'youtube' && stream.videoId === null) return fallback
    try {
      const url = stream.platform === 'youtube'
        ? 'https://www.youtube.com/oembed?' + new URLSearchParams({ url: `https://www.youtube.com/watch?v=${stream.videoId}`, format: 'json' })
        : 'https://gql.twitch.tv/gql'
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
      const result = await safeFetch(url, metadataConfig(), { signal, resolve: this.options.resolve, dispatcherPool: this.pool,
        fetchImpl: this.options.request,
        headers: { 'User-Agent': metadataUserAgent(this.options.version), Accept: 'application/json', 'Accept-Encoding': 'gzip',
          ...(stream.platform === 'twitch' ? { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' } : {}) },
        ...(stream.platform === 'twitch' ? { method: 'POST', body: JSON.stringify({ operationName: 'StreamTitle',
          query: 'query StreamTitle($login: String!) { user(login: $login) { stream { title type } } }', variables: { login: stream.channel } }) } : {}),
      })
      const data = await readJson(result.response)
      if (!object(data)) return fallback
      if (stream.platform === 'youtube') {
        const title = cleanTitle(data.title)
        return { ...fallback, title, stage: title ? titleStage(title) : null }
      }
      if (data.errors || !object(data.data) || !object(data.data.user)) return fallback
      const liveStream = data.data.user.stream
      if (liveStream === null) return { ...fallback, live: false }
      if (!object(liveStream) || typeof liveStream.type !== 'string') return fallback
      const title = cleanTitle(liveStream.title)
      return { ...fallback, title, stage: title ? titleStage(title) : null, live: liveStream.type === 'live' }
    } catch { return fallback }
  }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await this.pool.dispose()
    await Promise.allSettled([this.flight, ...this.titleFlights.values()])
    this.titles.clear()
  }
}
