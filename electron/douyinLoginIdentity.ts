/** Current-user endpoint consumed by the official live site's user store.
 * Observed source: client-entry~1.221bb38d.js on lf-webcast-platform.bytetos.com.
 * The SDK accepts status_code=0 and reads data.data.id_str / nickname. Its anonymous
 * response is status_code=20003. Callers must separately require valid auth cookies.
 */
export const DOUYIN_LOGIN_IDENTITY_URL = 'https://live.douyin.com/webcast/user/me/?aid=6383&app_name=douyin_web&device_platform=web&room_id=0'
export interface DouyinLoginIdentity { status: 'authenticated' | 'anonymous' | 'unknown'; uid?: string; nickname?: string }

export function parseDouyinLoginIdentity(payload: unknown): DouyinLoginIdentity {
  const unknown: DouyinLoginIdentity = { status: 'unknown' }
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unknown
    const root = payload as Record<string, unknown>
    if (root.status_code === 20003) return { status: 'anonymous' }
    if (root.status_code !== 0 || !root.data || typeof root.data !== 'object' || Array.isArray(root.data)) return unknown
    const user = root.data as Record<string, unknown>
    // A contradictory explicit guest state is never an authenticated account.
    if (user.is_login === false || user.isLogin === false || user.is_guest === true || user.is_anonymous === true
      || user.authenticated === false || user.id_str === '0') return { status: 'anonymous' }
    const uid = user.id_str
    if (typeof uid !== 'string' || !/^[1-9]\d{0,19}$/.test(uid) || BigInt(uid) > 0xffff_ffff_ffff_ffffn) return unknown
    const nickname = typeof user.nickname === 'string' && user.nickname.length <= 128 && !/[\x00-\x1f\x7f]/.test(user.nickname) ? user.nickname.trim() : ''
    return { status: 'authenticated', uid, ...(nickname ? { nickname } : {}) }
  } catch { return unknown }
}
