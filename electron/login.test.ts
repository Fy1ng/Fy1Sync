import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChromeLoginDriver, LoginManager } from './login'
import type { BrowserLoginDriver } from './login'
import type { BrowserCookie } from './cookies'
import { CookieStore } from './cookies'
import type { EmbeddedLoginDriver, EmbeddedLoginRequest } from './embeddedLoginContracts'

let root: string
const cookies: BrowserCookie[] = [{ domain: '.youtube.com', path: '/', name: 'SAPISID', value: 'never-leak-this-value', session: true }]
const invalidDestinations = [
  { platform: 'douyu', destination: 'https://outside.example/' },
  { platform: 'douyu', destination: 'https://yuba.douyu.com/' },
  { platform: 'douyu', destination: 'youtube' },
  { platform: 'douyu', destination: null },
  { platform: 'douyu', destination: { url: 'https://yuba.douyu.com/' } },
  { platform: 'youtube', destination: 'yuba' },
  { platform: 'youtube', destination: 'room:9999' },
  { platform: 'douyu', destination: 'room:0' },
  { platform: 'douyu', destination: 'room:09999' },
  { platform: 'douyu', destination: 'room:9999?next=https://outside.example/' },
  { platform: 'douyu', destination: 'room:1234567890123' },
  { platform: 'douyu', destination: 'room:9999\n' },
  { platform: 'youtube', destination: 'fish-act:9999' },
  { platform: 'douyin', destination: 'yuba' },
  { platform: 'douyin', destination: 'room:9999' },
  { platform: 'douyu', destination: 'fish-act:9999&other=1' },
  { platform: 'douyu', destination: 'fish-act:0' },
] as const
beforeEach(() => {
  const temporary = os.tmpdir()
  fs.mkdirSync(temporary, { recursive: true })
  root = fs.mkdtempSync(path.join(temporary, 'login-'))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

function fixture(driver: BrowserLoginDriver = { login: vi.fn(async () => cookies) }) {
  return { driver, manager: new LoginManager(root, { driver, chromeExecutable: 'test-chrome' }) }
}


function pauseOpen(): () => void {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const open = fs.promises.open
  vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => { await ready; return open(...args) })
  return () => release()
}

describe('LoginManager', () => {
  it('launches the dedicated platform profile and returns only safe metadata', async () => {
    const { manager, driver } = fixture()
    expect(await manager.login('youtube')).toEqual({ cookieCount: 1, authKeysPresent: ['SAPISID'] })
    expect(driver.login).toHaveBeenCalledWith('test-chrome', path.join(root, 'browser-profile', 'youtube'), 'youtube', expect.any(AbortSignal), undefined)
    expect(await manager.loginStatus()).toMatchObject({ youtube: { loggedIn: true, hasSessionCookies: true } })
    expect(JSON.stringify(await manager.loginStatus())).not.toContain('never-leak-this-value')
    await manager.dispose()
  })

  it('reuses the Douyu profile for Yuba and preserves cookie request scopes', async () => {
    const douyuCookies: BrowserCookie[] = [
      { domain: 'www.douyu.com', path: '/', name: 'acf_auth', value: 'synthetic-main', hostOnly: true, session: true },
      { domain: '.douyu.com', path: '/', name: 'acf_uid', value: '42', session: true },
      { domain: 'yuba.douyu.com', path: '/', name: 'acf_yb_t', value: 'synthetic-yuba', hostOnly: true, session: true },
    ]
    const driver = { login: vi.fn<BrowserLoginDriver['login']>().mockResolvedValueOnce(douyuCookies.slice(0, 2)).mockResolvedValueOnce(douyuCookies) }
    const { manager } = fixture(driver)
    await manager.login('douyu')
    expect(await manager.login('douyu', 'yuba')).toEqual({ cookieCount: 3, authKeysPresent: ['acf_uid', 'acf_auth'] })
    const profile = path.join(root, 'browser-profile', 'douyu')
    expect(driver.login).toHaveBeenNthCalledWith(1, 'test-chrome', profile, 'douyu', expect.any(AbortSignal), undefined)
    expect(driver.login).toHaveBeenNthCalledWith(2, 'test-chrome', profile, 'douyu', expect.any(AbortSignal), 'yuba')
    const yuba = await manager.cookieHeader('douyu', 'https://yuba.douyu.com/')
    expect(yuba).toContain('acf_uid=42')
    expect(yuba).toContain('acf_yb_t=synthetic-yuba')
    expect(yuba).not.toContain('synthetic-main')
    const main = await manager.cookieHeader('douyu', 'https://www.douyu.com/')
    expect(main).toContain('acf_auth=synthetic-main')
    expect(main).not.toContain('synthetic-yuba')
    expect(JSON.stringify(await manager.loginStatus())).not.toContain('synthetic-')
    await manager.dispose()
  })

  it.each(invalidDestinations)('rejects unsupported destinations before finding Chrome or preparing a profile (%j)', async ({ platform, destination }) => {
    const findChrome = vi.fn(() => 'test-chrome')
    const driver = { login: vi.fn(async () => cookies) }
    const manager = new LoginManager(root, { driver, findChrome })
    await expect(manager.login(platform, destination as unknown as 'yuba')).rejects.toMatchObject({ code: 'login-failed' })
    expect(findChrome).not.toHaveBeenCalled()
    expect(driver.login).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
    await manager.dispose()
  })

  it('classifies missing Chrome and can retry without a stale operation', async () => {
    const driver = { login: vi.fn(async () => cookies) }
    const manager = new LoginManager(root, { driver, findChrome: () => undefined })
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'chrome-not-found' })
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'chrome-not-found' })
    expect(driver.login).not.toHaveBeenCalled()
  })

  it('masks browser exceptions that may contain credentials', async () => {
    const { manager } = fixture({ login: async () => { throw new Error('cookie=never-leak-this-value') } })
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'login-failed', message: '平台登录或账号读取失败, 请关闭此平台的登录页面后重试.' })
  })

  it.each([
    [],
    [{ domain: '.youtube.com', name: 'PREF', value: 'synthetic-pref' }],
    [{ domain: '.outside.example', name: 'SAPISID', value: 'synthetic-wrong-domain' }],
    [{ domain: '.youtube.com', name: 'SAPISID', value: 'synthetic-expired', expirationDate: 1 }],
    [{ domain: '.youtube.com', name: 'SAPISID', value: '' }],
  ].map(missing => ({ missing })))('preserves an existing cookie file when export lacks valid authentication (%j)', async ({ missing }) => {
    const driver = { login: vi.fn<BrowserLoginDriver['login']>().mockResolvedValueOnce(cookies).mockResolvedValueOnce(missing) }
    const { manager } = fixture(driver)
    await manager.login('youtube')
    const target = path.join(root, 'cookies', 'youtube.txt')
    const previous = fs.readFileSync(target)
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'login-incomplete', message: expect.stringContaining('登录未完成') })
    expect(fs.readFileSync(target)).toEqual(previous)
    expect((await manager.loginStatus()).youtube.loggedIn).toBe(true)
    await manager.dispose()
  })

  it('does not create an empty cookie file after an incomplete first login', async () => {
    const { manager } = fixture({ login: async () => [] })
    await expect(manager.login('douyu')).rejects.toMatchObject({ code: 'login-incomplete' })
    expect(fs.existsSync(path.join(root, 'cookies', 'douyu.txt'))).toBe(false)
    await manager.dispose()
  })

  it('rejects duplicate login and aborts the current profile owner before logout', async () => {
    let browserStopped = false
    const { manager } = fixture({ login: (_executable, _profile, _platform, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { browserStopped = true; reject(new Error('aborted private browser')) }, { once: true })
    }) })
    const login = manager.login('youtube')
    const rejected = expect(login).rejects.toMatchObject({ code: 'login-cancelled' })
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'login-busy' })
    await manager.logout('youtube')
    await rejected
    expect(browserStopped).toBe(true)
    expect(fs.existsSync(path.join(root, 'browser-profile', 'youtube'))).toBe(false)
    expect((await manager.loginStatus()).youtube.loggedIn).toBe(false)
  })

  it('does not save cookies from a late browser response after cancellation', async () => {
    let finish!: (value: BrowserCookie[]) => void
    const { manager } = fixture({ login: () => new Promise(resolve => { finish = resolve }) })
    const login = manager.login('youtube')
    const rejected = expect(login).rejects.toMatchObject({ code: 'login-cancelled' })
    const logout = manager.logout('youtube')
    finish(cookies)
    await logout
    await rejected
    expect((await manager.loginStatus()).youtube.loggedIn).toBe(false)
  })

  it.each([undefined, 'yuba'] as const)('shares the Douyu login lock and logout cancellation with destination %s', async destination => {
    const { manager, driver } = fixture({ login: vi.fn((_executable, _profile, _platform, signal) => new Promise<BrowserCookie[]>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('synthetic cancellation')), { once: true })
    })) })
    const pending = manager.login('douyu', destination)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    await expect(manager.login('douyu')).rejects.toMatchObject({ code: 'login-busy' })
    await expect(manager.login('douyu', 'yuba')).rejects.toMatchObject({ code: 'login-busy' })
    await manager.logout('douyu')
    await rejected
    expect(driver.login).toHaveBeenCalledTimes(1)
    expect((await manager.loginStatus()).douyu.loggedIn).toBe(false)
    await manager.dispose()
  })

  it('aborts active logins on disposal and prevents further profile launch', async () => {
    const { manager, driver } = fixture({ login: vi.fn((_executable, _profile, _platform, signal) => new Promise<BrowserCookie[]>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    })) })
    const login = manager.login('douyu')
    const rejected = expect(login).rejects.toMatchObject({ code: 'login-cancelled' })
    await manager.dispose()
    await rejected
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'login-cancelled' })
    expect(driver.login).toHaveBeenCalledTimes(1)
    expect(await manager.cookieHeader('douyu')).toBe('')
  })

  it('exposes temporary cookie context only to the main-process consumer', async () => {
    const { manager } = fixture()
    await manager.login('youtube')
    let temporary = ''
    await manager.withTemporaryCookies('youtube', async file => { temporary = file!; expect(fs.existsSync(file!)).toBe(true) })
    expect(fs.existsSync(temporary)).toBe(false)
    await manager.logout('youtube')
    expect((await manager.loginStatus()).youtube.loggedIn).toBe(false)
  })

  it.each(['logout', 'login', 'dispose'] as const)('discards a cookie read that finishes after %s invalidation', async action => {
    const oldCookies: BrowserCookie[] = [{ domain: '.douyu.com', name: 'acf_auth', value: 'old-session', session: true }, { domain: '.douyu.com', name: 'acf_uid', value: '42', session: true }]
    const newCookies: BrowserCookie[] = [{ domain: '.douyu.com', name: 'acf_auth', value: 'new-session', session: true }, { domain: '.douyu.com', name: 'acf_uid', value: '42', session: true }]
    const release = pauseOpen()
    const driver = { login: vi.fn<BrowserLoginDriver['login']>().mockResolvedValue(oldCookies) }
    const manager = new LoginManager(root, { chromeExecutable: 'test-chrome', driver })
    await manager.login('douyu')
    const pending = manager.cookieHeader('douyu')
    if (action === 'logout') await manager.logout('douyu')
    else if (action === 'dispose') await manager.dispose()
    else { driver.login.mockResolvedValue(newCookies); await manager.login('douyu') }
    release()
    await expect(pending).resolves.toBe('')
    if (action === 'login') await expect(manager.cookieHeader('douyu')).resolves.toBe('acf_auth=new-session; acf_uid=42')
    await manager.dispose()
  })

  it('masks asynchronous storage errors at the public login boundary', async () => {
    const driver = { login: vi.fn<BrowserLoginDriver['login']>().mockResolvedValue([{ domain: '.douyu.com', name: 'acf_auth', value: 'secret', session: true }, { domain: '.douyu.com', name: 'acf_uid', value: '42', session: true }]) }
    const manager = new LoginManager(root, { chromeExecutable: 'test-chrome', driver })
    await manager.login('douyu')
    vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error('private filesystem error and cookie data'))
    await expect(manager.cookieHeader('douyu')).rejects.toMatchObject({ code: 'cookie-storage-failed', message: '登录信息保存失败, 请重试.' })
    await expect(manager.loginStatus()).rejects.toMatchObject({ code: 'cookie-storage-failed', message: '登录信息保存失败, 请重试.' })
    await manager.dispose()
  })

  it('never delivers a temporary cookie file to a consumer after disposal during a pending file read', async () => {
    const release = pauseOpen()
    const manager = new LoginManager(root, { chromeExecutable: 'test-chrome', driver: { login: vi.fn(async () => cookies) } })
    await manager.login('youtube')
    const consumer = vi.fn(async () => 'must not run')
    const pending = manager.withTemporaryCookies('youtube', consumer)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    await manager.dispose()
    release()
    await rejected
    expect(consumer).not.toHaveBeenCalled()
    expect(fs.readdirSync(path.join(root, 'cookies'))).toEqual(['youtube.txt'])
  })
})

function fakeChild(pid: number) {
  const writer = new PassThrough()
  const reader = new PassThrough()
  return Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null, stdio: [null, null, null, writer, reader],
    kill: vi.fn(() => true), writer, reader,
  }) as unknown as ChildProcess & { writer: PassThrough; reader: PassThrough }
}

describe('embedded platform LoginManager', () => {
  const auth = (platform: 'douyu' | 'bilibili' | 'huya', value = 'fixture-private-ticket'): BrowserCookie[] => {
    const names = platform === 'douyu' ? ['acf_uid', 'acf_auth'] : platform === 'bilibili' ? ['DedeUserID', 'SESSDATA'] : ['udb_uid', 'udb_biztoken']
    return names.map((name, index) => ({ domain: `.${platform}.com`, path: '/', name, value: index ? value : '42',
      session: true, secure: true, httpOnly: true, sameSite: 'lax' }))
  }

  it.each(['douyu', 'bilibili', 'huya'] as const)('uses %s embedded login without finding Chrome or creating browser profiles', async platform => {
    const findChrome = vi.fn(() => undefined)
    const driver = { login: vi.fn(async () => cookies) }
    const embeddedDriver = { login: vi.fn<EmbeddedLoginDriver['login']>(async () => auth(platform)) }
    const manager = new LoginManager(root, { driver, embeddedDriver, findChrome })
    const result = await manager.login(platform, undefined, '账号甲')
    expect(result).toMatchObject({ cookieCount: 2 })
    expect(embeddedDriver.login).toHaveBeenCalledExactlyOnceWith({ platform, signal: expect.any(AbortSignal), destination: undefined, accountLabel: '账号甲' })
    expect(findChrome).not.toHaveBeenCalled()
    expect(driver.login).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, 'browser-profile'))).toBe(false)
    expect((await manager.loginStatus())[platform].loggedIn).toBe(true)
    expect(JSON.stringify(result)).not.toContain('fixture-private-ticket')
    await manager.dispose()
  })

  it.each(['bilibili', 'huya'] as const)('fails closed when %s has no embedded driver', async platform => {
    const findChrome = vi.fn(() => 'fixture-chrome')
    const driver = { login: vi.fn(async () => cookies) }
    const manager = new LoginManager(root, { findChrome, driver })
    await expect(manager.login(platform)).rejects.toMatchObject({ code: 'login-failed' })
    expect(findChrome).not.toHaveBeenCalled()
    expect(driver.login).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
    const spawn = vi.fn(() => fakeChild(101))
    await expect(new ChromeLoginDriver({ spawn }).login('chrome', root, platform, new AbortController().signal)).rejects.toMatchObject({ code: 'login-failed' })
    expect(spawn).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('keeps YouTube on the existing Chrome driver when an embedded driver exists', async () => {
    const embeddedDriver = { login: vi.fn(async () => auth('douyu')) }
    const driver = { login: vi.fn(async () => cookies) }
    const manager = new LoginManager(root, { driver, embeddedDriver, chromeExecutable: 'test-chrome' })
    await manager.login('youtube')
    expect(driver.login).toHaveBeenCalledTimes(1)
    expect(embeddedDriver.login).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it.each(['yuba', 'room:9999', 'fish-act:9999'] as const)('injects only the initiating account for website destination %s', async destination => {
    const first = new CookieStore(root)
    first.write('douyu', auth('douyu', 'fixture-account-a'))
    const otherRoot = path.join(root, 'other-account')
    fs.mkdirSync(otherRoot)
    new CookieStore(otherRoot).write('douyu', auth('douyu', 'fixture-account-b'))
    first.write('bilibili', auth('bilibili', 'fixture-bili'))
    const set = vi.fn(async (_details: unknown) => {})
    const embeddedDriver = { login: vi.fn<EmbeddedLoginDriver['login']>(async request => {
      expect(request.destination).toBe(destination)
      expect(request.accountLabel).toBe('启动账号')
      await request.initializeSession!({ cookies: { set } })
      return auth('douyu', 'fixture-account-a')
    }) }
    const manager = new LoginManager(root, { embeddedDriver })
    await manager.login('douyu', destination, '启动账号')
    expect(set).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(set.mock.calls)).toContain('fixture-account-a')
    expect(JSON.stringify(set.mock.calls)).not.toMatch(/fixture-account-b|fixture-bili/)
    expect(set.mock.calls[1]![0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' })
    await manager.dispose()
  })

  it('starts a normal login without initializing the previous session', async () => {
    new CookieStore(root).write('douyu', auth('douyu', 'old-ticket'))
    const embeddedDriver = { login: vi.fn<EmbeddedLoginDriver['login']>(async request => {
      expect(request.initializeSession).toBeUndefined()
      return auth('douyu', 'new-ticket')
    }) }
    const manager = new LoginManager(root, { embeddedDriver })
    await manager.login('douyu')
    expect(await manager.cookieHeader('douyu')).toContain('acf_auth=new-ticket')
    await manager.dispose()
  })

  it.each(['douyu', 'bilibili', 'huya'] as const)('keeps previous %s credentials on incomplete or failed embedded authentication', async platform => {
    new CookieStore(root).write(platform, auth(platform, 'old-ticket'))
    const file = path.join(root, 'cookies', `${platform}.txt`)
    const previous = fs.readFileSync(file)
    const embeddedDriver = { login: vi.fn<EmbeddedLoginDriver['login']>().mockResolvedValueOnce(auth(platform).slice(0, 1))
      .mockRejectedValueOnce(new Error('private-cookie=secret-value')) }
    const manager = new LoginManager(root, { embeddedDriver })
    await expect(manager.login(platform)).rejects.toMatchObject({ code: 'login-incomplete' })
    expect(fs.readFileSync(file)).toEqual(previous)
    await expect(manager.login(platform)).rejects.toMatchObject({ code: 'login-failed' })
    expect(fs.readFileSync(file)).toEqual(previous)
    expect((await manager.loginStatus())[platform].loggedIn).toBe(true)
    await manager.dispose()
  })

  it.each(['douyu', 'bilibili', 'huya'] as const)('rejects duplicate %s attempts and suppresses late writes after logout', async platform => {
    let finish!: (value: BrowserCookie[]) => void
    let request!: EmbeddedLoginRequest
    const embeddedDriver = { login: vi.fn<EmbeddedLoginDriver['login']>(value => { request = value; return new Promise(resolve => { finish = resolve }) }) }
    const manager = new LoginManager(root, { embeddedDriver })
    const pending = manager.login(platform)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    await expect(manager.login(platform)).rejects.toMatchObject({ code: 'login-busy' })
    const logout = manager.logout(platform)
    expect(request.signal.aborted).toBe(true)
    finish(auth(platform))
    await logout
    await rejected
    expect(fs.existsSync(path.join(root, 'cookies', `${platform}.txt`))).toBe(false)
    await manager.dispose()
  })

  it('rejects a website initializer after its initiating attempt is cancelled', async () => {
    new CookieStore(root).write('douyu', auth('douyu'))
    let request!: EmbeddedLoginRequest
    const embeddedDriver = { login: vi.fn<EmbeddedLoginDriver['login']>(value => {
      request = value
      return new Promise((_resolve, reject) => value.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }) }
    const manager = new LoginManager(root, { embeddedDriver })
    const rejected = expect(manager.login('douyu', 'yuba')).rejects.toMatchObject({ code: 'login-cancelled' })
    await manager.dispose()
    await rejected
    const set = vi.fn(async () => {})
    await expect(request.initializeSession!({ cookies: { set } })).rejects.toMatchObject({ code: 'login-cancelled' })
    expect(set).not.toHaveBeenCalled()
  })

  it.each(['bilibili', 'huya'] as const)('discards a pending %s header after a login revision changes', async platform => {
    const embeddedDriver = { login: vi.fn<EmbeddedLoginDriver['login']>().mockResolvedValue(auth(platform, 'old-ticket')) }
    const manager = new LoginManager(root, { embeddedDriver })
    await manager.login(platform)
    const release = pauseOpen()
    const pending = manager.cookieHeader(platform)
    embeddedDriver.login.mockResolvedValue(auth(platform, 'new-ticket'))
    await manager.login(platform)
    release()
    expect(await pending).toBe('')
    expect(await manager.cookieHeader(platform)).toContain('new-ticket')
    await manager.dispose()
  })
})

describe('system Chrome pipe login', () => {
  it.each([
    { platform: 'youtube', destination: undefined, url: 'https://www.youtube.com' },
    { platform: 'douyu', destination: undefined, url: 'https://www.douyu.com' },
    { platform: 'douyin', destination: undefined, url: 'https://live.douyin.com/' },
    { platform: 'douyu', destination: 'yuba', url: 'https://yuba.douyu.com/' },
    { platform: 'douyu', destination: 'room:9999', url: 'https://www.douyu.com/9999' },
    { platform: 'douyu', destination: 'fish-act:9999', url: 'https://www.douyu.com/pages/fish-act?rid=9999' },
  ] as const)('waits for the fixed $url login window to close before exporting from the same profile over a pipe', async ({ platform, destination, url }) => {
    const manual = fakeChild(101)
    const headless = fakeChild(102)
    const domain = platform === 'youtube' ? '.youtube.com' : platform === 'douyu' ? '.douyu.com' : '.douyin.com'
    const name = platform === 'youtube' ? 'SAPISID' : platform === 'douyu' ? 'acf_auth' : 'sessionid'
    const commands: Array<{ id: number; method: string }> = []
    headless.writer.on('data', (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString('utf8').replace(/\0$/, '')) as { id: number; method: string }
      commands.push(command)
      if (command.method === 'Browser.close') { Object.assign(headless, { exitCode: 0 }); headless.emit('exit', 0, null) }
      if (command.id === 1) queueMicrotask(() => headless.reader.write(JSON.stringify({ id: 1, result: { cookies: [
        { domain, path: '/', name, value: 'secret', expires: 2_000_000_000, secure: true },
        ...(platform === 'douyu' ? [{ domain, path: '/', name: 'acf_uid', value: '42', expires: 2_000_000_000, secure: true }] : []),
      ] } }) + '\0'))
    })
    const spawn = vi.fn((_executable: string, args: string[], _options: SpawnOptions) => {
      if (args.includes('--headless=new')) { expect(manual.exitCode).toBe(0); return headless }
      queueMicrotask(() => { Object.assign(manual, { exitCode: 0 }); manual.emit('exit', 0, null) })
      return manual
    })
    const killTree = vi.fn(async (child: ChildProcess) => { Object.assign(child, { exitCode: 0 }); child.emit('exit', 0, null) })
    const driver = new ChromeLoginDriver({ spawn, killTree, platform: 'win32', windowPollMs: 1, releaseDelayMs: 0 })
    const result = await driver.login('chrome', '/private/profile', platform, new AbortController().signal, destination)
    expect(result).toEqual([{ domain, path: '/', name, value: 'secret', expirationDate: 2_000_000_000,
      secure: true, httpOnly: false, hostOnly: false, session: false },
    ...(platform === 'douyu' ? [{ domain, path: '/', name: 'acf_uid', value: '42', expirationDate: 2_000_000_000,
      secure: true, httpOnly: false, hostOnly: false, session: false }] : [])])
    expect(spawn).toHaveBeenCalledTimes(2)
    const manualArgs = spawn.mock.calls[0]![1]
    expect(manualArgs.at(-1)).toBe(url)
    expect(manualArgs).toContain('--new-window')
    expect(manualArgs).toContain('--disable-sync')
    expect(manualArgs.some(argument => argument.includes('remote-debugging'))).toBe(false)
    const exportArgs = spawn.mock.calls[1]![1]
    expect(exportArgs).toContain('--remote-debugging-pipe')
    expect(exportArgs.some(argument => argument.includes('remote-debugging-port'))).toBe(false)
    for (const call of spawn.mock.calls) {
      expect(call[1]).toContain('--user-data-dir=/private/profile')
      expect(call[2].shell).toBe(false)
    }
    expect(commands.map(command => command.method)).toEqual(['Storage.getCookies', 'Browser.close'])
    expect(killTree).toHaveBeenCalledWith(headless)
  })

  it.each(invalidDestinations)('refuses unsupported destinations before spawning Chrome (%j)', async ({ platform, destination }) => {
    const spawn = vi.fn(() => fakeChild(101))
    const driver = new ChromeLoginDriver({ spawn })
    await expect(driver.login('chrome', '/private/profile', platform, new AbortController().signal, destination as unknown as 'yuba'))
      .rejects.toMatchObject({ code: 'login-failed' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('kills the headless cookie reader on protocol timeout', async () => {
    const manual = fakeChild(101)
    const headless = fakeChild(102)
    const spawn = vi.fn((_executable: string, args: string[]) => {
      if (args.includes('--headless=new')) return headless
      queueMicrotask(() => { Object.assign(manual, { exitCode: 0 }); manual.emit('exit', 0, null) })
      return manual
    })
    const killTree = vi.fn(async () => {})
    const driver = new ChromeLoginDriver({ spawn, killTree, platform: 'win32', windowPollMs: 1, releaseDelayMs: 0, cookieTimeoutMs: 5 })
    await expect(driver.login('chrome', '/private/profile', 'douyu', new AbortController().signal)).rejects.toMatchObject({ code: 'login-failed' })
    expect(killTree).toHaveBeenCalledWith(headless)
  })

  it.each([[], [{ domain: '.youtube.com', name: 'PREF', value: 'synthetic' }]].map(missing => ({ missing })))
    ('bounds cookie polling and rejects an incomplete export (%j)', async ({ missing }) => {
      vi.useFakeTimers()
      try {
        const manual = fakeChild(101)
        const headless = fakeChild(102)
        const commands: string[] = []
        headless.writer.on('data', (chunk: Buffer) => {
          const command = JSON.parse(chunk.toString().replace(/\0$/, '')) as { id: number; method: string }
          commands.push(command.method)
          if (command.method === 'Storage.getCookies') queueMicrotask(() => headless.reader.write(JSON.stringify({ id: command.id, result: { cookies: missing } }) + '\0'))
          else { Object.assign(headless, { exitCode: 0 }); headless.emit('exit', 0, null) }
        })
        const spawn = vi.fn((_executable: string, args: string[]) => {
          if (args.includes('--headless=new')) return headless
          queueMicrotask(() => { Object.assign(manual, { exitCode: 0 }); manual.emit('exit', 0, null) })
          return manual
        })
        const driver = new ChromeLoginDriver({ spawn, killTree: async () => {}, platform: 'win32', windowPollMs: 1, releaseDelayMs: 0, cookieRetryMs: 100 })
        const pending = expect(driver.login('chrome', '/private/profile', 'youtube', new AbortController().signal)).rejects.toMatchObject({ code: 'login-incomplete' })
        await vi.advanceTimersByTimeAsync(500)
        await pending
        expect(commands).toEqual(['Storage.getCookies', 'Storage.getCookies', 'Storage.getCookies', 'Storage.getCookies', 'Browser.close'])
        expect(spawn).toHaveBeenCalledTimes(2)
      } finally { vi.useRealTimers() }
    })

  it('accepts authentication that appears during bounded polling without restarting Chrome', async () => {
    const manual = fakeChild(101)
    const headless = fakeChild(102)
    const ids: number[] = []
    headless.writer.on('data', (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString().replace(/\0$/, '')) as { id: number; method: string }
      if (command.method === 'Browser.close') { Object.assign(headless, { exitCode: 0 }); headless.emit('exit', 0, null); return }
      ids.push(command.id)
      queueMicrotask(() => headless.reader.write(JSON.stringify({ id: command.id, result: { cookies: command.id < 3 ? [] : [
        { domain: '.youtube.com', name: 'SAPISID', value: 'synthetic', session: true },
      ] } }) + '\0'))
    })
    const spawn = vi.fn((_executable: string, args: string[]) => {
      if (args.includes('--headless=new')) return headless
      queueMicrotask(() => { Object.assign(manual, { exitCode: 0 }); manual.emit('exit', 0, null) })
      return manual
    })
    const driver = new ChromeLoginDriver({ spawn, killTree: async () => {}, platform: 'win32', windowPollMs: 1, releaseDelayMs: 0, cookieRetryMs: 1 })
    await expect(driver.login('chrome', '/private/profile', 'youtube', new AbortController().signal)).resolves.toMatchObject([{ name: 'SAPISID' }])
    expect(ids).toEqual([1, 2, 3])
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('waits for Browser.close to exit before forcing the headless reader', async () => {
    vi.useFakeTimers()
    try {
      const manual = fakeChild(101)
      const headless = fakeChild(102)
      headless.writer.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Storage.getCookies')) queueMicrotask(() => headless.reader.write('{"id":1,"result":{"cookies":[{"domain":".youtube.com","name":"SAPISID","value":"synthetic"}]}}\0'))
      })
      const killTree = vi.fn(async (child: ChildProcess) => { Object.assign(child, { exitCode: 0 }); child.emit('exit', 0, null) })
      const spawn = vi.fn((_executable: string, args: string[]) => {
        if (args.includes('--headless=new')) return headless
        queueMicrotask(() => { Object.assign(manual, { exitCode: 0 }); manual.emit('exit', 0, null) })
        return manual
      })
      const driver = new ChromeLoginDriver({ spawn, killTree, platform: 'win32', windowPollMs: 1, releaseDelayMs: 0, gracefulExitTimeoutMs: 500 })
      const pending = driver.login('chrome', '/private/profile', 'youtube', new AbortController().signal)
      await vi.advanceTimersByTimeAsync(100)
      expect(killTree).not.toHaveBeenCalledWith(headless)
      await vi.advanceTimersByTimeAsync(500)
      await expect(pending).resolves.toMatchObject([{ name: 'SAPISID' }])
      expect(killTree).toHaveBeenCalledWith(headless)
    } finally { vi.useRealTimers() }
  })

  it('queries Windows window ownership asynchronously with a hidden PowerShell child', async () => {
    const manual = fakeChild(101)
    const headless = fakeChild(102)
    const query = Object.assign(fakeChild(103), { stdout: new PassThrough() })
    headless.writer.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Storage.getCookies')) queueMicrotask(() => headless.reader.write('{"id":1,"result":{"cookies":[{"domain":".youtube.com","name":"SAPISID","value":"synthetic"}]}}\0'))
      else { Object.assign(headless, { exitCode: 0 }); headless.emit('exit', 0, null) }
    })
    let queryStarted!: () => void
    const started = new Promise<void>(resolve => { queryStarted = resolve })
    const spawn = vi.fn((executable: string, args: string[], _options: SpawnOptions) => {
      if (executable.endsWith('powershell.exe')) { queryStarted(); return query }
      return args.includes('--headless=new') ? headless : manual
    })
    const driver = new ChromeLoginDriver({ spawn, killTree: async () => {}, platform: 'win32', windowPollMs: 1, releaseDelayMs: 0 })
    const pending = driver.login('chrome', '/private/profile', 'youtube', new AbortController().signal)
    await started
    // The query remains pending while the main event loop can process other work.
    await new Promise<void>(resolve => setTimeout(resolve, 1))
    expect(spawn.mock.calls[1]![2]).toMatchObject({ windowsHide: true, shell: false })
    query.stdout.write('no\r\n')
    Object.assign(manual, { exitCode: 0 })
    manual.emit('exit', 0, null)
    query.emit('close', 0, null)
    await expect(pending).resolves.toMatchObject([{ name: 'SAPISID' }])
  })

  it('allows a resident Chrome tree to be terminated after its window closes', async () => {
    vi.useFakeTimers()
    try {
      const manual = fakeChild(101)
      const headless = fakeChild(102)
      headless.writer.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Storage.getCookies')) headless.reader.write('{"id":1,"result":{"cookies":[{"domain":".youtube.com","name":"SAPISID","value":"synthetic"}]}}\0')
        else { Object.assign(headless, { exitCode: 0 }); headless.emit('exit', 0, null) }
      })
      const hasWindow = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
      const killTree = vi.fn(async (child: ChildProcess) => {
        Object.assign(child, { exitCode: 1 })
        child.emit('exit', 1, null)
      })
      const spawn = vi.fn((_executable: string, args: string[]) => args.includes('--headless=new') ? headless : manual)
      const driver = new ChromeLoginDriver({ spawn, killTree, hasWindow, platform: 'win32', windowPollMs: 1000, releaseDelayMs: 0 })
      const pending = driver.login('chrome', '/private/profile', 'youtube', new AbortController().signal)
      await vi.advanceTimersByTimeAsync(8_000)
      expect(killTree).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toMatchObject([{ name: 'SAPISID' }])
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(killTree).toHaveBeenCalledWith(manual)
    } finally { vi.useRealTimers() }
  })

  it('kills the manual browser tree when login is cancelled', async () => {
    const manual = fakeChild(101)
    const killTree = vi.fn(async () => {})
    const driver = new ChromeLoginDriver({ spawn: () => manual, killTree, windowPollMs: 1 })
    const controller = new AbortController()
    const pending = driver.login('chrome', '/private/profile', 'youtube', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    expect(killTree).toHaveBeenCalledWith(manual)
  })
})
