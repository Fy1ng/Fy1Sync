/** Receive-only Douyin client. Main injects the policy-checked header-capable socket factory. */
import { douyinWebSocketRequest, type DouyinDanmakuRoom } from '../platforms/douyinDanmaku'
import { decodeDouyinFrame, encodeDouyinHeartbeat, MAX_DOUYIN_FRAME } from './douyinProtocol'
import { DouyinSigner } from './douyinSigner'
import type { DanmakuClientEvents, DanmakuState, WebSocketLike } from './types'

export interface DouyinDanmakuClientDeps {
  resolveRoom: (webRoom: string) => Promise<DouyinDanmakuRoom>
  createSocket: (url: string, headers: Record<string, string>) => WebSocketLike
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}
export interface DouyinDanmakuDiagnostics { frames: number; malformedFrames: number; chats: number; unknownMessages: number; acknowledgements: number }

export class DouyinDanmakuClient {
  private socket: WebSocketLike | null = null
  private metadata: DouyinDanmakuRoom | null = null
  private generation = 0
  private resolving = false
  private closedByUser = false
  private stateValue: DanmakuState = 'idle'
  private reconnect: unknown = null
  private keepalive: unknown = null
  private watchdog: unknown = null
  private watchdogRevision = 0
  private attempts = 0
  private openedAt: number | null = null
  private heartbeatMs = 10_000
  private seen = new Set<string>()
  private signer = new DouyinSigner()
  private stats: DouyinDanmakuDiagnostics = { frames: 0, malformedFrames: 0, chats: 0, unknownMessages: 0, acknowledgements: 0 }
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(readonly room: string, private readonly events: DanmakuClientEvents, private readonly deps: DouyinDanmakuClientDeps) {
    if (!/^[1-9]\d{0,19}$/.test(room)) throw new Error('无效的抖音弹幕房间.')
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as never))
  }
  get state(): DanmakuState { return this.stateValue }
  get diagnostics(): Readonly<DouyinDanmakuDiagnostics> { return { ...this.stats } }

  connect(): void {
    if (this.socket || this.resolving) return
    if (this.reconnect !== null) { this.clearTimer(this.reconnect); this.reconnect = null }
    this.closedByUser = false
    this.resolving = true
    const generation = ++this.generation
    this.setState('connecting')
    if (generation !== this.generation || this.closedByUser) return
    this.armWatchdog(30_000, '抖音弹幕房间解析超时, 正在重新连接.')
    void Promise.resolve().then(() => this.deps.resolveRoom(this.room)).then(metadata => {
      if (generation !== this.generation || this.closedByUser) return
      if (metadata.webRoom !== this.room) throw new Error('Invalid room identity')
      const request = douyinWebSocketRequest(metadata, this.signer)
      this.resolving = false
      this.metadata = metadata
      this.heartbeatMs = Math.max(10_000, Math.min(60_000, metadata.heartbeatMs))
      const socket = this.deps.createSocket(request.url, request.headers)
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      this.armWatchdog(15_000, '抖音弹幕连接超时, 正在重新连接.')
      const current = () => this.socket === socket && generation === this.generation && !this.closedByUser
      socket.addEventListener('open', () => {
        if (!current()) return
        this.openedAt = this.now()
        this.armWatchdog(15_000, '抖音弹幕未收到有效回应, 正在重新连接.')
        if (this.send(encodeDouyinHeartbeat())) this.startKeepalive()
      })
      socket.addEventListener('message', (event: { data: unknown }) => { if (current()) this.ingest(event.data) })
      socket.addEventListener('error', () => { if (current()) this.scheduleReconnect('抖音弹幕连接出错, 正在重新连接.') })
      socket.addEventListener('close', () => { if (current()) this.scheduleReconnect('抖音弹幕连接已断开, 正在重新连接.') })
    }).catch(() => { if (generation === this.generation && !this.closedByUser) this.scheduleReconnect('无法连接抖音弹幕房间, 请检查登录状态或出网设置.') })
  }
  close(): void { this.closedByUser = true; this.teardown(); this.seen.clear(); this.setState('closed') }

  private ingest(raw: unknown): void {
    const socket = this.socket, metadata = this.metadata
    if (!socket || !metadata || this.openedAt === null) return
    this.add('frames')
    const bytes = douyinBinaryFrame(raw)
    if (!bytes || bytes.length > MAX_DOUYIN_FRAME) { this.add('malformedFrames'); return }
    const result = decodeDouyinFrame(bytes, this.room, metadata.roomId, this.now())
    if (result.malformed) { this.add('malformedFrames'); return }
    if (!result.valid) return
    this.add('unknownMessages', result.unknownMessages)
    if (result.ack) { if (!this.send(result.ack)) return; this.add('acknowledgements') }
    if (result.liveEnded) { this.scheduleReconnect('抖音直播已结束, 正在等待重新开播.'); return }
    if (result.heartbeatMs) this.heartbeatMs = result.heartbeatMs
    if (this.now() - this.openedAt >= 30_000) this.attempts = 0
    this.armWatchdog(135_000, '抖音弹幕长时间未收到回应, 正在重新连接.')
    if (this.stateValue !== 'connected') this.setState('connected')
    for (const message of result.messages) {
      if (this.socket !== socket || this.closedByUser) return
      if (this.seen.has(message.id)) continue
      this.seen.add(message.id)
      if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!)
      this.add('chats')
      this.events.onObservedMessage?.(message)
      if (this.socket !== socket || this.closedByUser) return
      this.events.onMessage(message)
    }
  }
  private send(bytes: Uint8Array<ArrayBuffer>): boolean {
    if (!this.socket || bytes.length > 16_384) return false
    try { this.socket.send(bytes); return true } catch { this.scheduleReconnect('抖音弹幕协议确认失败, 正在重新连接.'); return false }
  }
  private startKeepalive(): void {
    if (this.keepalive !== null) this.clearTimer(this.keepalive)
    const generation = this.generation
    this.keepalive = this.setTimer(() => { this.keepalive = null; if (generation === this.generation && this.socket && this.send(encodeDouyinHeartbeat())) this.startKeepalive() }, this.heartbeatMs)
  }
  private armWatchdog(delay: number, detail: string): void {
    if (this.watchdog !== null) this.clearTimer(this.watchdog)
    const revision = ++this.watchdogRevision
    this.watchdog = this.setTimer(() => { if (revision !== this.watchdogRevision || this.closedByUser) return; this.watchdog = null; this.scheduleReconnect(detail) }, delay)
  }
  private scheduleReconnect(detail: string): void {
    if (this.closedByUser) return
    this.teardown()
    this.attempts = Math.min(this.attempts + 1, 6)
    const delay = Math.min(1_000 * 2 ** (this.attempts - 1), 30_000)
    this.setState('reconnecting', detail)
    if (this.closedByUser) return
    this.reconnect = this.setTimer(() => { this.reconnect = null; this.connect() }, delay)
  }
  private teardown(): void {
    this.generation++; this.watchdogRevision++
    for (const handle of [this.keepalive, this.watchdog, this.reconnect]) if (handle !== null) this.clearTimer(handle)
    this.keepalive = this.watchdog = this.reconnect = null
    const socket = this.socket
    this.socket = null; this.metadata = null; this.resolving = false; this.openedAt = null
    try { socket?.close() } catch { /* Already closed. */ }
  }
  private add(key: keyof DouyinDanmakuDiagnostics, value = 1): void { this.stats[key] = Math.min(Number.MAX_SAFE_INTEGER, this.stats[key] + value) }
  private setState(state: DanmakuState, detail?: string): void { this.stateValue = state; this.events.onState(state, detail) }
}

export function douyinBinaryFrame(raw: unknown): Uint8Array | null {
  try { if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    const size = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(raw)
    return typeof size === 'number' ? new Uint8Array(raw as ArrayBuffer) : null
  } catch { return null }
}
