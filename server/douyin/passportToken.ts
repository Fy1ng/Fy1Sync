/** Main-owned anonymous passport token preparation, with no account cookies or inputs. */
import { safeFetch } from '../safeFetch'
import { abortable, cancelBody } from '../douyu/actionHttp'
import type { DouyinHttpTokenDependencies } from './httpToken'
import { createDouyinPassportReport } from './passportReport'
import { douyinBrowserUserAgent } from './httpContext'

export async function acquireDouyinPassportToken(deps: DouyinHttpTokenDependencies, signal: AbortSignal, current?: string): Promise<string> {
  signal.throwIfAborted()
  if (current !== undefined && (!/^[A-Za-z0-9_+/=-]+$/.test(current) || ![164,172,184].includes(current.length))) throw new TypeError('Invalid anonymous token context')
  const userAgent = douyinBrowserUserAgent(deps.userAgent)
  const url = 'https://mssdk.bytedance.com/web/' + (current ? 'common' : 'r/token') + '?ms_appid=6383' + (current ? '&msToken=' + encodeURIComponent(current) : '')
  const body = createDouyinPassportReport(current ? 'sms' : 'initial', { userAgent, now: (deps.now ?? Date.now)() })
  const work = safeFetch(url, { ...deps.proxy, maxRedirects: 0 }, { method: 'POST', body, signal, manualRedirect: true,
    headers: { 'User-Agent': userAgent, Origin: 'https://www.douyin.com', Referer: 'https://www.douyin.com/',
      'Content-Type': 'text/plain;charset=UTF-8', Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(current ? { 'sec-fetch-storage-access': 'active' } : {}) },
    network: deps.network?.(), fetchImpl: deps.fetchImpl, resolve: deps.resolve })
  void work.then(result => { if (signal.aborted) cancelBody(result.response) }, () => {})
  const { response, finalUrl } = await abortable(work, signal)
  try {
    if (!response.ok || finalUrl.href !== url) throw new Error('Anonymous passport token unavailable')
    const cookieTokens = response.headers.getSetCookie().flatMap(cookie => /^msToken=([^;]+)(?:;|$)/.exec(cookie)?.[1] ?? [])
    const candidates = [...new Set([response.headers.get('x-ms-token'), ...cookieTokens].filter((value): value is string => value !== null))]
    const lengths = current ? [172,184] : [164,172,184]
    if (candidates.length !== 1 || !/^[A-Za-z0-9_+/=-]+$/.test(candidates[0]!) || !lengths.includes(candidates[0]!.length)) throw new Error('Anonymous passport token receipt invalid')
    signal.throwIfAborted()
    return candidates[0]!
  } finally { cancelBody(response) }
}
