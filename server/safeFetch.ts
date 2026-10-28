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
import ipaddr from 'ipaddr.js'
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

const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8', // unspecified / this network
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local + metadata
  '172.16.0.0/12',
  '192.0.0.0/24', // IETF protocol assignments, not the entire 192.0.0.0/16
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // deprecated 6to4 relay anycast
  '192.168.0.0/16',
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, including limited broadcast
].map(cidr => ipaddr.IPv4.parseCIDR(cidr))

const BLOCKED_IPV6_CIDRS = [
  '::/128',
  '::1/128',
  '64:ff9b:1::/48', // local-use translation, unlike the well-known /96 below
  '100::/64', // discard-only
  '100:0:0:1::/64', // dummy prefix
  '2001:2::/48', // benchmarking
  '2001:10::/28', // deprecated ORCHID
  '2001:db8::/32', // documentation
  '3fff::/20', // documentation
  '5f00::/16', // SRv6 SIDs, not globally reachable destinations
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // deprecated site-local
  'ff00::/8', // multicast
].map(cidr => ipaddr.IPv6.parseCIDR(cidr))

const FAKE_IPV4_CIDR = ipaddr.IPv4.parseCIDR('198.18.0.0/15')
const EMBEDDED_IPV4_CIDRS = ['::/96', '::ffff:0:0/96', '64:ff9b::/96']
  .map(cidr => ipaddr.IPv6.parseCIDR(cidr))

/**
 * True for addresses that must never be reachable through the proxy: loopback, RFC1918,
 * link-local, CGNAT, multicast and the explicit reserved/local-use prefixes above.
 * Other addresses stay eligible; library range labels are not the proxy's policy.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  // Keep Node's strict literal gate: ipaddr.js also accepts legacy octal/short forms.
  if (version === 0) return false
  if (version === 4) return isPrivateIPv4(ipaddr.IPv4.parse(address))
  // A validated zone ID affects routing scope, not the address's CIDR membership.
  const parsed = ipaddr.IPv6.parse(address.split('%')[0]!)
  if (BLOCKED_IPV6_CIDRS.some(cidr => parsed.match(cidr))) return true
  if (EMBEDDED_IPV4_CIDRS.some(cidr => parsed.match(cidr))) {
    return isPrivateIPv4(new ipaddr.IPv4(parsed.toByteArray().slice(12)))
  }
  return false
}

function isPrivateIPv4(address: ipaddr.IPv4): boolean {
  // 198.18.0.0/15 (benchmarking) is deliberately NOT blocked. Clash/mihomo-style proxies in
  // TUN fake-IP mode answer every DNS query with an address from this range and route the
  // connection by domain, so blocking it rejects every platform request on such machines.
  // It is safe to allow: the hostname allow-list is checked before DNS, and the range is not
  // assigned to real hosts on a LAN.
  if (address.match(FAKE_IPV4_CIDR)) return false
  return BLOCKED_IPV4_CIDRS.some(cidr => address.match(cidr))
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
  body?: string | Uint8Array<ArrayBuffer>
  signal?: AbortSignal
  resolve?: Resolver
  fetchImpl?: typeof fetch
  /** Owned by a trusted service, never renderer input. Every reuse still validates DNS. */
  dispatcherPool?: PinnedDispatcherPool
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
export function createPinnedDispatcher(hostname: string, addresses: readonly string[], timeoutMs = 15_000, keepAliveTimeout = 4_000): Agent {
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
    keepAliveTimeout, keepAliveMaxTimeout: Math.max(keepAliveTimeout, 60_000),
    connect: (options, callback) => {
      // Literal addresses bypass Node's lookup callback, so validate the connect
      // hostname as well. Preserve the original hostname, Host header and TLS SNI.
      if (options.hostname.toLowerCase().replace(/^\[|\]$/g, '') !== host) { callback(reject(), null); return }
      connect(options, callback)
    },
  })
}

/** Small service-owned pool; changed DNS answers never reuse a differently pinned socket. */
export class PinnedDispatcherPool {
  private readonly agents = new Map<string, Agent>()
  private closed = false
  get(url: URL, addresses: string[], timeoutMs: number): Agent {
    if (this.closed) throw new Error('Network service closed')
    const key = JSON.stringify([url.origin, [...addresses].sort(), timeoutMs])
    let agent = this.agents.get(key)
    if (!agent) {
      if (this.agents.size >= 8) {
        const first = this.agents.keys().next().value!
        void this.agents.get(first)!.close().catch(() => {})
        this.agents.delete(first)
      }
      agent = createPinnedDispatcher(url.hostname, addresses, timeoutMs, 60_000)
      this.agents.set(key, agent)
    }
    return agent
  }
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.all([...this.agents.values()].map(agent => agent.destroy().catch(() => {})))
    this.agents.clear()
  }
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
    const pooled = options.dispatcherPool !== undefined
    const dispatcher = options.dispatcherPool?.get(check.url, check.addresses, config.requestTimeoutMs)
      ?? createPinnedDispatcher(check.url.hostname, check.addresses, config.requestTimeoutMs)
    const abort = () => { void dispatcher.destroy().catch(() => {}) }
    if (!pooled) signal.addEventListener('abort', abort, { once: true })
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
      if (!pooled) void dispatcher.close().catch(() => dispatcher.destroy()).catch(() => {})
        .finally(() => signal.removeEventListener('abort', abort))
    } catch (error) {
      signal.removeEventListener('abort', abort)
      if (!pooled) await dispatcher.destroy().catch(() => {})
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
