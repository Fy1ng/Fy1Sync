import { createHash } from 'node:crypto'
import { cookieDomainAllowed, hasAuthenticationCookies, authenticationCookieUserId, twitchAuthToken, type BrowserCookie, type LoginPlatform } from './cookies'
import { loginIdentityUrl, parseLoginIdentity } from './loginIdentity'
import { readPlatformBytes, readPlatformText } from '../server/platformResponse'
import { BrowserImportError, importAbort } from './browserImportError'
import { IMPORT_PLATFORM_NAMES } from './browserImportContracts'

export interface ImportedIdentity { uid?: string; username: string; avatar?: string }
export type BrowserIdentityVerifier = (platform: LoginPlatform, cookies: BrowserCookie[], signal: AbortSignal) => Promise<ImportedIdentity | null>
export type ImportFetch = (platform: LoginPlatform, url: string, init: RequestInit) => Promise<Response>
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql'

export function applySetCookieHeaders(cookies: BrowserCookie[], setCookies: readonly string[], requestUrl: URL,
  platform: LoginPlatform, now = Date.now() / 1000): void {
  if (!setCookies.length) return
  const host = requestUrl.hostname.toLowerCase()
  const defaultPath = (() => {
    const pathname = requestUrl.pathname || '/'
    if (!pathname.startsWith('/') || pathname === '/') return '/'
    const slash = pathname.lastIndexOf('/')
    return slash <= 0 ? '/' : pathname.slice(0, slash)
  })()
  for (const raw of setCookies) {
    if (typeof raw !== 'string' || !raw || raw.length > 40960) continue
    const parts = raw.split(';')
    const first = parts[0] ?? ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || value.length > 32768 || /[\x00-\x20\x7f;]/.test(value)) continue
    let hostOnly = true
    let normalizedDomain = host
    let cookiePath = defaultPath
    let secure = false
    let httpOnly = false
    let sameSite: BrowserCookie['sameSite']
    let maxAge: number | undefined
    let expiresAt: number | undefined
    let rejected = false
    for (let index = 1; index < parts.length; index++) {
      const part = parts[index]!.trim()
      if (!part) continue
      const sep = part.indexOf('=')
      const attrName = (sep < 0 ? part : part.slice(0, sep)).trim().toLowerCase()
      const attrVal = sep < 0 ? '' : part.slice(sep + 1).trim()
      if (attrName === 'domain') {
        if (!attrVal) continue
        const candidate = attrVal.replace(/^\./, '').toLowerCase()
        if (!(host === candidate || host.endsWith(`.${candidate}`)) || !cookieDomainAllowed(candidate, platform)) {
          rejected = true; break
        }
        hostOnly = false
        normalizedDomain = candidate
      } else if (attrName === 'path') {
        if (attrVal.startsWith('/') && !/[\x00-\x20\x7f]/.test(attrVal)) cookiePath = attrVal
      } else if (attrName === 'secure') {
        secure = true
      } else if (attrName === 'httponly') {
        httpOnly = true
      } else if (attrName === 'samesite') {
        const lower = attrVal.toLowerCase()
        sameSite = lower === 'none' ? 'no_restriction' : lower === 'lax' ? 'lax' : lower === 'strict' ? 'strict' : undefined
      } else if (attrName === 'max-age' && /^-?\d+$/.test(attrVal)) {
        const delta = Number(attrVal)
        if (Number.isSafeInteger(delta)) maxAge = Math.floor(now) + delta
      } else if (attrName === 'expires' && attrVal) {
        const parsed = Date.parse(attrVal)
        if (Number.isFinite(parsed)) expiresAt = Math.floor(parsed / 1000)
      }
    }
    if (rejected || !cookieDomainAllowed(normalizedDomain, platform)) continue
    const effectiveExpiry = maxAge !== undefined ? maxAge : expiresAt
    const matchIndex = cookies.findIndex(cookie =>
      cookie.domain.replace(/^\./, '').toLowerCase() === normalizedDomain
      && (cookie.hostOnly ?? !cookie.domain.startsWith('.')) === hostOnly
      && (cookie.path || '/') === cookiePath
      && cookie.name === name)
    if ((effectiveExpiry !== undefined && effectiveExpiry <= now) || value === '' || (platform === 'youtube' && name === 'LOGIN_INFO' && /^deleted$/i.test(value))) {
      if (matchIndex >= 0) cookies.splice(matchIndex, 1)
      continue
    }
    const next: BrowserCookie = {
      domain: hostOnly ? normalizedDomain : `.${normalizedDomain}`,
      path: cookiePath,
      name,
      value,
      hostOnly,
      secure,
      httpOnly,
      session: effectiveExpiry === undefined,
      ...(effectiveExpiry !== undefined ? { expirationDate: effectiveExpiry } : {}),
      ...(sameSite !== undefined ? { sameSite } : {}),
    }
    if (matchIndex >= 0) cookies[matchIndex] = next
    else cookies.push(next)
  }
}

export function importCookieHeader(cookies: BrowserCookie[], target: URL): string {
  const selected = new Map<string, BrowserCookie>()
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    const cookiePath = cookie.path || '/'
    if (cookie.expirationDate !== undefined && cookie.expirationDate > 0 && cookie.expirationDate <= Date.now() / 1000
      || !(target.hostname === domain || ((cookie.hostOnly === undefined ? cookie.domain.startsWith('.') : !cookie.hostOnly) && target.hostname.endsWith(`.${domain}`)))
      || !(target.pathname === cookiePath || target.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`))
      || cookie.secure && target.protocol !== 'https:' || /[^\x21-\x7e]|;/.test(cookie.value)) continue
    const previous = selected.get(cookie.name)
    const previousDomain = previous?.domain.replace(/^\./, '').toLowerCase()
    if (!previous || domain.length > previousDomain!.length
      || domain === previousDomain && cookiePath.length > (previous.path || '/').length
      || domain === previousDomain && cookiePath === previous.path && cookie.hostOnly && !previous.hostOnly) selected.set(cookie.name, cookie)
  }
  const result = [...selected.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  if (!result || result.length > 128 * 1024) throw new BrowserImportError('browser-import-verification-failed')
  return result
}
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || undefined
  if (value && typeof value === 'object') {
    const field = value as { simpleText?: unknown; runs?: { text?: unknown }[] }
    return text(field.simpleText) ?? (Array.isArray(field.runs) ? text(field.runs.map(run => typeof run.text === 'string' ? run.text : '').join('')) : undefined)
  }
  return undefined
}
function find(value: unknown, key: string, budget = { nodes: 0 }, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 24 || ++budget.nodes > 10000) return undefined
  if (Object.hasOwn(value, key)) return (value as Record<string, unknown>)[key]
  for (const child of Object.values(value)) { const found = find(child, key, budget, depth + 1); if (found) return found }
  return undefined
}
function selectedYoutubeAccount(value: unknown, budget = { nodes: 0 }, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 24 || ++budget.nodes > 10000) return undefined
  const item = (value as Record<string, any>).accountItemRenderer
  if (item?.isSelected === true) return item
  for (const child of Object.values(value)) { const found = selectedYoutubeAccount(child, budget, depth + 1); if (found) return found }
  return undefined
}
function embeddedObject(html: string, index: number): { value: any; end: number } | undefined {
  let quoted = false, escaped = false, depth = 0
  for (let end = index; end < html.length; end++) {
    const character = html[end]
    if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false }
    else if (character === '"') quoted = true
    else if (character === '{') depth++
    else if (character === '}' && --depth === 0) {
      try { return { value: JSON.parse(html.slice(index, end + 1)), end: end + 1 } } catch { return undefined }
    }
  }
  return undefined
}
function youtubeJson(html: string, name: 'config' | 'data'): any {
  const marker = name === 'config' ? /ytcfg\.set\(\s*(?=\{)/g : /(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*(?=\{)/g
  const config: Record<string, unknown> = {}
  let count = 0
  for (const match of html.matchAll(marker)) {
    if (++count > 32) break
    const object = embeddedObject(html, match.index + match[0].length)
    if (!object?.value || typeof object.value !== 'object' || Array.isArray(object.value)) continue
    if (name === 'data') return object.value
    Object.assign(config, object.value)
  }
  return name === 'config' && count ? config : undefined
}

const AVATAR_DOMAINS: Record<LoginPlatform, readonly string[]> = {
  douyu: ['douyucdn.cn', 'douyu.com'], huya: ['huya.com', 'huyaimg.com', 'yyimg.com', 'msstatic.com'],
  bilibili: ['hdslb.com'], douyin: ['douyinpic.com', 'douyincdn.com', 'byteimg.com', 'pstatp.com'],
  youtube: ['ggpht.com', 'googleusercontent.com'], twitch: ['jtvnw.net', 'twitchcdn.net'],
}
export function importAvatarUrl(platform: LoginPlatform, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    if (url.protocol !== 'https:' || url.port || url.username || url.password
      || !AVATAR_DOMAINS[platform].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return undefined
    return url.href
  } catch { return undefined }
}
/** Douyu's member endpoint names the avatar as a path on its image host, without size or extension. */
function douyuIcon(value: unknown): string | undefined {
  return typeof value === 'string' && /^avatar(?:_v3)?(?:\/[A-Za-z0-9_-]{1,64}){1,6}$/.test(value)
    ? `https://apic.douyucdn.cn/upload/${value}_middle.jpg` : undefined
}
function avatar(platform: LoginPlatform, body: any): string | undefined {
  const value = platform === 'bilibili' ? body.data?.face : platform === 'huya' ? body.userLogo
    : platform === 'douyu' ? body.msg?.info?.avatar?.small ?? body.msg?.info?.avatar ?? body.msg?.info?.avatar_url ?? douyuIcon(body.msg?.info?.icon)
      : body.data?.avatar_thumb?.url_list?.[0] ?? body.data?.avatar_medium?.url_list?.[0]
  return importAvatarUrl(platform, value)
}

export function browserIdentityVerifier(fetchImpl: ImportFetch,
  thumbnail: (bytes: Uint8Array) => string | undefined): BrowserIdentityVerifier {
  async function getAvatar(platform: LoginPlatform, url: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    if (!url) return undefined
    try {
      const response = await fetchImpl(platform, url, { method: 'GET', redirect: 'error', signal, credentials: 'omit' })
      if (!response.ok || !/^image\/(png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return undefined
      const bytes = await readPlatformBytes(response, signal)
      const image = thumbnail(bytes)
      return typeof image === 'string' && image.startsWith('data:image/png;base64,') && image.length <= 96 * 1024 ? image : undefined
    } catch { importAbort(signal); return undefined }
  }
  /**
   * Huya's login check leaves the avatar empty. Its own site header reads it from this public
   * lookup by uid, which needs and receives no credentials.
   */
  async function huyaAvatar(uid: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const response = await fetchImpl('huya', `https://user.huya.com/user/getUserInfo?uid=${uid}`,
        { method: 'GET', redirect: 'error', signal, credentials: 'omit', headers: { Accept: 'application/json' } })
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return undefined }
      const data = JSON.parse(await readPlatformText(response, signal))?.data
      return data && String(data.uid) === uid ? importAvatarUrl('huya', data.avatar) : undefined
    } catch { importAbort(signal); return undefined }
  }
  /**
   * Huya's login check can leave the display name empty. Its site header then reads this second
   * endpoint on every page load, and falls back to the login name; do the same, in that order.
   */
  async function huyaNickname(headers: Record<string, string>, loginName: unknown, signal: AbortSignal): Promise<string | undefined> {
    try {
      const response = await fetchImpl('huya', 'https://l.huya.com/udb_web/udbport2.php?m=HuyaOutside&do=checkUserNick', { method: 'GET', headers, signal, redirect: 'error' })
      if (response.ok) {
        const found = text(JSON.parse(await readPlatformText(response, signal))?.userNick)
        if (found) return found
      } else await response.body?.cancel().catch(() => {})
    } catch { importAbort(signal) }
    return text(loginName)
  }
  return async (platform, cookies, parentSignal) => {
    importAbort(parentSignal)
    if (!hasAuthenticationCookies(cookies, platform)) return null
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(20000)])
    if (platform === 'twitch') {
      const token = twitchAuthToken(cookies)
      if (!token) return null
      try {
        const response = await fetchImpl('twitch', TWITCH_GQL_URL, {
          method: 'POST', redirect: 'error', signal,
          headers: {
            'Client-Id': TWITCH_WEB_CLIENT_ID,
            Authorization: `OAuth ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify({ query: 'query { currentUser { id login displayName profileImageURL(width: 300) } }' }),
        })
        if (response.status === 401) { await response.body?.cancel().catch(() => {}); return null }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error() }
        const payload = JSON.parse(await readPlatformText(response, signal)) as Record<string, any>
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error()
        if (payload.data && typeof payload.data === 'object' && payload.data.currentUser === null && !payload.errors) return null
        const user = payload.data?.currentUser
        if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error()
        const uid = typeof user.id === 'string' && /^[1-9]\d{0,29}$/.test(user.id) ? user.id : undefined
        if (!uid) throw new Error()
        const image = await getAvatar('twitch', importAvatarUrl('twitch', user.profileImageURL), signal)
        const username = text(user.displayName) ?? text(user.login) ?? 'Twitch 账号'
        return { uid, username, ...(image ? { avatar: image } : {}) }
      } catch {
        importAbort(parentSignal)
        throw new BrowserImportError('browser-import-verification-failed')
      }
    }
    const target = new URL(platform === 'youtube' ? 'https://www.youtube.com/account' : loginIdentityUrl(platform))
    const header = importCookieHeader(cookies, target)
    const headers = { Cookie: header, 'User-Agent': USER_AGENT, Accept: platform === 'youtube' ? 'text/html' : 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9', Referer: platform === 'douyin' ? 'https://live.douyin.com/' : `${target.origin}/` }
    try {
      const response = await fetchImpl(platform, target.href, { method: 'GET', headers, signal, redirect: 'error' })
      if (platform === 'youtube') applySetCookieHeaders(cookies, response.headers.getSetCookie?.() ?? [], target, platform)
      if (!response.ok) throw new Error()
      const source = await readPlatformText(response, signal)
      if (platform !== 'youtube') {
        const payload = JSON.parse(source)
        const identity = parseLoginIdentity(platform, payload)
        if (identity.status === 'anonymous') return null
        if (identity.status !== 'authenticated' || !identity.uid
          || platform !== 'douyin' && authenticationCookieUserId(cookies, platform) !== identity.uid) throw new Error()
        const avatarAddress = avatar(platform, payload) ?? (platform === 'huya' ? await huyaAvatar(identity.uid, signal) : undefined)
        const image = await getAvatar(platform, avatarAddress, signal)
        const nickname = identity.nickname || (platform === 'huya' ? await huyaNickname(headers, payload?.userName, signal) : undefined)
        return { uid: identity.uid, username: nickname || `${IMPORT_PLATFORM_NAMES[platform]}账号`, ...(image ? { avatar: image } : {}) }
      }
      const config = youtubeJson(source, 'config')
      if (config?.LOGGED_IN === false || !hasAuthenticationCookies(cookies, 'youtube')) return null
      if (config?.LOGGED_IN !== true) throw new Error()
      let account = find(youtubeJson(source, 'data'), 'activeAccountHeaderRenderer')
        ?? find(youtubeJson(source, 'data'), 'accountHeaderRenderer')
      // These POST endpoints only read account presentation; they never select or create an account.
      const sapisid = cookies.find(cookie => (cookie.name === 'SAPISID' || cookie.name === '__Secure-3PAPISID') && cookie.domain.endsWith('youtube.com'))?.value
      if (!account && sapisid && typeof config.INNERTUBE_CONTEXT?.client?.clientVersion === 'string') {
        const timestamp = Math.floor(Date.now() / 1000)
        const hash = createHash('sha1').update(`${timestamp} ${sapisid} ${target.origin}`).digest('hex')
        try {
          const context = config.INNERTUBE_CONTEXT
          const clientHeaders = {
            'X-Youtube-Client-Name': String(config.INNERTUBE_CONTEXT_CLIENT_NAME ?? 1),
            'X-Youtube-Client-Version': context.client.clientVersion,
            ...(typeof context.client.visitorData === 'string' ? { 'X-Goog-Visitor-Id': context.client.visitorData } : {}),
          }
          const menuUrl = new URL(`${target.origin}/youtubei/v1/account/account_menu?prettyPrint=false&alt=json`)
          const menu = await fetchImpl(platform, menuUrl.href, {
            method: 'POST', redirect: 'error', signal,
            headers: { ...headers, Cookie: importCookieHeader(cookies, menuUrl), Accept: 'application/json', 'Content-Type': 'application/json', Origin: target.origin,
              Authorization: `SAPISIDHASH ${timestamp}_${hash}`, 'X-Goog-AuthUser': String(Number(config.SESSION_INDEX) || 0), ...clientHeaders },
            body: JSON.stringify({ context }),
          })
          applySetCookieHeaders(cookies, menu.headers.getSetCookie?.() ?? [], menuUrl, platform)
          if (menu.ok) {
            const data = JSON.parse(await readPlatformText(menu, signal))
            account = find(data, 'activeAccountHeaderRenderer') ?? find(data, 'accountHeaderRenderer')
          } else await menu.body?.cancel().catch(() => {})
          if (!account) {
            const listUrl = new URL(`${target.origin}/youtubei/v1/account/accounts_list?prettyPrint=false&alt=json`)
            const list = await fetchImpl(platform, listUrl.href, {
              method: 'POST', redirect: 'error', signal,
              headers: { ...headers, Cookie: importCookieHeader(cookies, listUrl), Accept: 'application/json', 'Content-Type': 'application/json', Origin: target.origin,
                Authorization: `SAPISIDHASH ${timestamp}_${hash}`, 'X-Goog-AuthUser': String(Number(config.SESSION_INDEX) || 0), ...clientHeaders },
              body: JSON.stringify({ context }),
            })
            applySetCookieHeaders(cookies, list.headers.getSetCookie?.() ?? [], listUrl, platform)
            if (list.ok) account = selectedYoutubeAccount(JSON.parse(await readPlatformText(list, signal)))
            else await list.body?.cancel().catch(() => {})
          }
        } catch { importAbort(parentSignal) }
      }
      const initial = youtubeJson(source, 'data')
      const accountAvatar = account?.accountPhoto?.thumbnails?.[0]?.url ?? account?.avatar?.thumbnails?.[0]?.url
        ?? find(initial, 'topbarMenuButtonRenderer')?.avatar?.thumbnails?.[0]?.url
      const image = await getAvatar(platform, importAvatarUrl(platform, accountAvatar), signal)
      const username = text(account?.accountName) ?? text(account?.channelName) ?? text(find(initial, 'channelMetadataRenderer')?.title) ?? 'YouTube 账号'
      const handle = text(account?.channelHandle)
      const uid = typeof config.DELEGATED_SESSION_ID === 'string' ? config.DELEGATED_SESSION_ID
        : handle ? createHash('sha256').update(handle).digest('hex') : undefined
      return { username, ...(uid ? { uid } : {}), ...(image ? { avatar: image } : {}) }
    } catch {
      importAbort(parentSignal)
      throw new BrowserImportError('browser-import-verification-failed')
    }
  }
}
