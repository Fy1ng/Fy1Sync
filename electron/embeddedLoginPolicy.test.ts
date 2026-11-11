import { describe, expect, it } from 'vitest'
import { loginAttemptId, loginRequestAllowed, loginViewport } from './embeddedLoginPolicy'

describe('login webpage boundary', () => {
  it('allows only the official Bilibili v4 fallback API paths and resource kinds', () => {
    for (const path of ['/load', '/verify']) {
      expect(loginRequestAllowed('bilibili', `https://gcaptcha4.gsensebot.com${path}`, 'script')).toBe(true)
      expect(loginRequestAllowed('bilibili', `https://gcaptcha4.gsensebot.com${path}`, 'xhr')).toBe(true)
      expect(loginRequestAllowed('bilibili', `https://gcaptcha4.gsensebot.com${path}`, 'mainFrame')).toBe(false)
      expect(loginRequestAllowed('bilibili', `https://gcaptcha4.gsensebot.com${path}`, 'subFrame')).toBe(false)
      expect(loginRequestAllowed('douyu', `https://gcaptcha4.gsensebot.com${path}`, 'script')).toBe(false)
    }
    expect(loginRequestAllowed('bilibili', 'https://gcaptcha4.gsensebot.com/other', 'script')).toBe(false)
    expect(loginRequestAllowed('bilibili', 'https://gcaptcha4.gsensebot.com.evil.test/load', 'script')).toBe(false)
  })
  it.each([
    'http://www.douyu.com/member/login', 'https://local.passport.douyu.com/pcclient/getUserInfo',
    'https://local.passport.douyu.com:49155/pcclient/getUserInfo', 'https://127.0.0.1/',
    'https://192.168.1.1/', 'https://[::1]/', 'file:///C:/private', 'app://app/',
    'https://www.douyu.com.evil.test/', 'https://www.douyu.com@evil.test/',
  ])('refuses remote login access to %s', url => {
    expect(loginRequestAllowed('douyu', url, 'mainFrame')).toBe(false)
    expect(loginRequestAllowed('douyu', url, 'xhr')).toBe(false)
  })
  it('permits official forms and captcha resources without granting their top-level navigation', () => {
    expect(loginRequestAllowed('douyu', 'https://passport.douyu.com/member/login', 'mainFrame')).toBe(true)
    expect(loginRequestAllowed('bilibili', 'https://www.bilibili.com/correspond/0/', 'subFrame')).toBe(true)
    expect(loginRequestAllowed('huya', 'https://aq.huya.com/p/udb_login.html', 'subFrame')).toBe(true)
    expect(loginRequestAllowed('huya', 'https://static.geetest.com/captcha.js', 'script')).toBe(true)
    expect(loginRequestAllowed('huya', 'https://static.geetest.com/captcha.js', 'mainFrame')).toBe(false)
    expect(loginRequestAllowed('huya', 'https://local.ylogin.yy.com:6108/pt_get_list', 'script')).toBe(false)
    expect(loginRequestAllowed('bilibili', 'https://passport.douyu.com/', 'subFrame')).toBe(false)
    expect(loginRequestAllowed('huya', 'https://v.huya.com/autoplay.flv', 'media')).toBe(false)
    expect(loginRequestAllowed('huya', 'https://static.geetest.com/audio.mp3', 'media')).toBe(false)
    expect(loginRequestAllowed('bilibili', 'https://hdaa.shuzilm.cn/device', 'xhr')).toBe(true)
    expect(loginRequestAllowed('bilibili', 'https://global-h5uni.checktrustworthiness.com/device', 'xhr')).toBe(true)
    expect(loginRequestAllowed('bilibili', 'https://hdaa.shuzilm.cn/', 'mainFrame')).toBe(false)
    expect(loginRequestAllowed('huya', 'https://hdaa.shuzilm.cn/device', 'xhr')).toBe(false)
    expect(loginRequestAllowed('bilibili', 'https://hdaa.shuzilm.cn.evil.test/device', 'xhr')).toBe(false)
  })
  it('permits the official Bilibili second-factor cookie and token completion chain', () => {
    // Official passport 304.7d10caa4.js module 5863 uses these requests after exchange_cookie succeeds.
    const completion: Array<[string, string]> = [
      ['https://passport.bilibili.com/x/safecenter/login/tel/verify', 'xhr'],
      ['https://passport.bilibili.com/x/passport-login/web/exchange_cookie', 'xhr'],
      ['https://s1.hdslb.com/bfs/static/jinkela/long/wasm/wasm_ras_umd.js', 'script'],
      ['https://s1.hdslb.com/bfs/static/jinkela/long/wasm/wasm_rsa_encrypt_bg.wasm', 'xhr'],
      ['https://www.bilibili.com/correspond/0/synthetic', 'subFrame'],
      ['https://www.bilibili.com/', 'mainFrame'],
    ]
    for (const [url, resourceType] of completion) {
      expect(loginRequestAllowed('bilibili', url, resourceType)).toBe(true)
      expect(loginRequestAllowed('douyu', url, resourceType)).toBe(false)
      expect(loginRequestAllowed('huya', url, resourceType)).toBe(false)
      expect(loginRequestAllowed('bilibili', url.replace('https:', 'http:'), resourceType)).toBe(false)
    }
    expect(loginRequestAllowed('bilibili', completion[2]![0], 'mainFrame')).toBe(false)
    expect(loginRequestAllowed('bilibili', 'https://www.bilibili.com.evil.test/correspond/0/synthetic', 'subFrame')).toBe(false)
    expect(loginRequestAllowed('bilibili', 'https://passport.biligame.com/cross-domain/login', 'subFrame')).toBe(false)
  })
  it('accepts only bounded, exact viewport messages and attempt identities', () => {
    const id = 'bba6003a-b1d2-4fe4-a712-5dd84a358c1f'
    const value = { id, visible: true, rect: { x: 10, y: 20, width: 700, height: 480 } }
    expect(loginViewport(value)).toEqual(value)
    expect(loginViewport({ ...value, partition: 'default' })).toBeNull()
    expect(loginViewport({ ...value, rect: { ...value.rect, width: NaN } })).toBeNull()
    expect(loginViewport({ ...value, rect: { ...value.rect, height: -1 } })).toBeNull()
    expect(loginViewport({ ...value, rect: { ...value.rect, x: 100_000 } })).toBeNull()
    expect(loginAttemptId({ id })).toBe(id)
    expect(loginAttemptId({ id, url: 'https://evil.test/' })).toBeNull()
  })
})
