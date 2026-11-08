import { copyBilibiliMetadata } from '../../src/core/bilibiliMetadata'
import { createHash, randomUUID } from 'node:crypto'
import { inflateSync, brotliDecompressSync } from 'node:zlib'
import { safeFetch } from '../safeFetch'
import { readPlatformText } from '../platformResponse'
import { createNetworkSocket } from './networkSocket'
import type { ChatMessage, DanmakuClientDeps, DanmakuClientEvents, DanmakuState, WebSocketLike } from './types'

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
export function signBilibili(params: Record<string, string>, key: string): string {
  const query = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!.replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`
}
export type BilibiliRoom = { room: string; token: string; endpoint: string; uid: number; buvid: string }
export type BilibiliDeps = DanmakuClientDeps & { cookieHeader?: (url: string) => Promise<string>; resolveRoom?: (room: string) => Promise<BilibiliRoom> }
export async function resolveBilibiliDanmaku(room: string, cookieHeader?: BilibiliDeps['cookieHeader']): Promise<BilibiliRoom> {
  let cookie = await cookieHeader?.('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo') ?? ''
  const json = async (url: string, authenticated = true): Promise<any> => {
    const signal = AbortSignal.timeout(15_000)
    const { response } = await safeFetch(url, { enabled: true, hosts: ['api.live.bilibili.com', 'api.bilibili.com'], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: 15_000 }, {
      signal, headers: { Referer: 'https://live.bilibili.com/', 'User-Agent': 'Mozilla/5.0', ...(authenticated && cookie ? { Cookie: cookie } : {}) },
    })
    const data = JSON.parse(await readPlatformText(response, signal))
    if (!response.ok || (data.code !== 0 && !(url.endsWith('/nav') && data.code === -101))) throw new Error('B 站弹幕接口暂不可用，请登录 B 站后重试。')
    return data.data
  }
  if (!/(?:^|;\s*)buvid3=/.test(cookie)) {
    const fingerprint = await json('https://api.bilibili.com/x/frontend/finger/spi', false)
    if (typeof fingerprint.b_3 !== 'string' || /[;\r\n]/.test(fingerprint.b_3)) throw new Error('无法获取 B 站访客标识。')
    cookie += `${cookie ? '; ' : ''}buvid3=${fingerprint.b_3}`
  }
  const identity = await json(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${room}`)
  const realRoom = String(identity.room_id)
  if (!/^[1-9]\d{0,11}$/.test(realRoom)) throw new Error('B 站房间号无效。')
  const nav = await json('https://api.bilibili.com/x/web-interface/nav', false)
  const keys = nav?.wbi_img
  const seed = [keys?.img_url, keys?.sub_url].map(url => typeof url === 'string' ? url.split('/').pop()!.split('.')[0] : '').join('')
  if (seed.length !== 64) throw new Error('无法获取 B 站弹幕签名。')
  const key = MIXIN.map(i => seed[i]).join('').slice(0, 32)
  const info = await json(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${signBilibili({ id: realRoom, type: '0', web_location: '444.8', wts: String(Math.floor(Date.now() / 1000)) }, key)}`)
  const host = info.host_list?.find((h: any) => typeof h.host === 'string' && /^[a-z0-9-]+\.chat\.bilibili\.com$/.test(h.host) && [443,2245].includes(h.wss_port))
  if (!host || typeof info.token !== 'string' || !info.token) throw new Error('无法获取 B 站弹幕服务器。')
  return { room: realRoom, token: info.token, endpoint: `wss://${host.host}:${host.wss_port}/sub`, uid: Number(/(?:^|;\s*)DedeUserID=(\d+)/.exec(cookie)?.[1] ?? 0), buvid: /(?:^|;\s*)buvid3=([^;]+)/.exec(cookie)![1]! }
}
export function bilibiliPacket(op: number, body: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(body)
  const packet = Buffer.alloc(16 + bytes.length)
  packet.writeUInt32BE(packet.length, 0); packet.writeUInt16BE(16, 4); packet.writeUInt16BE(1, 6)
  packet.writeUInt32BE(op, 8); packet.writeUInt32BE(1, 12); bytes.copy(packet, 16)
  return new Uint8Array(packet)
}
export function decodeBilibiliPackets(data: Uint8Array, visit: (op: number, body: Buffer) => void, depth = 0): void {
  if (depth > 4 || data.byteLength > 4 * 1024 * 1024) throw new Error('Invalid Bilibili packet')
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  for (let offset = 0; offset < buffer.length;) {
    if (buffer.length - offset < 16) throw new Error('Truncated packet')
    const length = buffer.readUInt32BE(offset), header = buffer.readUInt16BE(offset + 4), version = buffer.readUInt16BE(offset + 6)
    if (header < 16 || length < header || offset + length > buffer.length) throw new Error('Invalid packet length')
    const body = buffer.subarray(offset + header, offset + length)
    if (version === 2 || version === 3) decodeBilibiliPackets((version === 2 ? inflateSync : brotliDecompressSync)(body, { maxOutputLength: 4 * 1024 * 1024 }), visit, depth + 1)
    else visit(buffer.readUInt32BE(offset + 8), body)
    offset += length
  }
}
export class BilibiliDanmakuClient {
  private socket: WebSocketLike | null = null
  private generation = 0
  private stopped = false
  private retry: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private watchdog: ReturnType<typeof setTimeout> | undefined
  private attempts = 0
  private readonly seenSuperChats = new Set<string>()
  state: DanmakuState = 'idle'
  constructor(readonly room: string, private events: DanmakuClientEvents, private deps: BilibiliDeps = {}) {}
  private status(state: DanmakuState, detail?: string): void { this.state = state; this.events.onState(state, detail) }
  connect(): void {
    if (this.socket || this.state === 'connecting') return
    this.stopped = false
    const generation = ++this.generation
    this.status('connecting')
    this.watchdog = setTimeout(() => this.reconnect(), 30_000)
    void (this.deps.resolveRoom ?? (room => resolveBilibiliDanmaku(room, this.deps.cookieHeader)))(this.room).then(meta => {
      if (this.stopped || generation !== this.generation) return
      const socket = (this.deps.createSocket ?? (url => createNetworkSocket(url, 'bilibili')))(meta.endpoint)
      this.socket = socket; socket.binaryType = 'arraybuffer'
      const current = () => this.socket === socket && generation === this.generation && !this.stopped
      socket.addEventListener('open', () => {
        if (!current()) return
        try { socket.send(bilibiliPacket(7, JSON.stringify({ uid: meta.uid, roomid: Number(meta.room), protover: 3, platform: 'web', type: 2, key: meta.token, buvid: meta.buvid, support_ack: true, queue_uuid: randomUUID().slice(0, 8), scene: '' }))) } catch { this.reconnect() }
      })
      socket.addEventListener('message', (event: { data: unknown }) => {
        if (!current()) return
        try {
          const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : ArrayBuffer.isView(event.data) ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength) : null
          if (!data) return
          decodeBilibiliPackets(data, (op, body) => {
            if (!current()) return
            if (op === 8) {
              if (JSON.parse(body.toString()).code !== 0) { this.reconnect(); return }
              this.attempts = 0; this.status('connected'); this.alive()
              const beat = () => { try { socket.send(bilibiliPacket(2, '[object Object]')) } catch { this.reconnect() } }
              beat(); clearInterval(this.heartbeat); this.heartbeat = setInterval(beat, 30_000)
            } else if (op === 3) { this.alive(); if (body.length >= 4) this.events.onSignal?.({ platform: 'bilibili', kind: 'popularity', room: this.room, receivedAt: Date.now(), count: body.readUInt32BE(0) }) }
            else if (op === 5 && this.state === 'connected') {
              const message = JSON.parse(body.toString())
              const cmd = String(message.cmd).split(':')[0]
              const d = message.data
              if (cmd === 'WATCHED_CHANGE' || cmd === 'LIKE_INFO_V3_UPDATE') {
                const count = Number(cmd === 'WATCHED_CHANGE' ? d?.num : d?.click_count)
                if (Number.isSafeInteger(count) && count >= 0) this.events.onSignal?.({ platform: 'bilibili', kind: cmd === 'WATCHED_CHANGE' ? 'watched' : 'likes', room: this.room, receivedAt: Date.now(), count })
                return
              }
              if (cmd === 'SUPER_CHAT_MESSAGE') {
                const metadata = copyBilibiliMetadata({ bilibiliUid: String(d?.uid ?? ''), superChat: { id: String(d?.id ?? ''), price: d?.price, duration: d?.time, background: d?.background_bottom_color, color: d?.message_font_color } })
                if (!metadata.superChat || typeof d?.message !== 'string' || !d.message || this.seenSuperChats.has(metadata.superChat.id)) return
                if (this.seenSuperChats.size >= 512) this.seenSuperChats.delete(this.seenSuperChats.values().next().value!)
                this.seenSuperChats.add(metadata.superChat.id)
                const chat: ChatMessage = { ...metadata, id: `bilibili:${meta.room}:sc:${metadata.superChat.id}`, room: `bilibili:${meta.room}`, platform: 'bilibili', text: d.message.slice(0, 2000), username: String(d.user_info?.uname ?? d.uinfo?.base?.name ?? '匿名').slice(0, 128), color: 0xffffff, level: 0, receivedAt: (this.deps.now ?? Date.now)(), system: false }
                this.events.onObservedMessage?.(chat); this.events.onMessage(chat); return
              }
              if (cmd !== 'DANMU_MSG') return
              const info = message.info
              if (!Array.isArray(info) || typeof info[1] !== 'string' || !info[1]) return
              let extra: any = {}
              try { extra = JSON.parse(info[0]?.[15]?.extra ?? '{}') } catch { /* Older packets have no extra payload. */ }
              const emotes = Object.entries(extra.emots ?? {}).map(([text, value]) => ({ text, url: (value as any)?.url }))
              if (info[0]?.[13]?.url) emotes.push({ text: info[1], url: info[0][13].url })
              const metadata = copyBilibiliMetadata({ bilibiliUid: String(info[2]?.[0] ?? ''), emotes })
              const chat: ChatMessage = { ...metadata, id: `bilibili:${meta.room}:${extra.id_str || randomUUID()}`, room: `bilibili:${meta.room}`, platform: 'bilibili', text: info[1].slice(0, 2000), username: String(info[2]?.[1] ?? '匿名').slice(0, 128), color: Number.isInteger(info[0]?.[3]) ? info[0][3] : 0xffffff, level: Number(info[4]?.[0]) || 0, receivedAt: (this.deps.now ?? Date.now)(), system: false }
              this.events.onObservedMessage?.(chat); this.events.onMessage(chat)
            }
          })
        } catch { /* Ignore malformed remote packets. */ }
      })
      socket.addEventListener('close', () => { if (current()) this.reconnect() })
      socket.addEventListener('error', () => { if (current()) this.reconnect() })
    }).catch(() => { if (generation === this.generation && !this.stopped) this.reconnect() })
  }
  private alive(): void { clearTimeout(this.watchdog); this.watchdog = setTimeout(() => this.reconnect(), 75_000) }
  private teardown(): void {
    ++this.generation; clearTimeout(this.watchdog); clearTimeout(this.retry); clearInterval(this.heartbeat)
    const socket = this.socket; this.socket = null
    try { socket?.close() } catch { /* Already closed. */ }
  }
  private reconnect(): void {
    if (this.stopped) return
    this.teardown(); this.status('reconnecting', 'B 站弹幕连接失败，正在重试；可在设置中登录 B 站。')
    this.retry = setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)))
  }
  close(): void { this.stopped = true; this.teardown(); this.status('closed') }
}
