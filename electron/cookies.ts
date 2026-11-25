import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { messageCredentialStatus } from '../server/douyu/messageProtocol'
import { assertRegularPath, containedPath, privateDirectory } from './privateStorage'
import { douyinCookieFingerprint } from '../server/douyin/signingMaterial'
import type { CookiesSetDetails } from 'electron'

export interface LoginCookieSession { cookies: { set(details: CookiesSetDetails): Promise<void> } }
export type YoutubeCookieSession = LoginCookieSession

export type LoginPlatform = 'youtube' | 'twitch' | 'douyu' | 'bilibili' | 'huya' | 'douyin'
export type CookieHeaderPlatform = Exclude<LoginPlatform, 'youtube' | 'twitch'>
export type LoginSource = 'official' | 'browser-import'
export interface LoginResult { cookieCount: number; authKeysPresent: string[]; signingReady?: boolean; signingProblem?: string }
export interface PlatformLoginStatus extends LoginResult {
  loggedIn: boolean
  loginSource?: LoginSource
  /** Douyu gateway readiness, distinct from website authentication. No values leave main. */
  canSend?: boolean
  missingCredentialFields?: string[]
  /** Douyu display name from `acf_nickname`, shown in place of the account's local label. */
  nickname?: string
  avatar?: string
  /** Earliest persistent authentication-cookie expiry, as Unix seconds. */
  expiresAt: number | null
  hasSessionCookies: boolean
}
export interface TemporaryCookieControls {
  invalidate(): void
  sync(): { hadAuth: boolean; hasAuth: boolean }
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
export interface BrowserAccountIdentity { username: string; uid?: string; avatar?: string }
const ACCOUNT_PREFIX = '# Fy1Sync-Account\t'
const LOGIN_SOURCE_PREFIX = '# Fy1Sync-Login-Source\t'

function accountIdentity(value: unknown): BrowserAccountIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['username', 'uid', 'avatar'].includes(key))) throw storageFailure()
  const identity = value as BrowserAccountIdentity
  if (typeof identity.username !== 'string' || !identity.username.trim() || identity.username.length > 80
    || /[\x00-\x1f\x7f]/.test(identity.username)
    || identity.uid !== undefined && (typeof identity.uid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(identity.uid))
    || identity.avatar !== undefined && (typeof identity.avatar !== 'string' || identity.avatar.length > 96 * 1024
      || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(identity.avatar))) throw storageFailure()
  return { ...identity }
}
/** A display identity that storage accepts, or undefined. A rejected one must never fail a login. */
export function validAccountIdentity(value: unknown): BrowserAccountIdentity | undefined {
  try { return value ? accountIdentity(value) : undefined } catch { return undefined }
}
function readAccountIdentity(text: string): BrowserAccountIdentity | undefined {
  const lines = text.split(/\r?\n/).filter(line => line.startsWith('# Fy1Sync-Account'))
  if (lines.length > 1 || lines.length === 1 && !lines[0]!.startsWith(ACCOUNT_PREFIX)) throw storageFailure()
  return lines.length ? accountIdentity(JSON.parse(lines[0]!.slice(ACCOUNT_PREFIX.length))) : undefined
}
function readLoginSource(text: string): LoginSource | undefined {
  const lines = text.split(/\r?\n/).filter(line => line.startsWith('# Fy1Sync-Login-Source'))
  if (lines.length > 1 || lines.length === 1 && !lines[0]!.startsWith(LOGIN_SOURCE_PREFIX)) throw storageFailure()
  if (!lines.length) return undefined
  const value = lines[0]!.slice(LOGIN_SOURCE_PREFIX.length)
  if (value !== 'official' && value !== 'browser-import') throw storageFailure()
  return value
}

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
  return selectedCookies(cookies, target).filter(cookie => !/[^\x21-\x7e]|;/.test(cookie.value))
    .map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

/** Bind the same domain/path selection that the persisted current-user request will use. */
export function douyinBrowserCookieFingerprint(cookies: BrowserCookie[], now=Date.now()/1000): string {
  const eligible=cookies.filter(cookie => cookieDomainAllowed(cookie.domain,'douyin')
    && (cookie.expirationDate===undefined || cookie.expirationDate===0 || cookie.expirationDate>now))
  const selected=selectedCookies(eligible,new URL('https://live.douyin.com/webcast/user/me/'))
  return douyinCookieFingerprint(selected.map(cookie=>`${cookie.name}=${cookie.value}`).join('; '))
}

/** Server proof from the outgoing Cookie scope, used only in main to bind the captured private key. */
export function douyinBrowserSigningServerData(cookies: BrowserCookie[], now=Date.now()/1000): string|undefined {
  return parseDouyinServerDataCookie(selectedDouyinServerCookie(cookies,'https://live.douyin.com/webcast/user/me/',now))
}

function parseDouyinServerDataCookie(raw: string|undefined): string|undefined {
  try {
    if (!raw || raw.length>32768) return undefined
    const decoded=JSON.parse(Buffer.from(decodeURIComponent(raw),'base64').toString('utf8')) as Record<string,unknown>
    if (!decoded || typeof decoded!=='object' || !['ticket','ts_sign','client_cert'].every(key=>typeof decoded[key]==='string')) return undefined
    return JSON.stringify({ticket:decoded.ticket,ts_sign:decoded.ts_sign,client_cert:decoded.client_cert,
      ...(typeof decoded.aes_sign_safari==='string' ? {aes_sign_safari:decoded.aes_sign_safari} : {})})
  } catch { return undefined }
}

function selectedDouyinServerCookie(cookies: BrowserCookie[], targetUrl: string, now: number): string|undefined {
  const eligible=cookies.filter(cookie=>cookieDomainAllowed(cookie.domain,'douyin')
    && (cookie.expirationDate===undefined || cookie.expirationDate===0 || cookie.expirationDate>now))
  return selectedCookies(eligible,new URL(targetUrl)).find(cookie=>cookie.name==='bd_ticket_guard_server_data')?.value
}

/** Ordered server-proof candidates across Douyin subdomains for imported browser profiles. */
export function douyinBrowserSigningServerProofs(cookies: BrowserCookie[], now=Date.now()/1000): string[] {
  const seen=new Set<string>()
  const add=(raw: string|undefined)=>{ const parsed=parseDouyinServerDataCookie(raw); if (parsed) seen.add(parsed) }
  for (const url of ['https://live.douyin.com/webcast/user/me/','https://www.douyin.com/','https://login.douyin.com/','https://sso.douyin.com/']) {
    add(selectedDouyinServerCookie(cookies,url,now))
  }
  for (const cookie of cookies) {
    if (cookie.name==='bd_ticket_guard_server_data' && cookieDomainAllowed(cookie.domain,'douyin')
      && (cookie.expirationDate===undefined || cookie.expirationDate===0 || cookie.expirationDate>now)) {
      add(cookie.value)
    }
  }
  return [...seen]
}

export const LOGIN_PLATFORMS = {
  douyin: { url: 'https://live.douyin.com/', authKeys: ['sessionid', 'sessionid_ss'] },
  youtube: { url: 'https://www.youtube.com', authKeys: ['LOGIN_INFO', 'SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID', '__Secure-3PSID', '__Secure-1PSID', 'SID', 'HSID', 'SSID'] },
  twitch: { url: 'https://www.twitch.tv/login', apiUrl: 'https://gql.twitch.tv/gql', authKeys: ['auth-token'] },
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

/** Main-only Twitch web OAuth token selected under the same domain/path rules as outbound requests. */
export function twitchAuthToken(cookies: BrowserCookie[], now = Date.now() / 1000): string | undefined {
  if (!Array.isArray(cookies)) return undefined
  const eligible = cookies.filter(cookie => cookie && typeof cookie.domain === 'string' && cookieDomainAllowed(cookie.domain, 'twitch')
    && typeof cookie.name === 'string' && typeof cookie.value === 'string' && (cookie.path === undefined || typeof cookie.path === 'string')
    && (cookie.session || cookie.expirationDate === undefined || (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > now)))
  const token = selectedCookies(eligible, new URL(LOGIN_PLATFORMS.twitch.apiUrl)).find(cookie => cookie.name === 'auth-token')?.value
    ?? selectedCookies(eligible, new URL('https://www.twitch.tv/')).find(cookie => cookie.name === 'auth-token')?.value
  return typeof token === 'string' && /^[A-Za-z0-9]{20,128}$/.test(token) ? token : undefined
}

/** Presence means locally usable credential material, not verified server identity. */
export function hasAuthenticationCookies(cookies: BrowserCookie[], platform: LoginPlatform, now = Date.now() / 1000): boolean {
  if (!isLoginPlatform(platform) || !Array.isArray(cookies)) return false
  if (platform === 'douyin') return cookies.some(cookie => isDouyinAuthenticationCookie(cookie, now))
  if (platform === 'twitch') return Boolean(twitchAuthToken(cookies, now))
  const eligible = cookies.filter(cookie => cookie && typeof cookie.domain === 'string' && cookieDomainAllowed(cookie.domain, platform)
    && typeof cookie.name === 'string' && typeof cookie.value === 'string' && (cookie.path === undefined || typeof cookie.path === 'string')
    && (cookie.session || cookie.expirationDate === undefined || (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > now)))
  const validValue = (cookie: BrowserCookie) => cookie.value.length > 0 && cookie.value.length <= 32_768
    && !/[\x00-\x20\x7f;]/.test(cookie.value) && !/^(null|undefined)$/i.test(cookie.value)
  if (platform === 'youtube') {
    // Match yt-dlp's _has_auth_cookies: YouTube clears LOGIN_INFO when rotating/invalidating cookies
    // while leaving 3PAPISID/google.com cookies intact, so google.com or sid-only cookies are signed out.
    const fields = new Map(selectedCookies(eligible, new URL('https://www.youtube.com/')).filter(validValue).map(cookie => [cookie.name, cookie.value]))
    return fields.has('LOGIN_INFO') && ['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID'].some(key => fields.has(key))
  }
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
const STORAGE_FAILURE_MESSAGE = '账号数据读写失败，未返回任何 cookie 数据'
const storageFailure = () => new Error(STORAGE_FAILURE_MESSAGE)
class CookieReplacementBusy extends Error {
  constructor() { super(STORAGE_FAILURE_MESSAGE) }
}
const sameFile = (before: fs.Stats, after: fs.Stats): boolean => after.isFile() && !after.isSymbolicLink()
  && before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs
export function isLoginPlatform(value: unknown): value is LoginPlatform { return value === 'youtube' || value === 'twitch' || value === 'douyu' || value === 'bilibili' || value === 'huya' || value === 'douyin' }

export function cookieDomainAllowed(domain: string, platform: LoginPlatform): boolean {
  const host = domain.replace(/^\./, '').toLowerCase()
  if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && label.length <= 63)) return false
  if (platform === 'youtube' && (host === 'google.com' || host === 'accounts.google.com' || host.endsWith('.accounts.google.com'))) return true
  if (!isLoginPlatform(platform)) return false
  const base = platform === 'twitch' ? 'twitch.tv' : `${platform}.com`
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

function parseYtDlpCookies(text: string, now: number, previous: StoredCookie[], invalidated: boolean): BrowserCookie[] | null {
  if (Buffer.byteLength(text, 'utf8') > MAX_COOKIE_FILE_BYTES || !/^# Netscape HTTP Cookie File\r?\n/.test(text)) return null
  const exactPrior = new Map<string, StoredCookie>()
  const domainPrior = new Map<string, StoredCookie>()
  for (const cookie of previous) {
    exactPrior.set(`${cookie.domain}\t${cookie.subdomains}\t${cookie.path}\t${cookie.name}`, cookie)
    if (!domainPrior.has(`${cookie.domain}\t${cookie.name}`)) domainPrior.set(`${cookie.domain}\t${cookie.name}`, cookie)
  }
  const cookies: BrowserCookie[] = []
  for (let line of text.split(/\r?\n/)) {
    const httpOnlyPrefix = line.startsWith('#HttpOnly_')
    if (httpOnlyPrefix) line = line.slice(10)
    else if (!line || line.startsWith('#')) continue
    const fields = line.split('\t')
    if (fields.length !== 7) return null
    const [rawDomain, rawSubdomains, cookiePath, rawSecure, rawExpiry, name, value] = fields
    if (!name || !rawDomain || value === undefined || !cookiePath) continue
    if (!cookieDomainAllowed(rawDomain, 'youtube')) continue
    if (!/^(TRUE|FALSE)$/.test(rawSubdomains!) || !/^(TRUE|FALSE)$/.test(rawSecure!)
      || !cookiePath.startsWith('/') || /[\x00-\x20\x7f]/.test(cookiePath)
      || !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(name) || /[\x00-\x20\x7f;]/.test(value)) continue
    if (rawExpiry !== '' && !/^\d+(?:\.\d+)?$/.test(rawExpiry!)) return null
    const expires = rawExpiry === '' ? 0 : Math.floor(Number(rawExpiry))
    if (!Number.isSafeInteger(expires) || expires < 0) return null
    if (expires > 0 && expires <= now) continue
    if (invalidated && name === 'LOGIN_INFO') continue
    const normalizedDomain = rawDomain.replace(/^\./, '').toLowerCase()
    const subdomains = rawSubdomains === 'TRUE'
    const prior = exactPrior.get(`${normalizedDomain}\t${subdomains}\t${cookiePath}\t${name}`)
      ?? domainPrior.get(`${normalizedDomain}\t${name}`)
    cookies.push({
      domain: subdomains ? `.${normalizedDomain}` : normalizedDomain,
      path: cookiePath,
      secure: rawSecure === 'TRUE',
      httpOnly: httpOnlyPrefix || (prior?.httpOnly ?? false),
      hostOnly: !subdomains,
      session: expires === 0,
      ...(expires > 0 ? { expirationDate: expires } : {}),
      ...(prior?.sameSite !== undefined ? { sameSite: prior.sameSite } : {}),
      name,
      value,
    })
  }
  return cookies
}

function cookieListSignature(cookies: readonly BrowserCookie[]): string {
  return cookies.map(cookie => {
    const subdomains = cookie.hostOnly === undefined ? cookie.domain.startsWith('.') : !cookie.hostOnly
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    const expiry = cookie.session || !cookie.expirationDate ? 0 : Math.floor(cookie.expirationDate)
    return `${domain}\t${subdomains ? 1 : 0}\t${cookie.path || '/'}\t${cookie.secure ? 1 : 0}\t${cookie.httpOnly ? 1 : 0}\t${cookie.sameSite ?? ''}\t${expiry}\t${cookie.name}\t${cookie.value}`
  }).sort().join('\n')
}

export interface CookieStoreOptions { now?: () => number }

/** Cookie values are private to the main process; public methods return fixed metadata only. */
export class CookieStore {
  private readonly now: () => number
  private readonly revisions: Record<LoginPlatform, number> = { youtube: 0, twitch: 0, douyu: 0, bilibili: 0, huya: 0, douyin: 0 }
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

  resetProfile(platform: 'youtube'): string {
    try {
      if (platform !== 'youtube') throw storageFailure()
      const profile = containedPath(this.root, path.join(this.root, 'browser-profile', platform))
      if (fs.existsSync(profile)) {
        assertRegularPath(profile, true)
        fs.rmSync(profile, { recursive: true, force: true })
      }
      return privateDirectory(this.root, profile)
    } catch { throw storageFailure() }
  }

  private get directory(): string {
    return privateDirectory(this.root, path.join(this.root, 'cookies'))
  }

  private target(platform: LoginPlatform): string {
    if (!isLoginPlatform(platform)) throw storageFailure()
    return containedPath(this.root, path.join(this.root, 'cookies', `${platform}.txt`))
  }

  private async read(platform: LoginPlatform): Promise<{ text: string; cookies: StoredCookie[]; identity?: BrowserAccountIdentity; loginSource?: LoginSource } | undefined> {
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
      return { text, cookies: parseCookies(text, platform, this.now()), identity: readAccountIdentity(text), loginSource: readLoginSource(text) }
    } catch { throw storageFailure() }
  }

  write(platform: LoginPlatform, cookies: BrowserCookie[], identity?: BrowserAccountIdentity, loginSource?: LoginSource): LoginResult {
    let temporary: string | undefined
    let descriptor: number | undefined
    try {
      if (!isLoginPlatform(platform) || !Array.isArray(cookies) || cookies.length > 50_000
        || (loginSource !== undefined && loginSource !== 'official' && loginSource !== 'browser-import')) throw storageFailure()
      this.revisions[platform]++
      const lines = ['# Netscape HTTP Cookie File', '# Fy1Sync private login data. Do not share this file.', '']
      const headers: string[] = []
      if (identity) headers.push(ACCOUNT_PREFIX + JSON.stringify(accountIdentity(identity)))
      if (loginSource) headers.push(LOGIN_SOURCE_PREFIX + loginSource)
      if (headers.length) lines.splice(2, 0, ...headers)
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
      try { fs.renameSync(temporary, target) }
      catch (error) {
        // Windows readers and scanners can briefly prevent an atomic replacement.
        // Keep the old file; never unlink it to force a replacement through.
        if (['EPERM', 'EACCES', 'EBUSY'].includes(String((error as NodeJS.ErrnoException)?.code))) throw new CookieReplacementBusy()
        throw error
      }
      temporary = undefined
      assertRegularPath(target, false)
      const { cookieCount, authKeysPresent } = this.summary(platform, selected)
      return { cookieCount, authKeysPresent }
    } catch (error) { throw error instanceof CookieReplacementBusy ? error : storageFailure() }
    finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (temporary !== undefined) fs.rmSync(temporary, { force: true })
    }
  }

  /** Bounded local persistence retry. This never repeats a platform login or account action. */
  async writeAsync(platform: LoginPlatform, cookies: BrowserCookie[], signal?: AbortSignal, current: () => boolean = () => true, identity?: BrowserAccountIdentity, loginSource?: LoginSource): Promise<LoginResult> {
    if (!isLoginPlatform(platform) || !Array.isArray(cookies) || cookies.length > 50_000
      || (loginSource !== undefined && loginSource !== 'official' && loginSource !== 'browser-import')) throw storageFailure()
    let snapshot: BrowserCookie[]
    try { snapshot = structuredClone(cookies) } catch { throw storageFailure() }
    let revision = this.revisions[platform]
    for (let attempt = 0; attempt < 6; attempt++) {
      if (signal?.aborted || !current() || revision !== this.revisions[platform]) throw storageFailure()
      try { return this.write(platform, snapshot, identity, loginSource) }
      catch (error) {
        if (!(error instanceof CookieReplacementBusy) || attempt === 5) throw error
        revision++
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(storageFailure()) }
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, Math.min(40 * 2 ** attempt, 400))
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
      }
    }
    throw storageFailure()
  }

  /**
   * Add a display identity to a saved login that has none, or an avatar to one that lacks it.
   * The credentials are written back unchanged, and only if nothing replaced them meanwhile.
   */
  async attachIdentity(platform: LoginPlatform, resolve: (cookies: BrowserCookie[]) => Promise<BrowserAccountIdentity | undefined>,
    current: () => boolean = () => true): Promise<boolean> {
    const loaded = await this.read(platform)
    const known = loaded?.identity
    if (!loaded || known?.avatar || !hasAuthenticationCookies(loaded.cookies, platform, this.now())) return false
    const revision = this.revisions[platform]
    const identity = await resolve(loaded.cookies.map(cookie => ({ ...cookie })))
    if (!identity || !current() || revision !== this.revisions[platform]) return false
    // A recorded identity is only ever completed with an avatar, never swapped for another account.
    if (known && (!identity.avatar || known.uid !== undefined && identity.uid !== undefined && known.uid !== identity.uid)) return false
    this.write(platform, loaded.cookies, identity, loaded.loginSource)
    return true
  }

  private summary(platform: LoginPlatform, cookies: StoredCookie[], identity?: BrowserAccountIdentity, loginSource?: LoginSource): PlatformLoginStatus {
    const known: readonly string[] = LOGIN_PLATFORMS[platform].authKeys
    const auth = cookies.filter(cookie => platform === 'douyin' ? isDouyinAuthenticationCookie(cookie, this.now())
      : platform === 'twitch' ? cookie.name === 'auth-token' && /^[A-Za-z0-9]{20,128}$/.test(cookie.value)
        : known.includes(cookie.name) && cookie.value.length > 0)
    const expiries = auth.map(cookie => cookie.expires).filter(expiry => expiry > 0)
    const present = new Set(auth.map(cookie => cookie.name))
    const loggedIn = hasAuthenticationCookies(cookies, platform, this.now())
    return { cookieCount: cookies.length, authKeysPresent: known.filter(key => present.has(key)), loggedIn,
      ...(loggedIn && loginSource ? { loginSource } : {}),
      expiresAt: loggedIn && expiries.length ? Math.min(...expiries) : null, hasSessionCookies: auth.some(cookie => cookie.expires === 0),
      ...(platform === 'douyu' ? messageCredentialStatus(platformHeader(cookies, new URL('https://www.douyu.com/'))) : {}),
      ...(identity ? { nickname: identity.username, ...(identity.avatar ? { avatar: identity.avatar } : {}) } : {}),
      // Douyu keeps the current display name in its own cookie; a recorded identity adds the avatar.
      ...(platform === 'douyu' && loggedIn ? douyuNickname(cookies) : {}) }
  }

  async status(): Promise<LoginStatus> {
    return Object.fromEntries(await Promise.all((Object.keys(LOGIN_PLATFORMS) as LoginPlatform[]).map(async platform => {
      const loaded = await this.read(platform)
      return [platform, this.summary(platform, loaded?.cookies ?? [], loaded?.identity, loaded?.loginSource)]
    }))) as LoginStatus
  }

  /** Main-only identity lookup for matching imported Douyu accounts, including expired sessions. */
  async savedUserId(platform: CookieHeaderPlatform): Promise<string | undefined> {
    const loaded = await this.read(platform)
    return loaded?.identity?.uid ?? authenticationCookieUserId(loaded?.cookies ?? [], platform, this.now())
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
      || target.pathname === '/webcast/room/web/enter/' || target.pathname === '/webcast/im/fetch/'
      || target.pathname === '/webcast/user/me/' || target.pathname === '/webcast/room/chat/'))) throw storageFailure()
    const revision = this.revisions[platform]
    const loaded = await this.read(platform)
    if (revision !== this.revisions[platform]) throw storageFailure()
    return platformHeader(loaded?.cookies ?? [], target)
  }

  async twitchAuthorization(requestUrl: string = LOGIN_PLATFORMS.twitch.apiUrl): Promise<string> {
    if (typeof requestUrl !== 'string' || /[\\\x00-\x20\x7f]/.test(requestUrl)) throw storageFailure()
    let target: URL
    try { target = new URL(requestUrl) } catch { throw storageFailure() }
    if (target.protocol !== 'https:' || target.username || target.password || target.port
      || target.hostname !== 'gql.twitch.tv' || target.pathname !== '/gql' || target.search || target.hash) throw storageFailure()
    const revision = this.revisions.twitch
    const loaded = await this.read('twitch')
    if (revision !== this.revisions.twitch) throw storageFailure()
    const token = twitchAuthToken(loaded?.cookies ?? [], this.now())
    return token ? `OAuth ${token}` : ''
  }

  async withTemporaryCookies<T>(platform: 'youtube', callback: (file?: string, controls?: TemporaryCookieControls) => Promise<T>, current: () => boolean = () => true): Promise<T> {
    const revision = this.revisions.youtube
    let directory: string | undefined
    let temporary: string | undefined
    let loaded: Awaited<ReturnType<CookieStore['read']>>
    let invalidated = false
    let syncedOutcome: { hadAuth: boolean; hasAuth: boolean } | undefined
    const cleanup = () => {
      if (!directory) return
      try {
        containedPath(this.root, directory)
        assertRegularPath(directory, true)
        fs.rmSync(directory, { recursive: true, force: true })
        directory = undefined
      } catch { throw storageFailure() }
    }
    const syncTemporary = (): { hadAuth: boolean; hasAuth: boolean } => {
      if (syncedOutcome) return syncedOutcome
      const now = this.now()
      const hadAuth = Boolean(loaded && hasAuthenticationCookies(loaded.cookies, 'youtube', now))
      let hasAuth = hadAuth && !invalidated
      if (!temporary || !loaded || revision !== this.revisions.youtube || !current()) {
        syncedOutcome = { hadAuth, hasAuth }
        return syncedOutcome
      }
      try {
        containedPath(this.root, temporary)
        assertRegularPath(temporary, false)
        const stat = fs.lstatSync(temporary)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COOKIE_FILE_BYTES) {
          syncedOutcome = { hadAuth, hasAuth }
          return syncedOutcome
        }
        const nextText = fs.readFileSync(temporary, 'utf8')
        if (!invalidated && nextText === loaded.text) {
          syncedOutcome = { hadAuth, hasAuth: hadAuth }
          return syncedOutcome
        }
        const merged = parseYtDlpCookies(nextText, now, loaded.cookies, invalidated)
        if (!merged) {
          if (invalidated && revision === this.revisions.youtube && current()) {
            const stripped = loaded.cookies.filter(cookie => cookie.name !== 'LOGIN_INFO')
            this.write('youtube', stripped)
            hasAuth = false
          }
          syncedOutcome = { hadAuth, hasAuth }
          return syncedOutcome
        }
        hasAuth = hasAuthenticationCookies(merged, 'youtube', now)
        if ((invalidated || cookieListSignature(merged) !== cookieListSignature(loaded.cookies))
          && revision === this.revisions.youtube && current()) {
          this.write('youtube', merged, hasAuth ? loaded.identity : undefined, hasAuth ? loaded.loginSource : undefined)
        }
      } catch { /* Interrupted or busy local sync must never mask extraction results or leak paths. */ }
      syncedOutcome = { hadAuth, hasAuth }
      return syncedOutcome
    }
    // A normal app exit also removes a copy held by an interrupted extraction.
    const onExit = () => { try { cleanup() } catch { /* Never log cookie-related errors. */ } }
    try {
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
      const controls: TemporaryCookieControls | undefined = temporary ? {
        invalidate: () => { invalidated = true; syncedOutcome = undefined },
        sync: syncTemporary,
      } : undefined
      return await callback(temporary, controls)
    } finally {
      process.removeListener('exit', onExit)
      syncTemporary()
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
