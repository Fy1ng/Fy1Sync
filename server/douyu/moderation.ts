import { hostAllowed } from '../config'
import { dnsResolver, safeFetch } from '../safeFetch'
import { validDouyuRoom } from '../platforms/douyuRoom'
import type { DouyuActionDependencies } from './actions'
import type { DouyuAccountOperationContext, DouyuAccountOperationOutcome } from './types'
import { abortable, cancelBody, cancelled, MAX_TIMEOUT_MS, readPayload, record } from './actionHttp'

const HOST = 'www.douyu.com'
const ORIGIN = 'https://www.douyu.com'
const PERMISSION_PATH = '/japi/firepower/apinc/roomAdmin/getStatus'
const MUTE_PATH = '/room/roomSetting/addMuteUser'
const AUTH_FIELDS = ['acf_auth', 'acf_auth_wl', 'acf_dmjwt_token', 'acf_stk', 'acf_ltkid', 'acf_biz'] as const
export const DOUYU_MUTE_MINUTES = [1, 10, 30, 60, 480, 1440, 4320, 10080, 43200, 259200, 518400] as const

export interface DouyuModerationTarget { accountId: string; room: string }
export interface DouyuMuteInput extends DouyuModerationTarget { username: string; minutes: number }
export type DouyuModerationCode = 'allowed' | 'receipt-confirmed' | 'permission-required' | 'login-required'
  | 'verification-required' | 'rate-limited' | 'invalid-arguments' | 'cancelled' | 'busy' | 'unavailable' | 'unconfirmed' | 'request-failed'
export interface DouyuModerationOutcome {
  status: 'succeeded' | 'waiting-user' | 'failed'
  code: DouyuModerationCode
  message: string
  submitted: boolean
}
export interface DouyuModerationPermission {
  allowed: boolean
  code: DouyuModerationCode
  message: string
}
export type DouyuModerationExecutor = (context: DouyuAccountOperationContext,
  run: (signal: AbortSignal) => Promise<DouyuModerationOutcome>, signal: AbortSignal) => Promise<DouyuAccountOperationOutcome<DouyuModerationOutcome>>
export interface DouyuModerationDependencies extends DouyuActionDependencies { runExclusive: DouyuModerationExecutor }

const messages: Record<DouyuModerationCode, string> = {
  allowed: '斗鱼已确认当前账号具有该房间的管理资格.',
  'receipt-confirmed': '斗鱼已返回禁言成功回执.',
  'permission-required': '斗鱼未授予当前账号在该房间禁言的权限.',
  'login-required': '斗鱼登录信息缺失, 已变化或失效, 请重新登录该账号.',
  'verification-required': '斗鱼要求人工验证, 请在当前账号的官方房间完成验证后核对操作结果.',
  'rate-limited': '斗鱼限制了请求频率, 本次不会自动重试.',
  'invalid-arguments': '房间, 账号, 昵称或禁言时长无效.',
  cancelled: '禁言操作已取消, 已提交的请求请在官方房间核对, 本次不会自动重试.',
  busy: '已有账号操作正在执行, 请等待结束后重试.',
  unavailable: '当前账号或房间不满足执行条件, 未提交禁言请求.',
  unconfirmed: '本次禁言结果尚无法确认, 请在官方房间核对, 本次不会自动重试.',
  'request-failed': '无法完成斗鱼禁言请求, 请检查网络和官方房间状态.',
}
const outcome = (code: DouyuModerationCode, submitted = false): DouyuModerationOutcome => ({
  status: code === 'receipt-confirmed' ? 'succeeded'
    : ['invalid-arguments', 'request-failed', 'unavailable'].includes(code) ? 'failed' : 'waiting-user',
  code, message: messages[code], submitted,
})
const zero = (value: unknown) => value === 0 || value === '0'
const validAccount = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(value)

function readInput(raw: unknown, mute: boolean): DouyuMuteInput | DouyuModerationTarget | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null)) return null
    const keys = mute ? ['accountId', 'room', 'username', 'minutes'] : ['accountId', 'room']
    if (Reflect.ownKeys(raw).length !== keys.length) return null
    const fields: Record<string, unknown> = {}
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(raw, key)
      if (!field || !('value' in field)) return null
      fields[key] = field.value
    }
    if (!validAccount(fields.accountId) || typeof fields.room !== 'string' || !validDouyuRoom(fields.room)) return null
    const target = { accountId: fields.accountId, room: fields.room }
    if (!mute) return target
    if (typeof fields.username !== 'string' || !fields.username.trim() || fields.username.length > 64
      || /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(fields.username)
      || typeof fields.minutes !== 'number' || !(DOUYU_MUTE_MINUTES as readonly number[]).includes(fields.minutes)) return null
    return { ...target, username: fields.username, minutes: fields.minutes }
  } catch { return null }
}

type Credentials = { header: string; uid: string; fingerprint: string }
function credentials(header: unknown): Credentials | null {
  if (typeof header !== 'string' || !header || header.length > 32_768 || !/^[\x20-\x7e]+$/.test(header)) return null
  const values = new Map<string, string>()
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=')
    if (separator < 1) continue
    const name = entry.slice(0, separator).trim()
    if (name !== 'acf_uid' && !(AUTH_FIELDS as readonly string[]).includes(name)) continue
    if (values.has(name)) return null
    const value = entry.slice(separator + 1).trim()
    if (!value || value.length > 8_192 || /[\s\x00-\x1f\x7f]/.test(value) || /^(null|undefined)$/i.test(value)) return null
    values.set(name, value)
  }
  const uid = values.get('acf_uid')
  if (!uid || !/^[1-9][0-9]{0,19}$/.test(uid) || !(values.get('acf_auth') || values.get('acf_auth_wl')
    || values.get('acf_dmjwt_token') || (values.get('acf_stk') && values.get('acf_ltkid') && values.get('acf_biz')))) return null
  return { header, uid, fingerprint: JSON.stringify([uid, ...AUTH_FIELDS.map(key => values.get(key) ?? '')]) }
}

function responseProblem(status: number, body: Record<string, unknown> | null): DouyuModerationCode | null {
  const error = body?.error ?? body?.code
  if (status === 401 || error === 202 || error === '202') return 'login-required'
  if (status === 429) return 'rate-limited'
  const message = typeof body?.msg === 'string' && body.msg.length <= 512 ? body.msg : ''
  if (/验证码|人机验证|安全验证|captcha|geetest/i.test(message)) return 'verification-required'
  if (/未登录|请.{0,8}登录|登录.{0,8}(失效|过期)/.test(message)) return 'login-required'
  if (status === 403 || /权限不足|无权限|不是房管|非房管|权限不够/.test(message)) return 'permission-required'
  return null
}

/**
 * Request contract: DouyuEx f4b0228, LiveTool/Mute/Mute.js, addMuteUser.
 * Public official permission GET rechecked on 2026-10-25: anonymous error=202.
 * Successful POST receipts remain subject to real-account acceptance testing.
 * No caller can bypass the injected main-process account write lane.
 */
export class DouyuModeration {
  constructor(private readonly deps: DouyuModerationDependencies) {}

  async preflight(raw: DouyuModerationTarget, signal: AbortSignal): Promise<DouyuModerationPermission> {
    const target = readInput(raw, false)
    if (!target) return { allowed: false, code: 'invalid-arguments', message: messages['invalid-arguments'] }
    return this.withTimeout(signal, async combined => {
      try {
        const result = await this.permission(target, combined)
        return { allowed: result.code === 'allowed', code: result.code, message: messages[result.code] }
      } catch { return { allowed: false, code: signal.aborted ? 'cancelled' : 'request-failed', message: messages[signal.aborted ? 'cancelled' : 'request-failed'] } }
    })
  }

  async mute(raw: DouyuMuteInput, signal: AbortSignal): Promise<DouyuModerationOutcome> {
    const target = readInput(raw, true) as DouyuMuteInput | null
    if (!target) return outcome('invalid-arguments')
    if (signal.aborted) return outcome('cancelled')
    // Fix the target before entering the queue; later edits to a renderer draft have no effect.
    const result = await this.deps.runExclusive({ accountId: target.accountId, originRoom: target.room, rooms: [target.room] },
      combined => this.execute(target, combined), signal)
    if (result.status === 'completed') return result.value
    if (result.status === 'cancelled') return outcome('cancelled', result.started)
    return outcome(result.status === 'busy' ? 'busy' : result.status === 'unavailable' ? 'unavailable' : 'request-failed')
  }

  private async execute(target: DouyuMuteInput, signal: AbortSignal): Promise<DouyuModerationOutcome> {
    return this.withTimeout(signal, async combined => {
      let submitted = false
      try {
        const permission = await this.permission(target, combined)
        if (permission.code !== 'allowed' || !permission.credentials) return outcome(permission.code)
        const url = ORIGIN + MUTE_PATH
        const current = credentials(await abortable(this.deps.cookieHeader(target.accountId, url), combined))
        if (!current || current.fingerprint !== permission.credentials.fingerprint) return outcome('login-required')
        const body = new URLSearchParams({ ban_nickname: target.username, room_id: target.room, ban_time: String(target.minutes), reason: '7' }).toString()
        const response = await this.request(url, { method: 'POST', body, headers: { Cookie: current.header, Origin: ORIGIN,
          Referer: ORIGIN + '/' + target.room, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }, combined,
        () => { submitted = true })
        const payload = record(await readPayload(response, combined))
        if (combined.aborted) throw cancelled()
        const problem = responseProblem(response.status, payload)
        if (problem) return outcome(problem, submitted)
        // A concrete success message is required. HTTP 200 or error=0 alone is insufficient.
        const consistentStatus = (payload?.error === undefined || zero(payload.error)) && (payload?.code === undefined || zero(payload.code))
        if (response.ok && payload?.msg === '添加成功' && consistentStatus) return outcome('receipt-confirmed', true)
        return outcome('unconfirmed', submitted)
      } catch {
        return outcome(signal.aborted ? 'cancelled' : submitted ? 'unconfirmed' : 'request-failed', submitted)
      }
    })
  }

  private async permission(target: DouyuModerationTarget, signal: AbortSignal): Promise<{ code: DouyuModerationCode; credentials?: Credentials }> {
    const url = ORIGIN + PERMISSION_PATH + '?rid=' + target.room
    const current = credentials(await abortable(this.deps.cookieHeader(target.accountId, url), signal))
    if (!current) return { code: 'login-required' }
    const response = await this.request(url, { method: 'GET', headers: { Cookie: current.header, Accept: 'application/json', 'Cache-Control': 'no-cache' } }, signal)
    const payload = record(await readPayload(response, signal))
    if (signal.aborted) throw cancelled()
    const problem = responseProblem(response.status, payload)
    if (problem) return { code: problem }
    const data = record(payload?.data)
    if (!response.ok || !zero(payload?.error) || !data || (data.has !== 0 && data.has !== 1 && data.has !== '0' && data.has !== '1')) return { code: 'unconfirmed' }
    return data.has === 1 || data.has === '1' ? { code: 'allowed', credentials: current } : { code: 'permission-required' }
  }

  private async request(url: string, init: { method: 'GET' | 'POST'; body?: string; headers: Record<string, string> },
    signal: AbortSignal, dispatch?: () => void): Promise<Response> {
    if (!this.deps.proxy.enabled || !hostAllowed(HOST, this.deps.proxy.hosts)) throw new Error('Disabled policy')
    const response = await safeFetch(url, { ...this.deps.proxy, hosts: [HOST], maxRedirects: 0,
      allowNonLoopbackTargets: false, allowNonStandardPorts: false }, {
      ...init, signal,
      resolve: host => abortable((this.deps.resolve ?? dnsResolver)(host), signal),
      fetchImpl: async (input, requestInit) => {
        if (signal.aborted) throw cancelled()
        dispatch?.()
        // Do not release the account lane while an already-dispatched transport is unsettled.
        const result = await (this.deps.request ?? fetch)(input, requestInit)
        if (signal.aborted) { cancelBody(result); throw cancelled() }
        return result
      },
    })
    return response.response
  }

  private async withTimeout<T>(signal: AbortSignal, operation: (combined: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = new AbortController()
    const milliseconds = Number.isFinite(this.deps.proxy.requestTimeoutMs) ? Math.max(1, Math.min(MAX_TIMEOUT_MS, this.deps.proxy.requestTimeoutMs)) : MAX_TIMEOUT_MS
    const timer = setTimeout(() => timeout.abort(), milliseconds)
    try { return await operation(AbortSignal.any([signal, timeout.signal])) }
    finally { clearTimeout(timer) }
  }
}
