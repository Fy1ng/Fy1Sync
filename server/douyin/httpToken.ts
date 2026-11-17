/** Anonymous SDK token bootstrap, using F2's pinned public protocol payload.
 * No login cookie, account identity or chat text is sent to this service.
 * Source and license: fixtures/f2-NOTICE.txt.
 */
import bootstrap from './tokenBootstrap.json'
import type { ProxyConfig } from '../config'
import { safeFetch, type Resolver } from '../safeFetch'
import { networkContext, routeCandidates, type NetworkContext } from '../networkPolicy'
import { DOUYIN_USER_AGENT } from '../platforms/douyinDanmaku'
import { abortable, cancelBody } from '../douyu/actionHttp'
import { douyinBrowserUserAgent } from './httpContext'

export const DOUYIN_HTTP_TOKEN_URL = 'https://mssdk.bytedance.com/web/r/token?ms_appid=6383'
export interface DouyinHttpTokenDependencies {
  proxy: ProxyConfig
  network?: () => NetworkContext
  fetchImpl?: typeof fetch
  resolve?: Resolver
  now?: () => number
  userAgent?: string
}

export async function acquireDouyinHttpToken(deps: DouyinHttpTokenDependencies, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const context = deps.network?.() ?? networkContext()
  const network: NetworkContext = { route: async raw => routeCandidates(await context.route(raw)).find(route => route.kind !== 'unsupported') ?? { kind:'unsupported' } }
  const work = safeFetch(DOUYIN_HTTP_TOKEN_URL, { ...deps.proxy, maxRedirects:0 }, {
    method:'POST', body:JSON.stringify({ ...bootstrap, tspFromClient:(deps.now ?? Date.now)() }), signal,
    headers:{ 'User-Agent':douyinBrowserUserAgent(deps.userAgent ?? DOUYIN_USER_AGENT), 'Content-Type':'application/json; charset=utf-8', Origin:'https://live.douyin.com', Referer:'https://live.douyin.com/' },
    network, fetchImpl:deps.fetchImpl, resolve:deps.resolve,
  })
  void work.then(result => { if (signal.aborted) cancelBody(result.response) }, () => {})
  const { response, finalUrl } = await abortable(work, signal)
  try {
    if (!response.ok || finalUrl.href !== DOUYIN_HTTP_TOKEN_URL) throw new Error('Token bootstrap unavailable')
    const fromHeader = response.headers.get('x-ms-token')
    const cookieTokens = response.headers.getSetCookie().flatMap(cookie => /^msToken=([^;]+)(?:;|$)/.exec(cookie)?.[1] ?? [])
    const candidates = [...new Set([fromHeader, ...cookieTokens].filter((value): value is string => value !== null))]
    if (candidates.length !== 1 || !/^[A-Za-z0-9_+/=-]+$/.test(candidates[0]!) || ![164,184].includes(candidates[0]!.length)) throw new Error('Invalid token bootstrap response')
    signal.throwIfAborted()
    return candidates[0]!
  } finally { cancelBody(response) }
}
