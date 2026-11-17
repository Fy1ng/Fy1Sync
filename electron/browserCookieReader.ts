import fs from 'node:fs/promises'
import { cookieDomainAllowed, LOGIN_PLATFORMS, type BrowserCookie, type LoginPlatform } from './cookies'
import type { DiscoveredBrowserProfile } from './browserProfiles'
import { BrowserImportError, importAbort } from './browserImportError'
import { readBrowserKeys, type CredentialHelperOptions } from './browserCredentialHelper'
import { chromiumCookieValue, chromiumMasterKey } from './browserCookieCrypto'

export interface BrowserCookieRead { cookies: BrowserCookie[]; skipped: number; decryptionFailedPlatforms?: LoginPlatform[] }
export type BrowserCookieReadFunction = (profile: DiscoveredBrowserProfile, platforms: readonly LoginPlatform[], signal: AbortSignal) => Promise<BrowserCookieRead>

function allowed(host: string, platforms: readonly LoginPlatform[]): boolean {
  const base = host.replace(/^\./, '').toLowerCase()
  return platforms.some(platform => {
    const domains = platform === 'youtube' ? ['youtube.com', 'google.com'] : [`${platform}.com`]
    return domains.some(domain => base === domain || base.endsWith(`.${domain}`))
  })
}
function time(value: unknown, chromium: boolean, schema: number): number | undefined {
  const integer = typeof value === 'bigint' ? value : typeof value === 'number' ? BigInt(Math.trunc(value)) : 0n
  if (integer === 0n) return undefined
  const seconds = chromium ? integer / 1000000n - 11644473600n : schema >= 16 ? integer / 1000n : integer
  const result = Number(seconds)
  return Number.isSafeInteger(result) && result >= 0 ? result : 1
}
function sameSite(value: unknown): BrowserCookie['sameSite'] {
  const integer = Number(value)
  return integer === 0 ? 'no_restriction' : integer === 1 ? 'lax' : integer === 2 ? 'strict' : 'unspecified'
}

export function browserCookieReader(helper: CredentialHelperOptions): BrowserCookieReadFunction {
  return async (profile, platforms, signal) => {
    importAbort(signal)
    let database: import('node:sqlite').DatabaseSync | undefined
    let master: Buffer | undefined
    let material: Awaited<ReturnType<typeof readBrowserKeys>> | undefined
    const cookies: BrowserCookie[] = []
    const decryptionFailures = new Set<LoginPlatform>()
    let skipped = 0
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const stat = await fs.lstat(profile.database)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new BrowserImportError('browser-import-profile-missing')
      database = new DatabaseSync(profile.database, { readOnly: true })
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000')
      const firefox = profile.browser === 'firefox'
      const schemaRow = firefox ? database.prepare('PRAGMA user_version').get()
        : database.prepare("SELECT value FROM meta WHERE key='version'").get()
      const schema = Number(schemaRow?.[firefox ? 'user_version' : 'value'])
      if (!Number.isInteger(schema) || schema < 0) throw new BrowserImportError('browser-import-decryption-failed')
      const column = firefox ? 'host' : 'host_key'
      const table = firefox ? 'moz_cookies' : 'cookies'
      const bases = platforms.flatMap(platform => platform === 'youtube' ? ['youtube.com', 'google.com'] : [`${platform}.com`])
      const predicate = bases.map(() => `(${column} IN (?, ?) OR ${column} LIKE ?)`).join(' OR ')
      const statement = database.prepare(`SELECT * FROM ${table} WHERE ${predicate} LIMIT 5001`)
      statement.setReadBigInts(true)
      const rows = statement.all(...bases.flatMap(base => [base, `.${base}`, `%.${base}`]))
      if (rows.length > 5000) throw new BrowserImportError('browser-import-decryption-failed')
      // No UAC is requested unless the selected rows actually require native keys.
      if (!firefox && rows.some(row => (row.encrypted_value as Uint8Array)?.length)) {
        if (!profile.localState) throw new BrowserImportError('browser-import-profile-missing')
        const stateStat = await fs.lstat(profile.localState)
        if (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.size > 8 * 1024 * 1024) throw new BrowserImportError('browser-import-profile-missing')
        const state = JSON.parse(await fs.readFile(profile.localState, 'utf8'))
        const versions = new Set(rows.map(row => Buffer.from(row.encrypted_value as Uint8Array).subarray(0, 3).toString('ascii')))
        material = await readBrowserKeys(profile.browser === 'chrome' ? 'chrome' : 'edge', {
          ...(versions.has('v20') ? { appBoundKey: state.os_crypt?.app_bound_encrypted_key } : {}),
          ...(versions.has('v10') || versions.has('v11') ? { legacyKey: state.os_crypt?.encrypted_key } : {}),
        }, helper, signal)
        if (material.content) master = chromiumMasterKey(material.content, material.cng)
      }
      importAbort(signal)
      for (const row of rows) {
        const host = String(row[column] ?? '')
        if (!allowed(host, platforms)) { skipped++; continue }
        const expires = time(row[firefox ? 'expiry' : 'expires_utc'], !firefox, schema)
        const origin = firefox ? String(row.originAttributes ?? '') : String(row.top_frame_site_key ?? '')
        if (origin || expires !== undefined && expires <= Date.now() / 1000) { skipped++; continue }
        let value: string
        try {
          value = !firefox && (row.encrypted_value as Uint8Array)?.length
            ? chromiumCookieValue(Buffer.from(row.encrypted_value as Uint8Array), host, schema, { master, legacy: material?.legacy })
            : String(row.value ?? '')
        } catch {
          for (const platform of platforms) if (cookieDomainAllowed(host, platform)
            && (LOGIN_PLATFORMS[platform].authKeys as readonly string[]).includes(String(row.name))) decryptionFailures.add(platform)
          skipped++; continue
        }
        const name = String(row.name ?? '')
        if (!value || value.length > 32768 || /[\x00-\x20\x7f;]/.test(value)
          || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) { skipped++; continue }
        cookies.push({ domain: host, path: String(row.path || '/'), name, value,
          hostOnly: !host.startsWith('.'), secure: Boolean(row[firefox ? 'isSecure' : 'is_secure']),
          httpOnly: Boolean(row[firefox ? 'isHttpOnly' : 'is_httponly']),
          session: expires === undefined, ...(expires !== undefined ? { expirationDate: expires } : {}),
          sameSite: sameSite(row[firefox ? 'sameSite' : 'samesite']) })
      }
      importAbort(signal)
      return { cookies, skipped, decryptionFailedPlatforms: [...decryptionFailures] }
    } catch (error) {
      for (const cookie of cookies) cookie.value = ''
      if (error instanceof BrowserImportError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new BrowserImportError('browser-import-profile-missing')
      throw new BrowserImportError(!database && profile.browser !== 'firefox' ? 'browser-import-browser-in-use' : 'browser-import-decryption-failed')
    } finally {
      database?.close()
      master?.fill(0); material?.content?.fill(0); material?.cng?.fill(0); material?.legacy?.fill(0)
    }
  }
}
