import type { BilibiliLotterySnapshot } from '../../src/core/bilibiliLottery'
import type { ProxyConfig } from '../config'
import type { NetworkContext } from '../networkPolicy'
import { safeFetch, type SafeFetchOptions } from '../safeFetch'

const API = 'https://api.live.bilibili.com'
const LIMIT = 128 * 1024
const TIMEOUT = 8_000
const numericRoom = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,11}$/.test(value)
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | null => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null
const text = (value: unknown, limit = 500): string => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : ''
const exactCommand = (value: unknown): string | null => typeof value === 'string' && value.length > 0
  && value.length <= 500 && !/[\x00-\x1f\x7f]/.test(value) ? value : null

export function bilibiliLotteryRoom(input: unknown): string | null {
  if (numericRoom(input)) return input
  if (typeof input !== 'string' || input.length > 2048) return null
  const prefixed = /^(?:b|bili|bilibili|b站|哔哩哔哩)\s*[:：]?\s*([1-9][0-9]{0,11})$/i.exec(input.trim())
  if (prefixed) return prefixed[1]!
  try {
    const url = new URL(input.startsWith('live.bilibili.com/') ? `https://${input}` : input)
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'live.bilibili.com'
      || url.port || url.username || url.password || !/^\/[1-9][0-9]{0,11}\/?$/.test(url.pathname)) return null
    return url.pathname.replace(/\//g, '')
  } catch { return null }
}

export function bilibiliLotteryOfficialUrl(room: string): string {
  if (!numericRoom(room)) throw new Error('B站房间号无效.')
  return `https://live.bilibili.com/${room}`
}

export function bilibiliLotteryEmpty(room: string | null, checkedAt: number,
  phase: BilibiliLotterySnapshot['phase'] = 'empty'): BilibiliLotterySnapshot {
  return { room, phase, activity: null, serverNow: null, observedFrom: null, endsAt: null, checkedAt,
    clockSource: null, clockUncertaintyMs: null, reminder: false }
}

export function parseBilibiliLottery(raw: unknown, room: string, checkedAt: number,
  httpDate?: string | null, elapsedMs = 0): BilibiliLotterySnapshot {
  const envelope = object(raw)
  if (!numericRoom(room) || !Number.isFinite(checkedAt) || !envelope || typeof envelope.code !== 'number') return bilibiliLotteryEmpty(room, checkedAt, 'unverified')
  if (envelope.code === -101) return bilibiliLotteryEmpty(room, checkedAt, 'login-required')
  if ([-352, -412, 412, 429].includes(envelope.code)) return bilibiliLotteryEmpty(room, checkedAt, 'restricted')
  if (envelope.code !== 0) return bilibiliLotteryEmpty(room, checkedAt, 'unavailable')
  if (envelope.data === null) return bilibiliLotteryEmpty(room, checkedAt)
  const data = object(envelope.data)
  if (!data || integer(data.id) === null || !data.id || typeof data.award_name !== 'string'
    || !data.award_name.trim() || integer(data.join_type) === null || integer(data.require_type) === null
    || (data.room_id !== undefined && String(data.room_id) !== room)) return bilibiliLotteryEmpty(room, checkedAt, 'unverified')
  const stamp = data.current_timestamp ?? data.current_time
  const timestamp = typeof stamp === 'number' && Number.isFinite(stamp) ? stamp * 1000 : NaN
  const fromHeader = httpDate ? Date.parse(httpDate) : NaN
  const validTime = (value: number) => Number.isFinite(value) && value >= Date.UTC(2020, 0, 1) && value <= Date.UTC(2100, 0, 1)
  const clockSource = validTime(timestamp) ? 'payload' : validTime(fromHeader) ? 'http-date' : null
  const reference = clockSource === 'payload' ? timestamp : clockSource === 'http-date' ? fromHeader : null
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= TIMEOUT ? elapsedMs : null
  const time = integer(data.time, 86_400)
  const serverNow = reference === null || elapsed === null ? null : reference + elapsed / 2
  const endsAt = reference !== null && time !== null ? reference + time * 1000 : null
  const clockUncertaintyMs = serverNow === null || elapsed === null ? null : 1000 + elapsed / 2
  let phase: BilibiliLotterySnapshot['phase'] = data.lot_status === 0 ? 'ongoing' : data.lot_status === 1 ? 'settling'
    : data.lot_status === 2 ? 'ended' : 'unverified'
  if (phase === 'ongoing' && serverNow !== null && endsAt !== null && endsAt <= serverNow) phase = 'ended'
  const candidates = [data.danmu, ...(Array.isArray(data.danmu_new) ? data.danmu_new.slice(0, 32).map(item => object(item)?.danmu) : [])]
  const messages = [...new Set(candidates.map(exactCommand).filter((value): value is string => value !== null))]
  return { room, checkedAt, phase, serverNow, observedFrom: reference, endsAt, clockSource, clockUncertaintyMs, reminder: false, activity: {
    id: String(data.id), prize: text(data.award_name), prizeCount: integer(data.award_num, 1_000_000),
    joinType: data.join_type as number, requireType: data.require_type as number, requireValue: integer(data.require_value),
    requireText: text(data.require_text), joinText: text(data.join_type_text), messages,
    giftName: text(data.gift_name, 120), giftCount: integer(data.gift_num), giftPrice: integer(data.gift_price),
    joined: data.status === 2 ? true : data.status === 1 ? false : null,
  } }
}

export interface BilibiliLotteryGatewayDeps {
  proxy: ProxyConfig
  network?: () => NetworkContext
  cookieHeader: (url: string) => Promise<string>
  now?: () => number
  request?: typeof safeFetch
  resolve?: SafeFetchOptions['resolve']
}

export class BilibiliLotteryGateway {
  private readonly now: () => number
  private readonly identities = new Map<string, { room: string; expires: number }>()
  constructor(private readonly deps: BilibiliLotteryGatewayDeps) { this.now = deps.now ?? Date.now }

  private async get(url: string, signal: AbortSignal, authenticated: boolean) {
    const active = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)])
    active.throwIfAborted()
    const cookie = authenticated ? await this.deps.cookieHeader(url) : ''
    active.throwIfAborted()
    const started = this.now()
    const { response } = await (this.deps.request ?? safeFetch)(url, { ...this.deps.proxy, maxRedirects: 0, requestTimeoutMs: TIMEOUT }, {
      method: 'GET', signal: active, network: this.deps.network?.(), resolve: this.deps.resolve,
      headers: { Referer: 'https://live.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) },
    })
    if (response.status === 412 || response.status === 429) { await response.body?.cancel(); return { raw: { code: -352 }, date: null, elapsed: 0 } }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('B站活动读取失败.') }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    const abort = () => { void reader.cancel().catch(() => {}) }
    active.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        active.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > LIMIT) throw new Error('B站活动响应超过大小限制.')
        chunks.push(next.value)
      }
      active.throwIfAborted()
      return { raw: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, date: response.headers.get('date'), elapsed: this.now() - started }
    } finally { active.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
  }

  async read(input: string, signal: AbortSignal): Promise<BilibiliLotterySnapshot> {
    signal.throwIfAborted()
    const room = bilibiliLotteryRoom(input)
    if (!room) return bilibiliLotteryEmpty(null, this.now(), 'unverified')
    let canonical: string | null = null
    try {
      const cached = this.identities.get(room)
      if (cached && cached.expires > this.now()) canonical = cached.room
      else {
        const { raw } = await this.get(`${API}/room/v1/Room/room_init?id=${room}`, signal, false)
        const envelope = object(raw), data = object(envelope?.data)
        if (envelope?.code === -101 || envelope?.code === -352) return parseBilibiliLottery(raw, room, this.now())
        const id = integer(data?.room_id)
        if (envelope?.code !== 0 || id === null || !numericRoom(String(id))) return bilibiliLotteryEmpty(null, this.now(), 'unverified')
        canonical = String(id)
        if (this.identities.size >= 128) this.identities.delete(this.identities.keys().next().value!)
        this.identities.set(room, { room: canonical, expires: this.now() + 300_000 })
      }
      const result = await this.get(`${API}/xlive/lottery-interface/v1/Anchor/Check?roomid=${canonical}`, signal, true)
      signal.throwIfAborted()
      return parseBilibiliLottery(result.raw, canonical, this.now(), result.date, result.elapsed)
    } catch {
      signal.throwIfAborted()
      return bilibiliLotteryEmpty(canonical, this.now(), 'unavailable')
    }
  }
}
