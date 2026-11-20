import { createHash, randomUUID } from 'node:crypto'
import { inflateSync, brotliDecompressSync } from 'node:zlib'
import { bilibiliId, bilibiliRoomNumber } from '../../src/core/bilibiliMetadata'
import {
  bilibiliObject, fetchBilibiliWebData, readBilibiliRoomIdentity, type BilibiliCookieHeader,
} from '../platforms/bilibiliWeb'
import { parseBilibiliRoomEvent, type BilibiliChatMessage, type BilibiliRoomSignal } from './bilibiliEvents'
import type { DanmakuState, WebSocketLike } from './types'

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
const DANMAKU_INFO = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'
const PACKET_BUDGET = 4 * 1024 * 1024
const RECENT_ID_LIMIT = 512

export function signBilibili(params: Record<string, string>, key: string): string {
  const query = Object.keys(params).sort().map(name =>
    `${encodeURIComponent(name)}=${encodeURIComponent(params[name]!.replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`
}

export type BilibiliRoom = { room: string; token: string; endpoint: string; uid: number; buvid: string }
export type BilibiliDeps = {
  createSocket: (url: string) => WebSocketLike
  now?: () => number
  cookieHeader?: BilibiliCookieHeader
  resolveRoom?: (room: string, signal: AbortSignal) => Promise<BilibiliRoom>
}
export type BilibiliClientEvents = {
  onMessage: (message: BilibiliChatMessage) => void
  onObservedMessage?: (message: BilibiliChatMessage) => void
  onSignal?: (signal: BilibiliRoomSignal) => void
  onState: (state: DanmakuState, detail?: string) => void
}

export function isBilibiliDanmakuEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'wss:' && /^[a-z0-9-]+\.chat\.bilibili\.com$/.test(url.hostname)
      && ['', '2245'].includes(url.port) && url.pathname === '/sub'
      && !url.search && !url.hash && !url.username && !url.password
  } catch { return false }
}

export async function resolveBilibiliDanmaku(room: string, cookieHeader?: BilibiliCookieHeader, signal?: AbortSignal): Promise<BilibiliRoom> {
  const identity = await readBilibiliRoomIdentity(room, signal)
  let cookie = await cookieHeader?.(DANMAKU_INFO) ?? ''
  const knownVisitor = /(?:^|;\s*)buvid3=([^;]+)/.exec(cookie)?.[1]
  const fingerprint = knownVisitor ? undefined : await fetchBilibiliWebData('https://api.bilibili.com/x/frontend/finger/spi', { signal })
  const buvid = knownVisitor ?? fingerprint?.b_3
  if (typeof buvid !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(buvid)) throw new Error('无法获取哔哩哔哩访客标识')
  if (!knownVisitor) cookie += `${cookie ? '; ' : ''}buvid3=${buvid}`
  const nav = await fetchBilibiliWebData('https://api.bilibili.com/x/web-interface/nav', { signal, allowAnonymousNav: true })
  const keys = bilibiliObject(nav.wbi_img)
  const seed = [keys.img_url, keys.sub_url].map(url => typeof url === 'string' ? url.split('/').pop()!.split('.')[0] : '').join('')
  if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error('无法获取哔哩哔哩弹幕签名')
  const key = MIXIN.map(index => seed[index]).join('').slice(0, 32)
  const query = signBilibili({ id: identity.room, type: '0', web_location: '444.8', wts: String(Math.floor(Date.now() / 1000)) }, key)
  const info = await fetchBilibiliWebData(`${DANMAKU_INFO}?${query}`, { signal, cookieHeader: async () => cookie })
  const hosts = Array.isArray(info.host_list) ? info.host_list : []
  const endpoint = hosts.map(raw => {
    const host = bilibiliObject(raw)
    return typeof host.host === 'string' && [443, 2245].includes(Number(host.wss_port))
      ? `wss://${host.host}:${host.wss_port}/sub` : ''
  }).filter(isBilibiliDanmakuEndpoint).sort((first, second) => Number(new URL(first).port !== '') - Number(new URL(second).port !== ''))[0]
  if (!endpoint || typeof info.token !== 'string' || !info.token || info.token.length > 8192) throw new Error('无法获取哔哩哔哩弹幕服务器')
  const user = Number(bilibiliId(/(?:^|;\s*)DedeUserID=(\d+)/.exec(cookie)?.[1]) ?? 0)
  return { room: identity.room, token: info.token, endpoint, uid: Number.isSafeInteger(user) ? user : 0, buvid }
}

export function bilibiliPacket(op: number, body: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(body)
  const packet = Buffer.alloc(16 + bytes.length)
  packet.writeUInt32BE(packet.length, 0)
  packet.writeUInt16BE(16, 4)
  packet.writeUInt16BE(1, 6)
  packet.writeUInt32BE(op, 8)
  packet.writeUInt32BE(1, 12)
  bytes.copy(packet, 16)
  return new Uint8Array(packet)
}

export function decodeBilibiliPackets(data: Uint8Array, visit: (op: number, body: Buffer) => void): void {
  if (data.byteLength > PACKET_BUDGET) throw new Error('Invalid Bilibili packet')
  let remaining = PACKET_BUDGET
  const decode = (buffer: Buffer, depth: number): void => {
    for (let offset = 0; offset < buffer.length;) {
      if (buffer.length - offset < 16) throw new Error('Truncated Bilibili packet')
      const length = buffer.readUInt32BE(offset)
      const header = buffer.readUInt16BE(offset + 4)
      const version = buffer.readUInt16BE(offset + 6)
      if (header < 16 || length < header || offset + length > buffer.length) throw new Error('Invalid Bilibili packet length')
      const body = buffer.subarray(offset + header, offset + length)
      if (version === 2 || version === 3) {
        if (depth >= 4 || remaining <= 0) throw new Error('Bilibili decompression limit exceeded')
        const expanded = (version === 2 ? inflateSync : brotliDecompressSync)(body, { maxOutputLength: remaining })
        remaining -= expanded.length
        decode(expanded, depth + 1)
      } else if (version === 0 || version === 1) {
        visit(buffer.readUInt32BE(offset + 8), body)
      }
      offset += length
    }
  }
  decode(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 0)
}

export class BilibiliDanmakuClient {
  private socket?: WebSocketLike
  private session?: AbortController
  private retry?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private watchdog?: ReturnType<typeof setTimeout>
  private attempts = 0
  private readonly seen = new Set<string>()
  private readonly removed = new Set<string>()
  state: DanmakuState = 'idle'

  constructor(readonly room: string, private readonly events: BilibiliClientEvents, private readonly deps: BilibiliDeps) {}

  connect(): void {
    if (this.session) return
    clearTimeout(this.retry)
    const session = new AbortController()
    this.session = session
    this.mark('connecting')
    this.watchdog = setTimeout(() => this.reconnect(), 30_000)
    const resolve = this.deps.resolveRoom ?? ((room: string, signal: AbortSignal) => resolveBilibiliDanmaku(room, this.deps.cookieHeader, signal))
    void Promise.resolve().then(() => resolve(this.room, session.signal)).then(meta => {
      if (session.signal.aborted) return
      if (!bilibiliRoomNumber(meta.room) || !isBilibiliDanmakuEndpoint(meta.endpoint)) throw new Error('哔哩哔哩弹幕地址无效')
      const socket = this.deps.createSocket(meta.endpoint)
      this.socket = socket
      socket.binaryType = 'arraybuffer'
      const beat = () => { if (!session.signal.aborted) this.send(socket, 2, '[object Object]') }
      socket.addEventListener('open', () => {
        if (session.signal.aborted) return
        this.send(socket, 7, JSON.stringify({
          uid: meta.uid, roomid: Number(meta.room), protover: 3, platform: 'web', type: 2, key: meta.token,
          buvid: meta.buvid, support_ack: true, queue_uuid: randomUUID().slice(0, 8), scene: '',
        }))
      })
      socket.addEventListener('message', (event: { data: unknown }) => {
        if (session.signal.aborted) return
        const receivedAt = (this.deps.now ?? Date.now)()
        const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data)
          : ArrayBuffer.isView(event.data) ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength) : null
        if (!data) return
        try {
          decodeBilibiliPackets(data, (op, body) => {
            if (session.signal.aborted) return
            try {
              if (op === 8 && this.state === 'connecting') {
                if (JSON.parse(body.toString()).code !== 0) { this.reconnect(); return }
                this.attempts = 0
                this.mark('connected')
                if (session.signal.aborted) return
                this.alive()
                beat()
                if (!session.signal.aborted) this.heartbeat = setInterval(beat, 30_000)
              } else if (op === 3 && this.state === 'connected') {
                this.alive()
                if (body.length >= 4) this.events.onSignal?.({
                  platform: 'bilibili', kind: 'popularity', room: `bilibili:${meta.room}`, receivedAt, count: body.readUInt32BE(0),
                })
              } else if (op === 5 && this.state === 'connected') {
                this.observe(parseBilibiliRoomEvent(JSON.parse(body.toString()), meta.room, receivedAt))
              }
            } catch { return }
          })
        } catch { return }
      })
      const disconnected = () => { if (!session.signal.aborted) this.reconnect() }
      socket.addEventListener('close', disconnected)
      socket.addEventListener('error', disconnected)
    }).catch(() => { if (!session.signal.aborted) this.reconnect() })
  }

  close(): void {
    this.teardown()
    this.seen.clear()
    this.removed.clear()
    this.attempts = 0
    this.mark('closed')
  }

  private observe(event: BilibiliChatMessage | BilibiliRoomSignal | null): void {
    if (!event) return
    if ('kind' in event) {
      if (event.kind === 'super-chat-delete') {
        for (const id of event.ids) this.remember(this.removed, `${event.room}:sc:${id}`)
      }
      this.events.onSignal?.(event)
      return
    }
    if (this.seen.has(event.id) || this.removed.has(event.id)) return
    this.remember(this.seen, event.id)
    this.events.onObservedMessage?.(event)
    this.events.onMessage(event)
  }

  private remember(set: Set<string>, id: string): void {
    if (set.size >= RECENT_ID_LIMIT) set.delete(set.values().next().value!)
    set.add(id)
  }

  private send(socket: WebSocketLike, op: number, body: string): void {
    try { socket.send(bilibiliPacket(op, body)) } catch { this.reconnect() }
  }

  private mark(state: DanmakuState, detail?: string): void {
    this.state = state
    this.events.onState(state, detail)
  }

  private alive(): void {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => this.reconnect(), 75_000)
  }

  private teardown(): void {
    this.session?.abort()
    this.session = undefined
    clearTimeout(this.retry)
    clearTimeout(this.watchdog)
    clearInterval(this.heartbeat)
    const socket = this.socket
    this.socket = undefined
    try { socket?.close() } catch { return }
  }

  private reconnect(): void {
    this.teardown()
    this.mark('reconnecting', '哔哩哔哩弹幕连接失败，正在重试，请检查网络或登录状态')
    if (this.state === 'reconnecting') this.retry = setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)))
  }
}
