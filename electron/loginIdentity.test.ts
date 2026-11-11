import { describe, expect, it } from 'vitest'
import { loginIdentityUrl, parseLoginIdentity } from './loginIdentity'

describe('official login identity parsing', () => {
  it('uses exact read-only official identity endpoints', () => {
    expect(loginIdentityUrl('douyu')).toBe('https://www.douyu.com/lapi/member/api/getInfo?client_type=0')
    expect(loginIdentityUrl('bilibili')).toBe('https://api.bilibili.com/x/web-interface/nav')
    expect(loginIdentityUrl('huya')).toBe('https://l.huya.com/udb_web/udbport2.php?m=HuyaLogin&do=checkLogin')
  })

  it('recognizes live anonymous official response shapes', () => {
    expect(parseLoginIdentity('douyu', { error: 1, msg: { uid: 0, info: 0, silver: 0, nbl_spl: 0, exp: 0, hs: 0, gold: 0 } })).toEqual({ status: 'anonymous' })
    expect(parseLoginIdentity('bilibili', { code: -101, message: '账号未登录', data: { isLogin: false, wbi_img: {} } })).toEqual({ status: 'anonymous' })
    expect(parseLoginIdentity('huya', { isLogined: false, userName: '', uid: 0, userNick: '', userLogo: '', isHuya: true, isChecked: false })).toEqual({ status: 'anonymous' })
  })

  it('requires explicit successful status and positive bounded uid', () => {
    expect(parseLoginIdentity('bilibili', { code: 0, data: { isLogin: true, mid: 42, uname: '测试账号' } })).toEqual({ status: 'authenticated', uid: '42', nickname: '测试账号' })
    expect(parseLoginIdentity('huya', { isLogined: true, uid: '42', userNick: '测试账号', userName: 'private-phone-number' })).toEqual({ status: 'authenticated', uid: '42', nickname: '测试账号' })
    expect(parseLoginIdentity('douyu', { error: 0, msg: { uid: '42', info: { uid: 42, nickname: '测试账号' } } })).toEqual({ status: 'authenticated', uid: '42', nickname: '测试账号' })
  })

  it('rejects conflicting status, missing fields, truthy flags and unrelated payloads', () => {
    for (const payload of [null, true, [], '<html>200 OK</html>', { status: 200 }, { cookies: ['SESSDATA'] }]) {
      for (const platform of ['douyu', 'bilibili', 'huya'] as const) expect(parseLoginIdentity(platform, payload)).toEqual({ status: 'unknown' })
    }
    for (const payload of [
      { code: 0, data: { isLogin: true } }, { code: -101, data: { isLogin: true, mid: 42 } },
      { code: 0, data: { isLogin: false, mid: 42 } }, { code: '0', data: { isLogin: true, mid: 42 } },
      { code: 0, data: { isLogin: 'true', mid: 42 } }, { code: -101, data: { isLogin: false, mid: 42 } },
    ]) expect(parseLoginIdentity('bilibili', payload)).toEqual({ status: 'unknown' })
    for (const payload of [{ isLogined: 'true', uid: 42 }, { isLogined: false, uid: 42 }, { isLogined: true, uid: 0 }]) expect(parseLoginIdentity('huya', payload)).toEqual({ status: 'unknown' })
    for (const payload of [{ error: 1, msg: { uid: 42 } }, { error: '0', msg: { uid: 42 } }, { error: 0, msg: { uid: 42, info: { uid: 43 } } }, { error: 1, msg: { uid: 0, info: {} } }, { error: 0, msg: { uid: 42, info: 'malformed' } }]) expect(parseLoginIdentity('douyu', payload)).toEqual({ status: 'unknown' })
  })

  it.each([true, 1, '1'])('accepts only a defined authenticated Huya flag %j with a positive server UID', isLogined => {
    expect(parseLoginIdentity('huya', { isLogined, uid: '42', userNick: '测试账号' })).toEqual({ status: 'authenticated', uid: '42', nickname: '测试账号' })
    expect(parseLoginIdentity('huya', { isLogined, uid: 0 })).toEqual({ status: 'unknown' })
  })

  it.each([false, 0, '0'])('accepts only a defined anonymous Huya flag %j with a zero UID', isLogined => {
    expect(parseLoginIdentity('huya', { isLogined, uid: 0 })).toEqual({ status: 'anonymous' })
    expect(parseLoginIdentity('huya', { isLogined, uid: 42 })).toEqual({ status: 'unknown' })
  })

  it.each(['true', 'false', '01', 'yes', 2, -1, {}, []])('rejects unsupported Huya truthy encodings %j', isLogined => {
    expect(parseLoginIdentity('huya', { isLogined, uid: 42 })).toEqual({ status: 'unknown' })
  })

  it.each([undefined, null, 0, {}, { nickname: '测试账号' }])('uses explicit Douyu error/uid independently of optional profile details %j', info => {
    expect(parseLoginIdentity('douyu', { error: 0, msg: { uid: 42, ...(info !== undefined ? { info } : {}) } })).toMatchObject({ status: 'authenticated', uid: '42' })
    expect(parseLoginIdentity('douyu', { error: 0, msg: { ...(info !== undefined ? { info } : {}) } })).toEqual({ status: 'unknown' })
  })

  it('rejects invalid and precision-losing identity values', () => {
    for (const uid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '00', '01', '0', '-2', '1e3', '42 ', '9'.repeat(21), {}, true]) {
      expect(parseLoginIdentity('douyu', { error: 0, msg: { uid, info: {} } })).toEqual({ status: 'unknown' })
      expect(parseLoginIdentity('bilibili', { code: 0, data: { isLogin: true, mid: uid } })).toEqual({ status: 'unknown' })
      expect(parseLoginIdentity('huya', { isLogined: true, uid })).toEqual({ status: 'unknown' })
    }
  })

  it('limits display names and never falls back to account identifiers', () => {
    expect(parseLoginIdentity('huya', { isLogined: true, uid: 42, userName: 'private-phone-number' })).toEqual({ status: 'authenticated', uid: '42' })
    expect(parseLoginIdentity('bilibili', { code: 0, data: { isLogin: true, mid: 42, uname: ' \u0000测试\n账号 ' } })).toEqual({ status: 'authenticated', uid: '42', nickname: '测试账号' })
    expect(parseLoginIdentity('huya', { isLogined: true, uid: 42, userNick: '甲'.repeat(200) }).nickname).toHaveLength(80)
    expect(parseLoginIdentity('douyu', { error: 0, msg: { uid: 42, info: { nickname: '甲'.repeat(513) } } })).toEqual({ status: 'authenticated', uid: '42' })
  })
})
