import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { messageCredentialStatus } from '../server/douyu/messageProtocol'
import { assertRegularPath, containedPath, privateDirectory } from './privateStorage'
import type { CookiesSetDetails } from 'electron'

export interface LoginCookieSession { cookies: { set(details: CookiesSetDetails): Promise<void> } }
export type YoutubeCookieSession = LoginCookieSession

export type LoginPlatform = 'youtube' | 'douyu' | 'bilibili' | 'huya' | 'douyin'
export type CookieHeaderPlatform = Exclude<LoginPlatform, 'youtube'>
export interface LoginResult { cookieCount: number; authKeysPresent: string[] }
export interface PlatformLoginStatus extends LoginResult {
  loggedIn: boolean
  /** Douyu gateway readiness, distinct from website authentication. No values leave main. */
  canSend?: boolean
  missingCredentialFields?: string[]
  /** Douyu display name from `acf_nickname`, shown in place of the account's local label. */
  nickname?: string
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
  sameSite?: CookiesSetDetails['sameSite']
  name: string
  value: string
}
interface StoredCookie extends BrowserCookie { subdomains: boolean; expires: number; path: string }

/** The one cookie value allowed out of main: a display name, decoded and bounded. */
function douyuNickname(cookies: StoredCookie[]): { nickname?: string } {
  const raw = cookies.find(cookie => cookie.name === 'acf_nickname')?.value
  if (!raw) return {}
  let name: string
  try { name = decodeURIComponent(raw.replace(/\+/g, ' ')) } catch { return {} }
  name = name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40)
  return name ? { nickname: name } : {}
}

function scopedCookies<T extends BrowserCookie>(cookies: T[], target: URL): T[] {
  return cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    const subdomains = cookie.hostOnly === undefined ? cookie.domain.startsWith('.') : !cookie.hostOnly
    const cookiePath = cookie.path || '/'
    return (target.hostname === domain || (subdomains && target.hostname.endsWith(`.${domain}`)))
      && (target.pathname === cookiePath || target.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`))
      && (!cookie.secure || target.protocol === 'https:')
  })
}

function selectedCookies<T extends BrowserCookie>(cookies: T[], target: URL): T[] {
  const selected = new Map<string, T>()
  for (const cookie of scopedCookies(cookies, target)
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length)) {
    const previous = selected.get(cookie.name)
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    const previousDomain = previous?.domain.replace(/^\./, '').toLowerCase()
    const hostOnly = cookie.hostOnly ?? !cookie.domain.startsWith('.')
    const previousHostOnly = previous?.hostOnly ?? !previous?.domain.startsWith('.')
    // Use the same duplicate selection for authentication and outbound headers.
    if (!previous || domain.length > previousDomain!.length
      || (domain === previousDomain && (cookie.path || '/').length > (previous.path || '/').length)
      || (domain === previousDomain && cookie.path === previous.path && hostOnly && !previousHostOnly)) selected.set(cookie.name, cookie)
  }
  return [...selected.values()]
}

function platformHeader(cookies: StoredCookie[], target: URL): string {
  return selectedCookies(cookies, target).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

export const LOGIN_PLATFORMS = {
  douyin: { url: 'https://live.douyin.com/', authKeys: ['sessionid', 'sessionid_ss'] },
  youtube: { url: 'https://www.youtube.com', authKeys: ['SAPISID', '__Secure-3PSID', '__Secure-1PSID', 'SID', 'HSID', 'SSID'] },
  douyu: { url: 'https://www.douyu.com', apiUrl: 'https://www.douyu.com/lapi/live/getH5PlayV1/',
    authKeys: ['acf_uid', 'acf_auth', 'acf_auth_wl', 'acf_dmjwt_token', 'acf_ltkid', 'acf_biz', 'acf_stk'] },
  bilibili: { url: 'https://www.bilibili.com', apiUrl: 'https://api.bilibili.com/x/web-interface/nav', authKeys: ['SESSDATA', 'DedeUserID'] },
  huya: { url: 'https://www.huya.com', apiUrl: 'https://l.huya.com/udb_web/udbport2.php?m=HuyaLogin&do=checkLogin', authKeys: ['udb_uid', 'udb_biztoken'] },
} as const

const HEADER_HOSTS: Record<CookieHeaderPlatform, readonly string[]> = {
  douyin: ['live.douyin.com'],
  douyu: ['douyu.com', 'www.douyu.com', 'yuba.douyu.com', 'mapi-yuba.douyu.com', 'passport.douyu.com'],
  bilibili: ['bilibili.com', 'www.bilibili.com', 'api.bilibili.com', 'passport.bilibili.com', 'live.bilibili.com', 'api.live.bilibili.com'],
  huya: ['huya.com', 'www.huya.com', 'l.huya.com', 'udblgn.huya.com'],
}
const ATTRIBUTE_PREFIX = '# Fy1Sync-Cookie-Attributes\t'
const SAME_SITES = ['unspecified', 'no_restriction', 'lax', 'strict'] as const

function isDouyinAuthenticationCookie(cookie: BrowserCookie, now: number): boolean {
  if (!cookie || typeof cookie.domain !== 'string' || !cookieDomainAllowed(cookie.domain, 'douyin')
    || !['sessionid', 'sessionid_ss'].includes(cookie.name) || typeof cookie.value !== 'string' || !cookie.value) return false
  const expiry = cookie.expirationDate
  return !/[\x00-\x20\x7f;]/.test(cookie.value)
    && (expiry === undefined || (Number.isFinite(expiry) && expiry >= 0 && (expiry === 0 || Math.floor(expiry) > now)))
    && scopedCookies([cookie], new URL(LOGIN_PLATFORMS.douyin.url)).length > 0
}

/** Presence means locally usable credential material, not verified server identity. */
export function hasAuthenticationCookies(cookies: BrowserCookie[], platform: LoginPlatform, now = Date.now() / 1000): boolean {
  if (!isLoginPlatform(platform) || !Array.isArray(cookies)) return false
  if (platform === 'douyin') return cookies.some(cookie => isDouyinAuthenticationCookie(cookie, now))
  const eligible = cookies.filter(cookie => cookie && typeof cookie.domain === 'string' && cookieDomainAllowed(cookie.domain, platform)
    && typeof cookie.name === 'string' && typeof cookie.value === 'string' && (cookie.path === undefined || typeof cookie.path === 'string')
    && (cookie.session || cookie.expirationDate === undefined || (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > now)))
  const validValue = (cookie: BrowserCookie) => cookie.value.length > 0 && cookie.value.length <= 32_768
    && !/[\x00-\x20\x7f;]/.test(cookie.value) && !/^(null|undefined)$/i.test(cookie.value)
  const known: readonly string[] = LOGIN_PLATFORMS[platform].authKeys
  if (platform === 'youtube') return eligible.some(cookie => known.includes(cookie.name) && validValue(cookie))
  const scope = platform === 'douyu' ? LOGIN_PLATFORMS.douyu.url : LOGIN_PLATFORMS[platform].apiUrl
  const fields = new Map(selectedCookies(eligible, new URL(scope)).filter(validValue).map(cookie => [cookie.name, cookie.value]))
  const uid = fields.get(platform === 'bilibili' ? 'DedeUserID' : platform === 'huya' ? 'udb_uid' : 'acf_uid')
  if (!/^[1-9][0-9]{0,19}$/.test(uid ?? '')) return false
  if (platform === 'bilibili') return fields.has('SESSDATA')
  if (platform === 'huya') return fields.has('udb_biztoken')
  return ['acf_auth', 'acf_auth_wl', 'acf_dmjwt_token'].some(key => fields.has(key))
    || ['acf_ltkid', 'acf_biz', 'acf_stk'].every(key => fields.has(key))
}

/** Bind an online identity to the same domain/path selection used by saved credentials. */
export function authenticationCookieUserId(cookies: BrowserCookie[], platform: CookieHeaderPlatform, now = Date.now() / 1000): string | undefined {
  if (platform === 'douyin' || !hasAuthenticationCookies(cookies, platform, now)) return undefined
  const eligible = cookies.filter(cookie => cookieDomainAllowed(cookie.domain, platform)
    && (cookie.session || cookie.expirationDate === undefined || cookie.expirationDate > now))
  const scope = platform === 'douyu' ? LOGIN_PLATFORMS.douyu.url : LOGIN_PLATFORMS[platform].apiUrl
  const key = platform === 'bilibili' ? 'DedeUserID' : platform === 'huya' ? 'udb_uid' : 'acf_uid'
  return selectedCookies(eligible, new URL(scope)).find(cookie => cookie.name === key)?.value
}

const MAX_COOKIE_FILE_BYTES = 4 * 1024 * 1024
const storageFailure = () => new Error('账号数据读写失败, 未返回任何 cookie 数据.')
const sameFile = (before: fs.Stats, after: fs.Stats): boolean => after.isFile() && !after.isSymbolicLink()
  && before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs
export function isLoginPlatform(value: unknown): value is LoginPlatform { return value === 'youtube' || value === 'douyu' || value === 'bilibili' || value === 'huya' || value === 'douyin' }

export function cookieDomainAllowed(domain: string, platform: LoginPlatform): boolean {
  const host = domain.replace(/^\./, '').toLowerCase()
  if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && label.length <= 63)) return false
  if (platform === 'youtube' && (host === 'google.com' || host === 'accounts.google.com' || host.endsWith('.accounts.google.com'))) return true
  if (!isLoginPlatform(platform)) return false
  const base = `${platform}.com`
  return host === base || host.endsWith(`.${base}`)
}

function parseCookies(text: string, platform: LoginPlatform, now: number): StoredCookie[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_COOKIE_FILE_BYTES || !/^# Netscape HTTP Cookie File\r?\n/.test(text)) throw storageFailure()
  const cookies: StoredCookie[] = []
  let attributes: Pick<BrowserCookie, 'sameSite'> | undefined
  for (let line of text.split(/\r?\n/)) {
    if (line.startsWith('# Fy1Sync-Cookie-Attributes')) {
      if (attributes || !line.startsWith(ATTRIBUTE_PREFIX)) throw storageFailure()
      const encoded = line.slice(ATTRIBUTE_PREFIX.length)
      const value: unknown = JSON.parse(encoded)
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
        || !Object.hasOwn(value, 'sameSite') || !SAME_SITES.includes((value as BrowserCookie).sameSite!)
        || JSON.stringify(value) !== encoded) throw storageFailure()
      attributes = value as Pick<BrowserCookie, 'sameSite'>
      continue
    }
    const httpOnly = line.startsWith('#HttpOnly_')
    if (httpOnly) line = line.slice(10)
    else if (!line || line.startsWith('#')) { if (attributes) throw storageFailure(); continue }
    const fields = line.split('\t')
    const [domain, subdomains, cookiePath, secure, expiry, name, value] = fields
    if (fields.length !== 7 || !domain || !cookiePath || !expiry || !name || value === undefined
      || !cookieDomainAllowed(domain, platform) || !/^(TRUE|FALSE)$/.test(subdomains!)
      || !cookiePath.startsWith('/') || /[\x00-\x20\x7f]/.test(cookiePath) || !/^(TRUE|FALSE)$/.test(secure!)
      || !/^\d+$/.test(expiry) || !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(name) || /[\x00-\x20\x7f;]/.test(value)) throw storageFailure()
    const expires = Number(expiry)
    if (!Number.isSafeInteger(expires)) throw storageFailure()
    const metadata = attributes
    attributes = undefined
    if (expires && expires <= now) continue
    cookies.push({ domain: domain.replace(/^\./, '').toLowerCase(), subdomains: subdomains === 'TRUE', path: cookiePath,
      httpOnly, hostOnly: subdomains !== 'TRUE', session: expires === 0, expirationDate: expires || undefined,
      secure: secure === 'TRUE', name, value, expires, ...metadata })
  }
  if (attributes) throw storageFailure()
  return cookies
}

export interface CookieStoreOptions { now?: () => number }

/** Cookie values are private to the main process; public methods return fixed metadata only. */
export class CookieStore {
  private readonly now: () => number
  private readonly revisions: Record<LoginPlatform, number> = { youtube: 0, douyu: 0, bilibili: 0, huya: 0, douyin: 0 }
  readonly root: string

  constructor(userDataDirectory: string, options: CookieStoreOptions = {}) {
    this.root = path.resolve(userDataDirectory)
    this.now = options.now ?? (() => Date.now() / 1000)
  }

  prepareProfile(platform: LoginPlatform): string {
    try {
      if (!isLoginPlatform(platform)) throw storageFailure()
      return privateDirectory(this.root, path.join(this.root, 'browser-profile', platform))
    } catch { throw storageFailure() }
  }

  private get directory(): string {
    return privateDirectory(this.root, path.join(this.root, 'cookies'))
  }

  private target(platform: LoginPlatform): string {
    if (!isLoginPlatform(platform)) throw storageFailure()
    return containedPath(this.root, path.join(this.root, 'cookies', `${platform}.txt`))
  }

  private async read(platform: LoginPlatform): Promise<{ text: string; cookies: StoredCookie[] } | undefined> {
    try {
      const revision = this.revisions[platform]
      const file = this.target(platform)
      if (!fs.existsSync(file)) return undefined
      const before = fs.lstatSync(file)
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_COOKIE_FILE_BYTES) throw storageFailure()
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
      const lines = ['# Netscape HTTP Cookie File', '# Fy1Sync private login data. Do not share this file.', '']
      for (const cookie of cookies) {
        if (!cookie || typeof cookie.domain !== 'string' || !cookieDomainAllowed(cookie.domain, platform)) continue
        for (const key of ['hostOnly', 'secure', 'httpOnly', 'session'] as const) {
          if (cookie[key] !== undefined && typeof cookie[key] !== 'boolean') throw storageFailure()
        }
        if (cookie.expirationDate !== undefined && (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate < 0)
          || (cookie.sameSite !== undefined && !SAME_SITES.includes(cookie.sameSite))) throw storageFailure()
        const subdomains = cookie.hostOnly === undefined ? cookie.domain.startsWith('.') : !cookie.hostOnly
        const domain = `${cookie.httpOnly ? '#HttpOnly_' : ''}${subdomains ? '.' : ''}${cookie.domain.replace(/^\./, '').toLowerCase()}`
        const sessionCookie = platform === 'douyin' ? cookie.expirationDate === undefined || cookie.expirationDate === 0 : cookie.session || !cookie.expirationDate
        const expiry = sessionCookie ? 0 : Math.floor(cookie.expirationDate!)
        const fields = [domain, subdomains ? 'TRUE' : 'FALSE', cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE', String(expiry), cookie.name, cookie.value]
        if (fields.some(field => typeof field !== 'string' || /[\t\r\n\0]/.test(field))) throw storageFailure()
        if (cookie.sameSite !== undefined) lines.push(`${ATTRIBUTE_PREFIX}${JSON.stringify({ sameSite: cookie.sameSite })}`)
        lines.push(fields.join('\t'))
      }
      const text = `${lines.join('\n')}\n`
      const selected = parseCookies(text, platform, this.now())
      const directory = this.directory
      const target = this.target(platform)
      if (fs.existsSync(target)) assertRegularPath(target, false)
      temporary = containedPath(this.root, path.join(directory, `.${platform}-${randomUUID()}.tmp`))
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      assertRegularPath(temporary, false)
      fs.writeFileSync(descriptor, text, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      assertRegularPath(temporary, false)
      fs.renameSync(temporary, target)
      temporary = undefined
      assertRegularPath(target, false)
      const { cookieCount, authKeysPresent } = this.summary(platform, selected)
      return { cookieCount, authKeysPresent }
    } catch { throw storageFailure() }
    finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (temporary !== undefined) fs.rmSync(temporary, { force: true })
    }
  }

  private summary(platform: LoginPlatform, cookies: StoredCookie[]): PlatformLoginStatus {
    const known: readonly string[] = LOGIN_PLATFORMS[platform].authKeys
    const auth = cookies.filter(cookie => platform === 'douyin' ? isDouyinAuthenticationCookie(cookie, this.now()) : known.includes(cookie.name) && cookie.value.length > 0)
    const expiries = auth.map(cookie => cookie.expires).filter(expiry => expiry > 0)
    const present = new Set(auth.map(cookie => cookie.name))
    const loggedIn = hasAuthenticationCookies(cookies, platform, this.now())
    return { cookieCount: cookies.length, authKeysPresent: known.filter(key => present.has(key)), loggedIn,
      expiresAt: expiries.length ? Math.min(...expiries) : null, hasSessionCookies: auth.some(cookie => cookie.expires === 0),
      ...(platform === 'douyu' ? messageCredentialStatus(platformHeader(cookies, new URL('https://www.douyu.com/'))) : {}),
      ...(platform === 'douyu' && loggedIn ? douyuNickname(cookies) : {}) }
  }

  async status(): Promise<LoginStatus> {
    return Object.fromEntries(await Promise.all((Object.keys(LOGIN_PLATFORMS) as LoginPlatform[]).map(async platform => [platform,
      this.summary(platform, (await this.read(platform))?.cookies ?? []),
    ]))) as LoginStatus
  }

  /** Inject only into an isolated main-owned session; no credential values are returned. */
  async injectYoutubeCookies(target: YoutubeCookieSession): Promise<void> {
    return this.injectCookies('youtube', target)
  }

  /** The caller owns the isolated target; cookie values never cross the renderer bridge. */
  async injectCookies(platform: LoginPlatform, target: LoginCookieSession, current: () => boolean = () => true): Promise<void> {
    try {
      if (!isLoginPlatform(platform) || !current()) throw storageFailure()
      const revision = this.revisions[platform]
      const loaded = await this.read(platform)
      if (!loaded || !hasAuthenticationCookies(loaded.cookies, platform, this.now())) throw storageFailure()
      for (const cookie of loaded.cookies) {
        if (revision !== this.revisions[platform] || !current()) throw storageFailure()
        await target.cookies.set({
          url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}`,
          ...(cookie.subdomains ? { domain: `.${cookie.domain}` } : {}),
          path: cookie.path, name: cookie.name, value: cookie.value, secure: cookie.secure,
          httpOnly: cookie.httpOnly, ...(cookie.expires ? { expirationDate: cookie.expires } : {}),
          ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
        })
      }
      if (revision !== this.revisions[platform] || !current()) throw storageFailure()
    } catch { throw storageFailure() }
  }

  /** Restore only live-origin cookies into the controller's isolated, transient login session. */
  async injectDouyinCookies(target: LoginCookieSession, current: () => boolean = () => true): Promise<void> {
    try {
      const revision = this.revisions.douyin
      const loaded = await this.read('douyin')
      if (!current() || revision !== this.revisions.douyin) throw storageFailure()
      if (!loaded || !hasAuthenticationCookies(loaded.cookies, 'douyin', this.now())) return
      for (const cookie of loaded.cookies.filter(cookie => scopedCookies([cookie], new URL(LOGIN_PLATFORMS.douyin.url)).length > 0)) {
        if (!current() || revision !== this.revisions.douyin) throw storageFailure()
        await target.cookies.set({
          url: LOGIN_PLATFORMS.douyin.url,
          ...(cookie.subdomains ? { domain: `.${cookie.domain}` } : {}),
          path: cookie.path, name: cookie.name, value: cookie.value, secure: cookie.secure, httpOnly: cookie.httpOnly,
          ...(cookie.expires ? { expirationDate: cookie.expires } : {}),
        })
      }
      if (!current() || revision !== this.revisions.douyin) throw storageFailure()
    } catch { throw storageFailure() }
  }

  async cookieHeader(platform: CookieHeaderPlatform, requestUrl?: string): Promise<string> {
    if (!Object.hasOwn(HEADER_HOSTS, platform)) throw storageFailure()
    if (platform === 'douyin' && (!requestUrl || /[\\\x00-\x20\x7f]/.test(requestUrl))) throw storageFailure()
    let target: URL
    try { target = new URL(requestUrl ?? (platform === 'douyin' ? LOGIN_PLATFORMS.douyin.url : LOGIN_PLATFORMS[platform].apiUrl)) } catch { throw storageFailure() }
    if (target.protocol !== 'https:' || target.username || target.password || target.port
      || !HEADER_HOSTS[platform].includes(target.hostname)) throw storageFailure()
    if (platform === 'douyin' && (target.hash || !(target.pathname === '/' || /^\/[1-9][0-9]{0,19}\/?$/.test(target.pathname)
      || target.pathname === '/webcast/room/web/enter/' || target.pathname === '/webcast/im/fetch/'))) throw storageFailure()
    const revision = this.revisions[platform]
    const loaded = await this.read(platform)
    if (revision !== this.revisions[platform]) throw storageFailure()
    return platformHeader(loaded?.cookies ?? [], target)
  }

  async withTemporaryCookies<T>(platform: 'youtube', callback: (file?: string) => Promise<T>): Promise<T> {
    const revision = this.revisions.youtube
    let directory: string | undefined
    let temporary: string | undefined
    const cleanup = () => {
      if (!directory) return
      try {
        containedPath(this.root, directory)
        assertRegularPath(directory, true)
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
          assertRegularPath(directory, true)
          temporary = containedPath(this.root, path.join(directory, 'cookies.txt'))
          const descriptor = fs.openSync(temporary, 'wx', 0o600)
          try {
            assertRegularPath(temporary, false)
            fs.writeFileSync(descriptor, loaded.text, 'utf8')
            fs.fsyncSync(descriptor)
          } finally { fs.closeSync(descriptor) }
          assertRegularPath(temporary, false)
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
      const file = this.target(platform)
      if (fs.existsSync(file)) {
        assertRegularPath(file, false)
        fs.unlinkSync(file)
      }
      const profile = containedPath(this.root, path.join(this.root, 'browser-profile', platform))
      if (fs.existsSync(profile)) {
        assertRegularPath(profile, true)
        fs.rmSync(profile, { recursive: true, force: true })
      }
    } catch { throw storageFailure() }
  }
}
