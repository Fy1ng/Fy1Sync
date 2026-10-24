/** Main-process-only Douyu actions. Never return upstream payloads or credentials. */
import { hostAllowed, type ProxyConfig } from '../config'
import { validDouyuRoom } from '../platforms/douyuRoom'
import { safeFetch, type Resolver } from '../safeFetch'
import type { DouyuTaskDefinition, DouyuTaskOutcome } from './types'
import { abortable, cancelBody, cancelled, readPayload, record, MAX_TIMEOUT_MS } from './actionHttp'
import { DouyuYubaActions } from './yubaActions'
import { DouyuFishingActions } from './fishingActions'
import { DouyuRewardActions } from './rewardActions'

const COOKIE_SCOPE = 'https://www.douyu.com/'
const CHECK_IN_URL = 'https://apiv2.douyucdn.cn/japi/roomuserlevel/apinc/checkIn?client_sys=android'
const CHECK_IN_HOST = 'apiv2.douyucdn.cn'
const TOKEN_FIELDS = ['acf_uid', 'acf_biz', 'acf_stk', 'acf_ct', 'acf_ltkid'] as const

export interface DouyuActionDependencies {
  /** Returns cookies matching this exact URL from the selected account only. */
  cookieHeader: (accountId: string, url: string) => Promise<string>
  proxy: ProxyConfig
  /** Test seams. Production uses fetch and the existing guarded DNS resolver. */
  request?: typeof fetch
  resolve?: Resolver
}

const waiting = (message: string): DouyuTaskOutcome => ({ status: 'waiting-user', message })
const failed = (message: string): DouyuTaskOutcome => ({ status: 'failed', message })
const unknownResult = () => waiting('斗鱼签到结果尚无法确认. 请在官方房间核对后再决定是否重试.')
const loginRequired = () => waiting('斗鱼登录信息缺失或失效, 请重新登录该账号.')

/** Reject ambiguity and invalid header bytes instead of inventing token components. */
function loginToken(header: string): string | null {
  if (typeof header !== 'string' || header.length > 32_768 || /[\x00-\x1f\x7f]/.test(header)) return null
  const parts = new Map<string, string>()
  for (const cookie of header.split(';')) {
    const separator = cookie.indexOf('=')
    if (separator < 0) continue
    const name = cookie.slice(0, separator).trim()
    if (!(TOKEN_FIELDS as readonly string[]).includes(name)) continue
    if (parts.has(name)) return null
    let value: string
    try { value = decodeURIComponent(cookie.slice(separator + 1).trim()) } catch { return null }
    if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(value) || /^(null|undefined)$/i.test(value)) return null
    parts.set(name, value)
  }
  if (TOKEN_FIELDS.some(name => !parts.has(name)) || !/^[1-9][0-9]{0,19}$/.test(parts.get('acf_uid')!)) return null
  // Verified at qianjiachun/douyuEx f4b0228, src/common.js:115-119.
  return TOKEN_FIELDS.map(name => parts.get(name)!).join('_')
}

/**
 * f4b0228 Sign_Room.js:57-69 specifies the request but has an empty onload.
 * No current success schema has been verified. In particular HTTP 200, error=0,
 * data=true and generic "success" must not mark a real check-in as succeeded.
 * Messages below classify only a need for human action; upstream text is never shown.
 */
function classifyResponse(status: number, payload: unknown): DouyuTaskOutcome {
  if (status === 401) return loginRequired()
  if (status === 429) return waiting('斗鱼限制了请求频率. 请稍后在官方房间核对签到状态.')
  const data = record(payload)
  const messages = [data?.msg, data?.message].filter((value): value is string => typeof value === 'string' && value.length <= 512)
  const message = messages.join(' ')
  if (/未登录|请.{0,8}登录|重新登录|登录.{0,8}(失效|过期)|not\s*logged|login\s*required|invalid[ _-]?token|token.{0,8}(expired|invalid)/i.test(message)) return loginRequired()
  if (/验证码|人机验证|安全验证|滑块|geetest|captcha/i.test(message)) return waiting('斗鱼要求官方验证. 请在该账号的官方房间完成验证后核对签到状态.')
  if (/未满足|不满足|无资格|没有资格|等级不足|粉丝等级|权限不足|无权限|not\s*eligible|permission\s*denied/i.test(message)) return waiting('斗鱼提示签到资格或权限不足. 请在官方房间查看要求.')
  if (/已签到|已经签到|重复签到|already.{0,12}(check.?in|signed)/i.test(message)) return waiting('斗鱼提示今日已签到. 请在官方房间核对, 本次不会重复请求.')
  if (status === 403) return waiting('斗鱼拒绝了签到请求. 请在官方房间确认登录状态, 资格和验证要求.')
  if (status >= 400 && status < 500) return failed('斗鱼拒绝了本次签到请求. 请在官方房间查看状态.')
  return unknownResult()
}

export class DouyuActions {
  private readonly fishing: DouyuFishingActions
  private readonly rewards: DouyuRewardActions

  constructor(private readonly deps: DouyuActionDependencies) {
    this.fishing = new DouyuFishingActions(deps)
    this.rewards = new DouyuRewardActions(deps)
  }

  /** task.room must already be the canonical room resolved by the main process. */
  async run(task: DouyuTaskDefinition, signal: AbortSignal): Promise<DouyuTaskOutcome> {
    if (signal.aborted) throw cancelled()
    if (task.kind === 'auto-fish') return this.fishing.run(task, signal)
    if (task.kind === 'gift-packet' || task.kind === 'treasure-box') return this.rewards.run(task, signal)
    if (task.kind === 'yuba-sign') return new DouyuYubaActions(this.deps).run(task, signal)
    if (task.kind !== 'room-sign') return failed('该斗鱼任务类型尚未接入.')
    if (!validDouyuRoom(task.room)) return failed('斗鱼真实房间号无效, 请重新确认房间.')
    if (typeof task.accountId !== 'string' || !task.accountId || task.accountId.length > 128 || /[\s\x00-\x1f\x7f]/.test(task.accountId)) return loginRequired()
    const { proxy } = this.deps
    if (!proxy.enabled || !hostAllowed(CHECK_IN_HOST, proxy.hosts)) return failed('斗鱼请求未启用或目标域名未获允许.')
    const timeoutMs = Number.isFinite(proxy.requestTimeoutMs) ? Math.max(1, Math.min(proxy.requestTimeoutMs, MAX_TIMEOUT_MS)) : MAX_TIMEOUT_MS
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const combined = AbortSignal.any([signal, timeout.signal])
    let dispatched = false
    const target = { accountId: task.accountId, room: task.room }
    try {
      return await abortable(this.perform(target, combined, () => { dispatched = true }), combined)
    } catch {
      if (signal.aborted) throw cancelled()
      if (dispatched) return waiting(timeout.signal.aborted
        ? '斗鱼签到请求超时, 结果尚无法确认. 请在官方房间核对后再决定是否重试.'
        : '斗鱼签到响应未能完整读取, 结果尚无法确认. 请在官方房间核对后再决定是否重试.')
      return failed(timeout.signal.aborted ? '斗鱼请求准备超时, 未发送签到请求.' : '无法安全连接斗鱼, 未发送签到请求.')
    } finally { clearTimeout(timer) }
  }

  private async perform(task: Pick<DouyuTaskDefinition, 'accountId' | 'room'>, signal: AbortSignal, dispatch: () => void): Promise<DouyuTaskOutcome> {
    let header: string
    try { header = await this.deps.cookieHeader(task.accountId, COOKIE_SCOPE) } catch {
      if (signal.aborted) throw cancelled()
      return loginRequired()
    }
    if (signal.aborted) throw cancelled()
    const token = loginToken(header)
    if (!token) return loginRequired()
    const { response } = await safeFetch(CHECK_IN_URL, {
      ...this.deps.proxy,
      hosts: [CHECK_IN_HOST], maxRedirects: 0,
      allowNonLoopbackTargets: false, allowNonStandardPorts: false,
    }, {
      method: 'POST', body: new URLSearchParams({ rid: task.room }).toString(), signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', token, aid: 'android1' },
      resolve: this.deps.resolve,
      fetchImpl: async (url, init) => {
        if (signal.aborted) throw cancelled()
        dispatch()
        const result = await (this.deps.request ?? fetch)(url, init)
        if (signal.aborted) { cancelBody(result); throw cancelled() }
        return result
      },
    })
    if (signal.aborted) { cancelBody(response); throw cancelled() }
    if (response.status === 401 || response.status === 429) {
      cancelBody(response)
      return classifyResponse(response.status, null)
    }
    const payload = await readPayload(response, signal)
    if (signal.aborted) throw cancelled()
    return classifyResponse(response.status, payload)
  }
}
