import { validDouyuRoom } from '../platforms/douyuRoom'
import { DouyuGatewayCoordinator } from './gatewayCoordinator'
import type { DouyuWatchTime, DouyuFansWatchTime } from './insightsTypes'
import type { DouyuWatchPlaybackReport, DouyuWatchState } from './watchTypes'
import { abortable } from './actionHttp'

export interface DouyuWatchContext {
  accountId: string | null
  room: string | null
  loggedIn: boolean
  busy: boolean
  locked: boolean
  suspended: boolean
  live: boolean | null
  replay: boolean | null
}

export interface DouyuWatchSource { room: string; cdn: string; bytes: number; generation: string }
interface Sample {
  at: number; source: DouyuWatchSource; report: DouyuWatchPlaybackReport; advancing: boolean; windowBytes: number
}
interface Flight { controller: AbortController; accountId: string; room: string; heartbeat: boolean; settled: Promise<void> }
export interface DouyuWatchServiceOptions {
  coordinator: DouyuGatewayCoordinator
  run: (accountId: string, room: string, signal: AbortSignal, stats: () => { bytes: number; cdn: string }, heartbeat: (at: number) => void) => Promise<void>
  readWatchTime: (accountId: string, room: string, signal: AbortSignal) => Promise<DouyuWatchTime>
  readFansWatchTime: (accountId: string, room: string, signal: AbortSignal) => Promise<DouyuFansWatchTime>
  now?: () => number
}
const FRESH_MS = 7_000
const QUERY_MS = 60_000
const MAX_SAMPLES = 8
const RETRY_MS = [1_000, 5_000, 15_000]
const day = (at: number) => Math.floor((at + 8 * 60 * 60_000) / 86_400_000)

/** Real playback grants a short lease. Upstream acknowledgements never imply official credit. */
export class DouyuWatchService {
  private context: DouyuWatchContext = { accountId: null, room: null, loggedIn: false, busy: false, locked: true, suspended: false, live: null, replay: null }
  private value: DouyuWatchState = { accountId: null, room: null, phase: 'idle', reason: null, officialSeconds: null,
    baselineSeconds: null, verifiedIncrease: 0, checkedAt: null, lastHeartbeatAt: null,
    cumulativeSeconds: null, cumulativeBaselineSeconds: null, cumulativeIncrease: 0, cumulativeCheckedAt: null, badgeOwned: null, badgeLevel: null }
  private readonly samples = new Map<string, Sample>()
  private readonly listeners = new Set<(state: DouyuWatchState) => void>()
  private readonly timer: ReturnType<typeof setInterval>
  private readonly releaseCoordinator: () => void
  private flight: Flight | null = null
  private disposed = false
  private failures = 0
  private retryAt = 0
  private queryAt = 0
  private queryFlight: Promise<void> | null = null
  private observedDay: number
  private readonly now: () => number

  constructor(private readonly options: DouyuWatchServiceOptions) {
    this.now = options.now ?? Date.now
    this.observedDay = day(this.now())
    this.releaseCoordinator = options.coordinator.subscribe(() => this.reconcile())
    this.timer = setInterval(() => this.reconcile(), 1_000)
    this.timer.unref?.()
  }

  snapshot(): DouyuWatchState { return { ...this.value } }
  subscribe(listener: (state: DouyuWatchState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(patch: Partial<DouyuWatchState>): void {
    const next = { ...this.value, ...patch }
    if (Object.keys(next).every(key => next[key as keyof DouyuWatchState] === this.value[key as keyof DouyuWatchState])) return
    this.value = next
    for (const listener of this.listeners) try { listener(this.snapshot()) } catch { /* A closing view cannot interrupt cleanup. */ }
  }

  setContext(context: DouyuWatchContext): void {
    if (this.disposed) return
    const room = context.room && validDouyuRoom(context.room) ? context.room : null
    const changed = context.accountId !== this.context.accountId || room !== this.context.room
    if (!this.context.loggedIn && context.loggedIn) { this.failures = 0; this.retryAt = 0 }
    this.context = { ...context, room }
    if (changed) {
      this.stop()
      this.samples.clear()
      this.failures = 0; this.retryAt = 0; this.queryAt = 0
      this.observedDay = day(this.now())
      this.update({ accountId: context.accountId, room, officialSeconds: null, baselineSeconds: null,
        verifiedIncrease: 0, checkedAt: null, lastHeartbeatAt: null,
        cumulativeSeconds: null, cumulativeBaselineSeconds: null, cumulativeIncrease: 0, cumulativeCheckedAt: null, badgeOwned: null, badgeLevel: null })
    }
    this.reconcile()
  }

  report(senderId: number, report: DouyuWatchPlaybackReport, source: DouyuWatchSource | null): DouyuWatchState {
    if (this.disposed) return this.snapshot()
    const key = `${senderId}:${report.role}`
    if (!source || source.room !== this.context.room) {
      this.samples.delete(key)
      this.reconcile()
      return this.snapshot()
    }
    const now = this.now(), previous = this.samples.get(key)
    const same = previous?.source.generation === source.generation && previous.source.room === source.room
    const elapsed = previous ? now - previous.at : 0
    const timeDelta = previous ? report.currentTime - previous.report.currentTime : 0
    const frames = report.presentedFrames
    const oldFrames = previous?.report.presentedFrames
    const advancedFrames = frames !== null && oldFrames !== null && oldFrames !== undefined && frames > oldFrames
    const advancing = report.playing && !!same && elapsed > 0 && elapsed <= FRESH_MS
      && timeDelta >= 0 && timeDelta <= elapsed / 1000 * 3 + 1 && (timeDelta >= 0.01 || advancedFrames)
    const bytes = same && advancing && source.bytes >= previous!.source.bytes ? source.bytes - previous!.source.bytes : 0
    if (!this.samples.has(key) && this.samples.size >= MAX_SAMPLES) this.samples.delete(this.samples.keys().next().value!)
    this.samples.set(key, { at: now, source: { ...source }, report: { ...report }, advancing,
      windowBytes: advancing ? Math.min(0x3c00000, (same ? previous!.windowBytes : 0) + bytes) : 0 })
    if (previous?.advancing && !advancing) { this.failures = 0; this.retryAt = 0 }
    this.reconcile()
    return this.snapshot()
  }

  releaseSender(senderId: number): void {
    for (const key of this.samples.keys()) if (key.startsWith(`${senderId}:`)) this.samples.delete(key)
    this.reconcile()
  }

  releaseSource(role: DouyuWatchPlaybackReport['role']): void {
    for (const key of this.samples.keys()) if (key.endsWith(`:${role}`)) this.samples.delete(key)
    this.reconcile()
  }

  invalidateAccount(accountId: string): void {
    if (this.context.accountId !== accountId) return
    this.stop()
    this.samples.clear()
    this.failures = 0; this.retryAt = 0; this.queryAt = 0
    this.update({ baselineSeconds: null, officialSeconds: null, verifiedIncrease: 0, checkedAt: null, lastHeartbeatAt: null,
      cumulativeSeconds: null, cumulativeBaselineSeconds: null, cumulativeIncrease: 0, cumulativeCheckedAt: null, badgeOwned: null, badgeLevel: null })
  }

  private currentSample(): Sample | undefined {
    const now = this.now()
    // Prefer one actual playback source; duplicate windows do not double its statistics.
    return [...this.samples.entries()].filter(([, sample]) => sample.advancing && sample.report.playing
      && sample.source.room === this.context.room && now - sample.at <= FRESH_MS)
      .sort(([keyA, a], [keyB, b]) => Number(keyB.endsWith(':commentary')) - Number(keyA.endsWith(':commentary')) || b.at - a.at)[0]?.[1]
  }

  private stop(): void {
    if (this.flight && !this.flight.controller.signal.aborted) this.flight.controller.abort()
  }

  private reconcile(): void {
    if (this.disposed) return
    const { accountId, room } = this.context
    if (!room) { this.stop(); this.update({ phase: 'idle', reason: null }); return }
    if (!accountId || !this.context.loggedIn || this.context.busy) {
      this.stop(); this.update({ phase: 'login-required', reason: '请先登录当前斗鱼账号.' }); return
    }
    if (this.context.locked || this.context.suspended || !this.currentSample()) {
      this.stop(); this.update({ phase: 'paused', reason: this.context.suspended ? '系统休眠, 观时会话已停止.'
        : this.context.locked ? '系统锁屏, 观时会话已停止.' : '等待当前斗鱼房间的实际播放.' }); return
    }
    if (this.context.live !== true || this.context.replay !== false) {
      this.stop(); this.update({ phase: 'paused', reason: this.context.replay === true
        ? '当前房间为轮播, 观时会话已暂停.' : this.context.live === false
          ? '当前房间未开播, 观时会话已暂停.' : '尚未确认房间为直播, 正在核对官方状态.' }); return
    }
    if (this.options.coordinator.isBusy(accountId)) {
      this.stop(); this.update({ phase: 'yielding', reason: '账号网关正在处理其他操作, 观时会话暂时让出.' }); return
    }
    if (this.flight) {
      if (!this.flight.controller.signal.aborted && this.flight.heartbeat && this.now() - this.queryAt >= QUERY_MS) void this.query(this.flight)
      return
    }
    if (this.failures > RETRY_MS.length || this.now() < this.retryAt) return
    const flight: Flight = { controller: new AbortController(), accountId, room, heartbeat: false, settled: Promise.resolve() }
    this.flight = flight
    this.update({ phase: 'connecting', reason: '正在建立斗鱼观看会话, 官方观时尚未核验.' })
    flight.settled = this.start(flight)
  }

  private live(flight: Flight): boolean {
    return !this.disposed && this.flight === flight && !flight.controller.signal.aborted
      && this.context.accountId === flight.accountId && this.context.room === flight.room
  }

  private async start(flight: Flight): Promise<void> {
    try {
      await this.query(flight)
      if (!this.live(flight)) return
      if (!this.currentSample()) { flight.controller.abort(); return }
      await this.options.coordinator.runWatch(flight.accountId, flight.controller.signal, signal => this.options.run(
        flight.accountId, flight.room, signal,
        () => {
          const sample = this.currentSample()
          if (!sample || !this.live(flight) || signal.aborted) return { bytes: 0, cdn: '' }
          const stats = { bytes: sample.windowBytes, cdn: sample.source.cdn }
          for (const entry of this.samples.values()) entry.windowBytes = 0
          return stats
        },
        at => {
          if (!this.live(flight) || signal.aborted) return
          flight.heartbeat = true
          this.update({ phase: this.value.cumulativeIncrease > 0 && this.value.badgeOwned === true ? 'verified' : 'reporting',
            reason: this.value.cumulativeIncrease > 0 && this.value.badgeOwned === true ? null : '观看心跳已收到回应, 等待粉丝牌累计观时核验.', lastHeartbeatAt: at })
        }))
      if (this.live(flight)) throw new Error('Watch gateway ended')
    } catch (error) {
      if (this.live(flight) && !this.options.coordinator.isBusy(flight.accountId)) {
        const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
        const unsupported = code === 'protocol-unsupported' || code === 'invalid-arguments'
        const loginRequired = code === 'login-required' || code === 'account-changed'
        this.failures = unsupported || loginRequired ? RETRY_MS.length + 1 : this.failures + 1
        this.retryAt = this.now() + (RETRY_MS[this.failures - 1] ?? QUERY_MS)
        this.update({ phase: loginRequired ? 'login-required' : 'failed', reason: unsupported
          ? '斗鱼返回了尚未支持的观看协议参数, 已停止上报. 官方观时增长尚未确认.'
          : loginRequired ? '当前账号的观看鉴权信息缺失或已变化, 请重新登录.'
          : '斗鱼观时连接未完成, 当前未确认官方观时增长.' })
      }
    } finally {
      if (this.flight === flight) this.flight = null
      this.reconcile()
    }
  }

  private query(flight: Flight): Promise<void> {
    if (this.queryFlight) return this.queryFlight
    this.queryAt = this.now()
    const signal = flight.controller.signal
    const promise = Promise.allSettled([
      abortable(Promise.resolve().then(() => this.options.readWatchTime(flight.accountId, flight.room, signal)), signal),
      abortable(Promise.resolve().then(() => this.options.readFansWatchTime(flight.accountId, flight.room, signal)), signal),
    ]).then(([daily, cumulative]) => {
      if (!this.live(flight)) return
      if (daily.status === 'fulfilled') {
        const result = daily.value
        const valid = result.accountId === flight.accountId && result.room === flight.room && result.source === 'douyu-today-watch'
          && Number.isSafeInteger(result.checkedAt) && result.checkedAt >= 0 && result.checkedAt <= this.now()
          && (result.seconds === null || (Number.isSafeInteger(result.seconds) && result.seconds >= 0 && result.seconds <= 86_400))
        if (valid) {
          let baseline = this.value.baselineSeconds
          if (day(this.now()) !== this.observedDay || (result.seconds !== null && baseline !== null && result.seconds < baseline)) {
            baseline = null
            this.observedDay = day(this.now())
          }
          if (baseline === null) baseline = result.seconds
          const increase = result.seconds !== null && baseline !== null ? Math.max(0, result.seconds - baseline) : 0
          this.update({ officialSeconds: result.seconds, baselineSeconds: baseline, verifiedIncrease: increase, checkedAt: result.checkedAt })
        } else this.update({ officialSeconds: null, checkedAt: null, verifiedIncrease: 0 })
      }
      if (cumulative.status === 'fulfilled') {
        const result = cumulative.value
        if (result.accountId !== flight.accountId || result.room !== flight.room || result.source !== 'douyu-fanshome-cumulative'
          || !Number.isSafeInteger(result.checkedAt) || result.checkedAt < 0 || result.checkedAt > this.now()
          || (result.seconds !== null && (!Number.isSafeInteger(result.seconds) || result.seconds < 0))) throw new Error('Unconfirmed cumulative record')
        let baseline = this.value.cumulativeBaselineSeconds
        if (result.badgeOwned !== true || this.value.badgeOwned !== true) baseline = null
        if (baseline === null || (result.seconds !== null && result.seconds < baseline)) baseline = result.seconds
        const increase = result.seconds !== null && baseline !== null ? Math.max(0, result.seconds - baseline) : 0
        const verified = increase > 0 && result.badgeOwned === true
        this.update({ cumulativeSeconds: result.seconds, cumulativeBaselineSeconds: baseline, cumulativeIncrease: increase,
          cumulativeCheckedAt: result.checkedAt, badgeOwned: result.badgeOwned, badgeLevel: result.badgeLevel,
          ...(flight.heartbeat ? { phase: verified ? 'verified' : 'unverified', reason: verified ? null
            : result.badgeOwned === false ? '当前账号未持有此房间粉丝牌, 累计观时尚未验收.'
            : result.badgeOwned === null ? '粉丝牌持有状态未确认, 暂时无法验收累计观时.'
            : result.seconds === null ? '平台未返回粉丝牌累计观时, 暂时无法验收.' : '尚未查询到粉丝牌累计观时增长.' } as const : {}) })
      } else {
        this.update({ cumulativeSeconds: null, cumulativeCheckedAt: null, cumulativeIncrease: 0, badgeOwned: null, badgeLevel: null,
          ...(flight.heartbeat ? { phase: 'unverified', reason: '粉丝牌累计观时查询失败, 当前无法验收增长.' } as const : {}) })
      }
    }).catch(() => {
      if (this.live(flight)) this.update({ cumulativeSeconds: null, cumulativeCheckedAt: null, cumulativeIncrease: 0, badgeOwned: null, badgeLevel: null,
        ...(flight.heartbeat ? { phase: 'unverified', reason: '粉丝牌累计观时查询失败, 当前无法核验增长.' } as const : {}) })
    }).finally(() => { if (this.queryFlight === promise) this.queryFlight = null })
    this.queryFlight = promise
    return promise
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.timer)
    this.releaseCoordinator()
    this.stop()
    this.samples.clear(); this.listeners.clear()
    await this.flight?.settled
  }
}
