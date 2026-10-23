import { lstat, readFile } from 'node:fs/promises'
import { cookieDomainAllowed, type BrowserCookie } from '../electron/cookies'

/** Import only an explicitly authorized fixture; never inspect a daily browser profile. */
export async function fixtureCookies(file: string): Promise<BrowserCookie[]> {
  const invalid = () => new Error('YouTube 测试 cookie 文件无效, 内容未写入日志.')
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw invalid()
  const text = await readFile(file, 'utf8')
  if (!/^# Netscape HTTP Cookie File\r?\n/.test(text)) throw invalid()
  const cookies: BrowserCookie[] = []
  for (const raw of text.split(/\r?\n/)) {
    const httpOnly = raw.startsWith('#HttpOnly_')
    if (!raw || (raw.startsWith('#') && !httpOnly)) continue
    const fields = (httpOnly ? raw.slice(10) : raw).split('\t')
    const [domain, subdomains, cookiePath, secure, expiry, name, value] = fields
    if (fields.length !== 7 || !domain || !cookiePath || !name || value === undefined
      || !/^(TRUE|FALSE)$/.test(subdomains ?? '') || !/^(TRUE|FALSE)$/.test(secure ?? '')
      || !/^\d+$/.test(expiry ?? '')) throw invalid()
    if (!cookieDomainAllowed(domain, 'youtube')) continue
    const expirationDate = Number(expiry)
    if (!Number.isSafeInteger(expirationDate)) throw invalid()
    cookies.push({
      domain, path: cookiePath, secure: secure === 'TRUE', httpOnly, hostOnly: subdomains !== 'TRUE',
      session: expirationDate === 0, expirationDate, name, value,
    })
  }
  if (!cookies.length) throw invalid()
  return cookies
}
