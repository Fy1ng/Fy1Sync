/** Main-only receive session. Login credentials stay on exact live.douyin.com HTTP paths. */
import { parseDouyinPage } from './douyinPage'
import type { ResolverDeps } from './types'
import { decodeDouyinResponse, MAX_DOUYIN_FRAME } from '../danmaku/douyinProtocol'
import { DouyinSigner } from '../danmaku/douyinSigner'

export const DOUYIN_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ORIGIN = 'https://live.douyin.com'
const invalid = () => new Error('无法读取抖音弹幕连接信息.')
const validId = (input: string): boolean => /^[1-9]\d{0,19}$/.test(input) && BigInt(input) <= 0xffff_ffff_ffff_ffffn
const cleanHeader = (input: unknown, max = 32_768): string => typeof input === 'string' && input.length <= max && !/[\x00-\x1f\x7f]/.test(input) ? input : ''

export interface DouyinDanmakuRoom {
  webRoom: string; roomId: string; userUniqueId: string
  /** Only a freshly acquired anonymous ttwid, never the full logged-in HTTP cookie header. */
  cookie: string
  userAgent: string; cursor: string; internalExt: string; pushServer: string; heartbeatMs: number
}
export type DouyinDanmakuResolverDeps = Pick<ResolverDeps, 'fetchPage' | 'fetchBytes' | 'fetchJson' | 'now'> & {
  cookieHeader?: (requestUrl: string) => Promise<string>
}

/** Dynamic upstream endpoints remain within the observed official websocket host family. */
export function validateDouyinPushServer(raw: string): string {
  if (!raw || raw.length > 512 || /[\x00-\x20\x7f]/.test(raw)) throw invalid()
  const value = raw.startsWith('https://') ? raw.replace(/^https:/, 'wss:') : raw.includes('://') ? raw : `wss://${raw}`
  let url: URL
  try { url = new URL(value) } catch { throw invalid() }
  if (url.pathname === '/') url.pathname = '/webcast/im/push/v2/'
  if (url.protocol !== 'wss:' || !/^webcast[1-9][0-9]{0,2}-ws-web-(?:lf|hl|lq)\.douyin\.com$/.test(url.hostname)
    || url.username || url.password || url.port || url.hash || url.search || url.pathname !== '/webcast/im/push/v2/') throw invalid()
  return url.href
}

function anonymousCookie(setCookie: string[]): string {
  for (const raw of setCookie) {
    const first = raw.split(';', 1)[0]!
    if (/^ttwid=[^;\x00-\x20\x7f]{1,4096}$/.test(first)) return first
  }
  return ''
}
function httpCookie(loggedIn: string, anonymous: string): string {
  if (!loggedIn) return anonymous
  const parts = loggedIn.split(';').map(value => value.trim()).filter(value => value && !value.startsWith('ttwid='))
  if (anonymous) parts.push(anonymous)
  const result = parts.join('; ')
  if (!cleanHeader(result)) throw invalid()
  return result
}

export async function resolveDouyinDanmakuRoom(webRoom: string, deps: DouyinDanmakuResolverDeps): Promise<DouyinDanmakuRoom> {
  if (!validId(webRoom) || !deps.fetchPage || !deps.fetchBytes) throw invalid()
  const requestCookie = async (url: string) => {
    const raw = await deps.cookieHeader?.(url) ?? ''
    const value = cleanHeader(raw)
    if (raw && !value) throw invalid()
    return value
  }
  const pageUrl = `${ORIGIN}/${webRoom}`
  const loggedIn = await requestCookie(pageUrl)
  const baseHeaders: Record<string, string> = { 'User-Agent': DOUYIN_USER_AGENT, Referer: `${ORIGIN}/` }
  const page = await deps.fetchPage(pageUrl, { headers: { ...baseHeaders, ...(loggedIn ? { Cookie: loggedIn } : {}) } })
  if (page.finalUrl !== `${ORIGIN}/${webRoom}` && page.finalUrl !== `${ORIGIN}/${webRoom}/`) throw invalid()
  const room = parseDouyinPage(page.text, webRoom)
  if (!room || room.webRoom !== webRoom || !room.roomId || !validId(room.roomId)) throw invalid()
  if (room.status !== 2 && room.status !== '2') throw new Error('抖音直播间当前未开播.')
  // The page repeats its anonymous request identity. Conflicting identities are rejected.
  const ids = new Set([...page.text.matchAll(/\buser_unique_id\\?":\s*\\?"([1-9]\d{0,19})\\?"/g)].map(match => match[1]!))
  if (ids.size !== 1) throw invalid()
  const userUniqueId = [...ids][0]!
  if (!validId(userUniqueId)) throw invalid()
  let cookie = anonymousCookie(page.setCookie)
  if (!cookie) {
    const registration = await deps.fetchPage('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST', headers: { 'User-Agent': DOUYIN_USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'cn', aid: 6383, needFid: false, service: 'www.douyin.com', migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true }),
    })
    if (registration.finalUrl !== 'https://ttwid.bytedance.com/ttwid/union/register/') throw invalid()
    cookie = anonymousCookie(registration.setCookie)
  }
  if (!cookie) throw invalid()
  const params = new URLSearchParams({ resp_content_type: 'protobuf', did_rule: '3', device_id: '', app_name: 'douyin_web', endpoint: 'live_pc', support_wrds: '1', user_unique_id: userUniqueId,
    identity: 'audience', need_persist_msg_count: '15', insert_task_id: '', live_reason: '', room_id: room.roomId, version_code: '180800', last_rtt: '0', live_id: '1', aid: '6383', fetch_rule: '1', cursor: '', internal_ext: '',
    device_platform: 'web', cookie_enabled: 'true', screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Mozilla', browser_version: DOUYIN_USER_AGENT.slice(8),
    browser_online: 'true', tz_name: 'Asia/Shanghai', msToken: '' })
  const apiUrl = `${ORIGIN}/webcast/im/fetch/?${params}`
  const bytes = await deps.fetchBytes(apiUrl, { headers: { ...baseHeaders, Cookie: httpCookie(await requestCookie(apiUrl), cookie) } })
  if (!bytes.length || bytes.length > MAX_DOUYIN_FRAME) throw invalid()
  const response = decodeDouyinResponse(bytes)
  if (!response.cursor || !response.internalExt || !response.pushServer) throw invalid()
  return { webRoom, roomId: room.roomId, userUniqueId, cookie, userAgent: DOUYIN_USER_AGENT,
    cursor: response.cursor, internalExt: response.internalExt, pushServer: validateDouyinPushServer(response.pushServer), heartbeatMs: response.heartbeatMs }
}

export function createDouyinDanmakuResolver(deps: DouyinDanmakuResolverDeps): (webRoom: string) => Promise<DouyinDanmakuRoom> {
  return webRoom => resolveDouyinDanmakuRoom(webRoom, deps)
}

/** Build one ephemeral signed URL. It must never cross IPC or enter logs. */
export function douyinWebSocketRequest(room: DouyinDanmakuRoom, signer = new DouyinSigner()): { url: string; headers: Record<string, string> } {
  if (!validId(room.webRoom) || !validId(room.roomId) || !validId(room.userUniqueId) || room.userAgent !== DOUYIN_USER_AGENT
    || !/^ttwid=[^;\x00-\x20\x7f]{1,4096}$/.test(room.cookie) || !cleanHeader(room.cursor, 8192) || !cleanHeader(room.internalExt, 8192)
    || !Number.isFinite(room.heartbeatMs) || room.heartbeatMs < 10_000 || room.heartbeatMs > 60_000) throw invalid()
  const url = new URL(validateDouyinPushServer(room.pushServer))
  url.search = new URLSearchParams({ app_name: 'douyin_web', version_code: '180800', webcast_sdk_version: '1.0.15', update_version_code: '1.0.15', compress: 'gzip', device_platform: 'web', cookie_enabled: 'true', screen_width: '1920', screen_height: '1080',
    browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Mozilla', browser_version: room.userAgent.slice(8), browser_online: 'true', tz_name: 'Asia/Shanghai', cursor: room.cursor, internal_ext: room.internalExt,
    host: ORIGIN, aid: '6383', live_id: '1', did_rule: '3', endpoint: 'live_pc', support_wrds: '1', user_unique_id: room.userUniqueId, im_path: '/webcast/im/fetch/', identity: 'audience', need_persist_msg_count: '15',
    insert_task_id: '', live_reason: '', room_id: room.roomId, heartbeatDuration: '0', signature: signer.sign(room.roomId, room.userUniqueId) }).toString()
  return { url: url.href, headers: { 'User-Agent': room.userAgent, Origin: ORIGIN, Referer: `${ORIGIN}/`, Cookie: room.cookie } }
}
