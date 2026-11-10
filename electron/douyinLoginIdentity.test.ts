import { describe, expect, it } from 'vitest'
import { DOUYIN_LOGIN_IDENTITY_URL, parseDouyinLoginIdentity } from './douyinLoginIdentity'

describe('official Douyin current-user identity', () => {
  it('uses the exact official current-user endpoint and observed anonymous error code', () => {
    const url = new URL(DOUYIN_LOGIN_IDENTITY_URL)
    expect(url.origin).toBe('https://live.douyin.com')
    expect(url.pathname).toBe('/webcast/user/me/')
    expect(url.searchParams.get('room_id')).toBe('0')
    expect(parseDouyinLoginIdentity({ status_code: 20003, data: { message: 'synthetic-not-logged-in' } })).toEqual({ status: 'anonymous' })
  })
  it('reads only the SDK current-user schema and preserves a valid 64-bit string UID', () => {
    expect(parseDouyinLoginIdentity({ status_code: 0, data: { id_str: '9000000000000000001', nickname: 'synthetic-user', uid_tt: 'synthetic-hash', secret: 'synthetic-secret' } }))
      .toEqual({ status: 'authenticated', uid: '9000000000000000001', nickname: 'synthetic-user' })
    expect(parseDouyinLoginIdentity({ status_code: 0, data: { id_str: '9000000000000000001' } }))
      .toEqual({ status: 'authenticated', uid: '9000000000000000001' })
  })
  it('never treats UID presence, a cookie hash, another endpoint, or unknown status as authentication', () => {
    for (const input of [null, [], {}, { data: { id_str: '123' } }, { status_code: '0', data: { id_str: '123' } },
      { status_code: 8, user: { uid: '123' } }, { status_code: 0, user: { id_str: '123' } },
      { status_code: 0, data: { id: 123 } }, { status_code: 0, data: { uid_tt: '123' } },
      { status_code: 0, data: { id_str: '18446744073709551616' } }, { status_code: 0, data: { id_str: '123hash' } }]) {
      expect(parseDouyinLoginIdentity(input)).toEqual({ status: 'unknown' })
    }
  })
  it.each([{ is_login: false }, { isLogin: false }, { is_guest: true }, { is_anonymous: true }, { authenticated: false }, { id_str: '0' }])('denies explicit anonymous/visitor state %j', marker => {
    expect(parseDouyinLoginIdentity({ status_code: 0, data: { id_str: '123', ...marker } })).toEqual({ status: 'anonymous' })
  })
  it('does not return unsafe nicknames or source credential fields', () => {
    expect(parseDouyinLoginIdentity({ status_code: 0, data: { id_str: '123', nickname: 'name\r\nsecret', sessionid: 'synthetic-secret' } }))
      .toEqual({ status: 'authenticated', uid: '123' })
  })
})
