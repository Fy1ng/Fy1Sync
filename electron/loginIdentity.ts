import type { EmbeddedLoginPlatform } from './embeddedLoginContracts'
import { DOUYIN_LOGIN_IDENTITY_URL, parseDouyinLoginIdentity } from './douyinLoginIdentity'

export interface LoginIdentity {
  status: 'authenticated' | 'anonymous' | 'unknown'
  uid?: string
  nickname?: string
}

const urls: Record<EmbeddedLoginPlatform, string> = {
  douyin: DOUYIN_LOGIN_IDENTITY_URL,
  douyu: 'https://www.douyu.com/lapi/member/api/getInfo?client_type=0',
  bilibili: 'https://api.bilibili.com/x/web-interface/nav',
  huya: 'https://l.huya.com/udb_web/udbport2.php?m=HuyaLogin&do=checkLogin',
}

export function loginIdentityUrl(platform: EmbeddedLoginPlatform): string {
  return urls[platform]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function positiveUid(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : undefined
}

function zeroUid(value: unknown): boolean {
  return value === 0 || value === '0'
}

function nickname(value: unknown): { nickname?: string } {
  if (typeof value !== 'string' || value.length > 512) return {}
  const result = value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80)
  return result ? { nickname: result } : {}
}

/** Only explicit official success and a bounded positive identity can complete login. */
export function parseLoginIdentity(platform: EmbeddedLoginPlatform, payload: unknown): LoginIdentity {
  if (platform === 'douyin') {
    const identity = parseDouyinLoginIdentity(payload)
    if (identity.status !== 'authenticated') return { status: identity.status }
    if (!positiveUid(identity.uid)) return { status: 'unknown' }
    return { status: 'authenticated', uid: identity.uid, ...nickname(identity.nickname) }
  }
  const body = record(payload)
  if (!body) return { status: 'unknown' }
  if (platform === 'bilibili') {
    const data = record(body.data)
    if (!data) return { status: 'unknown' }
    if (body.code === -101 && data.isLogin === false && (data.mid === undefined || zeroUid(data.mid))) return { status: 'anonymous' }
    const uid = positiveUid(data.mid)
    if (body.code !== 0 || data.isLogin !== true || !uid) return { status: 'unknown' }
    return { status: 'authenticated', uid, ...nickname(data.uname) }
  }
  if (platform === 'huya') {
    // The official consumer uses this flag directly. Accept only defined boolean/0/1 encodings.
    const authenticated = body.isLogined === true || body.isLogined === 1 || body.isLogined === '1'
    const anonymous = body.isLogined === false || body.isLogined === 0 || body.isLogined === '0'
    if (anonymous && zeroUid(body.uid)) return { status: 'anonymous' }
    const uid = positiveUid(body.uid)
    if (!authenticated || !uid) return { status: 'unknown' }
    return { status: 'authenticated', uid, ...nickname(body.userNick) }
  }
  const msg = record(body.msg)
  if (!msg) return { status: 'unknown' }
  if (body.error === 1 && zeroUid(msg.uid) && msg.info === 0) return { status: 'anonymous' }
  const uid = positiveUid(msg.uid)
  if (body.error !== 0 || !uid) return { status: 'unknown' }
  // error/uid establish the server identity. Optional profile data is not an authentication flag.
  const info = record(msg.info)
  if (!info && msg.info !== undefined && msg.info !== null && msg.info !== 0) return { status: 'unknown' }
  if (info?.uid !== undefined && positiveUid(info.uid) !== uid) return { status: 'unknown' }
  return { status: 'authenticated', uid, ...nickname(info?.nickname) }
}
