/** Fresh, main-owned login cookies. Domain/path selection matches the persisted CookieStore. */
import type { BrowserCookie } from '../../electron/cookies'

const MAX_COOKIES = 256
const MAX_HEADER = 32768
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const valueAllowed = (value: string) => value.length <= MAX_HEADER && !/[\x00-\x20\x7f;]/.test(value)
const domainAllowed = (value: string) => value === 'douyin.com' || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.douyin\.com$/.test(value)

export class DouyinHttpCookieError extends Error {
  readonly code = 'douyin-http-cookie-invalid'
  constructor() { super('抖音 HTTP 登录 Cookie 无效, 未返回凭据内容.') }
}

function target(raw: string): URL {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !domainAllowed(url.hostname)) throw new Error()
    return url
  } catch { throw new DouyinHttpCookieError() }
}

function defaultPath(pathname: string): string {
  const last = pathname.lastIndexOf('/')
  return last <= 0 ? '/' : pathname.slice(0, last)
}

export class DouyinHttpCookies {
  private readonly entries = new Map<string, BrowserCookie>()
  constructor(private readonly now: () => number = Date.now) {}

  /** Client-created public state only; authentication always originates from an HTTPS response. */
  setPublic(name: string, value: string, domain = '.douyin.com', cookiePath = '/'): void {
    if (['sessionid', 'sessionid_ss'].includes(name)) throw new DouyinHttpCookieError()
    const hostOnly = !domain.startsWith('.')
    this.put({ name, value, domain, path: cookiePath, hostOnly, secure: true, session: true, sameSite: 'unspecified' })
  }

  receive(rawUrl: string, headers: Headers): void {
    const url = target(rawUrl)
    for (const line of headers.getSetCookie()) {
      if (line.length > MAX_HEADER) throw new DouyinHttpCookieError()
      const pieces = line.split(';'), first = pieces.shift() || '', split = first.indexOf('=')
      if (split < 1) throw new DouyinHttpCookieError()
      const cookie: BrowserCookie = { name: first.slice(0, split).trim(), value: first.slice(split + 1).trim(),
        domain: url.hostname, hostOnly: true, path: defaultPath(url.pathname), secure: false, httpOnly: false,
        session: true, sameSite: 'unspecified' }
      let expires: number | undefined, maxAge: number | undefined
      for (const piece of pieces) {
        const at = piece.indexOf('='), name = piece.slice(0, at < 0 ? undefined : at).trim().toLowerCase()
        const value = at < 0 ? '' : piece.slice(at + 1).trim()
        if (name === 'domain') {
          const domain = value.replace(/^\./, '').toLowerCase()
          if (!domainAllowed(domain) || url.hostname !== domain && !url.hostname.endsWith('.' + domain)) throw new DouyinHttpCookieError()
          cookie.domain = '.' + domain; cookie.hostOnly = false
        } else if (name === 'path' && value.startsWith('/')) cookie.path = value
        else if (name === 'secure') cookie.secure = true
        else if (name === 'httponly') cookie.httpOnly = true
        else if (name === 'samesite') cookie.sameSite = value.toLowerCase() === 'none' ? 'no_restriction'
          : value.toLowerCase() === 'lax' ? 'lax' : value.toLowerCase() === 'strict' ? 'strict' : 'unspecified'
        else if (name === 'expires' && Number.isFinite(Date.parse(value))) expires = Date.parse(value) / 1000
        else if (name === 'max-age' && /^-?\d{1,10}$/.test(value)) maxAge = Number(value)
      }
      const expirationDate = maxAge === undefined ? expires : this.now() / 1000 + maxAge
      if (expirationDate !== undefined) { cookie.expirationDate = expirationDate; cookie.session = false }
      this.put(cookie)
    }
  }

  header(rawUrl: string): string {
    const value = this.selected(target(rawUrl)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    if (value.length > MAX_HEADER) throw new DouyinHttpCookieError()
    return value
  }
  value(name: string, rawUrl: string): string | undefined { return this.selected(target(rawUrl)).find(cookie => cookie.name === name)?.value }
  snapshot(): BrowserCookie[] { this.expire(); return [...this.entries.values()].map(cookie => ({ ...cookie })) }
  clear(): void { this.entries.clear() }

  private put(cookie: BrowserCookie): void {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    if (!token.test(cookie.name) || !valueAllowed(cookie.value) || !domainAllowed(domain) || typeof cookie.path !== 'string'
      || !cookie.path.startsWith('/') || cookie.path.length > 2048 || /[\x00-\x20\x7f;]/.test(cookie.path)) throw new DouyinHttpCookieError()
    const key = `${domain}\n${cookie.path}\n${cookie.name}`
    if (!cookie.value || cookie.expirationDate !== undefined && cookie.expirationDate <= this.now() / 1000) this.entries.delete(key)
    else this.entries.set(key, { ...cookie, domain: cookie.hostOnly ? domain : '.' + domain })
    this.expire()
    if (this.entries.size > MAX_COOKIES) throw new DouyinHttpCookieError()
  }
  private expire(): void {
    for (const [key, cookie] of this.entries) if (cookie.expirationDate !== undefined && cookie.expirationDate <= this.now() / 1000) this.entries.delete(key)
  }
  private selected(url: URL): BrowserCookie[] {
    this.expire()
    const candidates = [...this.entries.values()].filter(cookie => {
      const domain = cookie.domain.replace(/^\./, ''), cookiePath = cookie.path || '/'
      return (url.hostname === domain || !cookie.hostOnly && url.hostname.endsWith('.' + domain))
        && (url.pathname === cookiePath || url.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/'))
    }).sort((a, b) => b.domain.replace(/^\./, '').length - a.domain.replace(/^\./, '').length
      || (b.path || '/').length - (a.path || '/').length || Number(b.hostOnly) - Number(a.hostOnly))
    const names = new Set<string>()
    return candidates.filter(cookie => { if (names.has(cookie.name)) return false; names.add(cookie.name); return true })
  }
}
