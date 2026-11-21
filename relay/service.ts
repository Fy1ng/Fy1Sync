import { CONTACT_EMAIL } from '../server/appIdentity'
import { diagnosticDetails } from '../server/errorDetails'
import { EsportsService, SCHEDULE_TTL_MS } from '../server/esports/schedule'
import { toRelaySchedule } from '../server/esports/relayProtocol'
import type { Cs2Schedule } from '../server/esports/types'
import type { ErrorDetails, ErrorDetailValue } from '../src/core/errorDetails'
import { scheduleFocuses, focusArgument } from './focus'
import { RelayHttp } from './http'

export const RELAY_POLL_MS = 20_000

// On 2026-11-21, Liquipedia temporarily banned the relay's egress IP for hours after
// about half an hour at a 2-minute cadence (14 parse requests). All clients share
// that IP, so keeping scores a few minutes behind is preferable to another ban.
const RELAY_ACTIVE_SCHEDULE_TTL_MS = SCHEDULE_TTL_MS
const MAX_LOGGED_SELECTORS = 8
const SELECTOR = /^[\w.* \[\]>-]+$/
const NETWORK_CODE = /^(?:E(?:CONN\w+|HOST\w+|NET\w+|AI_\w+|ADDR\w+|TIMEDOUT|NOTFOUND|PIPE|PROTO)|UND_ERR_\w+|ERR_(?:SSL|TLS)_\w+|CERT_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/

function identifier(value: unknown, allowed = /^[\w.-]+$/): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[^\x20-\x7e]/g, '').trim()
  return allowed.test(clean) ? clean.slice(0, 120) : undefined
}

function fields(value: ErrorDetailValue | undefined): ErrorDetails | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function networkCode(detail: ErrorDetails | undefined): string | undefined {
  if (!detail) return undefined
  const code = identifier(detail.code, NETWORK_CODE)
    ?? networkCode(fields(detail.cause)) ?? networkCode(fields(fields(detail.failure)?.detail))
  if (code) return code
  if (Array.isArray(detail.errors)) {
    for (const error of detail.errors) {
      const nested = networkCode(fields(error))
      if (nested) return nested
    }
  }
  return undefined
}

function summarizeFailure(detail?: ErrorDetails) {
  const name = identifier(detail?.name) ?? 'UnknownError'
  if (name === 'TimeoutError') return { errorKind: 'timeout', name }
  if (name === 'ScheduleFormatError') return { errorKind: 'format', selector: identifier(detail?.selector, SELECTOR) }
  const status = detail?.status
  if (typeof detail?.statusText === 'string') {
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 && status !== 200) {
      return { errorKind: 'http', status }
    }
  } else {
    const upstream = fields(detail?.upstream)
    if (upstream) return { errorKind: 'api', code: Number.isSafeInteger(upstream.code) ? upstream.code : identifier(upstream.code) }
  }
  const code = networkCode(detail) ?? (name === 'ProxyError' && detail?.reason === 'dns-failed' ? 'dns-failed' : undefined)
  if (code) return { errorKind: 'network', code }
  // safeFetch names why it refused or lost a request with a fixed identifier.
  const reason = name === 'ProxyError' ? identifier(detail?.reason) : undefined
  return { errorKind: 'other', name, ...(reason ? { detail: reason } : {}) }
}

type UpstreamOptions = ConstructorParameters<typeof EsportsService>[0]
interface Options extends Pick<UpstreamOptions, 'request' | 'resolve' | 'logos'> {
  dataDir: string
  version: string
  offline?: boolean
  now?: () => number
  log?: (message: string) => void
}

export class ScheduleRelay {
  readonly http: RelayHttp
  private readonly service: EsportsService
  private readonly now: () => number
  private readonly log: (message: string) => void
  private focus: string | null = null
  private skipped = { matches: 0, streams: 0 }
  private timer: ReturnType<typeof setInterval> | undefined
  private flight: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private stopped = false

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? console.log
    this.http = new RelayHttp(options.dataDir, this.now)
    const dependencies = { userDataDir: options.dataDir, version: options.version, now: this.now,
      request: options.request, resolve: options.resolve,
      userAgent: `Fy1Sync-schedule-relay/${options.version} (https://github.com/Fy1ng/Fy1Sync; ${CONTACT_EMAIL})` }
    const pendingParseSkips = new Set<string>()
    let previousParseSkips = ''
    const skippedPrefix = 'Liquipedia match skipped: '
    this.service = new EsportsService({ ...dependencies,
      logos: options.logos, offline: !!options.offline, activeScheduleTtlMs: RELAY_ACTIVE_SCHEDULE_TTL_MS,
      log: message => {
        if (!message.startsWith(skippedPrefix)) return
        const selector = identifier(message.slice(skippedPrefix.length), SELECTOR)
        if (selector) pendingParseSkips.add(selector)
      },
      onRefresh: schedule => {
        if (this.stopped) return
        this.publish(schedule)
        const selectors = [...pendingParseSkips].sort()
        pendingParseSkips.clear()
        const skipKey = selectors.join('\n')
        if (!schedule.error && skipKey !== previousParseSkips) {
          previousParseSkips = skipKey
          this.log(JSON.stringify({ type: 'parse-skipped', selectors: selectors.slice(0, MAX_LOGGED_SELECTORS) }))
        }
        this.log(JSON.stringify({ type: 'upstream-result', ok: !schedule.error, fetchedAt: schedule.fetchedAt,
          matches: schedule.matches.length, ...(schedule.error ? {
            reason: schedule.refreshReason === 'upstream-rate-limit' ? 'upstream-rate-limit' : 'schedule-unavailable',
            ...summarizeFailure(schedule.errorDetail),
          } : {}),
          cooldownUntil: this.limitedUntil(schedule) }))
      },
    })
  }

  private limitedUntil(schedule: Cs2Schedule): number | null {
    return schedule.refreshReason === 'upstream-rate-limit' && schedule.refreshAt !== undefined && schedule.refreshAt > this.now()
      ? schedule.refreshAt : null
  }

  private publish(schedule: Cs2Schedule): void {
    if (this.stopped) return
    const limitedUntil = this.limitedUntil(schedule)
    if (schedule.fetchedAt <= 0) { this.http.update(null, limitedUntil); return }
    const wire = toRelaySchedule(schedule, this.now(), limitedUntil)
    this.http.update(wire.schedule, limitedUntil)
    if (wire.skipped.matches !== this.skipped.matches || wire.skipped.streams !== this.skipped.streams) {
      this.skipped = wire.skipped
      this.log(JSON.stringify({ type: 'wire-skipped', ...wire.skipped }))
    }
  }

  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.flight) return this.flight
    const work = (async () => {
      try {
        const schedule = await this.service.getCs2Schedule()
        if (this.stopped) return
        this.publish(schedule)
        if (!this.options.offline) {
          const { waiting, active } = scheduleFocuses(schedule.matches, this.focus, this.now())
          for (const path of waiting) this.service.setScheduleFocus(focusArgument(path))
          this.focus = active
          this.service.setScheduleFocus(focusArgument(this.focus))
        }
      } catch (error) {
        if (!this.stopped) this.log(JSON.stringify({ type: 'upstream-result', ok: false, reason: 'refresh-loop-failed',
          ...summarizeFailure(diagnosticDetails(error)) }))
      }
    })().finally(() => { if (this.flight === work) this.flight = undefined })
    this.flight = work
    return work
  }

  async start(host = '127.0.0.1', port = 5081): Promise<number> {
    const boundPort = await this.http.listen(host, port)
    this.log(JSON.stringify({ type: 'started', host, port: boundPort, offline: !!this.options.offline }))
    this.timer = setInterval(() => { void this.poll() }, RELAY_POLL_MS)
    this.timer.unref?.()
    void this.poll()
    return boundPort
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    clearInterval(this.timer)
    this.closing = (async () => {
      const closed = this.http.close()
      await this.service.dispose()
      await this.flight
      await closed
      this.log(JSON.stringify({ type: 'stopped' }))
    })()
    return this.closing
  }
}
