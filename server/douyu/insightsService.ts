import type { ChatMessage } from '../danmaku/types'
import type { DanmakuState } from '../danmaku/types'
import { validDouyuRoom } from '../platforms/douyuRoom'
import { normalizeDouyuGift, normalizeDouyuUid } from '../../src/core/douyuMetadata'
import { cancelled } from './actionHttp'
import type { DouyuInsightsGateway } from './insightsGateway'
import type {
  DouyuFollowedRooms, DouyuGiftPrice, DouyuInsightsEvent, DouyuLiveNotification,
  DouyuRoomInsights, DouyuRoomSignal,
} from './insightsTypes'

const MAX_ROOMS = 64
const MAX_PEOPLE = 20_000
const MAX_IDS = 20_000
const MAX_PRICES = 20_000
const HEARTBEAT_MS = 15_000
type Playback = { playing: boolean; at: number }
type ObservedRoom = {
  value: DouyuRoomInsights
  people: Set<string>
  giftSenders: Set<string>
  ids: Set<string>
  playback: Map<string, Playback>
  watchAt: number
  watchMs: number
  revision: number
  lastSignalAt: number
}
type Monitor = { accountId: string; controller: AbortController; timer?: ReturnType<typeof setTimeout>; intervalMs: number; states: Map<string, boolean> }
type Gateway = Pick<DouyuInsightsGateway, 'readRoom' | 'readFollowedRooms'>

/** Main owns ingress and lifetime. This service never opens another socket or port. */
export class DouyuInsightsService {
  private readonly rooms = new Map<string, ObservedRoom>()
  private readonly listeners = new Set<(event: DouyuInsightsEvent) => void>()
  private readonly prices = new Map<string, DouyuGiftPrice>()
  private readonly changed = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Map<string, Promise<DouyuRoomInsights>>()
  private notifications = { enabled: false, rooms: new Set<string>() }
  private monitor: Monitor | null = null
  private readonly notificationKeys = new Map<string, number>()
  private notificationSequence = 0
  private disposed = false
  private readonly lifetime = new AbortController()

  constructor(private readonly options: { gateway: Gateway; now?: () => number; onNotification?: (event: DouyuLiveNotification) => void }) {}
  private now(): number {
    const now = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('本地时间无效.')
    return now
  }
  private check(): void { if (this.disposed) throw new Error('房间统计服务已关闭.') }
  private get(room: string): ObservedRoom {
    this.check()
    if (!validDouyuRoom(room)) throw new Error('房间号无效.')
    const existing = this.rooms.get(room)
    if (existing) return existing
    if (this.rooms.size >= MAX_ROOMS) throw new Error('已达到房间统计数量上限.')
    const now = this.now()
    const value: DouyuRoomInsights = {
      room, observedSince: now, checkedAt: now, connected: false, live: null, replay: null,
      startedAt: null, lastStartedAt: null, broadcastSeconds: null, localWatchSeconds: 0,
      viewers: null, uniqueChatters: 0, uniqueGiftSenders: 0, nobles: null, ranks: null,
      gifts: { count: 0, knownValueMinor: 0, unknownValueCount: 0, totalValueMinor: 0, currency: 'YUCHI', scale: 100, valuation: 'catalog-nominal' },
      coverage: { source: 'received-events', completeRoomHistory: false, disconnected: false, droppedEvents: 0, unknownSenderEvents: 0, uniqueUsersTruncated: false },
    }
    const row: ObservedRoom = { value, people: new Set(), giftSenders: new Set(), ids: new Set(), playback: new Map(),
      watchAt: now, watchMs: 0, revision: 0, lastSignalAt: -1 }
    this.rooms.set(room, row)
    return row
  }

  subscribe(listener: (event: DouyuInsightsEvent) => void): () => void {
    this.check(); this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(event: DouyuInsightsEvent): void {
    if (this.disposed) return
    for (const listener of this.listeners) { try { listener(structuredClone(event)) } catch { /* A closing view cannot disrupt ingress. */ } }
  }
  private notifyChanged(room: string): void {
    if (this.disposed || this.changed.has(room)) return
    const timer = setTimeout(() => {
      this.changed.delete(room)
      this.emit({ type: 'changed', room })
    }, 250)
    timer.unref?.()
    this.changed.set(room, timer)
  }

  snapshot(room: string): DouyuRoomInsights {
    const row = this.get(room), now = this.now()
    row.value.checkedAt = now
    row.value.broadcastSeconds = row.value.live === true && row.value.replay !== true && row.value.startedAt !== null
      ? Math.max(0, Math.floor((now - row.value.startedAt) / 1000)) : null
    row.value.localWatchSeconds = Math.floor(row.watchMs / 1000)
    return structuredClone(row.value)
  }

  /** Bounded local message IDs suppress relay replay without confusing equal text with duplicates. */
  observe(message: ChatMessage): void {
    if (this.disposed || !message || message.platform === 'huya' || !validDouyuRoom(message.room)) return
    const row = this.get(message.room)
    if (typeof message.id !== 'string' || message.id.length > 256) { this.dropped(message.room, 1); return }
    if (row.ids.has(message.id)) return
    if (row.ids.size >= MAX_IDS) row.ids.delete(row.ids.values().next().value!)
    row.ids.add(message.id)
    const uid = normalizeDouyuUid(message.sender?.uid)
    const addPerson = (set: Set<string>) => {
      if (!uid || set.has(uid)) return
      if (set.size >= MAX_PEOPLE) { row.value.coverage.uniqueUsersTruncated = true; return }
      set.add(uid)
    }
    const gift = normalizeDouyuGift(message.gift)
    if (!uid && (gift || !message.system)) row.value.coverage.unknownSenderEvents = Math.min(Number.MAX_SAFE_INTEGER, row.value.coverage.unknownSenderEvents + 1)
    if (gift) {
      addPerson(row.giftSenders)
      row.value.uniqueGiftSenders = row.giftSenders.size
      const candidate = this.prices.get(`${message.room}:${gift.kind}:${gift.id}`) ?? this.prices.get(`*:${gift.kind}:${gift.id}`)
      const price = candidate && candidate.checkedAt <= message.receivedAt && message.receivedAt - candidate.checkedAt <= 86_400_000 ? candidate : undefined
      const amount = price ? price.amountMinor * gift.count : null
      if (!Number.isSafeInteger(row.value.gifts.count + gift.count)) { this.dropped(message.room, 1); return }
      row.value.gifts.count += gift.count
      if (amount === null || !Number.isSafeInteger(amount) || !Number.isSafeInteger(row.value.gifts.knownValueMinor + amount)) {
        row.value.gifts.unknownValueCount += gift.count
      } else row.value.gifts.knownValueMinor += amount
      row.value.gifts.totalValueMinor = row.value.gifts.unknownValueCount > 0 ? null : row.value.gifts.knownValueMinor
    } else if (!message.system) { addPerson(row.people); row.value.uniqueChatters = row.people.size }
    this.notifyChanged(message.room)
  }

  /** Only the main-process catalog adapter may invoke this method. */
  setGiftPrices(prices: readonly DouyuGiftPrice[]): void {
    this.check()
    if (!Array.isArray(prices) || prices.length > MAX_PRICES) throw new Error('礼物价格目录超过上限.')
    const next = new Map<string, DouyuGiftPrice>()
    for (const price of prices) {
      if (!price || !['gift', 'prop'].includes(price.kind) || !normalizeDouyuUid(price.id) || price.currency !== 'YUCHI'
          || (price.room !== undefined && !validDouyuRoom(price.room)) ||
          !Number.isSafeInteger(price.amountMinor) || price.amountMinor < 0 || typeof price.source !== 'string' || !price.source || price.source.length > 256 ||
          !Number.isSafeInteger(price.checkedAt) || price.checkedAt < 0 || price.checkedAt > this.now()) throw new Error('礼物价格目录无法确认.')
      const key = `${price.room ?? '*'}:${price.kind}:${price.id}`
      if (next.has(key)) throw new Error('礼物价格目录含重复项目.')
      next.set(key, { ...price })
    }
    this.prices.clear()
    for (const [key, value] of next) this.prices.set(key, value)
    // Historic unknown gifts stay unknown; a later price is not proof of their earlier value.
  }

  setRoomGiftPrices(room: string, prices: readonly DouyuGiftPrice[]): void {
    if (!validDouyuRoom(room) || prices.length > 5_000) throw new Error('房间礼物目录无效')
    const retained = [...this.prices.values()].filter(price => price.room !== room)
    const incoming = prices.map(price => ({ ...price, room }))
    this.setGiftPrices([...retained.slice(-(MAX_PRICES - incoming.length)), ...incoming])
  }

  dropped(room: string, count: number): void {
    if (this.disposed || !Number.isSafeInteger(count) || count < 1 || count > 1_000_000) return
    const value = this.get(room).value
    value.coverage.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, value.coverage.droppedEvents + count)
    this.notifyChanged(room)
  }

  connection(room: string, state: DanmakuState): void {
    if (this.disposed) return
    const value = this.get(room).value
    if (value.connected && state !== 'connected') value.coverage.disconnected = true
    value.connected = state === 'connected'
    this.notifyChanged(room)
  }

  signal(event: DouyuRoomSignal): void {
    if (this.disposed || !event || !validDouyuRoom(event.room) || !Number.isSafeInteger(event.receivedAt) || event.receivedAt < 0 || event.receivedAt > this.now()) return
    const row = this.get(event.room)
    if (event.receivedAt < row.lastSignalAt) return
    row.lastSignalAt = event.receivedAt
    if (event.kind === 'nobles') row.value.nobles = { count: event.count, receivedAt: event.receivedAt }
    else if (event.kind === 'ranks') row.value.ranks = structuredClone(event.ranks)
    else {
      const previous = row.value.live === true && row.value.replay === false
      const wasKnown = row.value.live !== null
      const current = event.live && event.replay === false
      if (row.value.live === true && !event.live && row.value.startedAt !== null) row.value.lastStartedAt = row.value.startedAt
      if (row.value.live !== event.live || row.value.replay !== event.replay) row.value.startedAt = null
      row.value.live = event.live; row.value.replay = event.replay; row.revision++
      if (wasKnown && !previous && current) this.liveNotification(event.room, event.receivedAt, 'anonymous-rss')
    }
    this.notifyChanged(event.room)
  }

  async refreshRoom(room: string, signal: AbortSignal): Promise<DouyuRoomInsights> {
    const row = this.get(room)
    if (signal.aborted) throw cancelled()
    const existing = this.inFlight.get(room)
    if (existing) return existing
    const revision = row.revision
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    const promise = this.options.gateway.readRoom(room, combined).then(info => {
      if (combined.aborted || this.disposed || this.rooms.get(room) !== row) throw cancelled()
      if (row.revision === revision) {
        row.value.live = info.live; row.value.replay = info.replay
        row.value.startedAt = info.startedAt; row.value.lastStartedAt = info.lastStartedAt
      }
      this.notifyChanged(room)
      return this.snapshot(room)
    }).finally(() => { if (this.inFlight.get(room) === promise) this.inFlight.delete(room) })
    this.inFlight.set(room, promise)
    return promise
  }

  /** Each session ID is assigned by main, not a caller-supplied elapsed-time counter. */
  reportPlayback(room: string, playing: boolean, sessionId = 'main'): DouyuRoomInsights {
    if (typeof playing !== 'boolean' || !/^[A-Za-z0-9:_-]{1,128}$/.test(sessionId)) throw new Error('播放心跳参数无效.')
    const row = this.get(room), now = this.now()
    const interval = now - row.watchAt
    if (interval > 0 && interval <= HEARTBEAT_MS && [...row.playback.values()].some(session => session.playing && now - session.at <= HEARTBEAT_MS)) row.watchMs += interval
    row.watchAt = now
    for (const [id, session] of row.playback) if (now - session.at > HEARTBEAT_MS) row.playback.delete(id)
    if (!row.playback.has(sessionId) && row.playback.size >= 16) throw new Error('该房间的播放会话数量超过上限.')
    if (playing) row.playback.set(sessionId, { playing: true, at: now })
    else row.playback.delete(sessionId)
    this.notifyChanged(room)
    return this.snapshot(room)
  }

  setNotifications(enabled: boolean, rooms: readonly string[] = []): void {
    this.check()
    if (typeof enabled !== 'boolean' || !Array.isArray(rooms) || rooms.length > MAX_ROOMS || rooms.some(room => !validDouyuRoom(room))) throw new Error('开播提醒设置无效.')
    this.notifications = { enabled, rooms: new Set(rooms) }
  }
  private liveNotification(room: string, occurredAt: number, source: DouyuLiveNotification['source']): void {
    if (!this.notifications.enabled || (this.notifications.rooms.size > 0 && !this.notifications.rooms.has(room))) return
    // Poll and socket may report the same transition. This also bounds flapping spam.
    const last = this.notificationKeys.get(room)
    if (last !== undefined && occurredAt - last < 60_000) return
    if (this.notificationKeys.size >= MAX_ROOMS && !this.notificationKeys.has(room)) this.notificationKeys.delete(this.notificationKeys.keys().next().value!)
    this.notificationKeys.set(room, occurredAt)
    const notification: DouyuLiveNotification = { id: `${room}:${occurredAt}:${++this.notificationSequence}`, room, occurredAt, source }
    this.emit({ type: 'live', notification })
    try { this.options.onNotification?.(structuredClone(notification)) } catch { /* Notification failure does not change the observed stream. */ }
  }

  startFollowMonitor(accountId: string, intervalMs = 60_000): void {
    this.check()
    if (!/^[A-Za-z0-9-]{1,128}$/.test(accountId) || !Number.isFinite(intervalMs) || intervalMs < 60_000 || intervalMs > 15 * 60_000) throw new Error('关注监控参数无效.')
    this.stopFollowMonitor()
    const monitor: Monitor = { accountId, controller: new AbortController(), intervalMs, states: new Map() }
    this.monitor = monitor
    void this.poll(monitor)
  }
  private async poll(monitor: Monitor): Promise<void> {
    try {
      const result = await this.options.gateway.readFollowedRooms(monitor.accountId, monitor.controller.signal)
      if (this.monitor !== monitor || this.disposed || monitor.controller.signal.aborted) return
      this.observeFollowed(result, monitor)
    } catch {
      if (this.monitor === monitor && !this.disposed && !monitor.controller.signal.aborted) this.emit({ type: 'monitor-error', accountId: monitor.accountId, message: '关注开播状态读取失败, 未生成新的开播提醒.' })
    } finally {
      if (this.monitor === monitor && !this.disposed && !monitor.controller.signal.aborted) {
        monitor.timer = setTimeout(() => { void this.poll(monitor) }, monitor.intervalMs)
        monitor.timer.unref?.()
      }
    }
  }
  private observeFollowed(result: DouyuFollowedRooms, monitor: Monitor): void {
    if (result.accountId !== monitor.accountId || result.coverage !== 'all-pages') {
      this.emit({ type: 'monitor-error', accountId: monitor.accountId, message: '关注列表不完整, 本轮未生成开播提醒.' })
      return
    }
    const next = new Map<string, boolean>()
    for (const room of result.rooms) {
      if (room.live === null || room.replay === null) continue
      const live = room.live && !room.replay
      next.set(room.room, live)
      if (monitor.states.get(room.room) === false && live) this.liveNotification(room.room, this.now(), 'follow-list')
    }
    monitor.states = next
  }
  stopFollowMonitor(): void {
    const previous = this.monitor
    this.monitor = null
    if (previous) { previous.controller.abort(); if (previous.timer) clearTimeout(previous.timer) }
  }
  invalidateAccount(accountId: string): void { if (this.monitor?.accountId === accountId) this.stopFollowMonitor() }

  forgetRoom(room: string): void {
    this.check()
    const timer = this.changed.get(room)
    if (timer) clearTimeout(timer)
    this.changed.delete(room); this.rooms.delete(room); this.notificationKeys.delete(room); this.inFlight.delete(room)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(); this.stopFollowMonitor()
    for (const timer of this.changed.values()) clearTimeout(timer)
    this.changed.clear(); this.listeners.clear(); this.rooms.clear(); this.prices.clear(); this.notificationKeys.clear()
  }
}
