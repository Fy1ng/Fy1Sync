/** Official Yuba protocol, main process only. No upstream text or cookies escape. */
import { hostAllowed } from '../config'
import { validDouyuRoom } from '../platforms/douyuRoom'
import { safeFetch } from '../safeFetch'
import type { DouyuActionDependencies } from './actions'
import { abortable, cancelBody, cancelled, MAX_TIMEOUT_MS, readPayload, record } from './actionHttp'
import type { DouyuTaskDefinition, DouyuTaskOutcome } from './types'

const MAIN_HOST = 'www.douyu.com'
const YUBA_HOST = 'yuba.douyu.com'
const YUBA_ORIGIN = `https://${YUBA_HOST}`
const SIGN_URL = `${YUBA_ORIGIN}/ybapi/topic/sign`
const bindingUrl = (room: string) => `https://${MAIN_HOST}/wgapi/yubanc/api/group/getBindGroup?room_id=${room}`
const headUrl = (groupId: string) => `${YUBA_ORIGIN}/wbapi/web/group/head?group_id=${groupId}`
const groupPage = (groupId: string) => `${YUBA_ORIGIN}/discussion/${groupId}/posts`

const waiting = (message: string): DouyuTaskOutcome => ({ status: 'waiting-user', message })
const failed = (message: string): DouyuTaskOutcome => ({ status: 'failed', message })
const succeeded = (message: string): DouyuTaskOutcome => ({ status: 'succeeded', message })
const loginRequired = () => waiting('请登录鱼吧后再运行签到任务.')
const unknownResult = () => waiting('鱼吧签到结果尚无法确认. 请在官方鱼吧核对后再决定是否重试.')
const unknownPreflight = () => waiting('无法确认该鱼吧的账号状态, 未发送签到请求. 请在官方鱼吧核对.')
const unavailableGroup = () => waiting('该房间的鱼吧未开放或已关闭. 请在官方房间确认, 本次未发送签到请求.')

type Target = Pick<DouyuTaskDefinition, 'accountId' | 'room'>
type HttpResult = { status: number; payload: unknown } | { outcome: DouyuTaskOutcome }
type HeadState = { signed: number; experience: number; following: number | null }

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d{0,15})$/.test(value))) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function groupId(value: unknown): string | null {
  const number = nonnegativeInteger(value)
  return number !== null && number > 0 ? String(number) : null
}

function validCookieHeader(header: unknown): header is string {
  return typeof header === 'string' && header.length <= 32_768 && /^[\x20-\x7e]*$/.test(header)
}

/** Match the official acf_yb_t cookie; never invent a CSRF token or pick a duplicate. */
function csrfToken(header: string): string | null {
  let token: string | null = null
  for (const cookie of header.split(';')) {
    const separator = cookie.indexOf('=')
    if (separator < 0 && cookie.trim() === 'acf_yb_t') return null
    if (separator < 0 || cookie.slice(0, separator).trim() !== 'acf_yb_t') continue
    if (token !== null) return null
    try { token = decodeURIComponent(cookie.slice(separator + 1).trim()) } catch { return null }
    if (!/^[A-Za-z0-9._~+/-]{1,2048}={0,2}$/.test(token) || /^(null|undefined)$/i.test(token)) return null
  }
  return token
}

function hasNoConflictingError(payload: Record<string, unknown>): boolean {
  return !Object.hasOwn(payload, 'error') || nonnegativeInteger(payload.error) === 0
}

/** Classification can only request human action, never infer a successful write. */
function attention(status: number, value: unknown, dispatched: boolean): DouyuTaskOutcome | null {
  if (status === 401) return loginRequired()
  if (status === 429) return waiting('鱼吧限制了请求频率. 请稍后在官方鱼吧核对签到状态.')
  const payload = record(value)
  const error = nonnegativeInteger(payload?.error)
  const code = nonnegativeInteger(payload?.status_code)
  if (code === 4250 || code === 4206 || error === 901 || error === 902 || error === 1022) return loginRequired()
  if (code === 3004 || error === 3004) return waiting('鱼吧要求官方验证. 请在官方鱼吧完成验证后核对签到状态.')
  if (code === 3002) return dispatched ? unknownResult() : unavailableGroup()
  const messages = [payload?.msg, payload?.message].filter((text): text is string => typeof text === 'string' && text.length <= 512).join(' ')
  if (/未登录|请.{0,8}登录|重新登录|登录.{0,8}(失效|过期)|not\s*logged|login\s*required|invalid[ _-]?token|token.{0,8}(expired|invalid)/i.test(messages)) return loginRequired()
  if (/验证码|人机验证|安全验证|滑块|geetest|captcha/i.test(messages)) return waiting('鱼吧要求官方验证. 请在官方鱼吧完成验证后核对签到状态.')
  if (/未满足|不满足|无资格|没有资格|等级不足|权限不足|无权限|not\s*eligible|permission\s*denied/i.test(messages)) return waiting('鱼吧签到资格或权限不足. 请在官方鱼吧查看要求.')
  if (status === 403) return waiting('鱼吧拒绝了请求. 请在官方鱼吧确认登录状态, 资格和验证要求.')
  if (status < 200 || status >= 300) return dispatched ? unknownResult() : unknownPreflight()
  return null
}

export class DouyuYubaActions {
  constructor(private readonly deps: DouyuActionDependencies) {}

  /** Resolves the currently bound group afresh; task fields cannot change mid-run. */
  async run(task: DouyuTaskDefinition, signal: AbortSignal): Promise<DouyuTaskOutcome> {
    if (signal.aborted) throw cancelled()
    const { accountId, room, kind } = task
    if (kind !== 'yuba-sign') return failed('该鱼吧任务类型尚未接入.')
    if (!validDouyuRoom(room)) return failed('斗鱼真实房间号无效, 请重新确认房间.')
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128 || /[\s\x00-\x1f\x7f]/.test(accountId)) return loginRequired()
    const { proxy } = this.deps
    if (!proxy.enabled || ![MAIN_HOST, YUBA_HOST].every(host => hostAllowed(host, proxy.hosts))) return failed('鱼吧请求未启用或目标域名未获允许.')
    const timeoutMs = Number.isFinite(proxy.requestTimeoutMs) ? Math.max(1, Math.min(proxy.requestTimeoutMs, MAX_TIMEOUT_MS)) : MAX_TIMEOUT_MS
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const combined = AbortSignal.any([signal, timeout.signal])
    let dispatched = false
    try {
      return await abortable(this.perform({ accountId, room }, combined, () => { dispatched = true }), combined)
    } catch {
      if (signal.aborted) throw cancelled()
      if (dispatched) return waiting(timeout.signal.aborted
        ? '鱼吧签到请求超时, 结果尚无法确认. 请在官方鱼吧核对后再决定是否重试.'
        : '鱼吧签到响应未能完整读取, 结果尚无法确认. 请在官方鱼吧核对后再决定是否重试.')
      return failed(timeout.signal.aborted ? '鱼吧请求准备超时, 未发送签到请求.' : '无法安全连接鱼吧, 未发送签到请求.')
    } finally { clearTimeout(timer) }
  }

  private async perform(target: Target, signal: AbortSignal, dispatch: () => void): Promise<DouyuTaskOutcome> {
    // Official live-next common_17eee4a, module b552a: getBindGroup accepts error=0
    // and object/JSON-string data. Only the explicit numeric group_status=0 is open.
    const binding = await this.requestJson(target.accountId, bindingUrl(target.room), signal)
    if ('outcome' in binding) return binding.outcome
    const bindingAttention = attention(binding.status, binding.payload, false)
    if (bindingAttention) return bindingAttention
    const envelope = record(binding.payload)
    if (!envelope || nonnegativeInteger(envelope.error) !== 0) return unknownPreflight()
    let value = envelope.data
    if (typeof value === 'string') {
      try { value = JSON.parse(value) as unknown } catch { return unknownPreflight() }
    }
    const bindingData = record(value)
    const boundGroup = groupId(bindingData?.group_id)
    if (!bindingData || bindingData.group_status !== 0 || !boundGroup) return unavailableGroup()

    const before = await this.readHead(target.accountId, boundGroup, signal, false)
    if ('outcome' in before) return before.outcome
    if (before.signed > 0) return succeeded('鱼吧今日已签到.')
    // Official 0xol72ne4hpw3 group store sign() sets isFollow=1 and increments
    // fansNum for a nonmember. Do not implicitly join a group through check-in.
    if (before.following !== 1) return waiting('该账号尚未确认关注此鱼吧, 签到可能同时加入. 请在官方鱼吧自行处理, 本次未发送签到请求.')

    // Official 0xol72ne4hpw3: POST /ybapi/topic/sign uses multipart FormData.
    // The separate request helper obtains X-CSRF-TOKEN from the acf_yb_t cookie.
    const form = new FormData()
    form.set('group_id', boundGroup)
    form.set('cur_exp', String(before.experience))
    const result = await this.requestJson(target.accountId, SIGN_URL, signal, { form, dispatch, referer: groupPage(boundGroup) })
    if ('outcome' in result) return result.outcome
    const signAttention = attention(result.status, result.payload, true)
    if (signAttention) return signAttention
    const receipt = record(result.payload)
    const data = record(receipt?.data)
    if (receipt?.status_code !== 200 || !hasNoConflictingError(receipt) || !data) return unknownResult()
    if (Object.hasOwn(data, 'group_id') && groupId(data.group_id) !== boundGroup) return unknownResult()
    if (['level', 'levelScore', 'exp'].some(field => Object.hasOwn(data, field) && nonnegativeInteger(data[field]) === null)) return unknownResult()

    // A success-shaped POST alone is insufficient. One read confirms the same
    // group's current account state; no failure path retries a write.
    const after = await this.readHead(target.accountId, boundGroup, signal, true)
    if ('outcome' in after) return after.outcome
    return after.signed > 0 ? succeeded('鱼吧签到已由官方状态确认.') : unknownResult()
  }

  private async readHead(accountId: string, boundGroup: string, signal: AbortSignal, dispatched: boolean): Promise<HeadState | { outcome: DouyuTaskOutcome }> {
    const result = await this.requestJson(accountId, headUrl(boundGroup), signal, { referer: groupPage(boundGroup) })
    if ('outcome' in result) return result
    const problem = attention(result.status, result.payload, dispatched)
    if (problem) return { outcome: problem }
    const payload = record(result.payload)
    const data = record(payload?.data)
    const invalid = () => ({ outcome: dispatched ? unknownResult() : unknownPreflight() })
    if (payload?.status_code !== 200 || !hasNoConflictingError(payload) || !data) return invalid()
    if (groupId(data.group_id) !== boundGroup) return { outcome: dispatched ? unknownResult() : waiting('房间与鱼吧信息不一致. 请在官方房间重新确认, 本次未发送签到请求.') }
    const signed = nonnegativeInteger(data.is_signed)
    const experience = nonnegativeInteger(data.group_exp)
    if (signed === null || experience === null) return invalid()
    return { signed, experience, following: nonnegativeInteger(data.is_follow) }
  }

  private async requestJson(accountId: string, url: string, signal: AbortSignal, options: { form?: FormData; dispatch?: () => void; referer?: string } = {}): Promise<HttpResult> {
    if (signal.aborted) throw cancelled()
    let header: string
    try { header = await this.deps.cookieHeader(accountId, url) } catch {
      if (signal.aborted) throw cancelled()
      return { outcome: loginRequired() }
    }
    if (signal.aborted) throw cancelled()
    if (!validCookieHeader(header)) return { outcome: loginRequired() }
    const host = new URL(url).hostname
    const csrf = host === YUBA_HOST ? csrfToken(header) : null
    if (host === YUBA_HOST && !csrf) return { outcome: loginRequired() }
    const headers: Record<string, string> = { Accept: 'application/json', 'Cache-Control': 'no-cache' }
    if (header) headers.Cookie = header
    if (options.referer) headers.Referer = options.referer
    if (options.form) {
      headers.Origin = YUBA_ORIGIN
      headers['X-CSRF-TOKEN'] = csrf!
    }
    const { response } = await safeFetch(url, {
      ...this.deps.proxy,
      hosts: [host], maxRedirects: 0,
      allowNonLoopbackTargets: false, allowNonStandardPorts: false,
    }, {
      method: options.form ? 'POST' : 'GET', headers, signal,
      resolve: this.deps.resolve,
      fetchImpl: async (checkedUrl, init) => {
        if (signal.aborted) throw cancelled()
        if (options.form) options.dispatch?.()
        // safeFetch's shared media interface accepts string bodies. Preserve its
        // checked URL and headers while passing native FormData to fetch here.
        const response = await (this.deps.request ?? fetch)(checkedUrl, { ...init, ...(options.form ? { body: options.form } : {}) })
        if (signal.aborted) { cancelBody(response); throw cancelled() }
        return response
      },
    })
    if (signal.aborted) { cancelBody(response); throw cancelled() }
    if (response.status === 401 || response.status === 429) {
      cancelBody(response)
      return { status: response.status, payload: null }
    }
    const payload = await readPayload(response, signal)
    if (signal.aborted) throw cancelled()
    return { status: response.status, payload }
  }
}
