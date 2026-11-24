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
  it('builds the Douyu avatar address from the relative icon path and reads the abbreviated name', async () => {
    const icon = 'avatar_v3/202011/0123456789abcdef0123456789abcdef'
    const requested: string[] = []
    const fetch = vi.fn(async (_platform, url: string) => {
      requested.push(url)
      if (url.includes('/lapi/member/api/getInfo')) return new Response(JSON.stringify({ error: 0, msg: { uid: 42, info: { nn: '斗鱼昵称', icon } } }))
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/jpeg' } })
    })
    const verify = browserIdentityVerifier(fetch, () => 'data:image/png;base64,AQ==')
    const douyu = cookies('.douyu.com', { acf_uid: '42', acf_auth: 'synthetic', acf_biz: '1', acf_stk: 's', acf_ct: '0', acf_ltkid: '1' })
    await expect(verify('douyu', douyu, new AbortController().signal)).resolves.toEqual({ uid: '42', username: '斗鱼昵称', avatar: 'data:image/png;base64,AQ==' })
    expect(requested[1]).toBe(`https://apic.douyucdn.cn/upload/${icon}_middle.jpg`)
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const bad of ['', 'https://example.invalid/a.jpg', '//apic.douyucdn.cn/upload/avatar/1', '../avatar/1', 'avatar/../../secret', 'avatar/a.jpg', 'avatar', 'other/1/2', 42, null]) {
      fetch.mockClear()
      fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 0, msg: { uid: 42, info: { nn: '斗鱼昵称', icon: bad } } })))
      await expect(verify('douyu', douyu, new AbortController().signal)).resolves.toEqual({ uid: '42', username: '斗鱼昵称' })
      expect(fetch).toHaveBeenCalledOnce()
    }
  })
  it('reads the Huya avatar from the public lookup by uid, without sending credentials to it', async () => {
    const calls: { url: string; cookie: boolean }[] = []
    const answers = { lookup: JSON.stringify({ code: 0, data: { uid: 42, avatar: 'https://huyaimg.msstatic.com/avatar/1/2/example_180_135.jpg?1' }, message: '' }) }
    const fetch = vi.fn(async (_platform, url: string, init: RequestInit) => {
      calls.push({ url, cookie: new Headers(init.headers).has('Cookie') })
      if (url.includes('checkLogin')) return new Response(JSON.stringify({ isLogined: true, userName: 'n', uid: 42, userNick: '虎牙昵称', userLogo: '', isHuya: true }))
      if (url.startsWith('https://user.huya.com/')) return new Response(answers.lookup)
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/jpeg' } })
    })
    const verify = browserIdentityVerifier(fetch, () => 'data:image/png;base64,AQ==')
    const huya = cookies('.huya.com', { udb_uid: '42', udb_biztoken: 'synthetic' })
    await expect(verify('huya', huya, new AbortController().signal)).resolves.toEqual({ uid: '42', username: '虎牙昵称', avatar: 'data:image/png;base64,AQ==' })
    expect(calls.map(call => call.url)).toEqual(['https://l.huya.com/udb_web/udbport2.php?m=HuyaLogin&do=checkLogin',
      'https://user.huya.com/user/getUserInfo?uid=42', 'https://huyaimg.msstatic.com/avatar/1/2/example_180_135.jpg?1'])
    expect(calls.map(call => call.cookie)).toEqual([true, false, false])

    for (const lookup of [JSON.stringify({ code: 0, data: { uid: 43, avatar: 'https://huyaimg.msstatic.com/avatar/other.jpg' } }),
      JSON.stringify({ code: 0, data: { uid: 42, avatar: 'https://example.invalid/a.jpg' } }), JSON.stringify({ code: 500 }), '<html>']) {
      answers.lookup = lookup
      calls.length = 0
      await expect(verify('huya', huya, new AbortController().signal)).resolves.toEqual({ uid: '42', username: '虎牙昵称' })
      expect(calls).toHaveLength(2)
    }
  })
  it('resolves an empty Huya display name the way the site header does: second endpoint, then login name', async () => {
    const calls: { url: string; cookie: boolean }[] = []
    let second: Response | Error = new Response(JSON.stringify({ userNick: '补取的昵称', userLogo: '' }))
    const fetch = vi.fn(async (_platform, url: string, init: RequestInit) => {
      calls.push({ url, cookie: new Headers(init.headers).has('Cookie') })
      if (url.includes('do=checkLogin')) return new Response(JSON.stringify({ isLogined: true, userName: 'loginnm1', uid: 42, userNick: '', userLogo: 'https://huyaimg.msstatic.com/avatar/direct.jpg' }))
      if (url.includes('do=checkUserNick')) { if (second instanceof Error) throw second; return second }
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/jpeg' } })
    })
    const verify = browserIdentityVerifier(fetch, () => 'data:image/png;base64,AQ==')
    const huya = cookies('.huya.com', { udb_uid: '42', udb_biztoken: 'synthetic' })
    await expect(verify('huya', huya, new AbortController().signal)).resolves.toMatchObject({ uid: '42', username: '补取的昵称' })
    expect(calls.map(call => call.url)).toEqual(['https://l.huya.com/udb_web/udbport2.php?m=HuyaLogin&do=checkLogin',
      'https://huyaimg.msstatic.com/avatar/direct.jpg', 'https://l.huya.com/udb_web/udbport2.php?m=HuyaOutside&do=checkUserNick'])
    expect(calls.map(call => call.cookie)).toEqual([true, false, true])

    for (const answer of [new Response(JSON.stringify({ userNick: '' })), new Response('<html>'), new Response('', { status: 500 }), new Error('offline')]) {
      second = answer
      await expect(verify('huya', huya, new AbortController().signal)).resolves.toMatchObject({ uid: '42', username: 'loginnm1' })
    }
  })
  it('asks neither Huya follow-up when the login check is already complete', async () => {
    const urls: string[] = []
    const fetch = vi.fn(async (_platform, url: string) => {
      urls.push(url)
      if (url.includes('checkLogin')) return new Response(JSON.stringify({ isLogined: true, uid: 42, userNick: '虎牙昵称', userLogo: 'https://huyaimg.msstatic.com/avatar/direct.jpg' }))
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/jpeg' } })
    })
    const verify = browserIdentityVerifier(fetch, () => 'data:image/png;base64,AQ==')
    await expect(verify('huya', cookies('.huya.com', { udb_uid: '42', udb_biztoken: 'synthetic' }), new AbortController().signal)).resolves.toMatchObject({ username: '虎牙昵称' })
    expect(urls).toEqual(['https://l.huya.com/udb_web/udbport2.php?m=HuyaLogin&do=checkLogin', 'https://huyaimg.msstatic.com/avatar/direct.jpg'])
  })
  it('does not ask the Huya lookup when the login check already names an avatar', async () => {
    const urls: string[] = []
    const fetch = vi.fn(async (_platform, url: string) => {
      urls.push(url)
      if (url.includes('checkLogin')) return new Response(JSON.stringify({ isLogined: true, uid: 42, userNick: '虎牙昵称', userLogo: 'https://huyaimg.msstatic.com/avatar/direct.jpg' }))
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/jpeg' } })
    })
    const verify = browserIdentityVerifier(fetch, () => 'data:image/png;base64,AQ==')
    await verify('huya', cookies('.huya.com', { udb_uid: '42', udb_biztoken: 'synthetic' }), new AbortController().signal)
    expect(urls).toEqual(['https://l.huya.com/udb_web/udbport2.php?m=HuyaLogin&do=checkLogin', 'https://huyaimg.msstatic.com/avatar/direct.jpg'])
  })
  it('accepts the older Douyu avatar path form', async () => {
    const requested: string[] = []
    const fetch = vi.fn(async (_platform, url: string) => {
      requested.push(url)
      if (url.includes('/lapi/member/api/getInfo')) return new Response(JSON.stringify({ error: 0, msg: { uid: 42, info: { nn: '斗鱼昵称', icon: 'avatar/002/48/83/16_avatar' } } }))
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/jpeg' } })
    })
    const verify = browserIdentityVerifier(fetch, () => 'data:image/png;base64,AQ==')
    await verify('douyu', cookies('.douyu.com', { acf_uid: '42', acf_auth: 'synthetic', acf_biz: '1', acf_stk: 's', acf_ct: '0', acf_ltkid: '1' }), new AbortController().signal)
    expect(requested[1]).toBe('https://apic.douyucdn.cn/upload/avatar/002/48/83/16_avatar_middle.jpg')
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
