import { describe, expect, it } from 'vitest'
import { douyinBrowserCookieFingerprint } from '../../electron/cookies'
import { douyinCookieFingerprint } from './signingMaterial'
import { DouyinHttpCookieError, DouyinHttpCookies } from './httpLoginCookies'

const login = 'https://login.douyin.com/passport/web/check_qrconnect/'
const live = 'https://live.douyin.com/webcast/user/me/'
const headers = (...values: string[]) => { const result = new Headers(); values.forEach(value => result.append('set-cookie', value)); return result }

describe('isolated HTTP login cookie authority', () => {
  it('preserves actual host and path scopes across login redirects', () => {
    const jar = new DouyinHttpCookies()
    jar.receive(login, headers('csrf_session_id=synthetic-login; Path=/; Secure; HttpOnly', 'sessionid=synthetic-shared; Domain=.douyin.com; Path=/; Secure; HttpOnly'))
    jar.receive('https://www.douyin.com/', headers('UIFID_TEMP=synthetic-www; Path=/'))
    expect(jar.header(login)).toContain('csrf_session_id=synthetic-login')
    expect(jar.header(live)).toBe('sessionid=synthetic-shared')
    expect(jar.header(login)).not.toContain('UIFID_TEMP')
    expect(jar.snapshot().find(value => value.name === 'csrf_session_id')).toMatchObject({ hostOnly: true, httpOnly: true, secure: true })
  })

  it('matches the authentication selection used after CookieStore persistence', () => {
    const jar = new DouyinHttpCookies()
    jar.receive(login, headers('sessionid=synthetic-root; Domain=.douyin.com; Path=/'))
    jar.receive(live, headers('sessionid=synthetic-live; Path=/', 'sessionid_ss=synthetic-path; Path=/webcast'))
    expect(douyinCookieFingerprint(jar.header(live))).toBe(douyinBrowserCookieFingerprint(jar.snapshot()))
    expect(jar.header(live)).toContain('sessionid=synthetic-live')
  })

  it('uses RFC default paths and Max-Age precedence over Expires', () => {
    let now = 100000
    const jar = new DouyinHttpCookies(() => now)
    jar.receive(login, headers('temporary=synthetic; Max-Age=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT'))
    expect(jar.header(login)).toBe('temporary=synthetic')
    expect(jar.header('https://login.douyin.com/passport/other')).toBe('')
    now += 2001
    expect(jar.header(login)).toBe('')
  })

  it('deletes the exact cookie scope without deleting a same-name shared cookie', () => {
    const jar = new DouyinHttpCookies()
    jar.receive(login, headers('sample=shared; Domain=.douyin.com; Path=/', 'sample=host; Path=/'))
    expect(jar.value('sample', login)).toBe('host')
    jar.receive(login, headers('sample=deleted; Path=/; Max-Age=0'))
    expect(jar.value('sample', login)).toBe('shared')
  })

  it('refuses credential construction, foreign domains, unsafe destinations and header injection', () => {
    const jar = new DouyinHttpCookies()
    expect(() => jar.setPublic('sessionid', 'PRIVATE_TEST_SECRET')).toThrow(DouyinHttpCookieError)
    for (const value of ['test=PRIVATE_TEST_SECRET; Domain=.evil.example; Path=/', 'test=PRIVATE_TEST_SECRET\r\ninjected=1']) {
      expect(() => jar.receive(login, headers(value))).toThrow()
    }
    for (const url of ['http://live.douyin.com/', 'https://live.douyin.com.evil.example/', 'https://user:password@live.douyin.com/', 'https://live.douyin.com:8443/']) expect(() => jar.header(url)).toThrow(DouyinHttpCookieError)
    try { jar.setPublic('unsafe', 'PRIVATE_TEST_SECRET\r\n') } catch (error) { expect((error as Error).message).not.toContain('PRIVATE_TEST_SECRET') }
  })

  it('returns independent snapshots and removes all temporary material on clear', () => {
    const jar = new DouyinHttpCookies()
    jar.setPublic('s_v_web_id', 'synthetic-public-fp')
    jar.snapshot()[0]!.value = 'modified'
    expect(jar.value('s_v_web_id', login)).toBe('synthetic-public-fp')
    jar.clear()
    expect(jar.snapshot()).toEqual([])
  })
})
