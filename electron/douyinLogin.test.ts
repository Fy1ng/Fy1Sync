import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieStore, cookieDomainAllowed, hasAuthenticationCookies } from './cookies'
import type { BrowserCookie } from './cookies'
import { ChromeLoginDriver, LoginManager } from './login'
import type { BrowserLoginDriver } from './login'

const now = 2_000_000_000
const liveUrl = 'https://live.douyin.com/'
const authCookie = (overrides: Partial<BrowserCookie> = {}): BrowserCookie => ({
  domain: '.douyin.com', path: '/', name: 'sessionid', value: 'synthetic-private-session',
  secure: true, expirationDate: now + 60, ...overrides,
})
let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-login-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
const store = () => new CookieStore(root, { now: () => now })
const manager = (driver: BrowserLoginDriver, clock = () => now) => new LoginManager(root, { driver, chromeExecutable: 'synthetic-chrome', now: clock })

function pauseOpen(): () => void {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const open = fs.promises.open
  vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => { await ready; return open(...args) })
  return () => release()
}

describe('Douyin cookie authentication and scopes', () => {
  it('never reports anonymous identifiers as a login or exposes them as an account name', async () => {
    const cookies = ['ttwid', 'msToken', 'UIFID', 'uid_tt', 'uid_tt_ss', 'sid_tt', 'passport_csrf_token']
      .map(name => authCookie({ name }))
    const storage = store()
    expect(storage.write('douyin', cookies)).toEqual({ cookieCount: cookies.length, authKeysPresent: [] })
    expect(hasAuthenticationCookies(cookies, 'douyin', now)).toBe(false)
    expect((await storage.status()).douyin).toEqual({ loggedIn: false, cookieCount: cookies.length,
      authKeysPresent: [], expiresAt: null, hasSessionCookies: false })
  })

  it('uses the same authentication scope for export checks and persisted status', async () => {
    const storage = store()
    const cookies = [
      authCookie({ domain: 'live.douyin.com', hostOnly: true }),
      authCookie({ name: 'sessionid_ss', expirationDate: undefined, session: true }),
      authCookie({ domain: 'www.douyin.com', hostOnly: true, name: 'sessionid', expirationDate: now + 1 }),
      authCookie({ name: 'sessionid_ss', path: '/webcast', expirationDate: now + 2 }),
      authCookie({ name: 'uid_tt', value: 'synthetic-user-id' }),
      authCookie({ domain: '.youtube.com', name: 'SID' }),
      authCookie({ domain: '.douyu.com', name: 'acf_auth' }),
    ]
    expect(hasAuthenticationCookies(cookies, 'douyin', now)).toBe(true)
    expect(storage.write('douyin', cookies)).toEqual({ cookieCount: 5, authKeysPresent: ['sessionid', 'sessionid_ss'] })
    expect((await storage.status()).douyin).toEqual({ loggedIn: true, cookieCount: 5,
      authKeysPresent: ['sessionid', 'sessionid_ss'], expiresAt: now + 60, hasSessionCookies: true })
    expect(JSON.stringify(await storage.status())).not.toContain('synthetic-')
  })

  it.each([
    authCookie({ value: '' }),
    authCookie({ expirationDate: now }),
    authCookie({ expirationDate: now - 1, session: true }),
    authCookie({ domain: 'douyin.com', hostOnly: true }),
    authCookie({ domain: 'v.douyin.com' }),
    authCookie({ path: '/webcast' }),
  ])('keeps export and status unauthenticated for invalid live-homepage context (%j)', async cookie => {
    const storage = store()
    expect(hasAuthenticationCookies([cookie], 'douyin', now)).toBe(false)
    expect(storage.write('douyin', [cookie]).authKeysPresent).toEqual([])
    expect((await storage.status()).douyin).toMatchObject({ loggedIn: false, authKeysPresent: [], hasSessionCookies: false })
  })

  it.each(['douyin.com.evil.invalid', 'evildouyin.com', '.douyin.com..', '..douyin.com', '.-evil.douyin.com',
    '.youtube.com', '.douyu.com', 'ttwid.bytedance.com', 'webcast.amemv.com'])('filters forged or other-platform domains %s', async domain => {
    const storage = store()
    expect(cookieDomainAllowed(domain, 'douyin')).toBe(false)
    expect(storage.write('douyin', [authCookie({ domain })])).toEqual({ cookieCount: 0, authKeysPresent: [] })
    expect(await storage.cookieHeader('douyin', liveUrl)).toBe('')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, null as unknown as number])('never normalizes an invalid expiry into session authentication (%s)', expiry => {
    const storage = store()
    const cookie = authCookie({ expirationDate: expiry })
    expect(hasAuthenticationCookies([cookie], 'douyin', now)).toBe(false)
    expect(() => storage.write('douyin', [cookie])).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
    expect(fs.existsSync(path.join(root, 'cookies', 'douyin.txt'))).toBe(false)
  })

  it('sends only unexpired domain/path/secure matches and prefers the exact live host', async () => {
    const storage = store()
    storage.write('douyin', [
      authCookie({ value: 'parent-session' }),
      authCookie({ domain: 'live.douyin.com', hostOnly: true, value: 'live-session' }),
      authCookie({ name: 'ttwid', value: 'anonymous-context', secure: false }),
      authCookie({ path: '/webcast/room/web/enter', name: 'ENTRY', value: 'entry' }),
      authCookie({ path: '/12345', name: 'ROOM', value: 'room' }),
      authCookie({ domain: 'www.douyin.com', hostOnly: true, name: 'OTHER_HOST' }),
      authCookie({ domain: 'v.douyin.com', hostOnly: true, name: 'SHARE_HOST' }),
      authCookie({ domain: 'douyin.com', hostOnly: true, name: 'HOST_ONLY_PARENT' }),
      authCookie({ path: '/account', name: 'ACCOUNT' }),
      authCookie({ expirationDate: now - 1, name: 'EXPIRED' }),
      authCookie({ domain: '.douyu.com', name: 'acf_auth' }),
    ])
    expect(await storage.cookieHeader('douyin', liveUrl)).toBe('sessionid=live-session; ttwid=anonymous-context')
    expect(await storage.cookieHeader('douyin', `${liveUrl}12345`)).toBe('ROOM=room; sessionid=live-session; ttwid=anonymous-context')
    expect(await storage.cookieHeader('douyin', `${liveUrl}123456`)).toBe('sessionid=live-session; ttwid=anonymous-context')
    expect(await storage.cookieHeader('douyin', `${liveUrl}webcast/room/web/enter/?web_rid=12345`))
      .toBe('ENTRY=entry; sessionid=live-session; ttwid=anonymous-context')
    expect(await storage.cookieHeader('douyin', `${liveUrl}webcast/im/fetch/?room_id=12345`))
      .toBe('sessionid=live-session; ttwid=anonymous-context')
  })

  it.each([undefined, 'http://live.douyin.com/', 'https://live.douyin.com:8443/', 'https://user@live.douyin.com/',
    'https://user:password@live.douyin.com/', 'https://www.douyin.com/', 'https://douyin.com/', 'https://v.douyin.com/123/',
    'https://ttwid.bytedance.com/', 'https://pull-flv-l1.douyincdn.com/live/example.flv', 'https://live.douyin.com.evil.invalid/',
    'https://live.douyin.com/account/', 'https://live.douyin.com/0', 'https://live.douyin.com/0123',
    'https://live.douyin.com/123456789012345678901', 'https://live.douyin.com/webcast/im/fetch/other',
    'https://live.douyin.com/webcast/room/web/enter', 'https://live.douyin.com/%2f123', 'https://live.douyin.com/#account',
    'https://live.douyin.com\\123', 'https://live.douyin.com/\n'])('rejects credential export outside the exact allowlist (%s)', async url => {
    const storage = store()
    storage.write('douyin', [authCookie()])
    await expect(storage.cookieHeader('douyin', url)).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
  })

  it('returns an empty header without stored cookies and masks storage errors', async () => {
    const storage = store()
    expect(await storage.cookieHeader('douyin', liveUrl)).toBe('')
    storage.write('douyin', [authCookie()])
    vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error('synthetic-private-session and private path'))
    await expect(storage.cookieHeader('douyin', liveUrl)).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
    await expect(storage.status()).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
  })

  it('refuses corrupted stored cookie domains rather than returning their values', async () => {
    const storage = store()
    storage.write('douyin', [authCookie()])
    const file = path.join(root, 'cookies', 'douyin.txt')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('.douyin.com', '.outside.invalid'))
    await expect(storage.cookieHeader('douyin', liveUrl)).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
  })

  it('logs out only the verified Douyin profile and cookie file', async () => {
    const storage = store()
    for (const platform of ['douyin', 'douyu', 'youtube'] as const) storage.prepareProfile(platform)
    storage.write('douyin', [authCookie()])
    storage.write('douyu', [authCookie({ domain: '.douyu.com', name: 'acf_auth' })])
    storage.write('youtube', [authCookie({ domain: '.youtube.com', name: 'SID' })])
    storage.logout('douyin')
    expect(fs.existsSync(path.join(root, 'browser-profile', 'douyin'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'cookies', 'douyin.txt'))).toBe(false)
    for (const platform of ['douyu', 'youtube'] as const) {
      expect(fs.existsSync(path.join(root, 'browser-profile', platform))).toBe(true)
      expect(fs.existsSync(path.join(root, 'cookies', `${platform}.txt`))).toBe(true)
    }
    expect((await storage.status()).douyin.loggedIn).toBe(false)
  })

  it('injects only authenticated live-origin cookies and preserves their browser attributes', async () => {
    const storage = store()
    const set = vi.fn(async () => {})
    await storage.injectDouyinCookies({ cookies: { set } })
    expect(set).not.toHaveBeenCalled()
    storage.write('douyin', [authCookie({ httpOnly: true }),
      authCookie({ domain: 'live.douyin.com', hostOnly: true, name: 'sessionid_ss', session: true, expirationDate: undefined }),
      authCookie({ name: 'ttwid', secure: false }), authCookie({ domain: 'v.douyin.com', name: 'SHARE_ONLY' }),
      authCookie({ path: '/webcast', name: 'PATH_ONLY' }), authCookie({ domain: 'douyin.com', hostOnly: true, name: 'HOST_ONLY' }),
      authCookie({ name: 'EXPIRED', expirationDate: now - 1 })])
    await storage.injectDouyinCookies({ cookies: { set } })
    expect(set.mock.calls).toEqual([
      [{ url: liveUrl, domain: '.douyin.com', path: '/', name: 'sessionid', value: 'synthetic-private-session', secure: true, httpOnly: true, expirationDate: now + 60 }],
      [{ url: liveUrl, path: '/', name: 'sessionid_ss', value: 'synthetic-private-session', secure: true, httpOnly: false }],
      [{ url: liveUrl, domain: '.douyin.com', path: '/', name: 'ttwid', value: 'synthetic-private-session', secure: false, httpOnly: false, expirationDate: now + 60 }],
    ])
  })

  it('stops isolated-session injection when logout invalidates its generation', async () => {
    const storage = store()
    storage.write('douyin', [authCookie(), authCookie({ name: 'sessionid_ss' })])
    const set = vi.fn(async () => { storage.logout('douyin') })
    await expect(storage.injectDouyinCookies({ cookies: { set } })).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
    expect(set).toHaveBeenCalledOnce()
  })

  it('rejects profile junction cleanup before deleting any external content', () => {
    const storage = store()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-login-outside-'))
    const profile = storage.prepareProfile('douyin')
    try {
      fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve')
      fs.rmdirSync(profile)
      fs.symlinkSync(outside, profile, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => storage.logout('douyin')).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
      expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('preserve')
    } finally { fs.rmSync(outside, { recursive: true, force: true }) }
  })

  it.each(['write', 'logout'] as const)('invalidates a Douyin cookie read after %s', async action => {
    const storage = store()
    storage.write('douyin', [authCookie()])
    const release = pauseOpen()
    const pending = storage.cookieHeader('douyin', liveUrl)
    const rejected = expect(pending).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
    if (action === 'write') storage.write('douyin', [authCookie({ value: 'new-session' })])
    else storage.logout('douyin')
    release()
    await rejected
  })
})

describe('Douyin login lifecycle', () => {
  it.each(['sessionid', 'sessionid_ss'])('accepts %s session cookies in the isolated profile and returns only metadata', async name => {
    const driver = { login: vi.fn<BrowserLoginDriver['login']>().mockResolvedValue([authCookie({ name, expirationDate: undefined, session: true })]) }
    const login = manager(driver)
    expect(await login.login('douyin')).toEqual({ cookieCount: 1, authKeysPresent: [name] })
    expect(driver.login).toHaveBeenCalledWith('synthetic-chrome', path.join(root, 'browser-profile', 'douyin'), 'douyin', expect.any(AbortSignal), undefined)
    expect((await login.loginStatus()).douyin).toEqual({ loggedIn: true, cookieCount: 1,
      authKeysPresent: [name], expiresAt: null, hasSessionCookies: true })
    expect(JSON.stringify(await login.loginStatus())).not.toContain('synthetic-private-session')
    await login.dispose()
  })

  it.each([
    [], [authCookie({ name: 'ttwid' }), authCookie({ name: 'uid_tt' })],
    [authCookie({ value: '' })], [authCookie({ value: ' ' })],
    [authCookie({ expirationDate: now - 1 })], [authCookie({ expirationDate: now - 1, session: true })],
    [authCookie({ expirationDate: Number.NaN })], [authCookie({ expirationDate: -1 })],
    [authCookie({ domain: '.douyin.com.evil.invalid' })], [authCookie({ domain: 'v.douyin.com' })],
    [authCookie({ domain: 'douyin.com', hostOnly: true })], [authCookie({ path: '/account' })],
  ].map(cookies => ({ cookies })))('preserves existing authentication after an incomplete export (%j)', async ({ cookies }) => {
    const driver = { login: vi.fn<BrowserLoginDriver['login']>().mockResolvedValueOnce([authCookie()]).mockResolvedValueOnce(cookies) }
    const login = manager(driver)
    await login.login('douyin')
    const file = path.join(root, 'cookies', 'douyin.txt')
    const previous = fs.readFileSync(file)
    await expect(login.login('douyin')).rejects.toMatchObject({ code: 'login-incomplete' })
    expect(fs.readFileSync(file)).toEqual(previous)
    expect((await login.loginStatus()).douyin.loggedIn).toBe(true)
    await login.dispose()
  })

  it('does not create a cookie file for a first anonymous login and can retry', async () => {
    const driver = { login: vi.fn<BrowserLoginDriver['login']>().mockResolvedValueOnce([authCookie({ name: 'ttwid' })]).mockResolvedValueOnce([authCookie()]) }
    const login = manager(driver)
    await expect(login.login('douyin')).rejects.toMatchObject({ code: 'login-incomplete' })
    expect(fs.existsSync(path.join(root, 'cookies', 'douyin.txt'))).toBe(false)
    await expect(login.login('douyin')).resolves.toEqual({ cookieCount: 1, authKeysPresent: ['sessionid'] })
    await login.dispose()
  })

  it('updates login and headers when authentication expires', async () => {
    let clock = now
    const login = manager({ login: async () => [authCookie()] }, () => clock)
    await login.login('douyin')
    expect((await login.loginStatus()).douyin.expiresAt).toBe(now + 60)
    clock = now + 61
    expect((await login.loginStatus()).douyin).toEqual({ loggedIn: false, cookieCount: 0,
      authKeysPresent: [], expiresAt: null, hasSessionCookies: false })
    expect(await login.cookieHeader('douyin', liveUrl)).toBe('')
    await login.dispose()
  })

  it('waits for the active browser owner before clearing its profile and rejects late authentication', async () => {
    let finish!: (cookies: BrowserCookie[]) => void
    let signal!: AbortSignal
    const login = manager({ login: (_exe, _profile, _platform, currentSignal) => {
      signal = currentSignal
      return new Promise(resolve => { finish = resolve })
    } })
    const pending = login.login('douyin')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    await expect(login.login('douyin')).rejects.toMatchObject({ code: 'login-busy' })
    const logout = login.logout('douyin')
    expect(signal.aborted).toBe(true)
    expect(fs.existsSync(path.join(root, 'browser-profile', 'douyin'))).toBe(true)
    await expect(login.login('douyin')).rejects.toMatchObject({ code: 'login-busy' })
    finish([authCookie()])
    await logout
    await rejected
    expect(fs.existsSync(path.join(root, 'browser-profile', 'douyin'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'cookies', 'douyin.txt'))).toBe(false)
    expect((await login.loginStatus()).douyin.loggedIn).toBe(false)
    await login.dispose()
  })

  it.each(['logout', 'login', 'dispose'] as const)('discards a pending header after %s invalidates credentials', async action => {
    const driver = { login: vi.fn<BrowserLoginDriver['login']>().mockResolvedValue([authCookie({ value: 'old-session' })]) }
    const login = manager(driver)
    await login.login('douyin')
    const release = pauseOpen()
    const pending = login.cookieHeader('douyin', liveUrl)
    if (action === 'logout') await login.logout('douyin')
    else if (action === 'dispose') await login.dispose()
    else { driver.login.mockResolvedValue([authCookie({ value: 'new-session' })]); await login.login('douyin') }
    release()
    expect(await pending).toBe('')
    if (action === 'login') expect(await login.cookieHeader('douyin', liveUrl)).toBe('sessionid=new-session')
    await login.dispose()
  })

  it('masks cookie storage diagnostics at the manager boundary', async () => {
    const login = manager({ login: async () => [authCookie()] })
    await login.login('douyin')
    vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error('synthetic-private-session and private path'))
    await expect(login.cookieHeader('douyin', liveUrl)).rejects.toMatchObject({ code: 'cookie-storage-failed', message: '登录信息保存失败, 请重试.' })
    await expect(login.loginStatus()).rejects.toMatchObject({ code: 'cookie-storage-failed', message: '登录信息保存失败, 请重试.' })
    await login.dispose()
  })
})

function fakeChild(pid: number) {
  const writer = new PassThrough(), reader = new PassThrough()
  return Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null,
    stdio: [null, null, null, writer, reader], kill: vi.fn(() => true), writer, reader,
  }) as unknown as ChildProcess & { writer: PassThrough; reader: PassThrough }
}

describe('Douyin Chrome cookie pipe', () => {
  it('accepts session authentication after anonymous polling without opening an account page or reading a default profile', async () => {
    const manual = fakeChild(101), headless = fakeChild(102)
    const methods: string[] = []
    headless.writer.on('data', (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString('utf8').replace(/\0$/, '')) as { id: number; method: string }
      methods.push(command.method)
      if (command.method === 'Browser.close') { Object.assign(headless, { exitCode: 0 }); headless.emit('exit', 0, null); return }
      const cookies = command.id === 1 ? [{ domain: '.douyin.com', path: '/', name: 'ttwid', value: 'anonymous' }]
        : [{ domain: '.douyin.com', path: '/', name: 'sessionid_ss', value: 'synthetic-auth', expires: -1, secure: true, httpOnly: true }]
      queueMicrotask(() => headless.reader.write(`${JSON.stringify({ id: command.id, result: { cookies } })}\0`))
    })
    const spawn = vi.fn((_executable: string, args: string[]) => {
      if (args.includes('--headless=new')) return headless
      queueMicrotask(() => { Object.assign(manual, { exitCode: 0 }); manual.emit('exit', 0, null) })
      return manual
    })
    const profile = path.join(root, 'synthetic-profile')
    const driver = new ChromeLoginDriver({ spawn, killTree: async () => {}, platform: 'win32',
      windowPollMs: 1, releaseDelayMs: 0, cookieRetryMs: 1 })
    expect(await driver.login('synthetic-chrome', profile, 'douyin', new AbortController().signal)).toEqual([
      { domain: '.douyin.com', path: '/', name: 'sessionid_ss', value: 'synthetic-auth', secure: true,
        httpOnly: true, hostOnly: false, session: true, expirationDate: undefined },
    ])
    expect(methods).toEqual(['Storage.getCookies', 'Storage.getCookies', 'Browser.close'])
    expect(spawn.mock.calls[0]![1].at(-1)).toBe(liveUrl)
    expect(spawn.mock.calls[1]![1]).toContain('--remote-debugging-pipe')
    for (const [, args] of spawn.mock.calls) expect(args).toContain(`--user-data-dir=${profile}`)
  })
})
