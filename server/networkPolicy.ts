import { StreamFailureError } from './networkFailure'
import type { PlatformKind } from './platforms/types'

export type DomesticRouting = 'direct' | 'system'
export interface NetworkRoute {
  kind: 'direct' | 'http' | 'socks5' | 'unsupported'
  proxyUrl?: string
  reason?: 'socks4-unsupported' | 'proxy-type-unsupported'
  alternatives?: readonly NetworkRoute[]
}
export interface NetworkContext { route(url: string): Promise<NetworkRoute> }
export interface ProxySummary { type: 'direct' | 'HTTP' | 'SOCKS' | 'PAC'; fallbackReason?: string }
export const directNetwork: NetworkContext = { route: async () => ({ kind: 'direct' }) }
const DOMESTIC = /(^|\.)(douyu\.com|douyucdn[23]?\.cn|dyscdn\.com|edgesrv\.com|douyuscdn\.com|bytefcdnrd\.com|bilibili\.com|bilivideo\.com|hdslb\.com|huya\.com|msstatic\.com|douyin\.com|amemv\.com|douyincdn\.com)$/i
export function domesticTarget(raw: string): boolean { try { return DOMESTIC.test(new URL(raw).hostname) } catch { return false } }

/** Preserve Chromium's ordered alternatives. Never invent a DIRECT fallback. */
export function parseProxyResult(result: string): NetworkRoute {
  const routes: NetworkRoute[] = []
  for (const entry of result.split(';')) {
    const value = entry.trim()
    if (!value) continue
    if (/^DIRECT$/i.test(value)) { routes.push({ kind: 'direct' }); continue }
    const match = /^(PROXY|HTTPS|HTTP|SOCKS\d*)\s+(.+)$/i.exec(value)
    if (!match) { routes.push({ kind: 'unsupported', reason: 'proxy-type-unsupported' }); continue }
    const type = match[1]!.toUpperCase()
    if (type === 'SOCKS' || type === 'SOCKS4') {
      routes.push({ kind: 'unsupported', reason: 'socks4-unsupported' }); continue
    }
    if (type.startsWith('SOCKS') && type !== 'SOCKS5') {
      routes.push({ kind: 'unsupported', reason: 'proxy-type-unsupported' }); continue
    }
    try {
      const url = new URL(`${type === 'HTTPS' ? 'https' : type === 'SOCKS5' ? 'socks5' : 'http'}://${match[2]}`)
      if (!url.hostname || !['', '/'].includes(url.pathname)
        || url.search || url.hash || /[\s\x00-\x1f\x7f]/.test(match[2]!)) throw new Error('Invalid proxy endpoint')
      if (type === 'SOCKS5' && !url.port) url.port = '1080'
      routes.push({ kind: type === 'SOCKS5' ? 'socks5' : 'http', proxyUrl: url.href })
    } catch { routes.push({ kind: 'unsupported', reason: 'proxy-type-unsupported' }) }
  }
  const [first = { kind: 'unsupported', reason: 'proxy-type-unsupported' } as NetworkRoute, ...alternatives] = routes
  for (const route of alternatives) Object.freeze(route)
  return Object.freeze({ ...first, ...(alternatives.length ? { alternatives: Object.freeze(alternatives) } : {}) })
}

export function routeCandidates(route: NetworkRoute): readonly NetworkRoute[] {
  const result: NetworkRoute[] = []
  const seen = new Set<NetworkRoute>()
  const visit = (value: NetworkRoute): void => {
    if (seen.has(value)) return
    seen.add(value)
    const { alternatives, ...candidate } = value
    result.push(candidate)
    for (const alternative of alternatives ?? []) visit(alternative)
  }
  visit(route)
  return result
}

export function routeUsesRemoteDns(route: NetworkRoute): boolean { return route.kind === 'http' || route.kind === 'socks5' }

export class NetworkPolicy {
  private readonly cache = new Map<string, { expires: number; value: Promise<NetworkRoute> }>()
  constructor(private readonly resolveProxy: (url: string) => Promise<string>, private readonly mode: () => DomesticRouting,
    private readonly now = Date.now, private readonly ttlMs = 15_000, private readonly proxyMode?: () => Promise<'PAC' | undefined>) {}
  invalidate(): void { this.cache.clear() }
  private system(url: string): Promise<NetworkRoute> {
    const old = this.cache.get(url)
    if (old && old.expires > this.now()) return old.value
    let timer: ReturnType<typeof setTimeout>
    const lookup = Promise.race([this.resolveProxy(url), new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error('Proxy resolution timeout')), 15_000)
    })])
    const value = lookup.then(parseProxyResult).catch(() => { throw new StreamFailureError({ stage: 'proxy', code: 'proxy-resolution-failed', message: '无法取得系统代理决策, 请检查系统代理设置.' }) }).finally(() => clearTimeout(timer))
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(url, { expires: this.now() + this.ttlMs, value })
    void value.catch(() => { if (this.cache.get(url)?.value === value) this.cache.delete(url) })
    return value
  }
  /** Freeze the preference and decisions per concrete URL across resolve/pull/reconnect. */
  context(platform?: PlatformKind | null): NetworkContext {
    const domesticMode = this.mode()
    const memo = new Map<string, Promise<NetworkRoute>>()
    const domesticPlatform = platform === 'douyu' || platform === 'bilibili' || platform === 'huya' || platform === 'douyin'
    return { route: (url) => {
      if (domesticMode === 'direct' && (domesticPlatform || domesticTarget(url))) return directNetwork.route(url)
      let value = memo.get(url)
      if (!value) { value = this.system(url); if (memo.size >= 1024) memo.delete(memo.keys().next().value!); memo.set(url, value); void value.catch(() => { if (memo.get(url) === value) memo.delete(url) }) }
      return value
    } }
  }
  async summary(): Promise<ProxySummary> {
    const values = await Promise.all(['https://www.youtube.com/', 'https://gql.twitch.tv/', 'https://www.douyu.com/'].map(url => this.system(url)))
    const routes = values.flatMap(value => routeCandidates(value))
    const types = new Set<ProxySummary['type']>(routes.map(route => route.kind === 'socks5' || route.reason === 'socks4-unsupported' ? 'SOCKS'
      : route.kind === 'http' ? 'HTTP' : route.kind === 'direct' ? 'direct' : 'PAC'))
    const source = await this.proxyMode?.().catch(() => undefined)
    return { type: source ?? (types.size > 1 ? 'PAC' : [...types][0] as ProxySummary['type']),
      ...(routes.some(route => route.reason) ? { fallbackReason: routes.find(route => route.reason)!.reason } : {}) }
  }
}
let defaultPolicy: NetworkPolicy | undefined
export function installNetworkPolicy(policy: NetworkPolicy): void { defaultPolicy = policy }
export function networkContext(platform?: PlatformKind | null): NetworkContext { return defaultPolicy?.context(platform) ?? directNetwork }
export function cleanProxyEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(name)))
}
