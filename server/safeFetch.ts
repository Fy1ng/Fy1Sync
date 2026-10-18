/**
 * SSRF-guarded outbound fetch.
 *
 * The browser hands this server arbitrary URLs (a playlist the user pasted, a segment
 * URI found inside a playlist). Without checks that is a confused-deputy hole: the
 * server would happily fetch `http://169.254.169.254/` or a host on the user's LAN and
 * hand the body back. So every hop is validated: scheme, port, allow-listed hostname,
 * and the resolved IP literals.
 *
 * Redirects are followed manually, one validated hop at a time, because `fetch`'s own
 * redirect handling would skip the checks on hops 2..n.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { hostAllowed, type ProxyConfig } from './config'

export type UrlRejection =
  | 'invalid-url'
  | 'bad-scheme'
  | 'bad-port'
  | 'host-not-allowed'
  | 'private-address'
  | 'dns-failed'
  | 'too-many-redirects'

export type UrlCheck =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: UrlRejection; detail: string }

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const STANDARD_PORTS = new Set(['', '80', '443'])

/**
 * True for addresses that must never be reachable through the proxy: loopback, RFC1918,
 * link-local (including cloud metadata at 169.254.169.254), CGNAT, and their v6 forms.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPrivateIPv4(address)
  if (version === 6) return isPrivateIPv6(address)
  return false
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast + reserved
  return false
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fe80')) return true // link-local
  if (/^f[cd]/.test(normalized)) return true // unique local
  if (normalized.startsWith('ff')) return true // multicast
  // IPv4-mapped (::ffff:10.0.0.1) inherits the v4 rules.
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mapped) return isPrivateIPv4(mapped[1]!)
  return false
}

export type Resolver = (hostname: string) => Promise<string[]>

export const dnsResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

/** Validate one URL against the proxy policy. Never performs the request. */
export async function checkUrl(
  raw: string,
  config: ProxyConfig,
  resolve: Resolver = dnsResolver,
): Promise<UrlCheck> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid-url', detail: '目标地址无法解析为 URL' }
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: 'bad-scheme', detail: `仅支持 http/https，收到 ${url.protocol}` }
  }
  if (!config.allowNonStandardPorts && !STANDARD_PORTS.has(url.port)) {
    return { ok: false, reason: 'bad-port', detail: `不允许的端口 ${url.port}` }
  }
  if (!hostAllowed(url.hostname, config.hosts)) {
    return { ok: false, reason: 'host-not-allowed', detail: `域名未在白名单内：${url.hostname}` }
  }

  // A hostname is only as safe as what it resolves to; DNS can point anywhere.
  let addresses: string[]
  const literal = isIP(url.hostname.replace(/^\[|\]$/g, ''))
  if (literal) {
    addresses = [url.hostname.replace(/^\[|\]$/g, '')]
  } else {
    try {
      addresses = await resolve(url.hostname)
    } catch (error) {
      return {
        ok: false,
        reason: 'dns-failed',
        detail: `域名解析失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (addresses.length === 0) {
      return { ok: false, reason: 'dns-failed', detail: `域名没有解析结果：${url.hostname}` }
    }
  }

  if (!config.allowNonLoopbackTargets) {
    const blocked = addresses.find((address) => isPrivateAddress(address))
    if (blocked !== undefined) {
      return {
        ok: false,
        reason: 'private-address',
        detail: `目标解析到内网地址 ${blocked}，已拒绝`,
      }
    }
  }

  return { ok: true, url, addresses }
}

export class ProxyError extends Error {
  constructor(
    readonly reason: UrlRejection | 'upstream-failed',
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ProxyError'
  }
}

export type SafeFetchOptions = {
  headers?: Record<string, string>
  method?: string
  body?: string
  signal?: AbortSignal
  resolve?: Resolver
  fetchImpl?: typeof fetch
}

export type SafeFetchResult = {
  response: Response
  /** URL of the final hop, needed to resolve relative URIs inside playlists. */
  finalUrl: URL
}

/**
 * Fetch with per-hop validation. Redirects are resolved here rather than by `fetch`
 * so a redirect to an internal address is rejected instead of silently followed.
 */
export async function safeFetch(
  raw: string,
  config: ProxyConfig,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const doFetch = options.fetchImpl ?? fetch
  const resolve = options.resolve ?? dnsResolver
  let target = raw

  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    const check = await checkUrl(target, config, resolve)
    if (!check.ok) throw new ProxyError(check.reason, check.detail, 403)

    const response = await doFetch(check.url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      redirect: 'manual',
      signal: options.signal,
    })

    if (!isRedirect(response.status)) {
      return { response, finalUrl: check.url }
    }
    const location = response.headers.get('location')
    if (!location) return { response, finalUrl: check.url }
    // Drain the redirect body so the socket can be reused.
    await response.body?.cancel().catch(() => {})
    target = new URL(location, check.url).toString()
  }

  throw new ProxyError('too-many-redirects', `跳转次数超过 ${config.maxRedirects} 次`, 502)
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
