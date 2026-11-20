import { CONTACT_EMAIL } from '../server/appIdentity'
import { EsportsService } from '../server/esports/schedule'
import { toRelaySchedule } from '../server/esports/relayProtocol'
import type { Cs2Schedule } from '../server/esports/types'
import { scheduleFocuses, focusArgument } from './focus'
import { RelayHttp } from './http'

export const RELAY_POLL_MS = 20_000
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
    this.service = new EsportsService({ ...dependencies,
      logos: options.logos, offline: !!options.offline, activeScheduleTtlMs: 120_000,
      log: () => {},
      onRefresh: schedule => {
        if (this.stopped) return
        this.publish(schedule)
        const status = schedule.errorDetail?.status
        this.log(JSON.stringify({ type: 'upstream-result', ok: !schedule.error, fetchedAt: schedule.fetchedAt,
          matches: schedule.matches.length, ...(schedule.error ? { reason: schedule.error } : {}),
          ...(schedule.error && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
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
          error: error instanceof Error ? error.name : 'UnknownError' }))
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
