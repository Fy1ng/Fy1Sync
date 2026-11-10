import type { EmbeddedLoginPlatform } from './embeddedLoginContracts'
import { DOUYIN_LOGIN_IDENTITY_URL, parseDouyinLoginIdentity } from './douyinLoginIdentity'

export interface LoginIdentity {
  status: 'authenticated' | 'anonymous' | 'unknown'
  uid?: string
  nickname?: string
}

export function loginIdentityUrl(platform: EmbeddedLoginPlatform): string {
  return platform === 'douyin' ? DOUYIN_LOGIN_IDENTITY_URL : ''
}

/** Only the official current-user endpoint can establish a live account identity. */
export function parseLoginIdentity(platform: EmbeddedLoginPlatform, payload: unknown): LoginIdentity {
  if (platform !== 'douyin') return { status: 'unknown' }
  const identity = parseDouyinLoginIdentity(payload)
  if (identity.status !== 'authenticated') return { status: identity.status }
  if (!identity.uid || !/^[1-9][0-9]{0,19}$/.test(identity.uid)) return { status: 'unknown' }
  return { status: 'authenticated', uid: identity.uid,
    ...(typeof identity.nickname === 'string' ? { nickname: identity.nickname.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) } : {}) }
}
