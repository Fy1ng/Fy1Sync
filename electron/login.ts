import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { CookieStore, hasAuthenticationCookies, isLoginPlatform, LOGIN_PLATFORMS, douyinBrowserCookieFingerprint } from './cookies'
import type { BrowserCookie, BrowserAccountIdentity, CookieHeaderPlatform, CookieStoreOptions, LoginCookieSession, LoginPlatform, LoginResult, LoginStatus, YoutubeCookieSession } from './cookies'
import { powershellEnvironment } from './privateStorage'
import type { EmbeddedLoginDriver } from './embeddedLoginContracts'
import { diagnosticDetails } from '../server/errorDetails'
import { douyinCookieFingerprint, parseDouyinSigningSnapshot, type DouyinSigningLookup, type DouyinSigningMaterial, type DouyinSigningSnapshot } from '../server/douyin/signingMaterial'
import type { DouyinSigningStore } from './douyinSigningStore'

export type { LoginPlatform, LoginResult, LoginStatus, PlatformLoginStatus } from './cookies'
export type LoginDestination = 'yuba' | `room:${string}` | `fish-act:${string}`

export type LoginErrorCode = 'chrome-not-found' | 'login-busy' | 'login-cancelled' | 'login-failed' | 'login-incomplete' | 'cookie-storage-failed'
export class LoginError extends Error {
  readonly detail?: import('../src/core/errorDetails').ErrorDetails
  constructor(readonly code: LoginErrorCode, platform?: LoginPlatform, cause?: unknown) {
    super(platform === 'douyin' && code === 'login-failed' ? '抖音登录未完成，请在应用内重试' : { 'chrome-not-found': '未找到系统 Google Chrome，请先安装 Chrome 后重试',
      'login-busy': '该平台正在登录，请先关闭已有的登录页面', 'login-cancelled': '登录已取消',
      'login-failed': '平台登录或账号读取失败，请关闭此平台的登录页面后重试',
      'login-incomplete': '登录未完成，原账号已保留，请重试',
      'cookie-storage-failed': '登录信息保存失败，请重试' }[code])
    this.name = 'LoginError'
    if (cause !== undefined) this.detail = diagnosticDetails(cause)
  }
}

export interface BrowserLoginDriver {
  login(executable: string, profile: string, platform: LoginPlatform, signal: AbortSignal, destination?: LoginDestination): Promise<BrowserCookie[]>
}
export interface LoginManagerOptions extends CookieStoreOptions {
  driver?: BrowserLoginDriver
  embeddedDriver?: EmbeddedLoginDriver
  chromeExecutable?: string
  findChrome?: () => string | undefined
  store?: CookieStore
  douyinSigning?: Pick<DouyinSigningStore,'save'|'load'|'clear'|'dispose'>
}

export function findSystemChrome(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const candidates = platform === 'win32' ? [
    path.join(environment.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(environment.LOCALAPPDATA ? [path.join(environment.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  ] : platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...(environment.HOME && path.posix.isAbsolute(environment.HOME)
      ? [path.posix.join(environment.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')] : []),
  ]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile() } catch { return false } })
}

const CHROME_FLAGS = ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-mode']
type SpawnChrome = (executable: string, args: string[], options: SpawnOptions) => ChildProcess
export interface ChromeLoginDriverOptions {
  spawn?: SpawnChrome
  platform?: NodeJS.Platform
  hasWindow?: (pid: number) => boolean | Promise<boolean>
  killTree?: (child: ChildProcess) => Promise<void>
  loginTimeoutMs?: number
  cookieTimeoutMs?: number
  windowPollMs?: number
  releaseDelayMs?: number
  windowCloseGraceMs?: number
  gracefulExitTimeoutMs?: number
  cookieReadAttempts?: number
  cookieRetryMs?: number
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

  private async hasWindow(pid: number): Promise<boolean> {
    if (this.options.hasWindow) return this.options.hasWindow(pid)
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return await new Promise<boolean>((resolve, reject) => {
      const child = this.spawn(executable, ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { 'yes' } else { 'no' }`], {
        shell: false, windowsHide: true, env: powershellEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
      })
      let output = ''
      let settled = false
      const finish = (error?: LoginError, value = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => { child.kill(); finish(new LoginError('login-failed')) }, 15_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 1024) { child.kill(); finish(new LoginError('login-failed')) }
      })
      child.once('error', () => finish(new LoginError('login-failed')))
      child.once('close', code => finish(code === 0 ? undefined : new LoginError('login-failed'), output.trim() === 'yes'))
    })
  }

  private async allowNormalExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); resolve() }
      const timer = setTimeout(finish, this.options.gracefulExitTimeoutMs ?? 5_000)
      child.once('exit', finish)
    })
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
        const visible = await this.hasWindow(child.pid)
        cancelled(signal)
        if (exited) break
        if (visible) { sawWindow = true; disappearedAt = 0; continue }
        if (!sawWindow) continue
        if (!disappearedAt) { disappearedAt = Date.now(); continue }
        // Give Chrome time to persist profile data after its final visible window closes.
        if (Date.now() - disappearedAt >= (this.options.windowCloseGraceMs ?? 15_000)) {
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

  private async readCookies(executable: string, profile: string, platform: LoginPlatform, signal: AbortSignal): Promise<BrowserCookie[]> {
    cancelled(signal)
    const child = this.spawn(executable, [`--user-data-dir=${profile}`, ...CHROME_FLAGS, '--headless=new', '--remote-debugging-pipe', 'about:blank'], {
      shell: false, detached: this.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    })
    let closeRequested = false
    try {
      return await new Promise<BrowserCookie[]>((resolve, reject) => {
        const writer = child.stdio[3] as Writable | null
        const reader = child.stdio[4] as Readable | null
        let buffered = Buffer.alloc(0)
        let settled = false
        let requestId = 1
        let retryTimer: ReturnType<typeof setTimeout> | undefined
        const attempts = Math.max(1, Math.min(10, this.options.cookieReadAttempts ?? 4))
        const finish = (error?: LoginError, value?: BrowserCookie[]) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          clearTimeout(retryTimer)
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
            if (message.id !== requestId) continue
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
              ...(cookie.sameSite === 'Strict' ? { sameSite: 'strict' as const }
                : cookie.sameSite === 'Lax' ? { sameSite: 'lax' as const }
                  : cookie.sameSite === 'None' ? { sameSite: 'no_restriction' as const } : {}),
            }))
            if (!hasAuthenticationCookies(selected, platform) && requestId < attempts) {
              // Poll the same profile owner instead of relaunching another reader.
              retryTimer = setTimeout(() => {
                if (settled) return
                requestId++
                writer?.write(`${JSON.stringify({ id: requestId, method: 'Storage.getCookies' })}\0`)
              }, this.options.cookieRetryMs ?? 750)
              continue
            }
            closeRequested = true
            finish(hasAuthenticationCookies(selected, platform) ? undefined : new LoginError('login-incomplete'), selected)
            writer?.write(`${JSON.stringify({ id: attempts + 1, method: 'Browser.close' })}\0`)
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
      if (closeRequested) await this.allowNormalExit(child)
      await this.killTree(child)
    }
  }

  async login(executable: string, profile: string, platform: LoginPlatform, signal: AbortSignal, destination?: LoginDestination): Promise<BrowserCookie[]> {
    cancelled(signal)
    if ((platform !== 'youtube' && platform !== 'douyu' && platform !== 'douyin') || !isLoginDestination(platform, destination)) throw new LoginError('login-failed')
    const url = destination === 'yuba' ? 'https://yuba.douyu.com/'
      : destination?.startsWith('room:') ? `https://www.douyu.com/${destination.slice(5)}`
      : destination?.startsWith('fish-act:') ? `https://www.douyu.com/pages/fish-act?rid=${destination.slice(9)}` : LOGIN_PLATFORMS[platform].url
    const child = this.spawn(executable, [`--user-data-dir=${profile}`, ...CHROME_FLAGS, '--new-window', url], {
      shell: false, detached: this.platform !== 'win32', windowsHide: false, stdio: 'ignore',
    })
    try { await this.waitForLoginWindow(child, signal) }
    finally { await this.killTree(child) }
    await delay(this.options.releaseDelayMs ?? 1_500, signal)
    return await this.readCookies(executable, profile, platform, signal)
  }
}

/** One profile writer per platform; logout and disposal abort and await any browser owner. */
export class LoginManager {
  private readonly store: CookieStore
  private readonly driver: BrowserLoginDriver
  private readonly operations = new Map<LoginPlatform, { controller: AbortController; promise: Promise<LoginResult> }>()
  private readonly loggingOut = new Set<LoginPlatform>()
  private readonly revisions: Record<LoginPlatform, number> = { youtube: 0, douyu: 0, bilibili: 0, huya: 0, douyin: 0 }
  private disposed = false
  private signingBlocked = false
  private signingProblem: string | undefined

  constructor(userDataDirectory: string, private readonly options: LoginManagerOptions = {}) {
    this.store = options.store ?? new CookieStore(userDataDirectory, options)
    this.driver = options.driver ?? new ChromeLoginDriver()
  }

  login(platform: LoginPlatform, destination?: LoginDestination, accountLabel?: string): Promise<LoginResult> {
    if (!isLoginPlatform(platform) || this.disposed) return Promise.reject(new LoginError('login-cancelled'))
    if (!isLoginDestination(platform, destination)) return Promise.reject(new LoginError('login-failed'))
    if (accountLabel !== undefined && (typeof accountLabel !== 'string' || !accountLabel.trim() || accountLabel.length > 40
      || /[\x00-\x1f\x7f]/.test(accountLabel))) return Promise.reject(new LoginError('login-failed'))
    if (this.operations.has(platform) || this.loggingOut.has(platform)) return Promise.reject(new LoginError('login-busy'))
    this.revisions[platform]++
    const revision = this.revisions[platform]
    const controller = new AbortController()
    const promise = (async () => {
      try {
        let signingSnapshot: DouyinSigningSnapshot | null = null
        const signing=this.options.douyinSigning
        if (platform==='douyin' && signing) {
          this.signingBlocked=true; this.signingProblem=undefined
          try { await signing.clear(controller.signal,()=>revision===this.revisions[platform] && !this.disposed) }
          catch (error) { this.signingProblem='douyin-signing-store-failed'; throw new LoginError('cookie-storage-failed',platform,error) }
        }
        let cookies: BrowserCookie[]
        if (platform !== 'youtube' && this.options.embeddedDriver) {
          cookies = await this.options.embeddedDriver.login({ platform, signal: controller.signal, destination, accountLabel,
            ...(platform==='douyin' && signing ? {captureDouyinSigning:async (snapshot: DouyinSigningSnapshot) => {
              if (!controller.signal.aborted && revision===this.revisions[platform] && !this.disposed) signingSnapshot=structuredClone(snapshot)
            }} : {}),
            // Explicit reauthentication starts clean. Keep saved cookies intact until a
            // newly verified login succeeds, but never restore stale tickets into its form.
            ...(destination ? { initializeSession: async (target: LoginCookieSession) => {
              cancelled(controller.signal)
              await this.injectCookies(platform, target)
              cancelled(controller.signal)
              if (revision !== this.revisions[platform]) throw new LoginError('login-cancelled')
            } } : {}),
          })
        } else {
          if (platform === 'bilibili' || platform === 'huya' || platform === 'douyin' && !this.options.driver) throw new LoginError('login-failed')
          const executable = this.options.chromeExecutable ?? (this.options.findChrome ?? findSystemChrome)()
          if (!executable) throw new LoginError('chrome-not-found')
          let profile: string
          try { profile = this.store.prepareProfile(platform) } catch (error) { throw new LoginError('cookie-storage-failed', platform, error) }
          cookies = await this.driver.login(executable, profile, platform, controller.signal, destination)
        }
        cancelled(controller.signal)
        if (this.disposed || this.loggingOut.has(platform) || revision !== this.revisions[platform]) throw new LoginError('login-cancelled')
        if (!hasAuthenticationCookies(cookies, platform, this.options.now?.())) throw new LoginError('login-incomplete')
        try {
          const result = await this.store.writeAsync(platform, cookies, controller.signal,
            () => !this.disposed && !this.loggingOut.has(platform) && revision === this.revisions[platform])
          if (platform==='douyin' && signing) {
            const current=()=>!this.disposed && !this.loggingOut.has(platform) && revision===this.revisions[platform]
            let ready=false
            try {
              const captured=signingSnapshot as DouyinSigningSnapshot|null
              if (!captured || captured.cookieFingerprint!==douyinBrowserCookieFingerprint(cookies,this.options.now?.())) {
                this.signingProblem='douyin-signing-capture-unavailable'
              } else {
                const material=parseDouyinSigningSnapshot(captured)
                await signing.save(material,controller.signal,current)
                cancelled(controller.signal)
                if (!current()) throw new LoginError('login-cancelled')
                this.signingBlocked=false; this.signingProblem=undefined; ready=true
              }
            } catch (error) {
              if (controller.signal.aborted || !current()) throw new LoginError('login-cancelled')
              const code=typeof (error as {code?:unknown})?.code==='string' ? (error as {code:string}).code : ''
              this.signingProblem=/^douyin-(?:signing|ticket)-[a-z-]{1,60}$/.test(code) ? code : 'douyin-signing-store-failed'
            } finally { signingSnapshot=null }
            this.revisions[platform]++
            return {...result,signingReady:ready,...(this.signingProblem ? {signingProblem:this.signingProblem} : {})}
          }
          this.revisions[platform]++
          return result
        } catch (error) { throw new LoginError('cookie-storage-failed', platform, error) }
      } catch (error) {
        if (controller.signal.aborted) throw new LoginError('login-cancelled')
        if (platform === 'douyin') throw new LoginError(error instanceof LoginError ? error.code : 'login-failed', platform, error)
        throw error instanceof LoginError ? error : new LoginError('login-failed', platform, error)
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
    try { return await this.store.status() } catch (error) { throw new LoginError('cookie-storage-failed', undefined, error) }
  }

  /** Only a main-owned, online-verified import reaches this writer; it shares login/logout ownership. */
  importCookies(platform: LoginPlatform, cookies: BrowserCookie[], identity: BrowserAccountIdentity, signal?: AbortSignal): Promise<LoginResult> {
    if (!isLoginPlatform(platform) || this.disposed || signal?.aborted) return Promise.reject(new LoginError('login-cancelled'))
    if (this.loginInProgress(platform)) return Promise.reject(new LoginError('login-busy'))
    if (!hasAuthenticationCookies(cookies, platform, this.options.now?.())) return Promise.reject(new LoginError('login-incomplete'))
    const revision = ++this.revisions[platform]
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const current = () => !this.disposed && !this.loggingOut.has(platform) && revision === this.revisions[platform]
    const promise = (async () => {
      try {
        const result = await this.store.writeAsync(platform, cookies, controller.signal, current, identity)
        if (platform === 'douyin' && this.options.douyinSigning) {
          this.signingBlocked = true
          this.signingProblem = 'douyin-signing-material-missing'
          try { await this.options.douyinSigning.clear(controller.signal, current) }
          catch { this.signingProblem = 'douyin-signing-store-failed' }
          return { ...result, signingReady: false, signingProblem: this.signingProblem }
        }
        return result
      } catch (error) {
        throw new LoginError(controller.signal.aborted || !current() ? 'login-cancelled' : 'cookie-storage-failed', platform, error)
      } finally {
        signal?.removeEventListener('abort', abort)
        this.operations.delete(platform)
      }
    })()
    this.operations.set(platform, { controller, promise })
    void promise.catch(() => {}).finally(() => { if (this.operations.get(platform)?.promise === promise) this.operations.delete(platform) })
    return promise
  }

  savedUserId(platform: CookieHeaderPlatform): Promise<string | undefined> { return this.store.savedUserId(platform) }

  loginInProgress(platform: LoginPlatform): boolean { return this.operations.has(platform) || this.loggingOut.has(platform) }

  /** Private lookup, always bound to current authentication; no secrets are exposed through loginStatus. */
  async douyinSigningMaterial(header: string, signal?: AbortSignal, accountUid?: string): Promise<DouyinSigningMaterial|null> {
    if (this.disposed || this.loginInProgress('douyin') || !this.options.douyinSigning) return null
    if (this.signingBlocked) {
      if (this.signingProblem && this.signingProblem!=='douyin-signing-material-missing') {
        throw Object.assign(new Error('暂时不能发送抖音弹幕'),{code:this.signingProblem})
      }
      return null
    }
    const revision=this.revisions.douyin
    const current=()=>!this.disposed && !this.loginInProgress('douyin') && revision===this.revisions.douyin
    const lookup: DouyinSigningLookup={cookieFingerprint:douyinCookieFingerprint(header),...(accountUid ? {accountUid} : {})}
    return this.options.douyinSigning.load(lookup,signal,current)
  }

  async cookieHeader(platform: CookieHeaderPlatform, requestUrl?: string): Promise<string> {
    if (this.disposed || this.loggingOut.has(platform)) return ''
    const revision = this.revisions[platform]
    const current = () => !this.disposed && !this.loggingOut.has(platform) && revision === this.revisions[platform]
    try {
      const header = await this.store.cookieHeader(platform, requestUrl)
      return current() ? header : ''
    } catch (error) {
      if (!current()) return ''
      throw new LoginError('cookie-storage-failed', platform, error)
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

  /** Session cookies stay entirely in main and are invalidated by login changes. */
  async injectYoutubeCookies(target: YoutubeCookieSession): Promise<void> {
    return this.injectCookies('youtube', target)
  }

  async injectCookies(platform: LoginPlatform, target: LoginCookieSession): Promise<void> {
    if (!isLoginPlatform(platform)) throw new LoginError('login-cancelled')
    const revision = this.revisions[platform]
    const current = () => !this.disposed && !this.loggingOut.has(platform) && revision === this.revisions[platform]
    if (!current()) throw new LoginError('login-cancelled')
    try {
      await this.store.injectCookies(platform, target, current)
      if (!current()) throw new LoginError('login-cancelled')
    } catch { throw new LoginError(current() ? 'login-incomplete' : 'login-cancelled') }
  }

  async logout(platform: LoginPlatform): Promise<void> {
    if (!isLoginPlatform(platform)) throw new LoginError('login-cancelled')
    this.revisions[platform]++
    this.loggingOut.add(platform)
    try {
      const operation = this.operations.get(platform)
      operation?.controller.abort()
      await operation?.promise.catch(() => {})
      let signingError: unknown
      if (platform==='douyin' && this.options.douyinSigning) {
        this.signingBlocked=true; this.signingProblem=undefined
        try { await this.options.douyinSigning.clear() } catch (error) { signingError=error }
      }
      try { this.store.logout(platform) } catch { throw new LoginError('cookie-storage-failed') }
      if (signingError) throw new LoginError('cookie-storage-failed',platform,signingError)
    } finally { this.loggingOut.delete(platform) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const platform of Object.keys(LOGIN_PLATFORMS) as LoginPlatform[]) this.revisions[platform]++
    const operations = [...this.operations.values()]
    for (const operation of operations) operation.controller.abort()
    await Promise.allSettled(operations.map(operation => operation.promise))
    this.options.douyinSigning?.dispose()
  }
}
