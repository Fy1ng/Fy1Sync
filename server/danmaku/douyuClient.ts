/**
 * Douyu danmaku client.
 *
 * Runs server-side rather than in the browser for two reasons: the danmaku endpoint is
 * a raw WebSocket without CORS-friendly headers, and one upstream connection can fan out
 * to any number of local IPC subscribers, so no
 * WebSocket server is needed here either.
 *
 * Connects anonymously (`loginreq` with no token). No credentials are sent or stored.
 */

import {
  decodeFrames,
  encodeFrame,
  JOIN_GROUP_REQUEST,
  KEEPALIVE_REQUEST,
  LOGIN_REQUEST,
  parseStt,
  toChatMessage,
  toGiftMessage,
} from './douyuProtocol'
import { parseDouyuRoomSignal } from './roomSignals'
import type { DanmakuClientDeps, DanmakuClientEvents, DanmakuState, WebSocketLike } from './types'
export type { DanmakuClientDeps, DanmakuClientEvents, DanmakuState, WebSocketLike } from './types'

const DANMAKU_ENDPOINT = 'wss://danmuproxy.douyu.com:8506/'
const KEEPALIVE_INTERVAL_MS = 40_000
const CONNECT_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 15_000
// Quiet rooms still return mrkl/keeplive. Allow two heartbeat periods plus slack.
const INBOUND_TIMEOUT_MS = 90_000
const STABLE_CONNECTION_MS = 30_000
/** Exponential backoff, capped so a dead room does not hammer the endpoint. */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** Gift notifications cannot use up the chat timeline during a donation burst. */
export const MAX_GIFT_MESSAGES_PER_SECOND = 12

export class DouyuDanmakuClient {
  private socket: WebSocketLike | null = null
  // Explicitly the wide `Buffer<ArrayBufferLike>`: `Buffer.alloc` infers the narrow
  // `Buffer<ArrayBuffer>`, which then rejects the result of `Buffer.concat`.
  private buffer: Buffer = Buffer.alloc(0)
  private keepalive: unknown = null
  private reconnect: unknown = null
  private watchdog: unknown = null
  private watchdogRevision = 0
  private openedAt: number | null = null
  private attempts = 0
  private stateValue: DanmakuState = 'idle'
  private closedByUser = false
  private giftWindowStart = Number.NEGATIVE_INFINITY
  private giftsInWindow = 0
  private readonly createSocket: (url: string) => WebSocketLike
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    readonly room: string,
    private readonly events: DanmakuClientEvents,
    deps: DanmakuClientDeps = {},
  ) {
    this.createSocket =
      deps.createSocket ??
      ((url) => {
        const socket = new WebSocket(url) as unknown as WebSocketLike
        socket.binaryType = 'arraybuffer'
        return socket
      })
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as never))
  }

  get state(): DanmakuState {
    return this.stateValue
  }

  connect(): void {
    if (this.socket) return
    if (this.reconnect !== null) { this.clearTimer(this.reconnect); this.reconnect = null }
    this.closedByUser = false
    this.setState('connecting')
    let socket: WebSocketLike
    try {
      socket = this.createSocket(DANMAKU_ENDPOINT)
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error))
      return
    }
    this.socket = socket
    this.armWatchdog(socket, CONNECT_TIMEOUT_MS, '弹幕连接超时, 正在重新连接.')

    // Every listener is bound to the socket that registered it. `teardown` calls
    // `socket.close()`, which makes the old socket emit `close` after we have already
    // moved on; without this guard that stale event would advance the backoff a second
    // time and feed bytes from a dead connection into the current frame buffer.
    const isCurrent = (): boolean => this.socket === socket

    socket.addEventListener('open', () => {
      if (!isCurrent()) return
      this.openedAt = this.now()
      this.armWatchdog(socket, LOGIN_TIMEOUT_MS, '弹幕登录未收到有效回应, 正在重新连接.')
      if (!this.send(LOGIN_REQUEST(this.room)) || !isCurrent()) return
      if (!this.send(JOIN_GROUP_REQUEST(this.room)) || !isCurrent()) return
      this.startKeepalive()
    })
    socket.addEventListener('message', (event: { data: unknown }) => {
      if (!isCurrent()) return
      this.ingest(event.data)
    })
    socket.addEventListener('error', (event: { message?: string }) => {
      if (!isCurrent()) return
      this.scheduleReconnect(event?.message ?? '弹幕连接出错')
    })
    socket.addEventListener('close', (event: { reason?: string }) => {
      if (!isCurrent()) return
      this.scheduleReconnect(event?.reason || '弹幕连接已断开')
    })
  }

  close(): void {
    this.closedByUser = true
    this.teardown()
    this.setState('closed')
  }

  private ingest(data: unknown): void {
    const socket = this.socket
    if (!socket || this.openedAt === null) return
    const chunk = toBuffer(data)
    if (!chunk) return
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const { payloads, rest } = decodeFrames(this.buffer)
    this.buffer = rest
    for (const payload of payloads) {
      if (this.socket !== socket || this.closedByUser) return
      const parsed = parseStt(payload)
      if (parsed.type === 'error') {
        this.scheduleReconnect('斗鱼结束了弹幕连接, 正在重新连接.')
        return
      }
      if (['rid', 'roomid'].some(key => parsed[key] !== undefined && parsed[key] !== this.room)) continue
      const now = this.now()
      if (['loginres', 'mrkl', 'keeplive'].includes(parsed.type ?? '')) {
        if (['code', 'error'].some(key => parsed[key] !== undefined && parsed[key] !== '0')) {
          this.scheduleReconnect('斗鱼未接受弹幕连接, 正在重新连接.')
          return
        }
        this.acceptInbound(socket, now)
        continue
      }
      const chat = toChatMessage(parsed, this.room, now)
      if (chat) {
        chat.platform = 'douyu'
        this.acceptInbound(socket, now)
        if (this.socket !== socket) return
        this.events.onObservedMessage?.(chat)
        this.events.onMessage(chat)
        continue
      }
      const signal = parseDouyuRoomSignal(parsed, this.room, now)
      if (signal) {
        this.acceptInbound(socket, now)
        if (this.socket === socket) this.events.onSignal?.(signal)
        continue
      }
      const gift = toGiftMessage(parsed, this.room, now)
      if (!gift) continue
      gift.platform = 'douyu'
      this.acceptInbound(socket, now)
      if (this.socket !== socket) return
      this.events.onObservedMessage?.(gift)
      if (now < this.giftWindowStart || now - this.giftWindowStart >= 1_000) {
        this.giftWindowStart = now
        this.giftsInWindow = 0
      }
      if (this.giftsInWindow >= MAX_GIFT_MESSAGES_PER_SECOND) continue
      this.giftsInWindow += 1
      this.events.onMessage(gift)
    }
  }

  private send(payload: string): boolean {
    const socket = this.socket
    if (!socket) return false
    try {
      socket.send(encodeFrame(payload))
      return true
    } catch {
      if (this.socket === socket) this.scheduleReconnect('弹幕连接写入失败, 正在重新连接.')
      return false
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    const socket = this.socket
    this.keepalive = this.setTimer(() => {
      if (!socket || this.socket !== socket) return
      if (!this.send(KEEPALIVE_REQUEST())) return
      // Re-arm; a plain interval would keep firing after teardown on some runtimes.
      if (this.socket) this.startKeepalive()
    }, KEEPALIVE_INTERVAL_MS)
  }

  private acceptInbound(socket: WebSocketLike, now: number): void {
    if (this.socket !== socket) return
    // A connection that repeatedly opens and immediately drops must keep backing
    // off. Only valid traffic after a stable interval restores the initial delay.
    if (this.openedAt !== null && now - this.openedAt >= STABLE_CONNECTION_MS) this.attempts = 0
    this.armWatchdog(socket, INBOUND_TIMEOUT_MS, '弹幕连接长时间未收到回应, 正在重新连接.')
    if (this.stateValue !== 'connected') this.setState('connected')
  }

  private armWatchdog(socket: WebSocketLike, delay: number, detail: string): void {
    this.stopWatchdog()
    const revision = this.watchdogRevision
    this.watchdog = this.setTimer(() => {
      if (revision !== this.watchdogRevision || this.socket !== socket) return
      this.watchdog = null
      this.scheduleReconnect(detail)
    }, delay)
  }

  private stopWatchdog(): void {
    this.watchdogRevision++
    if (this.watchdog !== null) this.clearTimer(this.watchdog)
    this.watchdog = null
  }

  private stopKeepalive(): void {
    if (this.keepalive !== null) {
      this.clearTimer(this.keepalive)
      this.keepalive = null
    }
  }

  private scheduleReconnect(detail: string): void {
    if (this.closedByUser) return
    this.teardown()
    this.attempts = Math.min(this.attempts + 1, 6)
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS)
    this.setState('reconnecting', detail)
    this.reconnect = this.setTimer(() => {
      this.reconnect = null
      this.connect()
    }, delay)
  }

  private teardown(): void {
    this.stopKeepalive()
    this.stopWatchdog()
    if (this.reconnect !== null) {
      this.clearTimer(this.reconnect)
      this.reconnect = null
    }
    const socket = this.socket
    this.socket = null
    this.openedAt = null
    this.buffer = Buffer.alloc(0)
    this.giftWindowStart = Number.NEGATIVE_INFINITY
    this.giftsInWindow = 0
    try {
      socket?.close()
    } catch {
      // Already closed.
    }
  }

  private setState(state: DanmakuState, detail?: string): void {
    this.stateValue = state
    this.events.onState(state, detail)
  }
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return null
}
