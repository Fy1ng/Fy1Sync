import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { metadataUserAgent } from '../appIdentity'
import { metadataConfig } from '../config'
import { FeatureApiError } from '../featureApi'
import { PinnedDispatcherPool, safeFetch, type Resolver } from '../safeFetch'
import { currentMatches, parseSchedule, ScheduleFormatError, validEntry, validTwitchLogin } from './parser'
import { normalizeTournamentPath, queryTournamentTiers, type TournamentTier } from './tiers'
import { cooldownRound, DispatchTurns, LiquipediaCoolingDown, LiquipediaRateLimit, pause, verificationNotBefore, VerificationRoundEnded } from './liquipediaRateLimit'
import { channelLinksUrl, eventChannels, matchChannel, type EventChannels } from './streamChannels'
import type { Cs2ScheduleEvent } from '../../electron/featureContracts'
import type { Cs2Match, Cs2Schedule, StreamTitle, StreamTitleInput } from './types'
import { TeamLogoCache } from './teamLogos'
import { diagnosticDetails } from '../errorDetails'
import { httpErrorDetails } from '../httpError'

export { PARSE_INTERVAL_MS } from './liquipediaRateLimit'

// Parse the transclusion instead of reusing the shared page parser cache. Individual
// widgets can still return old match data; a fresh API read does not prove fresh scores.
export const SCHEDULE_URL = 'https://liquipedia.net/counterstrike/api.php?' + new URLSearchParams({
  action: 'parse', format: 'json', prop: 'text', title: 'Liquipedia:Matches', text: '{{Liquipedia:Matches}}',
})
export const ATTRIBUTION = '赛程数据来自 Liquipedia（CC-BY-SA 3.0）'
export const SCHEDULE_TTL_MS = 300_000
const ACTIVE_SCHEDULE_TTL_MS = 60_000
const SOON_WINDOW_MS = 15 * 60_000
export const TITLE_TTL_MS = 120_000
export const TIER_TTL_MS = 24 * 60 * 60_000
export const TIER_NULL_TTL_MS = 6 * 60 * 60_000
export const TIER_RETRY_MS = 300_000
/** An event's channels are read again after a day, or five minutes after a failed read. */
export const CHANNEL_TTL_MS = 24 * 60 * 60_000
export const CHANNEL_RETRY_MS = 300_000
const MAX_BODY_BYTES = 2_000_000
const UNAVAILABLE = '赛程暂时无法读取，请稍后重试'
const UPSTREAM_LIMITED = '赛程更新受限，暂时显示上次结果'
/** Refused for the 30-second parse quota; `at` is when the quota frees. */
class RateLimited extends Error { constructor(readonly at: number) { super('Liquipedia parse quota') } }

interface CachedSchedule { fetchedAt: number; matches: Cs2Match[]; logoPaths: Map<string, string> }
interface CachedTier { tier: TournamentTier | null; fetchedAt: number | null; retryAt?: number }
interface CachedTiers { schema: 2; entries: Record<string, CachedTier> }
interface CachedChannels extends EventChannels { at: number; failed: boolean; errorDetail?: import('../../src/core/errorDetails').ErrorDetails }
const emptyTiers = (): CachedTiers => ({ schema: 2, entries: Object.create(null) as Record<string, CachedTier> })
interface Dependencies {
  userDataDir: string
  bundledLogoDir?: string
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
    const detail = await httpErrorDetails(response)
    throw Object.assign(new Error('Metadata response unavailable'), detail)
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
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (object(payload) && payload.error) throw Object.assign(new Error('Metadata API returned an error'), { upstream: diagnosticDetails(payload.error) })
    return payload
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
/** The event 赛程 shows, as a Liquipedia path such as `/counterstrike/PGL/2026/Masters`; never a full URL. */
export function scheduleFocusArguments(raw: unknown): { eventPath: string | null } {
  if (!object(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'eventPath')) return invalid()
  const value = raw.eventPath
  if (value === null) return { eventPath: null }
  if (typeof value !== 'string' || value.length > 500 || !value.startsWith('/counterstrike/') || /[?#\\]/.test(value)) return invalid()
  return { eventPath: value }
}
export function streamTitleArguments(raw: unknown): { streams: StreamTitleInput[] } {
  if (!object(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.streams) || raw.streams.length > 12) return invalid()
  const streams = raw.streams.map(value => {
    if (!object(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'videoId')
      || (value.platform !== 'youtube' && value.platform !== 'twitch')
      || !(value.platform === 'twitch' ? validTwitchLogin(value.channel) : validEntry(value.channel))
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
  private readonly turns: DispatchTurns
  private readonly pool = new PinnedDispatcherPool()
  private readonly lifetime = new AbortController()
  private readonly logos: TeamLogoCache | null
  private cache: CachedSchedule | null = null
  private flight: Promise<Cs2Schedule> | undefined
  private tierFlight: Promise<void> | undefined
  private tierTimer: ReturnType<typeof setTimeout> | undefined
  private logoTimer: ReturnType<typeof setInterval> | undefined
  private eventTimer: ReturnType<typeof setTimeout> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private openedVerificationRound: string | undefined
  private usedVerificationRound: string | undefined
  /** When a parse was last tried, so a failed one waits a whole interval before the next. */
  private attemptedAt = -Infinity
  private lastFailure: { message: string; detail: ReturnType<typeof diagnosticDetails>; failedAt: number; retryAt: number } | null = null
  private lastEventAt = -Infinity
  private readonly pendingEvents = new Set<Cs2ScheduleEvent['data']['type']>()
  private booted = false
  /** The event 赛程 shows, normalized; its crests are fetched right after the live ones. */
  private focus: string | null = null
  private readonly titles = new Map<string, { at: number; value: StreamTitle }>()
  private readonly titleFlights = new Map<string, Promise<StreamTitle>>()
  /** The channels linked from each event page, by normalized event path, in memory only. */
  private readonly channels = new Map<string, CachedChannels>()
  private readonly channelFlights = new Map<string, Promise<void>>()
  constructor(private readonly options: Dependencies) {
    this.now = options.now ?? Date.now
    this.disk = new ScheduleDisk(options.userDataDir)
    this.rateLimit = new LiquipediaRateLimit(options.userDataDir, this.now)
    this.turns = new DispatchTurns(this.rateLimit)
    this.logos = options.logos === undefined ? new TeamLogoCache({ ...options, rateLimit: this.rateLimit, turns: this.turns,
      onUpdated: () => this.notify('logos-updated') }) : options.logos
    if (this.logos) {
      // Recompute the visible time window even while no renderer is reading snapshots.
      this.logoTimer = setInterval(() => this.enqueueLogos(), 30_000)
      this.logoTimer.unref?.()
    }
  }
  private snapshot(error?: string, refreshAt?: number, errorDetail?: unknown, refreshReason?: Cs2Schedule['refreshReason']): Cs2Schedule {
    const now = this.now()
    const cooldown = this.rateLimit.cooldown()
    if (cooldown) {
      error = UPSTREAM_LIMITED
      refreshAt = cooldown.until
      refreshReason = 'upstream-rate-limit'
      errorDetail = { ...diagnosticDetails(errorDetail ?? this.lastFailure?.detail ?? { status: 429 }), status: 429,
        cooldown, ...(cooldown.retryAfter ? { retryAfter: cooldown.retryAfter } : {}) }
    }
    const cached = this.disk.loadTiers()
    const matches = structuredClone(currentMatches(this.cache?.matches ?? [], now))
    this.updateActiveLogos(matches)
    for (const match of matches) {
      const path = normalizeTournamentPath(match.tournament.url)
      match.tournament.tier = path === null ? null : cached.entries[path]?.tier ?? null
      match.tournament.logo = this.logos?.get(this.cache?.logoPaths.get(`${match.id}:event`), false) ?? null
      match.teams.forEach((team, index) => { team.logo = this.logos?.get(this.cache?.logoPaths.get(`${match.id}:${index}`), false) ?? null })
      this.resolveStreams(match, path)
    }
    return { fetchedAt: this.cache?.fetchedAt ?? 0, source: 'liquipedia', attribution: ATTRIBUTION,
      stale: !!error || !this.cache || now - this.cache.fetchedAt >= this.scheduleTtl() || now < this.cache.fetchedAt,
      ...(error ? { error } : {}), ...(errorDetail === undefined ? {} : { errorDetail: diagnosticDetails(errorDetail) }),
      ...(cooldown ? { verification: { round: cooldownRound(cooldown), notBefore: verificationNotBefore(cooldown),
        used: this.usedVerificationRound === cooldownRound(cooldown) } } : {}),
      ...(refreshAt !== undefined ? { refreshAt, ...(refreshReason ? { refreshReason } : {}) } : {}), matches }
  }
  getCs2Schedule(raw?: { refresh?: boolean }): Promise<Cs2Schedule> {
    const args = scheduleArguments(raw)
    this.lifetime.signal.throwIfAborted()
    if (this.flight && !this.rateLimit.cooldown()) return this.flight.then(value => structuredClone(value))
    const fromDisk = this.disk.load()
    if (fromDisk && (!this.cache || fromDisk.fetchedAt > this.cache.fetchedAt)) {
      this.cache = fromDisk
      if (this.lastFailure && fromDisk.fetchedAt > this.lastFailure.failedAt && fromDisk.fetchedAt <= this.now()) this.lastFailure = null
    }
    const first = !this.booted
    this.booted = true
    const cooldown = this.rateLimit.cooldown()
    if (cooldown || (this.lastFailure && this.now() < this.lastFailure.retryAt)) {
      this.scheduleBackgroundRefresh()
      return Promise.resolve(this.snapshot(this.lastFailure?.message, this.lastFailure?.retryAt, this.lastFailure?.detail, 'retry'))
    }
    if (!args?.refresh && this.cache && !this.snapshot().stale) {
      this.scheduleTierRefresh()
      this.scheduleBackgroundRefresh()
      return Promise.resolve(this.snapshot())
    }
    const work = this.startRefresh()
    // Cold starts can paint old data immediately. A later read joins the same refresh.
    if (first && this.cache && !args?.refresh) { void work; return Promise.resolve(this.snapshot()) }
    return work.then(value => structuredClone(value))
  }
  async openLiquipediaVerification(open: () => Promise<void>): Promise<{ opened: true }> {
    const cooldown = this.rateLimit.cooldown()
    await open()
    if (cooldown && this.rateLimit.isVerificationRound(cooldownRound(cooldown))) this.openedVerificationRound = cooldownRound(cooldown)
    return { opened: true }
  }
  refreshCs2ScheduleAfterVerification(raw: { round: string }): Promise<Cs2Schedule> {
    if (!object(raw) || Object.keys(raw).length !== 1 || typeof raw.round !== 'string' || !/^[a-f\d:-]{1,64}$/.test(raw.round)) return invalid()
    const { round } = raw
    this.lifetime.signal.throwIfAborted()
    if (this.flight || this.openedVerificationRound !== round || this.usedVerificationRound === round || !this.rateLimit.isVerificationRound(round)) {
      return Promise.resolve({ ...this.snapshot(), verificationResult: 'not-attempted' })
    }
    this.usedVerificationRound = round
    return this.startRefresh(round).then(value => structuredClone(value))
  }
  private startRefresh(round?: string): Promise<Cs2Schedule> {
    const work = this.refresh(round).finally(() => {
      if (this.flight === work) this.flight = undefined
      this.scheduleTierRefresh()
      this.scheduleBackgroundRefresh()
    })
    this.flight = work
    return work
  }
  /** Only an active event being viewed needs minute-level reads; closed sheets keep the background cadence. */
  private scheduleTtl(): number {
    if (!this.focus || !this.cache) return SCHEDULE_TTL_MS
    const now = this.now()
    const active = currentMatches(this.cache.matches, now).some(match =>
      normalizeTournamentPath(match.tournament.url) === this.focus && match.state !== 'finished' && match.startsAt <= now + SOON_WINDOW_MS)
    return active ? ACTIVE_SCHEDULE_TTL_MS : SCHEDULE_TTL_MS
  }
  /** Refresh when due after the last fetch or failed try, without changing shared request quotas. */
  private scheduleBackgroundRefresh(): void {
    if (this.lifetime.signal.aborted) return
    clearTimeout(this.refreshTimer)
    if (this.flight) return
    const interval = this.scheduleTtl()
    const last = Math.max(this.cache?.fetchedAt ?? -Infinity, this.attemptedAt)
    // Capped at one interval, so a clock moved backwards cannot push the next read out for hours.
    const now = this.now(), cooldown = this.rateLimit.cooldown()
    const due = cooldown ? cooldown.until - now : this.lastFailure ? Math.max(0, this.lastFailure.retryAt - now)
      : Math.min(interval, Math.max(0, last + interval - now))
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      if (!this.lifetime.signal.aborted) void this.getCs2Schedule().catch(() => undefined)
    }, Math.min(due, 2_147_483_647))
    this.refreshTimer.unref?.()
  }
  /**
   * Remember which event 赛程 shows, so its missing crests are fetched next and the channels
   * behind its streams are looked up. Only events on the current schedule count.
   */
  setScheduleFocus(raw: { eventPath: string | null }): { updated: true } {
    const { eventPath } = scheduleFocusArguments(raw)
    this.lifetime.signal.throwIfAborted()
    const path = eventPath === null ? null : normalizeTournamentPath(eventPath)
    this.focus = path !== null && this.tournamentPaths().includes(path) ? path : null
    if (this.booted) this.scheduleBackgroundRefresh()
    this.enqueueLogos()
    if (this.focus) this.findChannels(this.focus)
    return { updated: true }
  }
  /**
   * Read which channels an event page links, for its streams that name no video: one plain
   * query in the shared 2-second slot, taking turns with crests as the tier query does. A page
   * that links none (a stage page under the event) passes the look to its parent, at most two
   * levels up. Kept a day; a failed read may be tried again after five minutes.
   */
  private findChannels(path: string): void {
    if (this.lifetime.signal.aborted || this.channelFlights.has(path)) return
    const cached = this.channels.get(path), now = this.now()
    if (cached && now >= cached.at && now - cached.at < (cached.failed ? CHANNEL_RETRY_MS : CHANNEL_TTL_MS)) return
    const waiting = currentMatches(this.cache?.matches ?? [], now)
      .some(match => normalizeTournamentPath(match.tournament.url) === path && match.streams.some(stream => stream.url === null))
    if (!waiting) return
    const work = (async () => {
      for (let page = path, depth = 0; ; depth++) {
        const found = eventChannels(await this.fetchMetadata(channelLinksUrl(page), false))
        const slash = page.lastIndexOf('/')
        if (found.twitch.length || found.youtube.length || depth >= 2 || slash < 0) return found
        page = page.slice(0, slash)
      }
    })().then(found => { this.channels.set(path, { ...found, at: this.now(), failed: false }) }, error => {
      if (this.lifetime.signal.aborted) return
      ;(this.options.log ?? console.warn)('Liquipedia stream channel lookup failed')
      this.channels.set(path, { twitch: [], youtube: [], at: this.now(), failed: true, errorDetail: diagnosticDetails(error) })
    }).finally(() => {
      this.channelFlights.delete(path)
      this.notify('streams-updated')
    })
    this.channelFlights.set(path, work)
  }
  /** Give each stream that names no video its matched channel, or say why it has none yet. */
  private resolveStreams(match: Cs2Match, path: string | null): void {
    const found = path === null ? undefined : this.channels.get(path)
    for (const stream of match.streams) {
      if (stream.url !== null) continue
      if (path !== null && (!found || found.failed)) {
        // A failed read being tried again shows as finding, not as failed.
        stream.missing = found && !this.channelFlights.has(path) ? 'failed' : 'finding'
        if (stream.missing === 'failed' && found?.errorDetail) stream.errorDetail = found.errorDetail
        continue
      }
      const channel = found ? matchChannel(stream.entry, found[stream.platform]) : null
      if (channel) Object.assign(stream, { channel: channel.name, url: channel.url, missing: null })
      else stream.missing = 'unmatched'
    }
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
  /**
   * Missing crests go live first, then the event 赛程 shows, then other matches still to
   * come, then finished ones. Each image is ranked once, by its most urgent match. Event icons
   * come after every crest: a crest says who plays, an icon only marks the event in the list.
   */
  private enqueueLogos(): void {
    if (this.lifetime.signal.aborted) return
    const matches = currentMatches(this.cache?.matches ?? [], this.now())
    this.updateActiveLogos(matches)
    const band = (match: Cs2Match): number => match.state === 'live' ? 0
      : normalizeTournamentPath(match.tournament.url) === this.focus && this.focus !== null ? 1
        : match.state === 'upcoming' ? 2 : 3
    // currentMatches already orders by start within each state; the band keeps that order.
    const ordered = matches.map((match, index) => ({ match, index }))
      .sort((a, b) => band(a.match) - band(b.match) || a.index - b.index).map(entry => entry.match)
    const paths = this.logoPathsOf(ordered)
    this.logos?.setPriorities(paths)
    for (const path of paths) this.logos?.get(path)
  }
  private updateActiveLogos(matches: Cs2Match[]): void {
    this.logos?.setActivePaths(this.logoPathsOf(matches))
  }
  /** Every crest of these matches in their order, then every event icon in the same order. */
  private logoPathsOf(matches: Cs2Match[]): string[] {
    const crests = matches.flatMap(match => match.teams.map((_team, index) => this.cache?.logoPaths.get(`${match.id}:${index}`)))
    const icons = matches.map(match => this.cache?.logoPaths.get(`${match.id}:event`))
    return [...crests, ...icons].filter((path): path is string => path !== undefined)
  }
  private scheduleTierRefresh(): void {
    if (this.lifetime.signal.aborted) return
    if (this.rateLimit.cooldown()) {
      clearTimeout(this.tierTimer)
      this.tierTimer = undefined
      return
    }
    // Crests never wait for the tier query, even one already in flight: both take the same
    // 2-second quota in turns, and the first crest asked for takes the first slot.
    this.enqueueLogos()
    if (this.tierFlight) return
    clearTimeout(this.tierTimer)
    this.tierTimer = undefined
    const now = this.now(), cached = this.disk.loadTiers(), paths = this.tournamentPaths()
    if (!paths.length) return
    const due = Math.min(...paths.map(path => this.tierDelay(cached.entries[path], now)))
    // Tier queries take only the HTTP quota, independent of the 30-second parse quota.
    this.tierTimer = setTimeout(() => {
      this.tierTimer = undefined
      if (this.flight) return
      const work = this.refreshTiers().catch(() => {
        if (!this.lifetime.signal.aborted) (this.options.log ?? console.warn)('Liquipedia tier cache refresh failed')
      }).finally(() => {
        this.tierFlight = undefined
        // Also re-ranks crests by any tier that just landed.
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
  /**
   * A parse that only waits for the shared 2-second slot (a crest or tier query just used it)
   * waits it out; one held back by the 30-second parse quota is refused with the time it frees,
   * before any request starts, so the refusal is never mistaken for a network failure.
   */
  private async parseSlot(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      this.rateLimit.throwIfCooling()
      // `delay()` is the shared 2-second slot alone; `delay(true)` adds the parse quota.
      const slot = this.rateLimit.delay(), quota = this.rateLimit.delay(true)
      if (quota > slot) throw new RateLimited(this.now() + quota)
      if (slot > 0) { await pause(slot, signal); continue }
      if (this.rateLimit.reserve(true)) return
      // Lost the slot to another window or process: look again rather than spin.
      await pause(25, signal)
    }
  }
  private async fetchMetadata(url: string, parse: boolean, verification?: { round: string; limited: boolean }): Promise<unknown> {
    if (!verification) this.rateLimit.throwIfCooling()
    const transport = new AbortController()
    const signal = AbortSignal.any([this.lifetime.signal, transport.signal])
    const timeout = () => setTimeout(() => transport.abort(new DOMException('Metadata request timed out', 'TimeoutError')), 15_000)
    let timer = timeout()
    let startedAt = this.now()
    let dispatched = false
    let quotaError: RateLimited | LiquipediaCoolingDown | VerificationRoundEnded | undefined
    const recordLimit = async (response: Response) => {
      if (verification) verification.limited = true
      await this.rateLimit.rateLimited(response.headers.get('retry-after'), signal, response.headers.get('date'))
      this.scheduleBackgroundRefresh()
      this.notify('schedule-updated')
    }
    try {
      const result = await safeFetch(url, metadataConfig(), {
        signal, resolve: this.options.resolve, dispatcherPool: this.pool,
        headers: { 'User-Agent': metadataUserAgent(this.options.version), 'Accept-Encoding': 'gzip', Accept: 'application/json' },
        fetchImpl: async (input, init) => {
          // Reserve immediately before dispatch; slow proxy/DNS decisions cannot bunch requests.
          try {
            if (verification) {
              if (dispatched) throw new Error('Verification request already dispatched')
              clearTimeout(timer)
              await this.rateLimit.waitForVerification(verification.round, signal)
              signal.throwIfAborted()
              timer = timeout()
              if (!this.rateLimit.isVerificationRound(verification.round)) throw new VerificationRoundEnded()
            } else {
              if (parse) await this.parseSlot(signal)
              else await this.turns.wait('tier', signal)
              this.rateLimit.throwIfCooling()
            }
          } catch (error) {
            if (error instanceof RateLimited || error instanceof LiquipediaCoolingDown || error instanceof VerificationRoundEnded) quotaError = error
            throw error
          }
          startedAt = this.now()
          dispatched = true
          const response = await (this.options.request ?? fetch)(input, init)
          if (response.status === 429) await recordLimit(response)
          return response
        },
      }).catch(error => { throw quotaError ?? error })
      try {
        const payload = await readJson(result.response)
        if (!verification) this.rateLimit.succeeded(startedAt)
        return payload
      } catch (error) {
        const upstream = diagnosticDetails(error).upstream
        if (result.response.status !== 429 && upstream && typeof upstream === 'object' && !Array.isArray(upstream)
          && (upstream.code === 'ratelimited' || upstream.code === 'rate-limited')) await recordLimit(result.response)
        throw error
      }
    } finally { clearTimeout(timer) }
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
  private async refresh(round?: string): Promise<Cs2Schedule> {
    this.attemptedAt = this.now()
    const verification = round ? { round, limited: false } : undefined
    try {
      const payload = await this.fetchMetadata(SCHEDULE_URL, true, verification)
      const logoPaths = new Map<string, string>()
      const matches = parseSchedule(payload, logoPaths,
        selector => (this.options.log ?? console.warn)(`Liquipedia match skipped: ${selector}`)), fetchedAt = this.now()
      const changed = this.cache !== null && JSON.stringify(this.cache.matches) !== JSON.stringify(matches)
      this.disk.save(payload, fetchedAt)
      const verified = round === undefined || await this.rateLimit.succeededVerification(round,
        AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(2_000)]))
      const recovered = this.lastFailure !== null
      if (verified || !this.rateLimit.cooldown()) this.lastFailure = null
      this.cache = { fetchedAt, matches, logoPaths }
      if (changed || recovered || verification) this.notify('schedule-updated')
      const value = this.snapshot()
      return verification ? { ...value, verificationResult: value.verification ? 'not-attempted' : 'recovered' } : value
    } catch (error) {
      if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
      if (error instanceof VerificationRoundEnded) return { ...this.snapshot(), verificationResult: 'not-attempted' }
      if (error instanceof RateLimited) {
        if (this.lastFailure) this.lastFailure.retryAt = Math.max(this.lastFailure.retryAt, error.at)
        return this.snapshot(this.lastFailure?.message ?? (this.cache ? undefined : UNAVAILABLE), error.at, this.lastFailure?.detail ?? error, 'parse-quota')
      }
      if (error instanceof ScheduleFormatError) (this.options.log ?? console.warn)(`Liquipedia selector failed: ${error.selector}`)
      const cooldown = this.rateLimit.cooldown()
      const message = cooldown || error instanceof LiquipediaCoolingDown ? UPSTREAM_LIMITED : error instanceof ScheduleFormatError ? error.message : UNAVAILABLE
      this.lastFailure = { message, detail: diagnosticDetails(error), failedAt: this.now(), retryAt: cooldown?.until ?? this.now() + SCHEDULE_TTL_MS }
      this.notify('schedule-updated')
      const value = this.snapshot(message, this.lastFailure.retryAt, error, cooldown ? 'upstream-rate-limit' : 'retry')
      return verification ? { ...value, verificationResult: verification.limited ? 'rate-limited' : 'failed' } : value
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
    clearInterval(this.logoTimer)
    clearTimeout(this.eventTimer)
    clearTimeout(this.refreshTimer)
    this.pendingEvents.clear()
    await this.logos?.dispose()
    await this.pool.dispose()
    await Promise.allSettled([this.flight, this.tierFlight, ...this.titleFlights.values(), ...this.channelFlights.values()])
    this.titles.clear()
    this.channels.clear()
  }
}
