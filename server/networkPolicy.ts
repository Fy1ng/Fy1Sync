import { StreamFailureError } from './networkFailure'
import type { PlatformKind } from './platforms/types'

export type DomesticRouting = 'direct' | 'system'
export interface NetworkRoute { kind: 'direct' | 'http'; proxyUrl?: string; reason?: 'socks-unsupported' | 'proxy-type-unsupported' }
export interface NetworkContext { route(url: string): Promise<NetworkRoute> }
export interface ProxySummary { type: 'direct' | 'HTTP' | 'SOCKS' | 'PAC'; fallbackReason?: string }
export const directNetwork: NetworkContext = { route: async () => ({ kind: 'direct' }) }
const DOMESTIC = /(^|\.)(douyu\.com|douyucdn[23]?\.cn|dyscdn\.com|edgesrv\.com|douyuscdn\.com|bytefcdnrd\.com|bilibili\.com|bilivideo\.com|hdslb\.com|huya\.com|msstatic\.com)$/i
export function domesticTarget(raw: string): boolean { try { return DOMESTIC.test(new URL(raw).hostname) } catch { return false } }

/** Parse Chromium's ordered result. Unsupported SOCKS explicitly falls back to DIRECT. */
export function parseProxyResult(result: string): NetworkRoute {
  for (const entry of result.split(';')) {
    const value = entry.trim()
    if (/^DIRECT$/i.test(value)) return { kind: 'direct' }
    const match = /^(PROXY|HTTPS|HTTP|SOCKS\d*)\s+(.+)$/i.exec(value)
    if (!match) continue
    if (/^SOCKS/i.test(match[1]!)) return { kind: 'direct', reason: 'socks-unsupported' }
    try {
      const url = new URL(`${match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`)
      if (!url.hostname || url.pathname !== '/' || url.search || url.hash) continue
      return { kind: 'http', proxyUrl: url.href }
    } catch { /* Try the next declared route. */ }
  }
  return { kind: 'direct', reason: 'proxy-type-unsupported' }
}

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
    const domesticPlatform = platform === 'douyu' || platform === 'bilibili' || platform === 'huya'
    return { route: (url) => {
      if (domesticMode === 'direct' && (domesticPlatform || domesticTarget(url))) return directNetwork.route(url)
      let value = memo.get(url)
      if (!value) { value = this.system(url); if (memo.size >= 1024) memo.delete(memo.keys().next().value!); memo.set(url, value); void value.catch(() => { if (memo.get(url) === value) memo.delete(url) }) }
      return value
    } }
  }
  async summary(): Promise<ProxySummary> {
    const values = await Promise.all(['https://www.youtube.com/', 'https://gql.twitch.tv/', 'https://www.douyu.com/'].map(url => this.system(url)))
    const types = new Set(values.map(route => route.reason === 'socks-unsupported' ? 'SOCKS' : route.kind === 'http' ? 'HTTP' : 'direct'))
    const source = await this.proxyMode?.().catch(() => undefined)
    return { type: source ?? (types.size > 1 ? 'PAC' : [...types][0] as ProxySummary['type']),
      ...(values.some(route => route.reason) ? { fallbackReason: values.find(route => route.reason)!.reason } : {}) }
  }
}
let defaultPolicy: NetworkPolicy | undefined
export function installNetworkPolicy(policy: NetworkPolicy): void { defaultPolicy = policy }
export function networkContext(platform?: PlatformKind | null): NetworkContext { return defaultPolicy?.context(platform) ?? directNetwork }
export function cleanProxyEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(name)))
}
