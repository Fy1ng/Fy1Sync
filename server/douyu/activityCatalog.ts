/** Fixed official destinations and bounded requests shared by automation adapters. */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { hostAllowed } from '../config'
import { dnsResolver, isPrivateAddress, safeFetch } from '../safeFetch'
import { abortable, cancelled, MAX_TIMEOUT_MS, record } from './actionHttp'
import { parseRewardJson, rewardCredentials, rewardInteger } from './rewardProtocol'
import type { DouyuAutomationDependencies, DouyuAutomationOutcome, DouyuAutomationRequest } from './automationTypes'

export const DOUYU_AUTOMATION_ORIGIN = 'https://www.douyu.com'
export type AutomationFaultCode = 'login' | 'verification' | 'rate-limit' | 'eligibility' | 'unavailable' | 'invalid-response' | 'already-signed' | 'unknown-result' | 'capacity'
export class AutomationFault extends Error {
  constructor(readonly code: AutomationFaultCode, readonly definiteRefusal = false) { super('Douyu automation unavailable.'); this.name = 'AutomationFault' }
}
export const automationActive = (signal: AbortSignal): void => { if (signal.aborted) throw cancelled() }
export const automationNumber = rewardInteger
export const automationId = (value: unknown): string | null => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
  ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null
export const automationData = (raw: unknown): Record<string, unknown> => {
  const value = typeof raw === 'string' ? parseRewardJson(raw) : raw
  const data = record(value)
  if (!data) throw new AutomationFault('invalid-response')
  return data
}
export const automationArray = (raw: unknown, maximum = 2_000): unknown[] => {
  if (!Array.isArray(raw) || raw.length > maximum) throw new AutomationFault('invalid-response')
  return raw
}

export function automationEnvelope(raw: unknown, yuba = false): Record<string, unknown> {
  const envelope = automationData(raw)
  attention(200, envelope)
  const accepted = yuba ? automationNumber(envelope.status_code) === 200 || automationNumber(envelope.error) === 0
    : automationNumber(envelope.error) === 0
  if (!accepted || ['error', 'code', 'result'].some(key => Object.hasOwn(envelope, key) && automationNumber(envelope[key]) !== 0)
    || Object.hasOwn(envelope, 'status_code') && automationNumber(envelope.status_code) !== 200) throw new AutomationFault('invalid-response')
  return automationData(envelope.data)
}

const MESSAGES: Record<AutomationFaultCode, string> = {
  login: '账号登录已失效或发生变化, 请在该账号的官方页面重新登录.',
  verification: '官方要求人工验证, 请打开该账号的官方页面处理后手动恢复.',
  'rate-limit': '官方限制了请求频率, 任务已暂停, 请稍后核对状态.',
  eligibility: '官方参与条件未满足或当前活动未开放, 本次已停止.',
  unavailable: '无法安全读取官方任务信息, 本次已停止.',
  'invalid-response': '官方任务字段或返回结果无法确认, 本次已停止.',
  'already-signed': '官方提示已经签到, 请核对状态后再继续.',
  'unknown-result': '操作已可能提交, 结果尚无法确认. 本次不会自动重发, 请在官方页面核对.',
  capacity: '任务数量或防重复记录已达到安全上限, 请结束当前批次后重新安排.',
}

export function automationFailure(error: unknown, submitted: boolean): DouyuAutomationOutcome {
  const fault = error instanceof AutomationFault ? error : new AutomationFault('unavailable')
  const code = submitted ? 'unknown-result' : fault.code
  return { status: code === 'unavailable' && !submitted ? 'failed' : 'waiting-user', message: MESSAGES[code] }
}

function attention(status: number, raw: unknown): void {
  if (status === 401) throw new AutomationFault('login', true)
  if (status === 429) throw new AutomationFault('rate-limit', true)
  if (status < 200 || status >= 300) throw new AutomationFault('unavailable')
  const result = record(raw)
  if (!result) return
  const error = automationNumber(result.error)
  const code = automationNumber(result.status_code)
  if ([901, 902, 1002, 1022].includes(error ?? -1) || [4250, 4206].includes(code ?? -1)) throw new AutomationFault('login', true)
  if ([3004, 1020440010, 1020440030].includes(error ?? -1) || code === 3004 || result.result === 170001) throw new AutomationFault('verification', true)
  const text = [result.msg, result.message].filter((value): value is string => typeof value === 'string' && value.length < 512).join(' ')
  if (/验证码|人机验证|安全验证|滑块|captcha|geetest|绑定手机/i.test(text)) throw new AutomationFault('verification', true)
  if (/未登[录陆]|请.{0,8}登[录陆]|登[录陆].{0,8}(过期|失效)|token.{0,12}(expired|invalid)|login\s*required/i.test(text)) throw new AutomationFault('login', true)
  if (/太频繁|频率|过于频繁|too.many|rate.limit/i.test(text)) throw new AutomationFault('rate-limit', true)
  if (/不满足|未满足|无资格|没有资格|权限不足|活动.{0,6}(结束|关闭)|not.eligible/i.test(text)) throw new AutomationFault('eligibility', true)
  // A message classifies a refusal, never proves a successful write.
  if (/已签到|已经签到|重复签到|already.{0,12}(check.?in|signed)/i.test(text) && error !== 0) throw new AutomationFault('already-signed', true)
}

interface Auth {
  uid: string
  fingerprint: string
  cookie: string
  csrf: string | null
  yubaCsrf: string | null
  token: string | null
}
export interface AutomationContext {
  task: DouyuAutomationRequest
  signal: AbortSignal
  submitted: boolean
  writeRefused?: boolean
  identity?: { uid: string; fingerprint: string }
  onWrite?: () => void
  onDefiniteRefusal?: () => void
}
export interface AutomationHttpOptions {
  method?: 'GET' | 'POST'
  auth?: 'main' | 'yuba' | 'token-header' | 'token-form' | 'dy-token' | 'public'
  /** Fields are constructed by an adapter from validated IDs, never passed through IPC. */
  fields?: Record<string, string>
  encoding?: 'form' | 'multipart'
  referer?: string
  limit?: number
  text?: boolean
  /** Some official read-only methods use POST. They do not consume a write slot attempt. */
  readOnlyPost?: boolean
  /** Carnival uses its own existing official CSRF cookie instead of ctn. */
  carnivalCsrf?: boolean
}

export function automationRecipient(context: AutomationContext, receipt: Record<string, unknown>): void {
  if (['uid', 'userId', 'user_id', 'receiverUid', 'receiver_uid', 'claimUid', 'claim_uid']
    .some(name => Object.hasOwn(receipt, name) && automationId(receipt[name]) !== context.identity?.uid)) throw new AutomationFault('invalid-response')
  if (['error', 'code', 'result'].some(name => Object.hasOwn(receipt, name) && automationNumber(receipt[name]) !== 0)) throw new AutomationFault('invalid-response')
}

function cookieFields(header: string): Map<string, string> {
  if (!header || header.length > 32_768 || !/^[\x20-\x7e]+$/.test(header)) throw new AutomationFault('login')
  const fields = new Map<string, string>()
  for (const part of header.split(';')) {
    if (!part.trim()) continue
    const separator = part.indexOf('=')
    const name = part.slice(0, separator).trim()
    const encoded = part.slice(separator + 1).trim()
    if (separator < 1 || !/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name) || /[\s\x00-\x1f\x7f"\\,;]/.test(encoded) || fields.has(name)) throw new AutomationFault('login')
    let value: string
    try { value = decodeURIComponent(encoded) } catch { throw new AutomationFault('login') }
    if (value.length > 8_192 || /[\x00-\x1f\x7f]/.test(value)) throw new AutomationFault('login')
    fields.set(name, value)
  }
  return fields
}

/** No caller-configured destination is accepted; this is an internal, fixed-host transport. */
export class DouyuAutomationHttp {
  constructor(readonly deps: DouyuAutomationDependencies) {}
  now(): number {
    const now = (this.deps.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 1_577_836_800_000 || now > 4_102_444_800_000) throw new AutomationFault('unavailable')
    return now
  }

  async identity(context: AutomationContext): Promise<Auth> {
    automationActive(context.signal)
    const header = await abortable(this.deps.cookieHeader(context.task.accountId, `${DOUYU_AUTOMATION_ORIGIN}/`), context.signal)
    automationActive(context.signal)
    let credentials: ReturnType<typeof rewardCredentials>
    try { credentials = rewardCredentials(header) } catch { throw new AutomationFault('login') }
    const fields = cookieFields(header)
    const fingerprint = createHash('sha256').update(credentials.fingerprint).digest('hex')
    if (context.identity && (context.identity.uid !== credentials.uid || context.identity.fingerprint !== fingerprint)) throw new AutomationFault('login')
    context.identity ??= { uid: credentials.uid, fingerprint }
    const tokenFields = ['acf_uid', 'acf_biz', 'acf_stk', 'acf_ct', 'acf_ltkid'].map(key => fields.get(key))
    const token = tokenFields.every(value => value && /^[A-Za-z0-9._~-]{1,2048}$/.test(value) && !/^(null|undefined)$/i.test(value)) ? tokenFields.join('_') : null
    return { uid: credentials.uid, fingerprint, cookie: header, csrf: credentials.csrf, yubaCsrf: fields.get('acf_yb_t') ?? null, token }
  }

  async request(context: AutomationContext, address: string, options: AutomationHttpOptions = {}): Promise<unknown> {
    const url = new URL(address)
    const mode = options.auth ?? 'main'
    const publicRequest = mode === 'public'
    const method = options.method ?? 'GET'
    const isWrite = method === 'POST' && !options.readOnlyPost
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !['www.douyu.com', 'yuba.douyu.com', 'apiv2.douyucdn.cn', 'mapi-yuba.douyu.com', 'webconf.douyucdn.cn'].includes(url.hostname)
      || !this.deps.proxy.enabled || !hostAllowed(url.hostname, this.deps.proxy.hosts)) throw new AutomationFault('unavailable')
    if (publicRequest && (method !== 'GET' || !['webconf.douyucdn.cn', 'www.douyu.com'].includes(url.hostname))) throw new AutomationFault('unavailable')
    if (!publicRequest) await this.identity(context)
    const { response } = await safeFetch(url.href, { ...this.deps.proxy, hosts: [url.hostname], maxRedirects: 0,
      allowNonLoopbackTargets: false, allowNonStandardPorts: false }, {
      method, signal: context.signal,
      resolve: async host => {
        const addresses = await abortable((this.deps.resolve ?? dnsResolver)(host), context.signal)
        if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(value => !isIP(value) || isPrivateAddress(value))) throw new AutomationFault('unavailable')
        return addresses
      },
      fetchImpl: async (checked, init) => {
        const auth = publicRequest ? null : await this.identity(context)
        const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
        let fields = { ...options.fields }
        if (auth) {
          if (mode.startsWith('token') || mode === 'dy-token') {
            if (!auth.token) throw new AutomationFault('login')
            if (mode === 'token-form') fields = { ...fields, token: auth.token }
            else if (mode === 'dy-token') { headers['dy-token'] = auth.token; headers['dy-client'] = 'pc' }
            else { headers.token = auth.token; headers[url.hostname === 'mapi-yuba.douyu.com' ? 'client' : 'aid'] = url.hostname === 'mapi-yuba.douyu.com' ? 'android' : 'android1' }
          } else {
            if (!['www.douyu.com', 'yuba.douyu.com'].includes(url.hostname)) throw new AutomationFault('unavailable')
            const scoped = await abortable(this.deps.cookieHeader(context.task.accountId, url.href), context.signal)
            const scopedFields = cookieFields(scoped)
            const mainFields = cookieFields(auth.cookie)
            if (['acf_uid', 'acf_auth', 'acf_auth_wl', 'acf_dmjwt_token', 'acf_stk', 'acf_ltkid', 'acf_biz', 'acf_ct']
              .some(name => scopedFields.has(name) && scopedFields.get(name) !== mainFields.get(name))) throw new AutomationFault('login')
            if (mode === 'main' && scopedFields.get('acf_uid') !== auth.uid) throw new AutomationFault('login')
            await this.identity(context)
            headers.Cookie = scoped
            headers['X-Requested-With'] = 'XMLHttpRequest'
            if (method === 'POST') {
              if (mode === 'yuba') {
                const csrf = scopedFields.get('acf_yb_t')
                if (!csrf || !/^[A-Za-z0-9._~+/-]{1,2048}={0,2}$/.test(csrf)) throw new AutomationFault('login')
                headers['X-CSRF-TOKEN'] = csrf
              } else {
                const csrf = scopedFields.get(options.carnivalCsrf ? 'cvl_csrf_token' : 'acf_ccn')
                if (!csrf || !/^[A-Za-z0-9._~+/=:-]{1,2048}$/.test(csrf)) throw new AutomationFault('login')
                fields = { ...fields, [options.carnivalCsrf ? 'csrfToken' : 'ctn']: csrf }
              }
            }
          }
        }
        if (options.referer) {
          const referer = new URL(options.referer)
          if (referer.origin !== url.origin) throw new AutomationFault('unavailable')
          headers.Referer = referer.href
        }
        let body: BodyInit | undefined
        if (method === 'POST') {
          headers.Origin = url.origin
          if (options.encoding === 'multipart') {
            const form = new FormData()
            for (const [key, value] of Object.entries(fields)) form.set(key, value)
            body = form
          } else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(fields).toString() }
        }
        automationActive(context.signal)
        if (isWrite) { context.onWrite?.(); context.submitted = true }
        const pending = (this.deps.request ?? fetch)(checked, { ...init, headers, body }).then(async result => {
          if (context.signal.aborted || result.redirected || result.url && result.url !== url.href) {
            await result.body?.cancel().catch(() => {})
            automationActive(context.signal)
            throw new AutomationFault('unavailable')
          }
          return result
        })
        return isWrite ? await pending : await abortable(pending, context.signal)
      },
    })
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {})
      this.inspect(context, isWrite, response.status, null)
    }
    const text = await this.readText(response, context.signal, options.limit ?? 262_144)
    if (!publicRequest) await this.identity(context)
    if (options.text) return text
    let payload: unknown
    try { payload = parseRewardJson(text) } catch { throw new AutomationFault('invalid-response') }
    this.inspect(context, isWrite, response.status, payload)
    return payload
  }

  private inspect(context: AutomationContext, isWrite: boolean, status: number, payload: unknown): void {
    try { attention(status, payload) } catch (error) {
      // A later read refusal does not prove that an earlier write was refused.
      if (isWrite && error instanceof AutomationFault && error.definiteRefusal) {
        context.writeRefused = true
        context.onDefiniteRefusal?.()
      }
      throw error
    }
  }

  private async readText(response: Response, signal: AbortSignal, limit: number): Promise<string> {
    const declared = response.headers.get('content-length')
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_048_576 || declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit) || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new AutomationFault('invalid-response')
    }
    const reader = response.body.getReader()
    let cancellation: Promise<unknown> | undefined
    const cancel = () => { cancellation ??= reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        automationActive(signal)
        const chunk = await reader.read()
        automationActive(signal)
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > limit || chunks.length >= 4_096) throw new AutomationFault('invalid-response')
        chunks.push(chunk.value)
      }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { throw new AutomationFault('invalid-response') }
    } finally {
      signal.removeEventListener('abort', cancel)
      cancel()
      await cancellation
      reader.releaseLock()
    }
  }
}

export interface DouyuArenaActivity { kind: 'actqzs' | 'cardArena'; id: string; alias: string; startsAt: number; endsAt: number; source: string }
export interface DouyuPointsActivity { alias: string; signAlias: string; startsAt: number; endsAt: number; source: string }

function configJson(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') throw new AutomationFault('invalid-response')
  const match = /^\s*DYConfigCallback\((\{[\s\S]*\})\);?\s*$/.exec(text)
  if (!match) throw new AutomationFault('invalid-response')
  return automationData(parseRewardJson(match[1]!))
}

/** Only public official pages/configuration can supply an activity identity. */
export class DouyuActivityCatalog {
  constructor(private readonly http: DouyuAutomationHttp) {}

  async arena(context: AutomationContext, kind: 'actqzs' | 'cardArena'): Promise<DouyuArenaActivity> {
    const now = this.http.now()
    const china = new Date(now + 8 * 3_600_000)
    const candidates = [0, -1, 1].map(offset => {
      const date = new Date(Date.UTC(china.getUTCFullYear(), china.getUTCMonth() + offset, 1))
      return `${kind}${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    })
    for (const alias of candidates) {
      automationActive(context.signal)
      const source = `https://webconf.douyucdn.cn/resource/common/activity/${alias}_w.json`
      try {
        const config = configJson(await this.http.request(context, source, { auth: 'public', text: true, limit: 1_048_576 }))
        const settings = automationData(automationData(config.data).activity_setting)
        const id = automationId(settings.activity_id)
        const start = automationNumber(settings.activity_start_time)
        const end = automationNumber(settings.activity_end_time)
        if (!id || settings.activity_alias_name !== alias || start === null || end === null || start >= end
          || !Number.isSafeInteger(start * 1_000) || !Number.isSafeInteger(end * 1_000)
          || Object.hasOwn(settings, 'system_switch') && automationNumber(settings.system_switch) !== 1) continue
        if (start * 1_000 <= now && now < end * 1_000) return { kind, id, alias, startsAt: start * 1_000, endsAt: end * 1_000, source }
      } catch (error) { automationActive(context.signal); if (error instanceof AutomationFault && ['login', 'verification', 'rate-limit'].includes(error.code)) throw error }
    }
    throw new AutomationFault('eligibility')
  }

  /** Discover current points links; an obsolete dated alias is never a fallback. */
  async points(context: AutomationContext): Promise<DouyuPointsActivity> {
    const page = await this.http.request(context, `${DOUYU_AUTOMATION_ORIGIN}/`, { auth: 'public', text: true, limit: 1_048_576 })
    if (typeof page !== 'string') throw new AutomationFault('invalid-response')
    const candidates = new Set<string>()
    for (const match of page.matchAll(/<a\b[^>]{0,4096}\bhref\s*=\s*["']((?:https:\/\/www\.douyu\.com)?\/topic\/([A-Za-z0-9_]{1,64}))["'][^>]{0,4096}>([\s\S]{0,2048}?)<\/a>/gi)) {
      if (!/积分|OPFOY/i.test(match[0])) continue
      candidates.add(match[2]!)
      if (candidates.size > 8) throw new AutomationFault('capacity')
    }
    for (const candidate of candidates) {
      const source = `https://webconf.douyucdn.cn/resource/common/activity/${candidate}_w.json`
      try {
        const config = configJson(await this.http.request(context, source, { auth: 'public', text: true, limit: 1_048_576 }))
        const data = automationData(config.data)
        const settings = automationData(data.activity_setting)
        const start = automationNumber(settings.activity_start_time)
        const end = automationNumber(settings.activity_end_time)
        const sign = record(data.sign_setting)
        const signAlias = sign?.signAlias ?? sign?.sign_alias
        if (settings.activity_alias_name !== candidate || typeof signAlias !== 'string'
          || !/^[A-Za-z0-9_]{1,96}$/.test(signAlias) || !signAlias.startsWith(`${candidate}_`) || start === null || end === null
          || !Number.isSafeInteger(start * 1_000) || !Number.isSafeInteger(end * 1_000) || start >= end
          || start * 1_000 > this.http.now() || end * 1_000 <= this.http.now()
          || Object.hasOwn(settings, 'system_switch') && automationNumber(settings.system_switch) !== 1) continue
        return { alias: candidate, signAlias, startsAt: start * 1_000, endsAt: end * 1_000, source }
      } catch (error) {
        automationActive(context.signal)
        if (error instanceof AutomationFault && ['login', 'verification', 'rate-limit', 'capacity'].includes(error.code)) throw error
      }
    }
    throw new AutomationFault('unavailable')
  }
}

export function automationTimeout(deps: DouyuAutomationDependencies, signal: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timeout = deps.proxy.requestTimeoutMs
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeout) ? Math.max(1, Math.min(MAX_TIMEOUT_MS, timeout)) : MAX_TIMEOUT_MS)
  return { signal: AbortSignal.any([signal, controller.signal]), dispose: () => clearTimeout(timer) }
}
