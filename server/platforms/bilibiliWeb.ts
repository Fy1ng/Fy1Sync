import { networkContext } from '../networkPolicy'
import { readPlatformText } from '../platformResponse'
import { safeFetch } from '../safeFetch'
import { bilibiliCount, bilibiliId, bilibiliRoomNumber } from '../../src/core/bilibiliMetadata'

export type BilibiliCookieHeader = (url: string) => Promise<string>
export type BilibiliRoomIdentity = { room: string; anchorUid?: string; live: boolean; liveStartedAt?: number }

export class BilibiliWebError extends Error {
  constructor(readonly code: 'login-required' | 'unavailable', message: string) {
    super(message)
  }
}

export function bilibiliObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
}

export async function fetchBilibiliWebData(url: string, options: {
  cookieHeader?: BilibiliCookieHeader
  signal?: AbortSignal
  allowAnonymousNav?: boolean
} = {}): Promise<Record<string, unknown>> {
  const hosts = ['api.live.bilibili.com', 'api.bilibili.com']
  const target = new URL(url)
  if (target.protocol !== 'https:' || !hosts.includes(target.hostname)
    || target.username || target.password || target.port || target.hash) {
    throw new BilibiliWebError('unavailable', 'B 站接口地址无效.')
  }
  const timeout = AbortSignal.timeout(15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  signal.throwIfAborted()
  const cookie = await options.cookieHeader?.(target.href)
  signal.throwIfAborted()
  const { response } = await safeFetch(target.href, {
    enabled: true, hosts, allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: 15_000,
  }, {
    signal, network: networkContext('bilibili'),
    headers: { Referer: 'https://live.bilibili.com/', 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) },
  })
  const payload = bilibiliObject(JSON.parse(await readPlatformText(response, signal)))
  if (response.ok && (payload.code === 0 || (options.allowAnonymousNav && payload.code === -101))) {
    return bilibiliObject(payload.data)
  }
  if (payload.code === -101) throw new BilibiliWebError('login-required', '请先登录 B 站.')
  throw new BilibiliWebError('unavailable', 'B 站接口暂不可用.')
}

export async function readBilibiliRoomIdentity(room: string, signal?: AbortSignal): Promise<BilibiliRoomIdentity> {
  if (!bilibiliRoomNumber(room)) throw new BilibiliWebError('unavailable', 'B 站房间号无效.')
  const data = await fetchBilibiliWebData(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${room}`, { signal })
  const canonical = bilibiliRoomNumber(data.room_id)
  if (!canonical || (canonical !== room && bilibiliRoomNumber(data.short_id) !== room) || bilibiliCount(data.live_status, 2) === undefined) {
    throw new BilibiliWebError('unavailable', 'B 站未返回可核对的房间.')
  }
  const live = data.live_status === 1
  const start = bilibiliCount(data.live_time, 9_999_999_999)
  return { room: canonical, anchorUid: bilibiliId(data.uid), live, liveStartedAt: live && start ? start * 1000 : undefined }
}
