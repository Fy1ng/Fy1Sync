/** Receive-only Huya socket with bounded parsing, watchdogs and Douyu-style backoff. */
import { readPlatformText } from '../platformResponse'
import { safeFetch } from '../safeFetch'
import { resolveHuyaDanmakuRoom, type HuyaDanmakuRoom } from '../platforms/huyaDanmaku'
import { decodeHuyaFrame, encodeHuyaHeartbeat, encodeHuyaRegistration, MAX_HUYA_FRAME } from './huyaProtocol'
import type { DanmakuClientDeps, DanmakuClientEvents, DanmakuState, WebSocketLike } from './types'

const ENDPOINT = 'wss://cdnws.api.huya.com'
const HEARTBEAT_MS = 60_000
const CONNECT_TIMEOUT_MS = 15_000
const INBOUND_TIMEOUT_MS = 135_000
const MAX_GIFTS_PER_SECOND = 12
const MAX_UNKNOWN_URI_KEYS = 64

export type HuyaDanmakuClientDeps = DanmakuClientDeps & { resolveRoom?: (room: string) => Promise<HuyaDanmakuRoom> }
export type HuyaDanmakuDiagnostics = {
  frames: number; malformedFrames: number; unknownUris: number; chats: number; gifts: number; viewerSignals: number; batches: number
  emptyFrames: number; nonBinaryFrames: number; unknownUriCounts: Record<string, number>
  viewerCount?: number
}

export async function defaultResolveHuyaDanmakuRoom(room: string): Promise<HuyaDanmakuRoom> {
  return resolveHuyaDanmakuRoom(room, async (url, init) => {
    const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS)
    const { response } = await safeFetch(url, { enabled: true, hosts: ['www.huya.com'], allowNonStandardPorts: false,
      allowNonLoopbackTargets: false, maxRedirects: 0, requestTimeoutMs: CONNECT_TIMEOUT_MS }, {
      headers: init?.headers as Record<string, string>, signal,
    })
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('请求虎牙弹幕房间失败.') }
    return readPlatformText(response, signal)
  })
}

export class HuyaDanmakuClient {
  private socket: WebSocketLike | null = null
  private generation = 0
  private resolving = false
  private reconnect: unknown = null
  private keepalive: unknown = null
  private watchdog: unknown = null
  private watchdogRevision = 0
  private attempts = 0
  private openedAt: number | null = null
  private registered = false
  private presenterUid: bigint | null = null
  private closedByUser = false
  private stateValue: DanmakuState = 'idle'
  private giftWindowStart = Number.NEGATIVE_INFINITY
  private giftsInWindow = 0
  private stats: HuyaDanmakuDiagnostics = { frames: 0, malformedFrames: 0, unknownUris: 0, chats: 0, gifts: 0, viewerSignals: 0, batches: 0,
    emptyFrames: 0, nonBinaryFrames: 0, unknownUriCounts: {} }
  private readonly createSocket: (url: string) => WebSocketLike
  private readonly resolveRoom: (room: string) => Promise<HuyaDanmakuRoom>
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(readonly room: string, private readonly events: DanmakuClientEvents, deps: HuyaDanmakuClientDeps = {}) {
    this.createSocket = deps.createSocket ?? (url => new WebSocket(url) as unknown as WebSocketLike)
    this.resolveRoom = deps.resolveRoom ?? defaultResolveHuyaDanmakuRoom
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as never))
  }

  get state(): DanmakuState { return this.stateValue }
  get diagnostics(): Readonly<HuyaDanmakuDiagnostics> { return { ...this.stats, unknownUriCounts: { ...this.stats.unknownUriCounts } } }

  connect(): void {
    if (this.socket || this.resolving) return
    if (this.reconnect !== null) { this.clearTimer(this.reconnect); this.reconnect = null }
    this.closedByUser = false
    this.resolving = true
    const generation = ++this.generation
    this.setState('connecting')
    this.armWatchdog(CONNECT_TIMEOUT_MS, '虎牙弹幕房间解析超时, 正在重新连接.')
    void Promise.resolve().then(() => this.resolveRoom(this.room)).then(metadata => {
      if (generation !== this.generation || this.closedByUser) return
      this.resolving = false
      if (metadata.room !== this.room) throw new Error('Invalid room identity')
      const registration = encodeHuyaRegistration(metadata)
      this.presenterUid = metadata.presenterUid
      const socket = this.createSocket(ENDPOINT)
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      this.armWatchdog(CONNECT_TIMEOUT_MS, '虎牙弹幕连接超时, 正在重新连接.')
      const current = () => this.socket === socket && generation === this.generation && !this.closedByUser
      socket.addEventListener('open', () => {
        if (!current()) return
        this.openedAt = this.now()
        this.armWatchdog(CONNECT_TIMEOUT_MS, '虎牙弹幕注册未收到有效回应, 正在重新连接.')
        if (this.send(registration)) this.startKeepalive()
      })
      socket.addEventListener('message', (event: { data: unknown }) => { if (current()) this.ingest(event.data) })
      // Never propagate a remote close reason, error text, raw frame or resolver error.
      socket.addEventListener('error', () => { if (current()) this.scheduleReconnect('虎牙弹幕连接出错, 正在重新连接.') })
      socket.addEventListener('close', () => { if (current()) this.scheduleReconnect('虎牙弹幕连接已断开, 正在重新连接.') })
    }).catch(() => {
      if (generation === this.generation && !this.closedByUser) this.scheduleReconnect('无法连接虎牙弹幕房间, 正在重新连接.')
    })
  }

  close(): void { this.closedByUser = true; this.teardown(); this.setState('closed') }

  private ingest(data: unknown): void {
    const socket = this.socket
    if (!socket || this.openedAt === null) return
    const frame = huyaBinaryFrame(data)
    this.add('frames')
    if (!frame) this.add('nonBinaryFrames')
    if (!frame || frame.byteLength > MAX_HUYA_FRAME) { this.add('malformedFrames'); return }
    // Huya sends genuine zero-length binary messages. They are neither errors nor liveness proof.
    if (frame.byteLength === 0) { this.add('emptyFrames'); return }
    const result = decodeHuyaFrame(frame, this.room, this.now(), { presenterUid: this.presenterUid! })
    if (result.malformed) { this.add('malformedFrames'); return }
    this.add('unknownUris', result.unknownUris)
    for (const [uri, count] of Object.entries(result.unknownUriCounts)) {
      const key = Object.hasOwn(this.stats.unknownUriCounts, uri) || Object.keys(this.stats.unknownUriCounts).length < MAX_UNKNOWN_URI_KEYS ? uri : 'other'
      this.stats.unknownUriCounts[key] = Math.min(Number.MAX_SAFE_INTEGER, (this.stats.unknownUriCounts[key] ?? 0) + count)
    }
    if (result.batch) this.add('batches')
    if (result.command === 17 && result.registrationFailed) { this.scheduleReconnect('虎牙未接受弹幕注册, 正在重新连接.'); return }
    if (result.command === 17 && result.registered) this.registered = true
    if (!this.registered) return
    if ((result.command === 17 && result.registered) || result.heartbeat || result.messages.length || result.signals.length) this.acceptInbound()
    for (const message of result.messages) {
      if (this.socket !== socket) return
      this.add(message.system ? 'gifts' : 'chats')
      this.events.onObservedMessage?.(message)
      if (message.system) {
        const now = this.now()
        if (now < this.giftWindowStart || now - this.giftWindowStart >= 1_000) { this.giftWindowStart = now; this.giftsInWindow = 0 }
        if (this.giftsInWindow >= MAX_GIFTS_PER_SECOND) continue
        this.giftsInWindow++
      }
      this.events.onMessage(message)
    }
    for (const signal of result.signals) {
      if (this.socket !== socket) return
      this.add('viewerSignals')
      this.stats.viewerCount = signal.count
      this.events.onSignal?.(signal)
    }
  }

  private acceptInbound(): void {
    if (this.openedAt !== null && this.now() - this.openedAt >= 30_000) this.attempts = 0
    this.armWatchdog(INBOUND_TIMEOUT_MS, '虎牙弹幕长时间未收到回应, 正在重新连接.')
    if (this.stateValue !== 'connected') this.setState('connected')
  }

  private send(data: Uint8Array<ArrayBuffer>): boolean {
    if (!this.socket) return false
    try { this.socket.send(data); return true }
    catch { this.scheduleReconnect('虎牙弹幕连接写入失败, 正在重新连接.'); return false }
  }

  private startKeepalive(): void {
    if (this.keepalive !== null) this.clearTimer(this.keepalive)
    const generation = this.generation
    this.keepalive = this.setTimer(() => {
      this.keepalive = null
      if (generation !== this.generation || !this.socket) return
      if (this.send(encodeHuyaHeartbeat())) this.startKeepalive()
    }, HEARTBEAT_MS)
  }

  private armWatchdog(delay: number, detail: string): void {
    if (this.watchdog !== null) this.clearTimer(this.watchdog)
    const revision = ++this.watchdogRevision
    this.watchdog = this.setTimer(() => {
      if (revision !== this.watchdogRevision || this.closedByUser) return
      this.watchdog = null
      this.scheduleReconnect(detail)
    }, delay)
  }

  private scheduleReconnect(detail: string): void {
    if (this.closedByUser) return
    this.teardown()
    this.attempts = Math.min(this.attempts + 1, 6)
    const delay = Math.min(1_000 * 2 ** (this.attempts - 1), 30_000)
    this.setState('reconnecting', detail)
    this.reconnect = this.setTimer(() => { this.reconnect = null; this.connect() }, delay)
  }

  private teardown(): void {
    this.generation++
    this.watchdogRevision++
    for (const handle of [this.keepalive, this.watchdog, this.reconnect]) if (handle !== null) this.clearTimer(handle)
    this.keepalive = this.watchdog = this.reconnect = null
    const socket = this.socket
    this.socket = null
    this.resolving = false
    this.registered = false
    this.presenterUid = null
    this.openedAt = null
    this.giftWindowStart = Number.NEGATIVE_INFINITY
    this.giftsInWindow = 0
    try { socket?.close() } catch { /* Already closed. */ }
  }

  private add(key: Exclude<keyof HuyaDanmakuDiagnostics, 'viewerCount' | 'unknownUriCounts'>, count = 1): void { this.stats[key] = Math.min(Number.MAX_SAFE_INTEGER, this.stats[key] + count) }
  private setState(state: DanmakuState, detail?: string): void { this.stateValue = state; this.events.onState(state, detail) }
}

/** Preserve binary data from other JS realms; never coerce strings/Blobs into empty arrays. */
export function huyaBinaryFrame(data: unknown): Uint8Array | null {
  try {
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(data)
    return typeof length === 'number' ? new Uint8Array(data as ArrayBuffer) : null
  } catch { return null }
}
