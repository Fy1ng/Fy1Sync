import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { metadataUserAgent } from '../appIdentity'
import { metadataConfig, SCHEDULE_RELAY_HOST } from '../config'
import { diagnosticDetails } from '../errorDetails'
import { httpErrorDetails } from '../httpError'
import { directNetwork } from '../networkPolicy'
import { PinnedDispatcherPool, safeFetch, type Resolver } from '../safeFetch'
import type { Cs2ScheduleEvent } from '../../electron/featureContracts'
import { atomicJson, object, readBody, readBounded, SCHEDULE_UNAVAILABLE, UPSTREAM_LIMITED } from './metadataIo'
import { currentMatches } from './parser'
import { fromRelaySchedule, parseRelaySchedule, type RelayLogo, type RelaySchedule } from './relayProtocol'
import { scheduleArguments, scheduleFocusArguments, verificationRoundArgument } from './scheduleArguments'
import { StreamTitles } from './streamTitles'
import { LOGO_MAX_BYTES, readTeamLogo, writeRelayTeamLogo } from './teamLogos'
import type { Cs2Schedule, StreamTitle, StreamTitleInput } from './types'

const DEFAULT_RELAY = `https://${SCHEDULE_RELAY_HOST}`
const CACHE_FILE = 'relay-schedule.json'
const SCHEDULE_MAX_BYTES = 4_000_000
const READ_MIN_MS = 60_000
const POLL_MS = 300_000
const REFRESH_MIN_MS = 10_000
const STALE_MS = 15 * 60_000
const LOGO_RETRY_MS = 10 * 60_000
const LOGO_CONCURRENCY = 4
const loopbackOverride = /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}\/?$/i
const strongEtag = (value: unknown): string | null => typeof value === 'string' && /^"[\x21\x23-\x7e]{1,128}"$/.test(value) ? value : null

export function scheduleRelayOrigin(raw: string | undefined): string {
  try {
    const url = new URL(raw ?? DEFAULT_RELAY)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')
      || /(^|\.)liquipedia\.net\.?$/i.test(url.hostname)) return DEFAULT_RELAY
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopbackOverride.test(raw ?? ''))) return url.origin
  } catch { /* Ignore malformed environment overrides. */ }
  return DEFAULT_RELAY
}

const startupOverride = process.env.FY1SYNC_SCHEDULE_RELAY
interface Cache { origin: string; receivedAt: number; etag: string | null; schedule: RelaySchedule }
interface Dependencies {
  userDataDir: string
  bundledLogoDir?: string
  version: string
  now?: () => number
  request?: typeof fetch
  resolve?: Resolver
  onEvent?: (event: Cs2ScheduleEvent) => void
}

export class RelayScheduleService {
  private readonly now: () => number
  private readonly directory: string
  private readonly lifetime = new AbortController()
  private readonly pool = new PinnedDispatcherPool({ connections: LOGO_CONCURRENCY })
  private readonly titlePool = new PinnedDispatcherPool()
  private readonly titles: StreamTitles
  private readonly origin: URL
  private cache: Cache | null
  private timer: ReturnType<typeof setTimeout> | undefined
  private flight: Promise<void> | undefined
  private attemptedAt = -Infinity
  private nextPoll = -Infinity
  private failures = 0
  private failure: Cs2Schedule['errorDetail']
  private published = ''
  private readonly logoFlights = new Map<string, Promise<void>>()
  private readonly logoFailures = new Map<string, number>()
  private wantedLogos = new Map<string, RelayLogo>()
  private logoEventTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: Dependencies, relayOverride = startupOverride) {
    this.now = options.now ?? Date.now
    this.directory = join(resolve(options.userDataDir), 'events')
    this.origin = new URL(scheduleRelayOrigin(relayOverride))
    this.titles = new StreamTitles(options, this.now, this.lifetime.signal, this.titlePool)
    this.cache = this.load()
  }

  private load(): Cache | null {
    try {
      const raw: unknown = JSON.parse(readBounded(join(this.directory, CACHE_FILE), SCHEDULE_MAX_BYTES + 1_024))
      if (!object(raw) || raw.origin !== this.origin.origin || typeof raw.receivedAt !== 'number'
        || !Number.isSafeInteger(raw.receivedAt) || raw.receivedAt < 0) return null
      return { origin: raw.origin, receivedAt: raw.receivedAt, etag: strongEtag(raw.etag), schedule: parseRelaySchedule(raw.schedule) }
    } catch { return null }
  }

  private async request(path: string, accept: string, etag?: string | null): Promise<Response> {
    const config = metadataConfig(), local = this.origin.protocol === 'http:'
    config.hosts = [this.origin.hostname.replace(/^\[|\]$/g, '')]
    config.allowNonStandardPorts = !!this.origin.port
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(config.requestTimeoutMs)])
    const { response } = await safeFetch(new URL(path, this.origin).href, config, {
      signal, dispatcherPool: this.pool, fetchImpl: this.options.request,
      ...(local ? { network: directNetwork, resolve: async () => ['127.0.0.1'] } : { resolve: this.options.resolve }),
      headers: { 'User-Agent': metadataUserAgent(this.options.version), Accept: accept, 'Accept-Encoding': 'gzip',
        ...(etag ? { 'If-None-Match': etag } : {}) },
    })
    return response
  }

  getCs2Schedule(raw?: { refresh?: boolean }): Promise<Cs2Schedule> {
    const refresh = scheduleArguments(raw)?.refresh === true
    this.lifetime.signal.throwIfAborted()
    const now = this.now(), elapsed = now - this.attemptedAt
    const interval = refresh ? REFRESH_MIN_MS : READ_MIN_MS
    const tooSoon = this.failures ? now < this.nextPoll : elapsed >= 0 && elapsed < interval
    if (!this.flight && !tooSoon) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.attemptedAt = now
      this.flight = this.refresh().finally(() => { this.flight = undefined })
    }
    if (this.flight && (refresh || !this.cache)) return this.flight.then(() => this.snapshot())
    return Promise.resolve(this.snapshot())
  }

  private state(): Omit<Cs2Schedule, 'matches'> {
    const schedule = this.cache?.schedule, fetchedAt = schedule?.fetchedAt ?? 0, now = this.now()
    const cooldown = schedule?.upstream.limitedUntil ?? 0
    const limited = cooldown > now
    return { fetchedAt, source: schedule?.source ?? 'liquipedia', attribution: schedule?.attribution ?? '赛程数据来自 Liquipedia（CC-BY-SA 3.0）',
      stale: !!this.failure || !schedule || now - fetchedAt > STALE_MS || limited,
      ...(this.failure ? { error: SCHEDULE_UNAVAILABLE, errorDetail: this.failure, refreshAt: this.nextPoll, refreshReason: 'retry' as const }
        : limited ? { error: UPSTREAM_LIMITED, errorDetail: diagnosticDetails({ status: 429 }), refreshAt: cooldown, refreshReason: 'upstream-rate-limit' as const } : {}) }
  }

  private snapshot(): Cs2Schedule {
    const urls = new Map<string, string | null>()
    const matches = this.cache ? fromRelaySchedule(this.cache.schedule, logo => {
      const version = this.logoVersion(logo)
      if (!urls.has(version)) urls.set(version, this.hasLogo(logo) ? `app://app/team-logo/${logo.key}?v=${logo.sha256}` : null)
      return urls.get(version) ?? null
    }).matches : []
    return { ...this.state(), matches: currentMatches(matches, this.now()) }
  }

  private async refresh(): Promise<void> {
    try {
      const response = await this.request('/v1/cs2/schedule', 'application/json', this.cache?.etag)
      if (response.status === 304 && !response.redirected && this.cache?.etag) {
        this.lifetime.signal.throwIfAborted()
        this.cache.receivedAt = this.now()
      } else {
        if (response.status !== 200 || response.redirected) throw await httpErrorDetails(response)
        const schedule = parseRelaySchedule(JSON.parse((await readBody(response, SCHEDULE_MAX_BYTES)).toString('utf8')))
        this.lifetime.signal.throwIfAborted()
        const etag = strongEtag(response.headers.get('etag'))
        this.cache = { origin: this.origin.origin, receivedAt: this.now(), etag, schedule }
        try { mkdirSync(this.directory, { recursive: true }); atomicJson(this.directory, CACHE_FILE, this.cache) }
        catch { /* Valid in-memory data is still usable if disk writes fail. */ }
      }
      this.failures = 0
      this.failure = undefined
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      this.failures = Math.min(this.failures + 1, 5)
      this.failure = diagnosticDetails(error)
    }
    if (this.lifetime.signal.aborted) return
    const delay = this.failures ? Math.min(30_000 * 2 ** (this.failures - 1), 300_000) : POLL_MS
    this.nextPoll = this.now() + delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.lifetime.signal.aborted) void this.getCs2Schedule().catch(() => undefined)
    }, delay)
    this.timer.unref?.()
    const signature = JSON.stringify([this.state(), this.cache?.schedule.matches])
    if (signature !== this.published) {
      this.published = signature
      this.notify('schedule-updated')
    }
    this.queueLogos()
  }

  private logoVersion(logo: RelayLogo): string { return `${logo.key}:${logo.sha256}` }
  private hasLogo(logo: RelayLogo): boolean {
    return readTeamLogo(this.options.userDataDir, logo.key, this.now(), this.options.bundledLogoDir)?.sha256 === logo.sha256
  }

  private queueLogos(): void {
    const now = this.now(), matches = this.cache?.schedule.matches ?? []
    for (const [version, until] of this.logoFailures) if (until <= now) this.logoFailures.delete(version)
    const wanted = new Map<string, RelayLogo>(), seen = new Set<string>()
    for (const match of [...matches.filter(match => match.state === 'live'), ...matches.filter(match => match.state !== 'live')]) {
      for (const logo of [...match.teams.map(team => team.logo), match.tournament.logo]) {
        if (!logo || seen.has(logo.key)) continue
        seen.add(logo.key)
        if (!this.logoFailures.has(this.logoVersion(logo)) && !this.hasLogo(logo)) wanted.set(logo.key, logo)
      }
    }
    this.wantedLogos = wanted
    this.pumpLogos()
  }

  private pumpLogos(): void {
    if (this.lifetime.signal.aborted) return
    for (const logo of this.wantedLogos.values()) {
      if (this.logoFlights.size >= LOGO_CONCURRENCY) break
      if (this.logoFlights.has(logo.key)) continue
      const work = this.downloadLogo(logo).catch(() => {
        if (!this.lifetime.signal.aborted) this.logoFailures.set(this.logoVersion(logo), this.now() + LOGO_RETRY_MS)
      }).finally(() => {
        if (this.wantedLogos.get(logo.key)?.sha256 === logo.sha256) this.wantedLogos.delete(logo.key)
        this.logoFlights.delete(logo.key)
        this.pumpLogos()
      })
      this.logoFlights.set(logo.key, work)
    }
  }

  private async downloadLogo(logo: RelayLogo): Promise<void> {
    const response = await this.request(`/v1/cs2/logos/${logo.key}?v=${logo.sha256}`, 'image/png,image/jpeg,image/webp')
    const size = response.headers.get('content-length')
    if (response.status !== 200 || response.redirected || (size !== null && (!/^\d+$/.test(size) || Number(size) > LOGO_MAX_BYTES))) {
      void response.body?.cancel().catch(() => {})
      throw new Error('Invalid relay logo response')
    }
    const bytes = await readBody(response, LOGO_MAX_BYTES)
    this.lifetime.signal.throwIfAborted()
    if (this.wantedLogos.get(logo.key)?.sha256 !== logo.sha256) return
    writeRelayTeamLogo(this.options.userDataDir, logo.key, bytes, logo.sha256, this.now())
    if (!this.logoEventTimer) {
      this.logoEventTimer = setTimeout(() => { this.logoEventTimer = undefined; this.notify('logos-updated') }, 100)
      this.logoEventTimer.unref?.()
    }
  }

  private notify(type: Cs2ScheduleEvent['data']['type']): void {
    if (this.lifetime.signal.aborted) return
    try { this.options.onEvent?.({ topic: 'cs2-schedule', data: { type } }) } catch { /* Observers must not affect cache results. */ }
  }

  getStreamTitles(raw: { streams: StreamTitleInput[] }): Promise<StreamTitle[]> { return this.titles.get(raw) }
  setScheduleFocus(raw: { eventPath: string | null }): { updated: true } {
    scheduleFocusArguments(raw)
    return { updated: true }
  }
  async openLiquipediaVerification(open: () => Promise<void>): Promise<{ opened: true }> { await open(); return { opened: true } }
  async refreshCs2ScheduleAfterVerification(raw: { round: string }): Promise<Cs2Schedule> {
    verificationRoundArgument(raw)
    return { ...this.snapshot(), verificationResult: 'not-attempted' }
  }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    clearTimeout(this.timer)
    clearTimeout(this.logoEventTimer)
    this.wantedLogos.clear()
    await Promise.all([this.pool.dispose(), this.titlePool.dispose()])
    await Promise.allSettled([this.flight, this.titles.dispose(), ...this.logoFlights.values()])
  }
}
