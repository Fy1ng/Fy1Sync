/**
 * Outbound fetch with per-hop URL validation.
 *
 * Every hop validates scheme, port, allow-listed hostname and URL credentials.
 * DIRECT routes retain valid resolved IP literals for the connection. HTTP proxy
 * routes use the configured proxy's DNS and retain certificate validation.
 * Redirects are followed manually so every destination receives the same checks.
 */

import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { Agent, ProxyAgent, buildConnector, type Dispatcher } from 'undici'
import { networkContext, type NetworkContext, type NetworkRoute } from './networkPolicy'
import { StreamFailureError, classifyNetworkFailure } from './networkFailure'
import { hostAllowed, type ProxyConfig } from './config'

export type UrlRejection =
  | 'invalid-url'
  | 'bad-scheme'
  | 'bad-port'
  | 'host-not-allowed'
  | 'dns-failed'
  | 'too-many-redirects'

export type UrlCheck =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: UrlRejection; detail: string }

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const STANDARD_PORTS = new Set(['', '80', '443'])
const MAX_DNS_ADDRESSES = 64

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
  proxied = false,
): Promise<UrlCheck> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid-url', detail: '目标地址无法解析为 URL' }
  }

  if (url.username || url.password) return { ok: false, reason: 'invalid-url', detail: '目标地址不能包含登录凭据' }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: 'bad-scheme', detail: `仅支持 http/https，收到 ${url.protocol}` }
  }
  if (!config.allowNonStandardPorts && !STANDARD_PORTS.has(url.port)) {
    return { ok: false, reason: 'bad-port', detail: `不允许的端口 ${url.port}` }
  }
  if (!hostAllowed(url.hostname, config.hosts)) {
    return { ok: false, reason: 'host-not-allowed', detail: `域名未在白名单内：${url.hostname}` }
  }

  if (proxied) return { ok: true, url, addresses: [] }

  // Resolve once and retain valid addresses for the direct connection.
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
  network?: NetworkContext
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
  private readonly agents = new Map<string, Dispatcher>()
  private closed = false
  get(url: URL, addresses: string[], timeoutMs: number, route?: NetworkRoute): Dispatcher {
    if (this.closed) throw new Error('Network service closed')
    const key = JSON.stringify([url.origin, [...addresses].sort(), timeoutMs, route?.proxyUrl ?? 'DIRECT'])
    let agent = this.agents.get(key)
    if (!agent) {
      if (this.agents.size >= 8) {
        const first = this.agents.keys().next().value!
        void this.agents.get(first)!.close().catch(() => {})
        this.agents.delete(first)
      }
      agent = route?.kind === 'http' ? new ProxyAgent({ uri: route.proxyUrl!, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } }) : createPinnedDispatcher(url.hostname, addresses, timeoutMs, 60_000)
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

async function checkWithSignal(target: string, config: ProxyConfig, resolve: Resolver, signal: AbortSignal, proxied = false): Promise<UrlCheck> {
  signal.throwIfAborted()
  let abort = () => {}
  try {
    return await Promise.race([
      checkUrl(target, config, resolve, proxied),
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
 * so each redirect destination is checked against the URL policy.
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
  const network = options.network ?? networkContext()

  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    const syntax = await checkWithSignal(target, config, resolve, signal, true)
    if (!syntax.ok) throw new ProxyError(syntax.reason, syntax.detail, 403)
    const route = await network.route(target)
    const check = await checkWithSignal(target, config, resolve, signal, route.kind === 'http')
    if (!check.ok) throw new ProxyError(check.reason, check.detail, 403)
    signal.throwIfAborted()
    const pooled = options.dispatcherPool !== undefined
    const dispatcher = options.dispatcherPool?.get(check.url, check.addresses, config.requestTimeoutMs, route)
      ?? (route.kind === 'http' ? new ProxyAgent({ uri: route.proxyUrl!, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } }) : createPinnedDispatcher(check.url.hostname, check.addresses, config.requestTimeoutMs))
    const abort = () => { void dispatcher.destroy().catch(() => {}) }
    if (!pooled) signal.addEventListener('abort', abort, { once: true })
    let response: Response
    try {
      const init: RequestInit & { dispatcher: Dispatcher } = {
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
      if (route.kind === 'direct' || error instanceof Error && error.name === 'AdaptivePullError') throw error
      const failure = classifyNetworkFailure(error, 'proxy')
      throw new StreamFailureError(failure)
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
