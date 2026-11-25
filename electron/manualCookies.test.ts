import { describe, expect, it } from 'vitest'
import { parseManualCookies } from './manualCookies'

describe('manual cookie parser', () => {
  it.each(['Cookie:\tSESSDATA=session; DedeUserID=42', 'SESSDATA=session;\tDedeUserID=42'])('accepts header whitespace: %s', text => {
    expect(parseManualCookies(text, 'bilibili')).toHaveLength(2)
  })
  it.each(['', '\n'])('preserves an empty final Netscape value with suffix %j', suffix => {
    const text = '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsession\n.bilibili.com\tTRUE\t/\tTRUE\t0\tDedeUserID\t42\n.bilibili.com\tTRUE\t/\tFALSE\t0\tpreference\t' + suffix
    expect(parseManualCookies(text, 'bilibili')[2]?.value).toBe('')
  })
  it.each([
    ['douyu', 'acf_uid=42; acf_auth=session'],
    ['bilibili', 'DedeUserID=42; SESSDATA=session=='],
    ['huya', 'udb_uid=42; udb_biztoken=session'],
    ['douyin', 'sessionid=session'],
    ['youtube', 'LOGIN_INFO=login; SAPISID=session'],
  ] as const)('accepts synthetic authentication for %s', (platform, text) => {
    expect(parseManualCookies(text, platform).some(cookie => cookie.value.startsWith('session'))).toBe(true)
  })
  it('parses a Cookie header and rejects an incomplete login', () => {
    const cookies = parseManualCookies('Cookie: SESSDATA=session; DedeUserID=42', 'bilibili')
    expect(cookies).toMatchObject([{ name: 'SESSDATA', value: 'session', domain: '.bilibili.com', session: true }, { name: 'DedeUserID', value: '42' }])
    expect(() => parseManualCookies('foo=bar', 'bilibili')).toThrowError(/完整登录凭据/)
  })
  it('parses Netscape cookies and ignores unrelated domains and expired rows', () => {
    const text = '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsession\n.bilibili.com\tTRUE\t/\tTRUE\t0\tDedeUserID\t42\n.google.com\tTRUE\t/\tTRUE\t0\tSID\tother\n.bilibili.com\tTRUE\t/\tTRUE\t1\told\tvalue\n'
    expect(parseManualCookies(text, 'bilibili', 2_000_000_000)).toHaveLength(2)
  })
  it('parses browser JSON exports and supports YouTube domains', () => {
    const cookies = parseManualCookies(JSON.stringify([
      { domain: '.youtube.com', name: 'SAPISID', value: 'session', path: '/', expirationDate: 2_000_000_001 },
      { domain: '.youtube.com', name: 'LOGIN_INFO', value: 'login', path: '/', expirationDate: 2_000_000_001 },
    ]), 'youtube', 2_000_000_000)
    expect(cookies[0]).toMatchObject({ domain: '.youtube.com', name: 'SAPISID' })
  })
  it('rejects unsafe values and oversized input', () => {
    expect(() => parseManualCookies('SESSDATA=a;b=bad', 'bilibili')).toThrow()
    expect(() => parseManualCookies('x'.repeat(1024 * 1024 + 1), 'bilibili')).toThrow()
  })
})
