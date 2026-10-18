import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChromeLoginDriver, LoginManager } from './login'
import type { BrowserLoginDriver } from './login'
import type { BrowserCookie } from './cookies'

let root: string
const cookies: BrowserCookie[] = [{ domain: '.youtube.com', path: '/', name: 'SAPISID', value: 'never-leak-this-value', session: true }]
const permissions = { protect: () => {}, verify: () => {} }
beforeEach(() => { root = fs.mkdtempSync(path.join(process.cwd(), '.cookie-tests-login-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

function fixture(driver: BrowserLoginDriver = { login: vi.fn(async () => cookies) }) {
  return { driver, manager: new LoginManager(root, { driver, chromeExecutable: 'test-chrome', permissions }) }
}

describe('LoginManager', () => {
  it('launches the dedicated platform profile and returns only safe metadata', async () => {
    const { manager, driver } = fixture()
    expect(await manager.login('youtube')).toEqual({ cookieCount: 1, authKeysPresent: ['SAPISID'] })
    expect(driver.login).toHaveBeenCalledWith('test-chrome', path.join(root, 'browser-profile', 'youtube'), 'youtube', expect.any(AbortSignal))
    expect(await manager.loginStatus()).toMatchObject({ youtube: { loggedIn: true, hasSessionCookies: true } })
    expect(JSON.stringify(await manager.loginStatus())).not.toContain('never-leak-this-value')
    await manager.dispose()
  })

  it('classifies missing Chrome and can retry without a stale operation', async () => {
    const driver = { login: vi.fn(async () => cookies) }
    const manager = new LoginManager(root, { driver, findChrome: () => undefined, permissions })
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'chrome-not-found' })
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'chrome-not-found' })
    expect(driver.login).not.toHaveBeenCalled()
  })

  it('masks browser exceptions that may contain credentials', async () => {
    const { manager } = fixture({ login: async () => { throw new Error('cookie=never-leak-this-value') } })
    await expect(manager.login('youtube')).rejects.toMatchObject({ code: 'login-failed', message: 'Chrome 登录或账号导出失败, 请关闭此平台的登录窗口后重试.' })
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
})

function fakeChild(pid: number) {
  const writer = new PassThrough()
  const reader = new PassThrough()
  return Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null, stdio: [null, null, null, writer, reader],
    kill: vi.fn(() => true), writer, reader,
  }) as unknown as ChildProcess & { writer: PassThrough; reader: PassThrough }
}

describe('system Chrome pipe login', () => {
  it('waits for the plain login window to close before opening a headless pipe without a listening port', async () => {
    const manual = fakeChild(101)
    const headless = fakeChild(102)
    const commands: Array<{ id: number; method: string }> = []
    headless.writer.on('data', (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString('utf8').replace(/\0$/, '')) as { id: number; method: string }
      commands.push(command)
      if (command.id === 1) queueMicrotask(() => headless.reader.write(JSON.stringify({ id: 1, result: { cookies: [
        { domain: '.youtube.com', path: '/', name: 'SAPISID', value: 'secret', expires: 2_000_000_000, secure: true },
      ] } }) + '\0'))
    })
    const spawn = vi.fn((_executable: string, args: string[], _options: SpawnOptions) => {
      if (args.includes('--headless=new')) { expect(manual.exitCode).toBe(0); return headless }
      queueMicrotask(() => { Object.assign(manual, { exitCode: 0 }); manual.emit('exit', 0, null) })
      return manual
    })
    const killTree = vi.fn(async (child: ChildProcess) => { Object.assign(child, { exitCode: 0 }); child.emit('exit', 0, null) })
    const driver = new ChromeLoginDriver({ spawn, killTree, platform: 'win32', windowPollMs: 1, releaseDelayMs: 0 })
    const result = await driver.login('chrome', '/private/profile', 'youtube', new AbortController().signal)
    expect(result).toEqual([{ domain: '.youtube.com', path: '/', name: 'SAPISID', value: 'secret', expirationDate: 2_000_000_000,
      secure: true, httpOnly: false, hostOnly: false, session: false }])
    expect(spawn).toHaveBeenCalledTimes(2)
    const manualArgs = spawn.mock.calls[0]![1]
    expect(manualArgs).toContain('--disable-sync')
    expect(manualArgs.some(argument => argument.includes('remote-debugging'))).toBe(false)
    const exportArgs = spawn.mock.calls[1]![1]
    expect(exportArgs).toContain('--remote-debugging-pipe')
    expect(exportArgs.some(argument => argument.includes('remote-debugging-port'))).toBe(false)
    for (const call of spawn.mock.calls) expect(call[2].shell).toBe(false)
    expect(commands.map(command => command.method)).toEqual(['Storage.getCookies', 'Browser.close'])
    expect(killTree).toHaveBeenCalledWith(headless)
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

  it('allows a resident Chrome tree to be terminated after its window closes', async () => {
    vi.useFakeTimers()
    try {
      const manual = fakeChild(101)
      const headless = fakeChild(102)
      headless.writer.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Storage.getCookies')) headless.reader.write('{"id":1,"result":{"cookies":[]}}\0')
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
      await expect(pending).resolves.toEqual([])
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
