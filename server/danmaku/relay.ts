/**
 * Danmaku relay: one upstream client per room, fanned out to local renderer subscribers
 * through a transport-neutral callback.
 *
 * Rooms are reference-counted: the upstream socket opens with the
 * first subscriber and closes shortly after the last one leaves, so a closed tab does not
 * leave a connection running forever.
 */

import { DouyuDanmakuClient } from './douyuClient'
import { DouyinDanmakuClient, type DouyinDanmakuClientDeps } from './douyinClient'
import { HuyaRoomClient, type HuyaRoomClientDeps } from './huyaRoomClient'
import { BilibiliDanmakuClient, type BilibiliDeps } from './bilibiliClient'
import { BilibiliRoomMetrics, summarizeBilibiliRoom } from '../platforms/bilibiliRoomInsights'
import type { BilibiliChatMessage } from './bilibiliEvents'
import type { HuyaOnTvSnapshot } from '../platforms/huyaOnTv'
import { danmakuRoom, type ChatMessage, type DanmakuClient, type DanmakuClientDeps,
  type DanmakuClientEvents, type DanmakuPlatform, type DanmakuState, type RoomSignal } from './types'

/** Grace period before dropping an idle room, so a page reload reuses the connection. */
const IDLE_CLOSE_MS = 10_000
/** Bound the replay buffer; danmaku is worthless once it is minutes old. */
const REPLAY_LIMIT = 50
export const MAX_ROOMS = 64
export type RawDanmakuEvent = { platform: DanmakuPlatform } & ({ type: 'message'; message: ChatMessage }
  | { type: 'signal'; signal: RoomSignal }
  | { type: 'state'; room: string; state: DanmakuState })

export type DanmakuRelayDeps = DanmakuClientDeps & {
  huya?: HuyaRoomClientDeps
  douyin?: DouyinDanmakuClientDeps
  bilibili?: BilibiliDeps
  createClient?: (platform: DanmakuPlatform, room: string, events: DanmakuClientEvents) => DanmakuClient
}

type Subscriber = {
  id: number
  write: (event: string, data: unknown) => void
  close: () => void
}

type Room = {
  key: string
  client: DanmakuClient
  subscribers: Map<number, Subscriber>
  recent: ChatMessage[]
  state: DanmakuState
  detail?: string
  idleTimer: unknown
  huyaOnTv?: HuyaOnTvSnapshot
  bilibiliObserved: BilibiliChatMessage[]
  bilibiliTruncated: boolean
  removedSuperChats: Set<string>
}

export class DanmakuRelay {
  private readonly rooms = new Map<string, Room>()
  private nextSubscriberId = 1
  private readonly observers = new Set<(event: RawDanmakuEvent) => void>()
  private readonly bilibiliMetrics = new BilibiliRoomMetrics()

  constructor(private readonly deps: DanmakuRelayDeps = {}) {}

  observe(listener: (event: RawDanmakuEvent) => void): () => void {
    this.observers.add(listener)
    return () => { this.observers.delete(listener) }
  }

  get roomCount(): number {
    return this.rooms.size
  }

  stateOf(roomId: string): DanmakuState {
    return this.rooms.get(danmakuRoom(roomId).key)?.state ?? 'idle'
  }

  subscriberCount(roomId: string): number {
    return this.rooms.get(danmakuRoom(roomId).key)?.subscribers.size ?? 0
  }

  closeIdleRoom(roomId: string): void {
    const room = this.rooms.get(danmakuRoom(roomId).key)
    if (!room || room.subscribers.size > 0) return
    if (room.idleTimer !== null) this.clearTimer(room.idleTimer)
    this.rooms.delete(room.key)
    room.client.close()
  }

  activeDouyinClient(roomId: string): DouyinDanmakuClient | null {
    const room = this.rooms.get(danmakuRoom(roomId).key)
    return room?.subscribers.size && room.client instanceof DouyinDanmakuClient ? room.client : null
  }

  bilibiliRoomInsights(roomId: string) {
    const room = this.rooms.get(roomId)
    const now = Date.now()
    const messages = room?.bilibiliObserved ?? []
    const receivedLastMinute = messages.filter(message => message.receivedAt >= now - 60_000 && !message.system && !message.superChat && !message.bilibiliGift).length
    return summarizeBilibiliRoom({ room: roomId, messages, rate: { receivedLastMinute }, capacity: REPLAY_LIMIT,
      truncated: room?.bilibiliTruncated ?? false, checkedAt: now }, this.bilibiliMetrics.read(roomId))
  }

  /** Attach a transport-neutral subscriber. Returns null when the room cap is already reached. */
  subscribe(roomId: string, subscriber: Omit<Subscriber, 'id'>): (() => void) | null {
    const identity = danmakuRoom(roomId)
    let room = this.rooms.get(identity.key)
    if (!room && this.rooms.size >= MAX_ROOMS) return null

    if (!room) {
      room = this.openRoom(roomId)
    } else if (room.idleTimer !== null) {
      this.clearTimer(room.idleTimer)
      room.idleTimer = null
      if (identity.platform === 'douyin') {
        // An explicit disconnect/reconnect must refresh session metadata and login state.
        room.recent = []
        room.client.close()
        room.client.connect()
      }
    }

    const id = this.nextSubscriberId++
    const entry: Subscriber = { id, ...subscriber }
    room.subscribers.set(id, entry)

    try {
      entry.write('state', { room: identity.external, state: room.state, detail: room.detail })
      if (room.huyaOnTv) entry.write('huya-on-tv', room.huyaOnTv)
      // Replay recent messages so a late subscriber's overlay is not empty for 30s.
      for (const message of room.recent) entry.write('danmaku', message)
    } catch {
      room.subscribers.delete(id)
      if (room.subscribers.size === 0) this.scheduleIdleClose(room)
      return () => {}
    }

    const currentRoom = room
    return () => {
      if (currentRoom.subscribers.delete(id) && currentRoom.subscribers.size === 0) {
        this.scheduleIdleClose(currentRoom)
      }
    }
  }

  closeAll(): void {
    const rooms = [...this.rooms.values()]
    this.rooms.clear()
    for (const room of rooms) {
      if (room.idleTimer !== null) this.clearTimer(room.idleTimer)
      room.idleTimer = null
      room.client.close()
      for (const subscriber of room.subscribers.values()) {
        try { subscriber.close() } catch { /* A destroyed renderer must not interrupt teardown. */ }
      }
      room.subscribers.clear()
    }
  }

  /** Refresh live receive sessions after a login change without dropping subscribers. */
  refreshPlatform(platform: DanmakuPlatform): void {
    for (const room of this.rooms.values()) {
      if (!room.key.startsWith(`${platform}:`)) continue
      room.recent = []
      room.bilibiliObserved = []
      room.bilibiliTruncated = false
      room.client.close()
      if (room.subscribers.size > 0) room.client.connect()
    }
  }

  /** An explicit retry refreshes the shared connection, including any PiP subscribers. */
  reconnectRoom(roomId: string): boolean {
    const room = this.rooms.get(danmakuRoom(roomId).key)
    if (!room || room.subscribers.size === 0) return false
    room.recent = []
    room.client.close()
    room.client.connect()
    return true
  }

  private openRoom(roomId: string): Room {
    const identity = danmakuRoom(roomId)
    const room: Room = {
      key: identity.key,
      subscribers: new Map(),
      recent: [],
      state: 'connecting',
      idleTimer: null,
      bilibiliObserved: [],
      bilibiliTruncated: false,
      removedSuperChats: new Set(),
      client: null as unknown as DanmakuClient,
    }
    const normalize = (message: ChatMessage): ChatMessage => ({ ...message, platform: identity.platform, room: identity.external })
    const events: DanmakuClientEvents = {
      onMessage: (message) => {
        if (identity.platform === 'bilibili' && (message.room !== identity.external
          || (message.superChat && room.removedSuperChats.has(message.superChat.id)))) return
        message = normalize(message)
        room.recent.push(message)
        if (room.recent.length > REPLAY_LIMIT) room.recent.shift()
        this.broadcast(room, 'danmaku', message)
      },
      onObservedMessage: message => {
        if (identity.platform === 'bilibili' && message.platform === 'bilibili' && message.room === identity.external) {
          room.bilibiliObserved.push(message as BilibiliChatMessage)
          if (room.bilibiliObserved.length > REPLAY_LIMIT) { room.bilibiliObserved.shift(); room.bilibiliTruncated = true }
        }
        this.observeRaw({ platform: identity.platform, type: 'message', message: normalize(message) })
      },
      onSignal: signal => {
        if (identity.platform === 'bilibili' && signal.room !== identity.external) return
        signal = { ...signal, platform: identity.platform, room: identity.external } as RoomSignal
        if (signal.platform === 'bilibili') {
          if (signal.kind === 'super-chat-delete') {
            for (const id of signal.ids) room.removedSuperChats.add(id)
            while (room.removedSuperChats.size > 512) room.removedSuperChats.delete(room.removedSuperChats.values().next().value!)
            room.recent = room.recent.filter(message => !message.superChat || !room.removedSuperChats.has(message.superChat.id))
          } else this.bilibiliMetrics.observe(signal)
        }
        this.observeRaw({ platform: identity.platform, type: 'signal', signal })
        this.broadcast(room, 'room-signal', signal)
      },
      onState: (state, detail) => {
        if (state !== 'connected') room.huyaOnTv = undefined
        room.state = state
        room.detail = detail
        this.observeRaw({ platform: identity.platform, type: 'state', room: identity.external, state })
        this.broadcast(room, 'state', { room: identity.external, state, detail })
      },
    }
    room.client = this.deps.createClient?.(identity.platform, identity.room, events)
      ?? (identity.platform === 'douyin'
        ? new DouyinDanmakuClient(identity.room, events, this.deps.douyin ?? {
          resolveRoom: async () => { throw new Error('抖音弹幕服务尚未配置') },
          createSocket: () => { throw new Error('抖音弹幕服务尚未配置') },
        })
        : identity.platform === 'huya'
        ? new HuyaRoomClient(identity.room, events, { ...this.deps, ...this.deps.huya,
          onTv: this.deps.huya?.onTv && { ...this.deps.huya.onTv, onSnapshot: snapshot => {
            if (snapshot.room !== identity.external || room.state !== 'connected') return
            room.huyaOnTv = snapshot
            this.deps.huya?.onTv?.onSnapshot(snapshot)
            this.broadcast(room, 'huya-on-tv', snapshot)
          } } })
        : identity.platform === 'bilibili'
        ? new BilibiliDanmakuClient(identity.room, events, this.deps.bilibili ?? {
          resolveRoom: async () => { throw new Error('哔哩哔哩弹幕暂不可用') },
          createSocket: () => { throw new Error('哔哩哔哩弹幕暂不可用') },
        })
        : new DouyuDanmakuClient(identity.room, events, this.deps))
    this.rooms.set(identity.key, room)
    room.client.connect()
    return room
  }

  private broadcast(room: Room, event: string, data: unknown): void {
    let dropped = false
    for (const subscriber of room.subscribers.values()) {
      try {
        subscriber.write(event, data)
      } catch {
        room.subscribers.delete(subscriber.id)
        dropped = true
      }
    }
    if (dropped && room.subscribers.size === 0) this.scheduleIdleClose(room)
  }

  private observeRaw(event: RawDanmakuEvent): void {
    for (const observer of this.observers) { try { observer(event) } catch { /* Observers cannot tear down the shared socket. */ } }
  }

  private scheduleIdleClose(room: Room): void {
    if (this.rooms.get(room.key) !== room) return
    if (room.idleTimer !== null) this.clearTimer(room.idleTimer)
    room.idleTimer = this.setTimer(() => {
      room.idleTimer = null
      if (this.rooms.get(room.key) === room) this.closeIdleRoom(room.key)
    }, IDLE_CLOSE_MS)
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms)
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle)
    else clearTimeout(handle as never)
  }
}
