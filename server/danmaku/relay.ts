/**
 * Danmaku relay: one upstream client per room, fanned out to local renderer subscribers
 * through a transport-neutral callback.
 *
 * Rooms are reference-counted: the upstream socket opens with the
 * first subscriber and closes shortly after the last one leaves, so a closed tab does not
 * leave a connection running forever.
 */

import { DouyuDanmakuClient } from './douyuClient'
import { HuyaRoomClient, type HuyaRoomClientDeps } from './huyaRoomClient'
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
}

export class DanmakuRelay {
  private readonly rooms = new Map<string, Room>()
  private nextSubscriberId = 1
  private readonly observers = new Set<(event: RawDanmakuEvent) => void>()

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
    }

    const id = this.nextSubscriberId++
    const entry: Subscriber = { id, ...subscriber }
    room.subscribers.set(id, entry)

    try {
      entry.write('state', { room: identity.external, state: room.state, detail: room.detail })
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

  private openRoom(roomId: string): Room {
    const identity = danmakuRoom(roomId)
    const room: Room = {
      key: identity.key,
      subscribers: new Map(),
      recent: [],
      state: 'connecting',
      idleTimer: null,
      client: null as unknown as DanmakuClient,
    }
    const normalize = (message: ChatMessage): ChatMessage => ({ ...message, platform: identity.platform, room: identity.external })
    const events: DanmakuClientEvents = {
      onMessage: (message) => {
        message = normalize(message)
        room.recent.push(message)
        if (room.recent.length > REPLAY_LIMIT) room.recent.shift()
        this.broadcast(room, 'danmaku', message)
      },
      onObservedMessage: message => this.observeRaw({ platform: identity.platform, type: 'message', message: normalize(message) }),
      onSignal: signal => {
        signal = { ...signal, platform: identity.platform, room: identity.external } as RoomSignal
        this.observeRaw({ platform: identity.platform, type: 'signal', signal })
        this.broadcast(room, 'room-signal', signal)
      },
      onState: (state, detail) => {
        room.state = state
        room.detail = detail
        this.observeRaw({ platform: identity.platform, type: 'state', room: identity.external, state })
        this.broadcast(room, 'state', { room: identity.external, state, detail })
      },
    }
    room.client = this.deps.createClient?.(identity.platform, identity.room, events)
      ?? (identity.platform === 'huya'
        ? new HuyaRoomClient(identity.room, events, { ...this.deps, ...this.deps.huya })
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
      if (room.subscribers.size > 0) return
      room.client.close()
      this.rooms.delete(room.key)
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
