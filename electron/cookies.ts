import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { messageCredentialStatus } from '../server/douyu/messageProtocol'
import { containedPath, NativePrivatePermissions, privateDirectory } from './privateStorage'
import type { PrivatePermissions } from './privateStorage'

export type LoginPlatform = 'youtube' | 'douyu'
export interface LoginResult { cookieCount: number; authKeysPresent: string[] }
export interface PlatformLoginStatus extends LoginResult {
  loggedIn: boolean
  /** Douyu gateway readiness, distinct from website authentication. No values leave main. */
  canSend?: boolean
  missingCredentialFields?: string[]
  /** Earliest persistent authentication-cookie expiry, as Unix seconds. */
  expiresAt: number | null
  hasSessionCookies: boolean
}
export type LoginStatus = Record<LoginPlatform, PlatformLoginStatus>
export interface BrowserCookie {
  domain: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  hostOnly?: boolean
  session?: boolean
  expirationDate?: number
  name: string
  value: string
}
interface StoredCookie extends BrowserCookie { subdomains: boolean; expires: number; path: string }

function douyuHeader(cookies: StoredCookie[], target: URL): string {
  const selected = new Map<string, StoredCookie>()
  for (const cookie of cookies.filter(cookie => (target.hostname === cookie.domain || (cookie.subdomains && target.hostname.endsWith(`.${cookie.domain}`)))
    && (target.pathname === cookie.path || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)) {
    const previous = selected.get(cookie.name)
    // Prefer the exact host (www.douyu.com for sending) before parent-domain material.
    if (!previous || cookie.domain.length > previous.domain.length
      || (cookie.domain === previous.domain && cookie.path.length > previous.path.length)
      || (cookie.domain === previous.domain && cookie.path === previous.path && !cookie.subdomains && previous.subdomains)) selected.set(cookie.name, cookie)
  }
  return [...selected.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

export const LOGIN_PLATFORMS = {
  youtube: { url: 'https://www.youtube.com', authKeys: ['SAPISID', '__Secure-3PSID', '__Secure-1PSID', 'SID', 'HSID', 'SSID'] },
  douyu: { url: 'https://www.douyu.com', authKeys: ['acf_uid', 'acf_auth', 'acf_biz', 'acf_stk'] },
} as const

const MAX_COOKIE_FILE_BYTES = 4 * 1024 * 1024
const storageFailure = () => new Error('账号数据读写失败, 未返回任何 cookie 数据.')
const sameFile = (before: fs.Stats, after: fs.Stats): boolean => after.isFile() && !after.isSymbolicLink()
  && before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs
export function isLoginPlatform(value: unknown): value is LoginPlatform { return value === 'youtube' || value === 'douyu' }

export function cookieDomainAllowed(domain: string, platform: LoginPlatform): boolean {
  const host = domain.replace(/^\./, '').toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(host)) return false
  if (platform === 'youtube' && (host === 'google.com' || host === 'accounts.google.com' || host.endsWith('.accounts.google.com'))) return true
  const base = platform === 'youtube' ? 'youtube.com' : 'douyu.com'
  return host === base || host.endsWith(`.${base}`)
}

function parseCookies(text: string, platform: LoginPlatform, now: number): StoredCookie[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_COOKIE_FILE_BYTES || !/^# Netscape HTTP Cookie File\r?\n/.test(text)) throw storageFailure()
  const cookies: StoredCookie[] = []
  for (let line of text.split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.slice(10)
    else if (!line || line.startsWith('#')) continue
    const fields = line.split('\t')
    const [domain, subdomains, cookiePath, secure, expiry, name, value] = fields
    if (fields.length !== 7 || !domain || !cookiePath || !expiry || !name || value === undefined
      || !cookieDomainAllowed(domain, platform) || !/^(TRUE|FALSE)$/.test(subdomains!)
      || !cookiePath.startsWith('/') || /[\x00-\x20\x7f]/.test(cookiePath) || !/^(TRUE|FALSE)$/.test(secure!)
      || !/^\d+$/.test(expiry) || !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(name) || /[\x00-\x20\x7f;]/.test(value)) throw storageFailure()
    const expires = Number(expiry)
    if (!Number.isSafeInteger(expires)) throw storageFailure()
    if (expires && expires <= now) continue
    cookies.push({ domain: domain.replace(/^\./, '').toLowerCase(), subdomains: subdomains === 'TRUE', path: cookiePath,
      secure: secure === 'TRUE', name, value, expires })
  }
  return cookies
}

export interface CookieStoreOptions { permissions?: PrivatePermissions; now?: () => number }

/** Cookie values are private to the main process; public methods return fixed metadata only. */
export class CookieStore {
  private readonly permissions: PrivatePermissions
  private readonly now: () => number
  private readonly revisions: Record<LoginPlatform, number> = { youtube: 0, douyu: 0 }
  readonly root: string

  constructor(userDataDirectory: string, options: CookieStoreOptions = {}) {
    this.root = path.resolve(userDataDirectory)
    this.permissions = options.permissions ?? new NativePrivatePermissions()
    this.now = options.now ?? (() => Date.now() / 1000)
  }

  prepareProfile(platform: LoginPlatform): string {
    try {
      if (!isLoginPlatform(platform)) throw storageFailure()
      return privateDirectory(this.root, path.join(this.root, 'browser-profile', platform), this.permissions, true)
    } catch { throw storageFailure() }
  }

  private get directory(): string {
    return privateDirectory(this.root, path.join(this.root, 'cookies'), this.permissions)
  }

  private target(platform: LoginPlatform): string {
    if (!isLoginPlatform(platform)) throw storageFailure()
    return containedPath(this.root, path.join(this.root, 'cookies', `${platform}.txt`))
  }

  private invalidatePermissions(platform: LoginPlatform): void {
    this.permissions.invalidate?.(path.join(this.root, 'cookies', `${platform}.txt`))
    this.permissions.invalidate?.(path.join(this.root, 'cookies'))
  }

  private async read(platform: LoginPlatform): Promise<{ text: string; cookies: StoredCookie[] } | undefined> {
    try {
      const revision = this.revisions[platform]
      const file = this.target(platform)
      if (!fs.existsSync(file)) return undefined
      const before = fs.lstatSync(file)
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_COOKIE_FILE_BYTES) throw storageFailure()
      if (this.permissions.verifyManyAsync) await this.permissions.verifyManyAsync([
        { target: path.dirname(file), directory: true }, { target: file, directory: false },
      ])
      else {
        this.permissions.verify(path.dirname(file), true)
        this.permissions.verify(file, false)
      }
      if (revision !== this.revisions[platform]) throw storageFailure()
      containedPath(this.root, file)
      const handle = await fs.promises.open(file, 'r')
      let text: string
      try {
        const stat = await handle.stat()
        if (!sameFile(before, stat) || stat.size > MAX_COOKIE_FILE_BYTES) throw storageFailure()
        const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_COOKIE_FILE_BYTES + 1))
        let length = 0
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > stat.size || length > MAX_COOKIE_FILE_BYTES) throw storageFailure()
        if (!sameFile(before, await handle.stat())) throw storageFailure()
        text = bytes.subarray(0, length).toString('utf8')
      } finally { await handle.close() }
      if (revision !== this.revisions[platform]) throw storageFailure()
      containedPath(this.root, file)
      if (!sameFile(before, fs.lstatSync(file))) throw storageFailure()
      return { text, cookies: parseCookies(text, platform, this.now()) }
    } catch { throw storageFailure() }
  }

  write(platform: LoginPlatform, cookies: BrowserCookie[]): LoginResult {
    let temporary: string | undefined
    let descriptor: number | undefined
    try {
      if (!isLoginPlatform(platform) || !Array.isArray(cookies) || cookies.length > 50_000) throw storageFailure()
      this.revisions[platform]++
      this.invalidatePermissions(platform)
      const lines = ['# Netscape HTTP Cookie File', '# Stream Syncer private login data. Do not share this file.', '']
      for (const cookie of cookies) {
        if (!cookie || typeof cookie.domain !== 'string' || !cookieDomainAllowed(cookie.domain, platform)) continue
        const subdomains = cookie.hostOnly === undefined ? cookie.domain.startsWith('.') : !cookie.hostOnly
        const domain = `${cookie.httpOnly ? '#HttpOnly_' : ''}${subdomains ? '.' : ''}${cookie.domain.replace(/^\./, '').toLowerCase()}`
        const expiry = cookie.session || !cookie.expirationDate ? 0 : Math.floor(cookie.expirationDate)
        const fields = [domain, subdomains ? 'TRUE' : 'FALSE', cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE', String(expiry), cookie.name, cookie.value]
        if (fields.some(field => typeof field !== 'string' || /[\t\r\n\0]/.test(field))) throw storageFailure()
        lines.push(fields.join('\t'))
      }
      const text = `${lines.join('\n')}\n`
      const selected = parseCookies(text, platform, this.now())
      const directory = this.directory
      const target = this.target(platform)
      if (fs.existsSync(target)) this.permissions.verify(target, false)
      temporary = containedPath(this.root, path.join(directory, `.${platform}-${randomUUID()}.tmp`))
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      this.permissions.protect(temporary, false)
      fs.writeFileSync(descriptor, text, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      this.permissions.verify(temporary, false)
      fs.renameSync(temporary, target)
      temporary = undefined
      this.permissions.verify(target, false)
      const { cookieCount, authKeysPresent } = this.summary(platform, selected)
      return { cookieCount, authKeysPresent }
    } catch { throw storageFailure() }
    finally {
      if (isLoginPlatform(platform)) this.invalidatePermissions(platform)
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (temporary !== undefined) fs.rmSync(temporary, { force: true })
    }
  }

  private summary(platform: LoginPlatform, cookies: StoredCookie[]): PlatformLoginStatus {
    const known: readonly string[] = LOGIN_PLATFORMS[platform].authKeys
    const auth = cookies.filter(cookie => known.includes(cookie.name))
    const expiries = auth.map(cookie => cookie.expires).filter(expiry => expiry > 0)
    const present = new Set(auth.map(cookie => cookie.name))
    return { cookieCount: cookies.length, authKeysPresent: known.filter(key => present.has(key)), loggedIn: auth.length > 0,
      expiresAt: expiries.length ? Math.min(...expiries) : null, hasSessionCookies: auth.some(cookie => cookie.expires === 0),
      ...(platform === 'douyu' ? messageCredentialStatus(douyuHeader(cookies, new URL('https://www.douyu.com/'))) : {}) }
  }

  async status(): Promise<LoginStatus> {
    return Object.fromEntries(await Promise.all((['youtube', 'douyu'] as const).map(async platform => [platform,
      this.summary(platform, (await this.read(platform))?.cookies ?? []),
    ]))) as LoginStatus
  }

  async cookieHeader(platform: 'douyu', requestUrl = 'https://www.douyu.com/lapi/live/getH5PlayV1/'): Promise<string> {
    if (platform !== 'douyu') throw storageFailure()
    let target: URL
    try { target = new URL(requestUrl) } catch { throw storageFailure() }
    if (target.protocol !== 'https:' || target.username || target.password || target.port
      || (target.hostname !== 'douyu.com' && !target.hostname.endsWith('.douyu.com'))) throw storageFailure()
    const revision = this.revisions[platform]
    const loaded = await this.read(platform)
    if (revision !== this.revisions[platform]) throw storageFailure()
    return douyuHeader(loaded?.cookies ?? [], target)
  }

  async withTemporaryCookies<T>(platform: 'youtube', callback: (file?: string) => Promise<T>): Promise<T> {
    const revision = this.revisions.youtube
    let directory: string | undefined
    let temporary: string | undefined
    const cleanup = () => {
      if (!directory) return
      try {
        containedPath(this.root, directory)
        this.permissions.verify(directory, true, true)
        fs.rmSync(directory, { recursive: true, force: true })
        directory = undefined
      } catch { throw storageFailure() }
    }
    // A normal app exit also removes a copy held by an interrupted extraction.
    const onExit = () => { try { cleanup() } catch { /* Never log cookie-related errors. */ } }
    try {
      let loaded: Awaited<ReturnType<CookieStore['read']>>
      try {
        if (platform !== 'youtube') throw storageFailure()
        loaded = await this.read(platform)
        if (revision !== this.revisions.youtube) throw storageFailure()
        if (loaded?.cookies.length) {
          const parent = this.directory
          directory = fs.mkdtempSync(path.join(parent, 'yt-dlp-'))
          containedPath(this.root, directory)
          this.permissions.protect(directory, true)
          temporary = containedPath(this.root, path.join(directory, 'cookies.txt'))
          const descriptor = fs.openSync(temporary, 'wx', 0o600)
          try {
            this.permissions.protect(temporary, false)
            fs.writeFileSync(descriptor, loaded.text, 'utf8')
            fs.fsyncSync(descriptor)
          } finally { fs.closeSync(descriptor) }
          this.permissions.verify(temporary, false)
          process.once('exit', onExit)
        }
      } catch { throw storageFailure() }
      if (revision !== this.revisions.youtube) throw storageFailure()
      return await callback(temporary)
    } finally {
      process.removeListener('exit', onExit)
      cleanup()
    }
  }

  logout(platform: LoginPlatform): void {
    try {
      if (!isLoginPlatform(platform)) throw storageFailure()
      this.revisions[platform]++
      this.invalidatePermissions(platform)
      const file = this.target(platform)
      if (fs.existsSync(file)) {
        this.permissions.verify(file, false)
        fs.unlinkSync(file)
      }
      const profile = containedPath(this.root, path.join(this.root, 'browser-profile', platform))
      if (fs.existsSync(profile)) {
        this.permissions.verify(profile, true, true)
        fs.rmSync(profile, { recursive: true, force: true })
      }
    } catch { throw storageFailure() }
  }
}
