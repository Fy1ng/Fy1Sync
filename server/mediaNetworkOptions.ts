export interface MediaSourceRule {
  origin: string
  headers: Record<string, string>
  verifyTls: boolean
  verifyProxyTls: boolean
}

/** User-owned playback policy. Account, update and other service requests stay strict. */
export interface MediaNetworkOptions {
  routing: 'platform' | 'system' | 'direct' | 'custom'
  proxyUrl: string
  fallbackDirect: boolean
  verifyTls: boolean
  verifyProxyTls: boolean
  allowPrivate: boolean
  /** Zero disables the corresponding application limit. */
  maxRedirects: number
  requestTimeoutMs: number
  startupTimeoutMs: number
  stallTimeoutMs: number
  reconnectAttempts: number
  sourceRules?: MediaSourceRule[]
  maxExtraStreams?: number
}

export const DEFAULT_MEDIA_NETWORK: Readonly<MediaNetworkOptions> = Object.freeze({
  routing: 'platform', proxyUrl: '', fallbackDirect: false,
  verifyTls: false, verifyProxyTls: false, allowPrivate: true,
  maxRedirects: 0, requestTimeoutMs: 0, startupTimeoutMs: 0, stallTimeoutMs: 0, reconnectAttempts: 0,
  sourceRules: [], maxExtraStreams: 0,
})

export function validMediaNetwork(value: unknown): value is MediaNetworkOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !Object.hasOwn(DEFAULT_MEDIA_NETWORK, key))
    || !Object.keys(DEFAULT_MEDIA_NETWORK).filter(key => !['sourceRules', 'maxExtraStreams'].includes(key)).every(key => Object.hasOwn(item, key))) return false
  if (!['platform', 'system', 'direct', 'custom'].includes(String(item.routing))
    || typeof item.proxyUrl !== 'string' || item.proxyUrl.length > 8192) return false
  for (const key of ['fallbackDirect', 'verifyTls', 'verifyProxyTls', 'allowPrivate']) if (typeof item[key] !== 'boolean') return false
  for (const key of ['maxRedirects', 'requestTimeoutMs', 'startupTimeoutMs', 'stallTimeoutMs', 'reconnectAttempts']) {
    if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0 || Number(item[key]) > 2_147_483_647) return false
  }
  if (item.maxExtraStreams !== undefined && (!Number.isSafeInteger(item.maxExtraStreams) || Number(item.maxExtraStreams) < 0)) return false
  if (item.sourceRules !== undefined) {
    if (!Array.isArray(item.sourceRules)) return false
    const origins = new Set<string>()
    for (const rule of item.sourceRules) {
      if (!validMediaSourceRule(rule) || origins.has(rule.origin)) return false
      origins.add(rule.origin)
    }
    if (JSON.stringify(item.sourceRules).length > 512 * 1024) return false
  }
  if (!item.proxyUrl) return item.routing !== 'custom'
  try {
    const url = new URL(item.proxyUrl)
    return ['http:', 'https:', 'socks5:'].includes(url.protocol) && Boolean(url.hostname)
      && ['', '/'].includes(url.pathname) && !url.search && !url.hash && !/[\s\x00-\x1f\x7f]/.test(item.proxyUrl)
  } catch { return false }
}

export function validMediaSourceRule(value: unknown): value is MediaSourceRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rule = value as MediaSourceRule
  if (Object.keys(rule).length !== 4 || typeof rule.origin !== 'string' || typeof rule.verifyTls !== 'boolean'
    || typeof rule.verifyProxyTls !== 'boolean' || !rule.headers || typeof rule.headers !== 'object' || Array.isArray(rule.headers)) return false
  try {
    const url = new URL(rule.origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== rule.origin) return false
  } catch { return false }
  const names = new Set<string>()
  for (const [name, content] of Object.entries(rule.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof content !== 'string' || /[\r\n\0]/.test(content) || names.has(name.toLowerCase())) return false
    names.add(name.toLowerCase())
  }
  return JSON.stringify(rule.headers).length <= 65_536
}

export function mediaSourceRule(media: Readonly<MediaNetworkOptions> | undefined, raw: string): MediaSourceRule | undefined {
  try { return media?.sourceRules?.find(rule => rule.origin === new URL(raw).origin) } catch { return undefined }
}

export function mediaTlsPolicy(media: Readonly<MediaNetworkOptions> | undefined, raw: string, credentialed: boolean): { verifyTls: boolean; verifyProxyTls: boolean } {
  const rule = mediaSourceRule(media, raw)
  return { verifyTls: rule?.verifyTls ?? (credentialed || media?.verifyTls !== false),
    verifyProxyTls: rule?.verifyProxyTls ?? (credentialed || media?.verifyProxyTls !== false) }
}

export function timeoutSignal(milliseconds: number, owner?: AbortSignal): AbortSignal {
  const timeout = milliseconds > 0 ? AbortSignal.timeout(milliseconds) : undefined
  return owner && timeout ? AbortSignal.any([owner, timeout]) : owner ?? timeout ?? new AbortController().signal
}
