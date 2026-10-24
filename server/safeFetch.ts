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
import { isIP, type LookupFunction } from 'node:net'
import { Agent, buildConnector } from 'undici'
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
const MAX_DNS_ADDRESSES = 64

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
  // 198.18.0.0/15 (benchmarking) is deliberately NOT blocked. Clash/mihomo-style proxies in
  // TUN fake-IP mode answer every DNS query with an address from this range and route the
  // connection by domain, so blocking it rejects every platform request on such machines.
  // It is safe to allow: the hostname allow-list is checked before DNS, and the range is not
  // assigned to real hosts on a LAN.
  if (a >= 224) return true // multicast + reserved
  return false
}

function isPrivateIPv6(address: string): boolean {
  const words = parseIPv6(address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!)
  // Anything that does not parse is refused rather than guessed at.
  if (!words) return true
  const [first, second] = words as [number, number]
  if (words.every((word) => word === 0)) return true // ::
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true // ::1
  if ((first & 0xffc0) === 0xfe80) return true // link-local
  if ((first & 0xfe00) === 0xfc00) return true // unique local
  if ((first & 0xff00) === 0xff00) return true // multicast
  if (first === 0x2001 && second === 0x0db8) return true // documentation
  // An IPv4 address carried inside IPv6 inherits the v4 rules. The URL parser rewrites
  // `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the hex form must be decoded too —
  // matching only the dotted form let loopback and cloud metadata through.
  const embedded = embeddedIPv4(words)
  if (embedded) return isPrivateIPv4(embedded)
  return false
}

/** Eight 16-bit words, or null when the text is not a valid IPv6 literal. */
function parseIPv6(text: string): number[] | null {
  let normalized = text
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1]
  if (dotted) {
    if (isIP(dotted) !== 4) return null
    const [a, b, c, d] = dotted.split('.').map(Number) as [number, number, number, number]
    normalized = `${normalized.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  if ((normalized.match(/::/g) ?? []).length > 1) return null
  const [head = '', tail = ''] = normalized.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const compressed = normalized.includes('::')
  const missing = 8 - headParts.length - tailParts.length
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return null
  const parts = compressed ? [...headParts, ...Array<string>(missing).fill('0'), ...tailParts] : headParts
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  return parts.map((part) => Number.parseInt(part, 16))
}

/** IPv4-compatible (::a.b.c.d), IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96). */
function embeddedIPv4(words: number[]): string | null {
  const zeroPrefix = words.slice(0, 5).every((word) => word === 0)
  const compatible = zeroPrefix && words[5] === 0
  const mapped = zeroPrefix && words[5] === 0xffff
  const nat64 = words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)
  if (!compatible && !mapped && !nat64) return null
  const high = words[6]!
  const low = words[7]!
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
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
    if (!validAddresses(addresses)) {
      return { ok: false, reason: 'dns-failed', detail: '域名没有返回有界且有效的 IP 地址.' }
    }
  }
  // Retain an immutable snapshot of this lookup, not a resolver-owned array.
  addresses = [...new Set(addresses)]

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

function validAddresses(addresses: unknown): addresses is string[] {
  return Array.isArray(addresses) && addresses.length > 0 && addresses.length <= MAX_DNS_ADDRESSES
    && addresses.every(address => typeof address === 'string' && isIP(address) !== 0)
}

/** The caller has already applied its HTTP or WebSocket address policy. */
export function createPinnedDispatcher(hostname: string, addresses: readonly string[], timeoutMs = 15_000): Agent {
  if (!validAddresses(addresses)) throw new ProxyError('dns-failed', '无法固定已校验的连接地址.', 403)
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const records = [...new Set(addresses)].map(address => ({ address, family: isIP(address) }))
  const reject = () => Object.assign(new Error('Unvalidated connection target'), { code: 'ENOTFOUND' })
  const lookup: LookupFunction = (target, options, callback) => {
    if (target.toLowerCase().replace(/^\[|\]$/g, '') !== host) { queueMicrotask(() => callback(reject(), '')); return }
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
    const selected = records.filter(record => !family || record.family === family)
    queueMicrotask(() => {
      if (!selected.length) callback(reject(), '')
      else if (options.all) callback(null, selected.map(record => ({ ...record })))
      else callback(null, selected[0]!.address, selected[0]!.family)
    })
  }
  const connect = buildConnector({ lookup, timeout: timeoutMs, autoSelectFamily: true })
  return new Agent({
    connections: 1, maxOrigins: 1,
    connect: (options, callback) => {
      // Literal addresses bypass Node's lookup callback, so validate the connect
      // hostname as well. Preserve the original hostname, Host header and TLS SNI.
      if (options.hostname.toLowerCase().replace(/^\[|\]$/g, '') !== host) { callback(reject(), null); return }
      connect(options, callback)
    },
  })
}

async function checkWithSignal(target: string, config: ProxyConfig, resolve: Resolver, signal: AbortSignal): Promise<UrlCheck> {
  signal.throwIfAborted()
  let abort = () => {}
  try {
    return await Promise.race([
      checkUrl(target, config, resolve),
      new Promise<never>((_yes, no) => {
        abort = () => no(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally { signal.removeEventListener('abort', abort) }
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
  const signal = options.signal ?? AbortSignal.timeout(config.requestTimeoutMs)
  let target = raw

  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    const check = await checkWithSignal(target, config, resolve, signal)
    if (!check.ok) throw new ProxyError(check.reason, check.detail, 403)
    signal.throwIfAborted()
    const dispatcher = createPinnedDispatcher(check.url.hostname, check.addresses, config.requestTimeoutMs)
    const abort = () => { void dispatcher.destroy().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    let response: Response
    try {
      const init: RequestInit & { dispatcher: Agent } = {
        method: options.method ?? 'GET', headers: options.headers, body: options.body,
        redirect: 'manual', signal, dispatcher,
      }
      response = await doFetch(check.url, init)
      if (signal.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted() }
      // close() drains the in-flight response without aborting it, then releases
      // its connection. A body cancellation or signal abort also tears it down.
      void dispatcher.close().catch(() => dispatcher.destroy()).catch(() => {})
        .finally(() => signal.removeEventListener('abort', abort))
    } catch (error) {
      signal.removeEventListener('abort', abort)
      await dispatcher.destroy().catch(() => {})
      throw error
    }

    if (!isRedirect(response.status)) {
      return { response, finalUrl: check.url }
    }
    const location = response.headers.get('location')
    if (!location) return { response, finalUrl: check.url }
    // Drain the redirect body so the socket can be reused.
    await response.body?.cancel().catch(() => {})
    const next = new URL(location, check.url)
    // Platform login credentials must never follow a redirect to another origin.
    const credentials = Object.keys(options.headers ?? {}).some(name => /^(cookie|authorization|proxy-authorization)$/i.test(name))
    if (credentials && next.origin !== check.url.origin) throw new ProxyError('upstream-failed', '禁止将平台登录信息发送到其他来源', 403)
    target = next.toString()
  }

  throw new ProxyError('too-many-redirects', `跳转次数超过 ${config.maxRedirects} 次`, 502)
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
