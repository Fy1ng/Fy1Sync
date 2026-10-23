/** Anonymous, bounded identity lookup. Only static JSON is read; scripts never run. */
import { hostAllowed, type ProxyConfig } from '../config'
import { safeFetch, type Resolver } from '../safeFetch'
import type { ResolveFailure } from './types'

export type DouyuRoomIdentity = { room: string; inputRoom: string }
export type DouyuRoomResult = { ok: true; identity: DouyuRoomIdentity } | { ok: false; failure: ResolveFailure }
export type ResolveDouyuRoom = (input: string) => Promise<DouyuRoomResult>
const MAX_PAGE_BYTES = 1_048_576

export function validDouyuRoom(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 && value <= 999_999_999_999 ? String(value) : null
  return typeof value === 'string' && /^[1-9][0-9]{0,11}$/.test(value) ? value : null
}

export function parseDouyuRoom(input: string): string | null {
  const trimmed = input.trim()
  if (validDouyuRoom(trimmed)) return trimmed
  let url: URL
  try { url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`) } catch { return null }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !/(^|\.)douyu\.com$/i.test(url.hostname)) return null
  const rid = url.searchParams.get('rid')
  if (rid !== null) return validDouyuRoom(rid)
  return url.pathname.split('/').filter(Boolean).reverse().map(validDouyuRoom).find(Boolean) ?? null
}

function fail(code: ResolveFailure['code'], message: string): DouyuRoomResult {
  return { ok: false, failure: { code, message, hint: '请检查斗鱼数字房间号和网络后重试. 身份确认成功后可独立连接弹幕.' } }
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** The input route and vipId are aliases. Only the roomInfo.rid is authoritative. */
export function parseDouyuRoomPage(page: string, inputRoom: string): DouyuRoomResult {
  if (Buffer.byteLength(page) > MAX_PAGE_BYTES) return fail('upstream-error', '斗鱼房间身份响应超过上限.')
  const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => {
      const attributes = [...match[1]!.matchAll(/(?:^|\s)([\w:-]+)\s*=\s*(["'])(.*?)\2/g)]
      const value = (name: string) => {
        const found = attributes.filter(attribute => attribute[1]!.toLowerCase() === name)
        return found.length === 1 ? found[0]![3] : null
      }
      return value('id') === 'vike_pageContext' && value('type')?.toLowerCase() === 'application/json'
    })
  if (scripts.length !== 1) return fail('upstream-error', '斗鱼房间身份暂时无法确认, 请重试.')
  try {
    const root = object(JSON.parse(scripts[0]![2]!, (key: string, value: unknown, context?: { source?: string }) => {
      if (key === 'rid' && typeof value === 'number' && context?.source && !/^[1-9][0-9]{0,11}$/.test(context.source)) throw new Error('Invalid numeric identity')
      return value
    }))
    const room = object(object(object(object(root?.pageProps)?.room)?.roomInfo)?.roomInfo)
    if (!room) return fail('upstream-error', '斗鱼房间身份数据无效.')
    if (Object.keys(room).length === 0) return fail('room-not-found', '斗鱼房间不存在.')
    const id = validDouyuRoom(room.rid)
    if (!id) return fail('upstream-error', '斗鱼返回了无效的真实房间号.')
    return { ok: true, identity: { room: id, inputRoom } }
  } catch { return fail('upstream-error', '斗鱼房间身份数据无法读取.') }
}

export class DouyuRoomResolver {
  private readonly cache = new Map<string, { room: string; expires: number }>()
  private readonly pending = new Map<string, Promise<DouyuRoomResult>>()
  constructor(private readonly fetchPage: (room: string) => Promise<string>, private readonly options: { now?: () => number; ttlMs?: number; capacity?: number } = {}) {}
  readonly resolve: ResolveDouyuRoom = async input => {
    const id = parseDouyuRoom(input)
    if (!id) return fail('unsupported-url', '无法识别斗鱼数字房间号.')
    const now = (this.options.now ?? Date.now)()
    const cached = this.cache.get(id)
    if (cached && cached.expires > now) return { ok: true, identity: { room: cached.room, inputRoom: id } }
    this.cache.delete(id)
    const existing = this.pending.get(id)
    if (existing) return existing
    const capacity = this.options.capacity ?? 128
    if (this.pending.size >= capacity) return fail('upstream-error', '房间身份查询繁忙, 请稍后重试.')
    const lookup = (async (): Promise<DouyuRoomResult> => {
      try {
        const result = parseDouyuRoomPage(await this.fetchPage(id), id)
        if (result.ok) {
          while (this.cache.size >= capacity) this.cache.delete(this.cache.keys().next().value!)
          this.cache.set(id, { room: result.identity.room, expires: (this.options.now ?? Date.now)() + (this.options.ttlMs ?? 60_000) })
        }
        return result
      } catch { return fail('upstream-error', '请求斗鱼房间身份失败, 请检查网络后重试.') }
    })()
    this.pending.set(id, lookup)
    try { return await lookup } finally { if (this.pending.get(id) === lookup) this.pending.delete(id) }
  }
}

export function createDouyuRoomResolver(proxy: ProxyConfig, fetchImpl?: typeof fetch, dns?: Resolver): DouyuRoomResolver {
  return new DouyuRoomResolver(async room => {
    if (!proxy.enabled || !hostAllowed('m.douyu.com', proxy.hosts)) throw new Error('Remote metadata disabled')
    const signal = AbortSignal.timeout(Math.min(proxy.requestTimeoutMs, 15_000))
    const { response } = await safeFetch(`https://m.douyu.com/${room}`, {
      ...proxy, hosts: ['m.douyu.com'], maxRedirects: 0, allowNonLoopbackTargets: false, allowNonStandardPorts: false,
    }, { signal, fetchImpl, resolve: dns, headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.douyu.com/' } })
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Metadata unavailable') }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_PAGE_BYTES) throw new Error('Metadata exceeds limit')
        chunks.push(chunk.value)
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  })
}
