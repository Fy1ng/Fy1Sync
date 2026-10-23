/** Douyu's PC player seed + iterated MD5 flow. No remote JavaScript is executed. */

import { createHash } from 'node:crypto'
import { failure, MANUAL_URL_HINT, type QualityOption, type ResolveResult, type ResolverDeps } from './types'

const REFERER = 'https://www.douyu.com/'
const ENCRYPTION_API = 'https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption'
const PLAY_API = 'https://www.douyu.com/lapi/live/getH5PlayV1'
const ANONYMOUS_DID = '10000000000000000000000000001501'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

export { parseDouyuRoom } from './douyuRoom'
import { parseDouyuRoom } from './douyuRoom'

export type DouyuEncryption = {
  rand_str: string
  key: string
  enc_time: number
  is_special: number
  enc_data: string
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function encryptionData(value: unknown): DouyuEncryption | null {
  const data = record(value)
  if (typeof data.rand_str !== 'string' || data.rand_str.length > 4096 || typeof data.key !== 'string' || data.key.length > 4096) return null
  if (!Number.isInteger(data.enc_time) || Number(data.enc_time) < 0 || Number(data.enc_time) > 10_000) return null
  if (typeof data.enc_data !== 'string' || !data.enc_data || data.enc_data.length > 65_536) return null
  if (data.is_special !== 0 && data.is_special !== 1) return null
  return data as DouyuEncryption
}

const md5 = (input: string): string => createHash('md5').update(input).digest('hex')

export function buildDouyuAuth(room: string, timestamp: number, encryption: DouyuEncryption): string {
  let seed = encryption.rand_str
  for (let index = 0; index < encryption.enc_time; index += 1) seed = md5(seed + encryption.key)
  return md5(seed + encryption.key + (encryption.is_special === 1 ? '' : `${room}${timestamp}`))
}

/** Labels describe the API's advertised rates, not measured resolution or frame rate. */
export function parseDouyuQualities(value: unknown): QualityOption[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  return value.slice(0, 100).flatMap((raw): QualityOption[] => {
    const item = record(raw)
    const rate = item.rate
    if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0 || rate > 9999 || seen.has(rate)) return []
    seen.add(rate)
    const name = typeof item.name === 'string' ? item.name.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 80).trim() : ''
    return [{ id: String(rate), label: name || (rate === 0 ? '原画' : `画质 ${rate}`) }]
  })
}

function playFailure(payload: Record<string, unknown>, roomHint: string): ResolveResult {
  const code = payload.error
  const message = typeof payload.msg === 'string' ? payload.msg : ''
  if (code === 101 || /房间不存在|不存在的房间|room.*not.*found/i.test(message)) {
    return failure('room-not-found', '斗鱼房间不存在.', roomHint)
  }
  if (code === 102 || code === -3 || /未开播|未直播|已下播|直播已结束|not.live|offline/i.test(message)) {
    return failure('not-live', '斗鱼房间当前未开播.', roomHint)
  }
  if (code === 403 || code === -5 || /登录|权限|付费|限制|封禁|密码|验证|login|forbidden|restricted/i.test(message)) {
    return failure('restricted', '斗鱼房间或所选画质需要登录, 或受到访问限制.', roomHint)
  }
  return failure('upstream-error', '斗鱼未返回有效的播放信息.', roomHint)
}

export async function resolveDouyu(input: string, deps: ResolverDeps): Promise<ResolveResult> {
  const inputRoom = parseDouyuRoom(input)
  if (!inputRoom) return failure('unsupported-url', '无法从输入中识别斗鱼房间号.', '支持 douyu.com/房间号 或数字房间号. 个性域名请先在浏览器中复制数字房间号.')
  let roomHint = `${MANUAL_URL_HINT} 弹幕可在房间身份确认后单独连接.`
  const requestedRate = deps.quality ?? '0'
  if (!/^\d{1,4}$/.test(requestedRate)) return failure('unsupported-url', '斗鱼画质编号无效.', roomHint)
  const cookie = deps.douyuCookie ?? ''
  if (/[\r\n\x00]/.test(cookie)) return failure('restricted', '斗鱼登录信息无效, 请重新登录.', roomHint)
  if (!deps.douyuRoomIdentity && !deps.resolveDouyuRoom) return failure('upstream-error', '斗鱼房间身份查询暂不可用, 请重新加载.', roomHint)
  const identity = deps.douyuRoomIdentity ? { ok: true as const, identity: deps.douyuRoomIdentity }
    : await deps.resolveDouyuRoom!(input)
  if (!identity.ok) return identity
  const room = identity.identity.room
  roomHint = `${MANUAL_URL_HINT} 弹幕仍可使用真实房间号 ${room} 单独连接.`
  const did = cookie.match(/(?:^|;\s*)dy_did=([a-f0-9]{32})(?:;|$)/i)?.[1] ?? ANONYMOUS_DID
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Referer: REFERER, ...(cookie ? { Cookie: cookie } : {}) }
  let encryption: DouyuEncryption
  try {
    const seed = record(await deps.fetchJson(`${ENCRYPTION_API}?did=${did}`, { headers }))
    const parsed = encryptionData(seed.data)
    if (seed.error !== 0 || !parsed) return failure('upstream-error', '斗鱼签名参数暂时不可用.', roomHint)
    encryption = parsed
  } catch {
    return failure('upstream-error', '请求斗鱼签名参数失败.', roomHint)
  }
  // Generate tt immediately before each play request. The auth must use that same tt.
  const timestamp = Math.round((deps.now ?? Date.now)() / 1000)
  const body = new URLSearchParams({
    enc_data: encryption.enc_data, tt: String(timestamp), did,
    auth: buildDouyuAuth(room, timestamp, encryption),
    cdn: '', rate: requestedRate, hevc: '0', fa: '0', ive: '0',
  })
  let payload: Record<string, unknown>
  try {
    payload = record(await deps.fetchJson(`${PLAY_API}/${room}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    }))
  } catch {
    // The upstream error may contain the request Cookie header or a signed media URL.
    return failure('upstream-error', '请求斗鱼播放地址失败.', roomHint)
  }
  if (payload.error !== 0) return playFailure(payload, roomHint)
  const data = record(payload.data)
  if (data.room_status === '2' || data.live_status === 0) return failure('not-live', '斗鱼房间当前未开播.', roomHint)
  const base = typeof data.rtmp_url === 'string' ? data.rtmp_url.trim() : ''
  const live = typeof data.rtmp_live === 'string' ? data.rtmp_live.trim() : ''
  let url: URL
  try {
    if (!base || !live) throw new Error('missing URL')
    url = new URL(`${base.replace(/\/$/, '')}/${live.replace(/^\//, '')}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid URL')
  } catch { return failure('needs-manual-url', '斗鱼未返回可用的 HTTP 直播地址.', roomHint) }
  const qualities = parseDouyuQualities(data.multirates)
  const returnedRate = typeof data.rate === 'number' && Number.isInteger(data.rate) ? String(data.rate) : requestedRate
  const notes = ['直播地址带时效签名, 断流后将重新解析. 画质标签由斗鱼提供.']
  if (inputRoom !== room) notes.push(`房间 ${inputRoom} 已解析为真实房间号 ${room}.`)
  if (returnedRate !== requestedRate) notes.push('斗鱼返回了较低或不同的画质档位. 原画可能需要登录后重试.')
  return { ok: true, stream: {
    platform: 'douyu', url: deps.proxify(url.toString()), kind: /\.m3u8?$/i.test(url.pathname) ? 'hls' : 'progressive',
    label: `斗鱼 ${room}`, channel: room, sourceRoom: room, requiresProxy: true, danmakuRoom: room,
    headers: { Referer: REFERER, 'User-Agent': USER_AGENT }, qualities, quality: returnedRate, notes,
  } }
}
