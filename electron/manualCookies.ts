import { cookieDomainAllowed, hasAuthenticationCookies, type BrowserCookie, type LoginPlatform } from './cookies'
import { BrowserImportError } from './browserImportError'

export const MAX_MANUAL_COOKIE_BYTES = 1024 * 1024
const invalid = () => new BrowserImportError('manual-cookie-invalid')

/** Parse untrusted exports without decoding or rewriting credential values. */
export function parseManualCookies(input: unknown, platform: LoginPlatform, now = Date.now() / 1000): BrowserCookie[] {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_MANUAL_COOKIE_BYTES) throw invalid()
  const source = input.replace(/^\uFEFF/, '')
  const text = source.trim()
  if (!text) throw invalid()
  let rows: unknown[]
  try {
    if (text.startsWith('[') || text.startsWith('{')) {
      const json: unknown = JSON.parse(text)
      rows = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { cookies?: unknown }).cookies)
        ? (json as { cookies: unknown[] }).cookies : (() => { throw invalid() })()
    } else if (!/^cookie\s*:/i.test(text) && (text.startsWith('#') || /\t(?:TRUE|FALSE)\t/.test(text))) {
      rows = source.split(/\r?\n/).filter(line => line.trim() && (!line.startsWith('#') || line.startsWith('#HttpOnly_'))).map(line => {
        const httpOnly = line.startsWith('#HttpOnly_')
        const fields = (httpOnly ? line.slice(10) : line).split('\t')
        const [domain, subdomains, path, secure, expiry, name, value] = fields
        if (fields.length !== 7 || !/^(TRUE|FALSE)$/.test(subdomains!) || !/^(TRUE|FALSE)$/.test(secure!) || !/^\d+$/.test(expiry!)) throw invalid()
        return { domain, hostOnly: subdomains === 'FALSE', path, secure: secure === 'TRUE', httpOnly,
          expirationDate: Number(expiry), name, value }
      })
    } else {
      const header = text.replace(/^cookie\s*:\s*/i, '')
      if (/[\r\n]/.test(header)) throw invalid()
      rows = header.split(';').filter(part => part.trim()).map(part => {
        const index = part.indexOf('=')
        if (index < 1) throw invalid()
        return { domain: platform === 'twitch' ? '.twitch.tv' : `.${platform}.com`, path: '/', secure: true, session: true,
          name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() }
      })
    }
    if (!rows.length || rows.length > 5000) throw invalid()
    const cookies: BrowserCookie[] = []
    const keys = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid()
      const raw = row as Record<string, unknown>
      if (typeof raw.domain !== 'string') throw invalid()
      // Multi-site exports are common; only the chosen platform is eligible.
      if (!cookieDomainAllowed(raw.domain, platform)) continue
      if (typeof raw.name !== 'string' || !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(raw.name)
        || typeof raw.value !== 'string' || raw.value.length > 32768 || /[^\x21-\x7e]|;/.test(raw.value)) throw invalid()
      for (const key of ['secure', 'httpOnly', 'hostOnly', 'session']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw invalid()
      const path = raw.path ?? '/'
      if (typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x20\x7f]/.test(path)) throw invalid()
      const expiry = raw.expirationDate ?? raw.expires
      if (expiry !== undefined && (typeof expiry !== 'number' || !Number.isSafeInteger(Math.floor(expiry)) || expiry < -1)) throw invalid()
      const expirationDate = typeof expiry === 'number' && expiry > 0 ? expiry : undefined
      if (!raw.session && expirationDate !== undefined && expirationDate <= now) continue
      const sameSite = raw.sameSite === 'unspecified' || raw.sameSite === 'no_restriction' || raw.sameSite === 'lax' || raw.sameSite === 'strict'
        ? raw.sameSite : raw.sameSite === 'none' ? 'no_restriction' : undefined
      const cookie: BrowserCookie = { domain: raw.domain.toLowerCase(), path, name: raw.name, value: raw.value,
        secure: raw.secure as boolean | undefined, httpOnly: raw.httpOnly as boolean | undefined,
        hostOnly: raw.hostOnly as boolean | undefined, session: raw.session === true || expirationDate === undefined,
        ...(raw.session === true ? {} : { expirationDate }), ...(sameSite ? { sameSite } : {}) }
      const key = JSON.stringify([cookie.domain.replace(/^\./, ''), cookie.hostOnly ?? !cookie.domain.startsWith('.'), path, cookie.name])
      if (keys.has(key)) throw invalid()
      keys.add(key); cookies.push(cookie)
    }
    if (!hasAuthenticationCookies(cookies, platform, now)) throw new BrowserImportError('manual-cookie-incomplete')
    return cookies
  } catch (error) { throw error instanceof BrowserImportError ? error : invalid() }
}
