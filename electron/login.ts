import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { CookieStore, isLoginPlatform, LOGIN_PLATFORMS } from './cookies'
import type { BrowserCookie, CookieStoreOptions, LoginPlatform, LoginResult, LoginStatus } from './cookies'
import { powershellEnvironment } from './privateStorage'

export type { LoginPlatform, LoginResult, LoginStatus, PlatformLoginStatus } from './cookies'
export type LoginDestination = 'yuba' | `room:${string}` | `fish-act:${string}`

export type LoginErrorCode = 'chrome-not-found' | 'login-busy' | 'login-cancelled' | 'login-failed' | 'cookie-storage-failed'
export class LoginError extends Error {
  constructor(readonly code: LoginErrorCode) {
    super({ 'chrome-not-found': '未找到系统 Google Chrome, 请先安装 Chrome 后重试.',
      'login-busy': '该平台正在登录, 请先关闭已有的登录窗口.', 'login-cancelled': '登录已取消.',
      'login-failed': 'Chrome 登录或账号导出失败, 请关闭此平台的登录窗口后重试.',
      'cookie-storage-failed': '账号数据读写或私有权限验证失败.' }[code])
    this.name = 'LoginError'
  }
}

export interface BrowserLoginDriver {
  login(executable: string, profile: string, platform: LoginPlatform, signal: AbortSignal, destination?: LoginDestination): Promise<BrowserCookie[]>
}
export interface LoginManagerOptions extends CookieStoreOptions {
  driver?: BrowserLoginDriver
  chromeExecutable?: string
  findChrome?: () => string | undefined
  store?: CookieStore
}

export function findSystemChrome(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const candidates = platform === 'win32' ? [
    path.join(environment.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(environment.LOCALAPPDATA ? [path.join(environment.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  ] : platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile() } catch { return false } })
}

const CHROME_FLAGS = ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-mode']
type SpawnChrome = (executable: string, args: string[], options: SpawnOptions) => ChildProcess
export interface ChromeLoginDriverOptions {
  spawn?: SpawnChrome
  platform?: NodeJS.Platform
  hasWindow?: (pid: number) => boolean
  killTree?: (child: ChildProcess) => Promise<void>
  loginTimeoutMs?: number
  cookieTimeoutMs?: number
  windowPollMs?: number
  releaseDelayMs?: number
}

function cancelled(signal: AbortSignal): void { if (signal.aborted) throw new LoginError('login-cancelled') }
function isLoginDestination(platform: LoginPlatform, destination: unknown): boolean {
  return destination === undefined || (platform === 'douyu' && (destination === 'yuba'
    || (typeof destination === 'string' && /^(room|fish-act):[1-9][0-9]{0,11}$/.test(destination))))
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    cancelled(signal)
    const onAbort = () => { clearTimeout(timer); reject(new LoginError('login-cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class ChromeLoginDriver implements BrowserLoginDriver {
  private readonly spawn: SpawnChrome
  private readonly platform: NodeJS.Platform
  constructor(private readonly options: ChromeLoginDriverOptions = {}) {
    this.spawn = options.spawn ?? spawn
    this.platform = options.platform ?? process.platform
  }

  private hasWindow(pid: number): boolean {
    if (this.options.hasWindow) return this.options.hasWindow(pid)
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { 'yes' } else { 'no' }`], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000, env: powershellEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) throw new LoginError('login-failed')
    return result.stdout.trim() === 'yes'
  }

  private async killTree(child: ChildProcess): Promise<void> {
    if (this.options.killTree) return await this.options.killTree(child)
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    if (this.platform === 'win32') {
      await new Promise<void>(resolve => {
        const killer = this.spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
        const timer = setTimeout(() => { killer.kill(); resolve() }, 5_000)
        const finish = () => { clearTimeout(timer); resolve() }
        killer.once('error', finish)
        killer.once('exit', finish)
      })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const exited = () => { clearTimeout(timer); resolve() }
      child.once('exit', exited)
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        timer = setTimeout(() => { child.removeListener('exit', exited); reject(new LoginError('login-failed')) }, 2_000)
      }, 2_000)
    })
  }

  private async waitForLoginWindow(child: ChildProcess, signal: AbortSignal): Promise<void> {
    let exited = child.exitCode !== null || child.signalCode !== null
    let failed = false
    let stoppingAfterClose = false
    const onExit = (code: number | null) => { exited = true; failed = !stoppingAfterClose && code !== 0 && code !== null }
    const onError = () => { exited = true; failed = true }
    child.on('exit', onExit)
    child.on('error', onError)
    let sawWindow = false
    let disappearedAt = 0
    const deadline = Date.now() + (this.options.loginTimeoutMs ?? 30 * 60_000)
    try {
      while (!exited) {
        cancelled(signal)
        if (Date.now() >= deadline) throw new LoginError('login-failed')
        await delay(this.options.windowPollMs ?? 2_000, signal)
        if (exited) break
        if (this.platform !== 'win32') continue
        if (!child.pid) throw new LoginError('login-failed')
        if (this.hasWindow(child.pid)) { sawWindow = true; disappearedAt = 0; continue }
        if (!sawWindow) continue
        if (!disappearedAt) { disappearedAt = Date.now(); continue }
        if (Date.now() - disappearedAt >= 4_000) {
          stoppingAfterClose = true
          await this.killTree(child)
          break
        }
      }
      cancelled(signal)
      if (failed) throw new LoginError('login-failed')
    } finally {
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
    }
  }

  private async readCookies(executable: string, profile: string, signal: AbortSignal): Promise<BrowserCookie[]> {
    cancelled(signal)
    const child = this.spawn(executable, [`--user-data-dir=${profile}`, ...CHROME_FLAGS, '--headless=new', '--remote-debugging-pipe', 'about:blank'], {
      shell: false, detached: this.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    })
    try {
      return await new Promise<BrowserCookie[]>((resolve, reject) => {
        const writer = child.stdio[3] as Writable | null
        const reader = child.stdio[4] as Readable | null
        let buffered = Buffer.alloc(0)
        let settled = false
        const finish = (error?: LoginError, value?: BrowserCookie[]) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          child.removeListener('error', onFailure)
          child.removeListener('exit', onFailure)
          child.on('error', () => {})
          reader?.removeListener('data', onData)
          // Keep an error listener until the process is killed; late pipe errors contain no diagnostics.
          writer?.on('error', () => {})
          if (error) reject(error)
          else resolve(value ?? [])
        }
        const onFailure = () => finish(new LoginError('login-failed'))
        const onAbort = () => finish(new LoginError('login-cancelled'))
        const onData = (chunk: Buffer) => {
          if (buffered.length + chunk.length > 4 * 1024 * 1024) { onFailure(); return }
          buffered = Buffer.concat([buffered, chunk])
          let end: number
          while ((end = buffered.indexOf(0)) !== -1) {
            const raw = buffered.subarray(0, end).toString('utf8')
            buffered = buffered.subarray(end + 1)
            let message: { id?: number; error?: unknown; result?: { cookies?: Array<Record<string, unknown>> } }
            try { message = JSON.parse(raw) as typeof message } catch { onFailure(); return }
            if (!message || typeof message !== 'object') { onFailure(); return }
            if (message.id !== 1) continue
            const cookies = message.result?.cookies
            if (message.error || !Array.isArray(cookies) || cookies.length > 50_000
              || cookies.some(cookie => !cookie || typeof cookie !== 'object' || typeof cookie.domain !== 'string'
                || typeof cookie.name !== 'string' || typeof cookie.value !== 'string')) { onFailure(); return }
            const selected: BrowserCookie[] = cookies.map(cookie => ({
              domain: cookie.domain as string, name: cookie.name as string, value: cookie.value as string,
              path: cookie.path as string, httpOnly: cookie.httpOnly === true, secure: cookie.secure === true,
              hostOnly: typeof cookie.domain === 'string' && !cookie.domain.startsWith('.'),
              session: cookie.session === true || !(typeof cookie.expires === 'number' && cookie.expires > 0),
              expirationDate: typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires : undefined,
            }))
            writer?.write(`${JSON.stringify({ id: 2, method: 'Browser.close' })}\0`)
            finish(undefined, selected)
          }
        }
        const timer = setTimeout(onFailure, this.options.cookieTimeoutMs ?? 20_000)
        signal.addEventListener('abort', onAbort, { once: true })
        child.once('error', onFailure)
        child.once('exit', onFailure)
        if (!writer || !reader) { onFailure(); return }
        reader.on('data', onData)
        reader.once('error', onFailure)
        writer.once('error', onFailure)
        writer.write(`${JSON.stringify({ id: 1, method: 'Storage.getCookies' })}\0`)
      })
    } finally {
      await this.killTree(child)
    }
  }

  async login(executable: string, profile: string, platform: LoginPlatform, signal: AbortSignal, destination?: LoginDestination): Promise<BrowserCookie[]> {
    cancelled(signal)
    if (!isLoginPlatform(platform) || !isLoginDestination(platform, destination)) throw new LoginError('login-failed')
    const url = destination === 'yuba' ? 'https://yuba.douyu.com/'
      : destination?.startsWith('room:') ? `https://www.douyu.com/${destination.slice(5)}`
      : destination?.startsWith('fish-act:') ? `https://www.douyu.com/pages/fish-act?rid=${destination.slice(9)}` : LOGIN_PLATFORMS[platform].url
    const child = this.spawn(executable, [`--user-data-dir=${profile}`, ...CHROME_FLAGS, '--new-window', url], {
      shell: false, detached: this.platform !== 'win32', windowsHide: false, stdio: 'ignore',
    })
    try { await this.waitForLoginWindow(child, signal) }
    finally { await this.killTree(child) }
    await delay(this.options.releaseDelayMs ?? 1_500, signal)
    return await this.readCookies(executable, profile, signal)
  }
}

/** One profile writer per platform; logout and disposal abort and await any browser owner. */
export class LoginManager {
  private readonly store: CookieStore
  private readonly driver: BrowserLoginDriver
  private readonly operations = new Map<LoginPlatform, { controller: AbortController; promise: Promise<LoginResult> }>()
  private readonly loggingOut = new Set<LoginPlatform>()
  private readonly revisions: Record<LoginPlatform, number> = { youtube: 0, douyu: 0 }
  private disposed = false

  constructor(userDataDirectory: string, private readonly options: LoginManagerOptions = {}) {
    this.store = options.store ?? new CookieStore(userDataDirectory, options)
    this.driver = options.driver ?? new ChromeLoginDriver()
  }

  login(platform: LoginPlatform, destination?: LoginDestination): Promise<LoginResult> {
    if (!isLoginPlatform(platform) || this.disposed) return Promise.reject(new LoginError('login-cancelled'))
    if (!isLoginDestination(platform, destination)) return Promise.reject(new LoginError('login-failed'))
    if (this.operations.has(platform) || this.loggingOut.has(platform)) return Promise.reject(new LoginError('login-busy'))
    this.revisions[platform]++
    const controller = new AbortController()
    const promise = (async () => {
      try {
        const executable = this.options.chromeExecutable ?? (this.options.findChrome ?? findSystemChrome)()
        if (!executable) throw new LoginError('chrome-not-found')
        let profile: string
        try { profile = this.store.prepareProfile(platform) } catch { throw new LoginError('cookie-storage-failed') }
        const cookies = await this.driver.login(executable, profile, platform, controller.signal, destination)
        cancelled(controller.signal)
        try {
          const result = this.store.write(platform, cookies)
          this.revisions[platform]++
          return result
        } catch { throw new LoginError('cookie-storage-failed') }
      } catch (error) {
        if (controller.signal.aborted) throw new LoginError('login-cancelled')
        throw error instanceof LoginError ? error : new LoginError('login-failed')
      } finally {
        this.operations.delete(platform)
      }
    })()
    this.operations.set(platform, { controller, promise })
    // Prevent a synchronous preparation failure from leaving a stale operation.
    void promise.catch(() => {}).finally(() => { if (this.operations.get(platform)?.promise === promise) this.operations.delete(platform) })
    return promise
  }

  async loginStatus(): Promise<LoginStatus> {
    try { return await this.store.status() } catch { throw new LoginError('cookie-storage-failed') }
  }

  async cookieHeader(platform: 'douyu', requestUrl?: string): Promise<string> {
    if (this.disposed || this.loggingOut.has(platform)) return ''
    const revision = this.revisions[platform]
    const current = () => !this.disposed && !this.loggingOut.has(platform) && revision === this.revisions[platform]
    try {
      const header = await this.store.cookieHeader(platform, requestUrl)
      return current() ? header : ''
    } catch {
      if (!current()) return ''
      throw new LoginError('cookie-storage-failed')
    }
  }

  async withTemporaryCookies<T>(platform: 'youtube', callback: (file?: string) => Promise<T>): Promise<T> {
    if (this.disposed || this.loggingOut.has(platform)) throw new LoginError('login-cancelled')
    const revision = this.revisions[platform]
    return await this.store.withTemporaryCookies(platform, async file => {
      if (this.disposed || this.loggingOut.has(platform) || revision !== this.revisions[platform]) throw new LoginError('login-cancelled')
      return callback(file)
    })
  }

  async logout(platform: LoginPlatform): Promise<void> {
    if (!isLoginPlatform(platform)) throw new LoginError('login-cancelled')
    this.revisions[platform]++
    this.loggingOut.add(platform)
    try {
      const operation = this.operations.get(platform)
      operation?.controller.abort()
      await operation?.promise.catch(() => {})
      try { this.store.logout(platform) } catch { throw new LoginError('cookie-storage-failed') }
    } finally { this.loggingOut.delete(platform) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.revisions.youtube++
    this.revisions.douyu++
    const operations = [...this.operations.values()]
    for (const operation of operations) operation.controller.abort()
    await Promise.allSettled(operations.map(operation => operation.promise))
  }
}
