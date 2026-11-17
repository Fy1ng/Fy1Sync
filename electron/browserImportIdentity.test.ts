import { describe, expect, it, vi } from 'vitest'
import { browserIdentityVerifier, importAvatarUrl, importCookieHeader } from './browserImportIdentity'
import type { BrowserCookie } from './cookies'

const cookies = (domain: string, fields: Record<string, string>): BrowserCookie[] => Object.entries(fields)
  .map(([name, value]) => ({ domain, name, value, path: '/', secure: true, session: true }))
describe('import identity verification and avatars', () => {
  it('verifies official Bilibili identity and fetches its avatar without credentials', async () => {
    const fetch = vi.fn(async (_platform, url: string, init: RequestInit) => {
      if (url.includes('x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: {
        isLogin: true, mid: 42, uname: '账号名称', face: 'https://i0.hdslb.com/bfs/face/example.png',
      } }))
      expect(init.headers).toBeUndefined()
      expect(init.credentials).toBe('omit')
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } })
    })
    const verify = browserIdentityVerifier(fetch, () => 'data:image/png;base64,AQ==')
    await expect(verify('bilibili', cookies('.bilibili.com', { DedeUserID: '42', SESSDATA: 'synthetic' }), new AbortController().signal))
      .resolves.toEqual({ uid: '42', username: '账号名称', avatar: 'data:image/png;base64,AQ==' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('rejects identity mismatch and unknown responses instead of treating HTTP 200 as login', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ isLogined: true, uid: '84', userNick: 'other' })))
    const verify = browserIdentityVerifier(fetch, () => undefined)
    await expect(verify('huya', cookies('.huya.com', { udb_uid: '42', udb_biztoken: 'synthetic' }), new AbortController().signal))
      .rejects.toMatchObject({ code: 'browser-import-verification-failed' })
    fetch.mockImplementationOnce(async () => new Response('<html>HTTP 200</html>'))
    await expect(verify('huya', cookies('.huya.com', { udb_uid: '42', udb_biztoken: 'synthetic' }), new AbortController().signal)).rejects.toThrow()
  })
  it('supports current YouTube account menu names and avatars using only a read operation', async () => {
    const fetch = vi.fn(async (_platform, url: string, init: RequestInit) => {
      if (url.endsWith('/account')) return new Response('ytcfg.set({"EXPERIMENT_FLAGS":{"test":true}}); ytcfg.set({"LOGGED_IN":true,"SESSION_INDEX":0,"INNERTUBE_CONTEXT":{"client":{"clientVersion":"test"}}}); var ytInitialData={};')
      expect(url).toContain('/account/account_menu')
      expect(init.method).toBe('POST')
      return new Response(JSON.stringify({ menu: { activeAccountHeaderRenderer: { accountName: { simpleText: '频道名称' } } } }))
    })
    const verify = browserIdentityVerifier(fetch, () => undefined)
    await expect(verify('youtube', cookies('.youtube.com', { SID: 'synthetic', SAPISID: 'synthetic' }), new AbortController().signal))
      .resolves.toEqual({ username: '频道名称' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('accepts only HTTPS platform avatar origins and never arbitrary renderer URLs', () => {
    for (const value of ['http://localhost/image', 'https://127.0.0.1/image', 'file:///secret.png', 'data:image/svg+xml,test',
      'https://i0.hdslb.com.evil.test/image', 'https://user:password@i0.hdslb.com/image', 'https://i0.hdslb.com:444/image']) {
      expect(importAvatarUrl('bilibili', value)).toBeUndefined()
    }
    expect(importAvatarUrl('bilibili', '//i0.hdslb.com/bfs/avatar.jpg')).toBe('https://i0.hdslb.com/bfs/avatar.jpg')
  })
  it('uses precise domain/path selection and rejects unrelated host-only and expired cookies', () => {
    const source: BrowserCookie[] = [
      ...cookies('.douyu.com', { token: 'parent' }),
      { domain: 'www.douyu.com', hostOnly: true, name: 'token', value: 'host', path: '/', session: true },
      { domain: 'passport.douyu.com', hostOnly: true, name: 'secret', value: 'unrelated', path: '/', session: true },
      { domain: '.douyu.com', name: 'old', value: 'expired', path: '/', expirationDate: 1 },
      { domain: '.douyu.com', name: 'otherPath', value: 'path', path: '/member' },
    ]
    expect(importCookieHeader(source, new URL('https://www.douyu.com/lapi/member/api/getInfo'))).toBe('token=host')
  })
})
