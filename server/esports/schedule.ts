import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { metadataUserAgent } from '../appIdentity'
import { metadataConfig } from '../config'
import { FeatureApiError } from '../featureApi'
import { PinnedDispatcherPool, safeFetch, type Resolver } from '../safeFetch'
import { currentMatches, parseSchedule, ScheduleFormatError, validChannel } from './parser'
import { normalizeTournamentPath, queryTournamentTiers, type TournamentTier } from './tiers'
import { LiquipediaRateLimit } from './liquipediaRateLimit'
import type { Cs2ScheduleEvent } from '../../electron/featureContracts'
import type { Cs2Match, Cs2Schedule, StreamTitle, StreamTitleInput } from './types'
import { TeamLogoCache } from './teamLogos'

export { PARSE_INTERVAL_MS } from './liquipediaRateLimit'

export const SCHEDULE_URL = 'https://liquipedia.net/counterstrike/api.php?action=parse&page=Liquipedia:Matches&format=json&prop=text'
export const ATTRIBUTION = '赛程数据来自 Liquipedia (CC-BY-SA 3.0)'
export const SCHEDULE_TTL_MS = 300_000
export const TITLE_TTL_MS = 120_000
export const TIER_TTL_MS = 24 * 60 * 60_000
export const TIER_NULL_TTL_MS = 6 * 60 * 60_000
export const TIER_RETRY_MS = 300_000
const MAX_BODY_BYTES = 2_000_000
const UNAVAILABLE = '赛程暂时无法读取, 请稍后重试'
class RateLimited extends Error {}

interface CachedSchedule { fetchedAt: number; matches: Cs2Match[]; logoPaths: Map<string, string> }
interface CachedTier { tier: TournamentTier | null; fetchedAt: number | null; retryAt?: number }
interface CachedTiers { schema: 2; entries: Record<string, CachedTier> }
const emptyTiers = (): CachedTiers => ({ schema: 2, entries: Object.create(null) as Record<string, CachedTier> })
interface Dependencies {
  userDataDir: string
  version: string
  now?: () => number
  request?: typeof fetch
  resolve?: Resolver
  log?: (message: string) => void
  onEvent?: (event: Cs2ScheduleEvent) => void
  /** Disable background images in parse-only tests. Production always creates a cache. */
  logos?: TeamLogoCache | null
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

/** Persistent schedule payload and path-level tier metadata shared across windows. */
class ScheduleDisk {
  readonly directory: string
  constructor(root: string) { this.directory = join(resolve(root), 'events') }
  load(): CachedSchedule | null {
    try {
      const value = JSON.parse(readBounded(join(this.directory, 'liquipedia.json'))) as { schema?: unknown; fetchedAt?: unknown; payload?: unknown }
      if (value.schema !== 1 || !Number.isSafeInteger(value.fetchedAt) || Number(value.fetchedAt) < 0) return null
      const logoPaths = new Map<string, string>()
      return { fetchedAt: Number(value.fetchedAt), matches: parseSchedule(value.payload, logoPaths), logoPaths }
    } catch { return null }
  }
  save(payload: unknown, fetchedAt: number): void { atomicJson(this.directory, 'liquipedia.json', { schema: 1, fetchedAt, payload }) }
  loadTiers(): CachedTiers {
    const result = emptyTiers()
    try {
      const value = JSON.parse(readBounded(join(this.directory, 'tiers.json'))) as CachedTiers
      if (value.schema !== 2 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return result
      for (const [path, entry] of Object.entries(value.entries)) {
        // Ignore malformed entries independently. A schema-1 table is never reused.
        if (path.length > 2_000 || normalizeTournamentPath('/counterstrike/' + path.split('/').map(encodeURIComponent).join('/')) !== path
          || !entry || (entry.tier !== null && ![1, 2, 3, 4].includes(entry.tier))
          || (entry.fetchedAt !== null && (!Number.isSafeInteger(entry.fetchedAt) || entry.fetchedAt < 0))
          || (entry.retryAt !== undefined && (!Number.isSafeInteger(entry.retryAt) || entry.retryAt < 0))) continue
        result.entries[path] = entry
      }
    } catch { /* Missing, legacy and damaged caches are rebuilt in the background. */ }
    return result
  }
  saveTiers(entries: Record<string, CachedTier>): void {
    const value = this.loadTiers()
    Object.assign(value.entries, entries)
    mkdirSync(this.directory, { recursive: true })
    atomicJson(this.directory, 'tiers.json', value)
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
  private readonly rateLimit: LiquipediaRateLimit
  private readonly pool = new PinnedDispatcherPool()
  private readonly lifetime = new AbortController()
  private readonly logos: TeamLogoCache | null
  private cache: CachedSchedule | null = null
  private flight: Promise<Cs2Schedule> | undefined
  private tierFlight: Promise<void> | undefined
  private tierTimer: ReturnType<typeof setTimeout> | undefined
  private eventTimer: ReturnType<typeof setTimeout> | undefined
  private lastEventAt = -Infinity
  private readonly pendingEvents = new Set<Cs2ScheduleEvent['data']['type']>()
  private booted = false
  private readonly titles = new Map<string, { at: number; value: StreamTitle }>()
  private readonly titleFlights = new Map<string, Promise<StreamTitle>>()
  constructor(private readonly options: Dependencies) {
    this.now = options.now ?? Date.now
    this.disk = new ScheduleDisk(options.userDataDir)
    this.rateLimit = new LiquipediaRateLimit(options.userDataDir, this.now)
    this.logos = options.logos === undefined ? new TeamLogoCache({ ...options, rateLimit: this.rateLimit,
      onUpdated: () => this.notify('logos-updated') }) : options.logos
  }
  private snapshot(error?: string): Cs2Schedule {
    const now = this.now()
    const cached = this.disk.loadTiers()
    const matches = structuredClone(currentMatches(this.cache?.matches ?? [], now))
    for (const match of matches) {
      const path = normalizeTournamentPath(match.tournament.url)
      match.tournament.tier = path === null ? null : cached.entries[path]?.tier ?? null
      match.teams.forEach((team, index) => { team.logo = this.logos?.get(this.cache?.logoPaths.get(`${match.id}:${index}`), false) ?? null })
    }
    return { fetchedAt: this.cache?.fetchedAt ?? 0, source: 'liquipedia', attribution: ATTRIBUTION,
      stale: !!error || !this.cache || now - this.cache.fetchedAt >= SCHEDULE_TTL_MS || now < this.cache.fetchedAt,
      ...(error ? { error } : {}), matches }
  }
  getCs2Schedule(raw?: { refresh?: boolean }): Promise<Cs2Schedule> {
    const args = scheduleArguments(raw)
    this.lifetime.signal.throwIfAborted()
    if (this.flight) return this.flight.then(value => structuredClone(value))
    const fromDisk = this.disk.load()
    if (fromDisk && (!this.cache || fromDisk.fetchedAt > this.cache.fetchedAt)) this.cache = fromDisk
    const first = !this.booted
    this.booted = true
    if (!args?.refresh && this.cache && !this.snapshot().stale) { this.scheduleTierRefresh(); return Promise.resolve(this.snapshot()) }
    const work = this.refresh().finally(() => { if (this.flight === work) this.flight = undefined; this.scheduleTierRefresh() })
    this.flight = work
    // Cold starts can paint old data immediately. A later read joins the same refresh.
    if (first && this.cache && !args?.refresh) { void work; return Promise.resolve(this.snapshot()) }
    return work.then(value => structuredClone(value))
  }
  private tournamentPaths(): string[] {
    return [...new Set(currentMatches(this.cache?.matches ?? [], this.now())
      .map(match => normalizeTournamentPath(match.tournament.url)).filter((path): path is string => path !== null))]
  }
  private tierDelay(entry: CachedTier | undefined, now: number): number {
    if (!entry) return 0
    if (entry.retryAt !== undefined && now < entry.retryAt) return entry.retryAt - now
    if (entry.fetchedAt === null || now < entry.fetchedAt) return 0
    return Math.max(0, entry.fetchedAt + (entry.tier === null ? TIER_NULL_TTL_MS : TIER_TTL_MS) - now)
  }
  private enqueueLogos(): void {
    if (this.lifetime.signal.aborted) return
    for (const match of currentMatches(this.cache?.matches ?? [], this.now())) {
      match.teams.forEach((_team, index) => this.logos?.get(this.cache?.logoPaths.get(`${match.id}:${index}`)))
    }
  }
  private scheduleTierRefresh(): void {
    if (this.lifetime.signal.aborted || this.tierFlight) return
    clearTimeout(this.tierTimer)
    this.tierTimer = undefined
    const now = this.now(), cached = this.disk.loadTiers(), paths = this.tournamentPaths()
    if (!paths.length) { this.enqueueLogos(); return }
    const due = Math.min(...paths.map(path => this.tierDelay(cached.entries[path], now)))
    if (due > 0) this.enqueueLogos()
    // Tier queries take only the HTTP quota, independent of the 30-second parse quota.
    this.tierTimer = setTimeout(() => {
      this.tierTimer = undefined
      if (this.flight) return
      const work = this.refreshTiers().catch(() => {
        if (!this.lifetime.signal.aborted) (this.options.log ?? console.warn)('Liquipedia tier cache refresh failed')
      }).finally(() => {
        this.tierFlight = undefined
        this.enqueueLogos()
        this.scheduleTierRefresh()
      })
      this.tierFlight = work
    }, Math.max(this.rateLimit.delay(), due))
    this.tierTimer.unref?.()
  }
  private notify(type: Cs2ScheduleEvent['data']['type']): void {
    if (this.lifetime.signal.aborted || !this.options.onEvent) return
    this.pendingEvents.add(type)
    if (this.eventTimer) return
    const emit = () => {
      this.eventTimer = undefined
      if (this.lifetime.signal.aborted) return
      const next = this.pendingEvents.values().next().value
      if (!next) return
      this.pendingEvents.delete(next)
      this.lastEventAt = this.now()
      try { this.options.onEvent?.({ topic: 'cs2-schedule', data: { type: next } }) } catch { /* An observer cannot invalidate cached metadata. */ }
      if (this.pendingEvents.size) this.notify(this.pendingEvents.values().next().value!)
    }
    const delay = Math.max(0, this.lastEventAt + 2_000 - this.now())
    if (!delay) emit()
    else { this.eventTimer = setTimeout(emit, delay); this.eventTimer.unref?.() }
  }
  private async fetchMetadata(url: string, parse: boolean): Promise<unknown> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
    const result = await safeFetch(url, metadataConfig(), {
      signal, resolve: this.options.resolve, dispatcherPool: this.pool,
      headers: { 'User-Agent': metadataUserAgent(this.options.version), 'Accept-Encoding': 'gzip', Accept: 'application/json' },
      fetchImpl: async (input, init) => {
        if (parse) { if (!this.rateLimit.reserve(true)) throw new RateLimited() }
        else await this.rateLimit.wait(signal)
        return (this.options.request ?? fetch)(input, init)
      },
    })
    return readJson(result.response)
  }
  private async refreshTiers(): Promise<void> {
    const cached = this.disk.loadTiers(), now = this.now()
    const paths = this.tournamentPaths().filter(path => this.tierDelay(cached.entries[path], now) === 0)
    if (!paths.length) return
    const result = await queryTournamentTiers(paths, url => this.fetchMetadata(url, false))
    if (this.lifetime.signal.aborted) return
    const updates: Record<string, CachedTier> = Object.create(null) as Record<string, CachedTier>
    const previous = this.disk.loadTiers()
    let changed = false
    for (const [path, tier] of result.tiers) {
      if ((previous.entries[path]?.tier ?? null) !== tier) changed = true
      updates[path] = { tier, fetchedAt: this.now() }
    }
    for (const path of result.failed) {
      updates[path] = { tier: previous.entries[path]?.tier ?? null, fetchedAt: previous.entries[path]?.fetchedAt ?? null,
        retryAt: this.now() + TIER_RETRY_MS }
    }
    this.disk.saveTiers(updates)
    if (result.failed.length) (this.options.log ?? console.warn)(`Liquipedia tier query failed for ${result.failed.length} tournament paths`)
    if (changed) this.notify('tiers-updated')
  }
  private async refresh(): Promise<Cs2Schedule> {
    try {
      const payload = await this.fetchMetadata(SCHEDULE_URL, true)
      const logoPaths = new Map<string, string>()
      const matches = parseSchedule(payload, logoPaths,
        selector => (this.options.log ?? console.warn)(`Liquipedia match skipped: ${selector}`)), fetchedAt = this.now()
      this.disk.save(payload, fetchedAt)
      this.cache = { fetchedAt, matches, logoPaths }
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
    clearTimeout(this.tierTimer)
    clearTimeout(this.eventTimer)
    this.pendingEvents.clear()
    await this.logos?.dispose()
    await this.pool.dispose()
    await Promise.allSettled([this.flight, this.tierFlight, ...this.titleFlights.values()])
    this.titles.clear()
  }
}
