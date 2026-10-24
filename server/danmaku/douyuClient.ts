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
  type ChatMessage,
} from './douyuProtocol'

const DANMAKU_ENDPOINT = 'wss://danmuproxy.douyu.com:8506/'
const KEEPALIVE_INTERVAL_MS = 40_000
/** Exponential backoff, capped so a dead room does not hammer the endpoint. */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** Gift visuals cannot use up the chat timeline during a donation burst. */
export const MAX_GIFT_MESSAGES_PER_SECOND = 12

export type DanmakuState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export type DanmakuClientEvents = {
  onMessage: (message: ChatMessage) => void
  onState: (state: DanmakuState, detail?: string) => void
}

export type WebSocketLike = {
  send: (data: ArrayBufferView | ArrayBuffer) => void
  close: () => void
  addEventListener: (type: string, listener: (event: any) => void) => void
  binaryType?: string
}

export type DanmakuClientDeps = {
  createSocket?: (url: string) => WebSocketLike
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class DouyuDanmakuClient {
  private socket: WebSocketLike | null = null
  // Explicitly the wide `Buffer<ArrayBufferLike>`: `Buffer.alloc` infers the narrow
  // `Buffer<ArrayBuffer>`, which then rejects the result of `Buffer.concat`.
  private buffer: Buffer = Buffer.alloc(0)
  private keepalive: unknown = null
  private reconnect: unknown = null
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

    // Every listener is bound to the socket that registered it. `teardown` calls
    // `socket.close()`, which makes the old socket emit `close` after we have already
    // moved on; without this guard that stale event would advance the backoff a second
    // time and feed bytes from a dead connection into the current frame buffer.
    const isCurrent = (): boolean => this.socket === socket

    socket.addEventListener('open', () => {
      if (!isCurrent()) return
      this.attempts = 0
      this.setState('connected')
      this.send(LOGIN_REQUEST(this.room))
      this.send(JOIN_GROUP_REQUEST(this.room))
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
    const chunk = toBuffer(data)
    if (!chunk) return
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const { payloads, rest } = decodeFrames(this.buffer)
    this.buffer = rest
    for (const payload of payloads) {
      const parsed = parseStt(payload)
      const now = this.now()
      const chat = toChatMessage(parsed, this.room, now)
      if (chat) {
        this.events.onMessage(chat)
        continue
      }
      const gift = toGiftMessage(parsed, this.room, now)
      if (!gift) continue
      if (now < this.giftWindowStart || now - this.giftWindowStart >= 1_000) {
        this.giftWindowStart = now
        this.giftsInWindow = 0
      }
      if (this.giftsInWindow >= MAX_GIFT_MESSAGES_PER_SECOND) continue
      this.giftsInWindow += 1
      this.events.onMessage(gift)
    }
  }

  private send(payload: string): void {
    try {
      this.socket?.send(encodeFrame(payload))
    } catch {
      // The socket died between the state check and the write; the close handler reconnects.
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepalive = this.setTimer(() => {
      this.send(KEEPALIVE_REQUEST())
      // Re-arm; a plain interval would keep firing after teardown on some runtimes.
      if (this.socket) this.startKeepalive()
    }, KEEPALIVE_INTERVAL_MS)
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
    this.attempts += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS)
    this.setState('reconnecting', detail)
    this.reconnect = this.setTimer(() => {
      this.reconnect = null
      this.connect()
    }, delay)
  }

  private teardown(): void {
    this.stopKeepalive()
    if (this.reconnect !== null) {
      this.clearTimer(this.reconnect)
      this.reconnect = null
    }
    const socket = this.socket
    this.socket = null
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
