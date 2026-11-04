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
import { Agent, buildConnector, type Dispatcher } from 'undici'
import { networkContext, routeCandidates, routeUsesRemoteDns, type NetworkContext, type NetworkRoute } from './networkPolicy'
import { createProxyDispatcher, isProxyConnectFailure } from './proxyDispatcher'
import { StreamFailureError, classifyNetworkFailure } from './networkFailure'
import { hostAllowed, type RequestPolicy } from './config'
import { mediaEntry, type MediaAccess } from './mediaAccess'

export type UrlRejection =
  | 'invalid-url'
  | 'bad-scheme'
  | 'bad-port'
  | 'host-not-allowed'
  | 'dns-failed'
  | 'too-many-redirects'
  | 'media-network-boundary'
  | 'cross-origin-credentials'

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
  config: RequestPolicy,
  resolve: Resolver = dnsResolver,
  proxied = false,
): Promise<UrlCheck> {
  const syntax = checkUrlSyntax(raw, config)
  return syntax.ok ? resolveTarget(syntax.url, resolve, proxied) : syntax
}

export function checkUrlSyntax(raw: string, config: RequestPolicy): UrlCheck {
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
  const strict = 'purpose' in config ? undefined : config
  if (strict && !strict.allowNonStandardPorts && !STANDARD_PORTS.has(url.port)) {
    return { ok: false, reason: 'bad-port', detail: `不允许的端口 ${url.port}` }
  }
  if (strict && !hostAllowed(url.hostname, strict.hosts)) {
    return { ok: false, reason: 'host-not-allowed', detail: `域名未在白名单内：${url.hostname}` }
  }

  return { ok: true, url, addresses: [] }
}

async function resolveTarget(url: URL, resolve: Resolver, proxied: boolean): Promise<UrlCheck> {
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
  /** Explicit source authority, shared by redirects and automatically discovered HLS resources. */
  mediaAccess?: MediaAccess
  /** Separates sessions and credential identities while retaining per-origin pooling. */
  connectionScope?: string
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
export function createPinnedDispatcher(hostname: string, addresses: readonly string[], timeoutMs = 15_000, keepAliveTimeout = 4_000, connections = 1): Agent {
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
    connections, maxOrigins: 1,
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
  private readonly retiring = new Set<Dispatcher>()
  private closed = false
  constructor(private readonly options: { maxEntries?: number; connections?: number } = {}) {}
  get(url: URL, addresses: string[], timeoutMs: number, route?: NetworkRoute, scope = ''): Dispatcher {
    if (this.closed) throw new Error('Network service closed')
    const key = JSON.stringify([url.origin, [...addresses].sort(), timeoutMs, route?.kind ?? 'direct', route?.proxyUrl ?? '', scope])
    let agent = this.agents.get(key)
    if (!agent) {
      if (this.agents.size >= (this.options.maxEntries ?? 8)) {
        const first = this.agents.keys().next().value!
        const retiring = this.agents.get(first)!
        this.retiring.add(retiring)
        void retiring.close().catch(() => {}).finally(() => this.retiring.delete(retiring))
        this.agents.delete(first)
      }
      agent = route && route.kind !== 'direct' ? createProxyDispatcher(route, timeoutMs, this.options.connections ?? 1)
        : createPinnedDispatcher(url.hostname, addresses, timeoutMs, 60_000, this.options.connections ?? 1)
      this.agents.set(key, agent)
    }
    return agent
  }
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.all([...this.agents.values(), ...this.retiring].map(agent => agent.destroy().catch(() => {})))
    this.agents.clear()
    this.retiring.clear()
  }
}

async function withSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort = () => {}
  try {
    return await Promise.race([
      operation(),
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
  config: RequestPolicy,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const doFetch = options.fetchImpl ?? fetch
  const resolve = options.resolve ?? dnsResolver
  const signal = options.signal ?? AbortSignal.timeout(config.requestTimeoutMs)
  let target = raw
  const network = options.network ?? networkContext()
  const access = 'purpose' in config && config.purpose === 'media' ? options.mediaAccess ?? mediaEntry(raw) : undefined

  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    signal.throwIfAborted()
    const syntax = checkUrlSyntax(target, config)
    if (!syntax.ok) throw new ProxyError(syntax.reason, syntax.detail, 403)
    const routes = routeCandidates(await withSignal(() => network.route(target), signal))
    let response: Response | undefined
    for (let index = 0; index < routes.length; index++) {
      const route = routes[index]!
      const hasNext = index < routes.length - 1
      if (route.kind === 'unsupported') {
        if (hasNext) continue
        throw new StreamFailureError({ stage: 'proxy', code: route.reason === 'socks4-unsupported' ? 'socks4-unsupported' : 'proxy-type-unsupported',
          message: route.reason === 'socks4-unsupported' ? '系统代理要求 SOCKS4, 当前不支持, 请在代理软件中改用 SOCKS5 或 HTTP.' : '系统代理类型不受支持, 请检查代理设置.' })
      }
      const check = await withSignal(() => resolveTarget(syntax.url, resolve, routeUsesRemoteDns(route)), signal)
      if (!check.ok) throw new ProxyError(check.reason, check.detail, 403)
      if (access && !access.scope.permits(check.url, check.addresses, access.entry && hop === 0, false)) {
        throw new ProxyError('media-network-boundary', '自动发现的媒体资源跨到了未授权的本机或局域网来源, 请手动添加该来源.', 403)
      }
      signal.throwIfAborted()
      const pooled = options.dispatcherPool !== undefined
      const dispatcher = options.dispatcherPool?.get(check.url, check.addresses, config.requestTimeoutMs, route, options.connectionScope)
        ?? (route.kind !== 'direct' ? createProxyDispatcher(route, config.requestTimeoutMs) : createPinnedDispatcher(check.url.hostname, check.addresses, config.requestTimeoutMs))
      const abort = () => { void dispatcher.destroy().catch(() => {}) }
      if (!pooled) signal.addEventListener('abort', abort, { once: true })
      try {
        const init: RequestInit & { dispatcher: Dispatcher } = {
          method: options.method ?? 'GET', headers: options.headers, body: options.body,
          redirect: 'manual', signal, dispatcher,
        }
        response = await doFetch(check.url, init)
        if (signal.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted() }
        access?.scope.permits(check.url, check.addresses, access.entry && hop === 0)
        if (!pooled) void dispatcher.close().catch(() => dispatcher.destroy()).catch(() => {})
          .finally(() => signal.removeEventListener('abort', abort))
        break
      } catch (error) {
        signal.removeEventListener('abort', abort)
        if (!pooled) await dispatcher.destroy().catch(() => {})
        signal.throwIfAborted()
        if (route.kind !== 'direct' && hasNext && isProxyConnectFailure(error)) continue
        if (route.kind === 'direct' || error instanceof Error && error.name === 'AdaptivePullError') throw error
        throw new StreamFailureError(classifyNetworkFailure(error, 'proxy'))
      }
    }
    if (!response) throw new StreamFailureError({ stage: 'proxy', code: 'proxy-type-unsupported', message: '系统代理没有可用的连接候选.' })

    if (!isRedirect(response.status)) {
      return { response, finalUrl: syntax.url }
    }
    const location = response.headers.get('location')
    if (!location) return { response, finalUrl: syntax.url }
    // Drain the redirect body so the socket can be reused.
    await response.body?.cancel().catch(() => {})
    const next = new URL(location, syntax.url)
    // Platform login credentials must never follow a redirect to another origin.
    if (hasSensitiveHeaders(options.headers) && next.origin !== syntax.url.origin) throw new ProxyError('cross-origin-credentials', '禁止将平台登录信息发送到其他来源', 403)
    target = next.toString()
  }

  throw new ProxyError('too-many-redirects', `跳转次数超过 ${config.maxRedirects} 次`, 502)
}

export function hasSensitiveHeaders(headers?: Record<string, string>): boolean {
  return Object.keys(headers ?? {}).some(name => /^(?:cookie2?|authorization|proxy-authorization)$/i.test(name)
    || /(?:token|secret|csrf|api[-_]?key|^x-auth)/i.test(name))
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
