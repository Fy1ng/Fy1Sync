/** One explicit plain-text HTTP action. Credentials and signed URLs never leave main. */
import { safeFetch } from '../safeFetch'
import { diagnosticDetails } from '../errorDetails'
import { httpErrorDetails } from '../httpError'
import { networkContext, routeCandidates, type NetworkContext } from '../networkPolicy'
import { readPlatformText } from '../platformResponse'
import { parseDouyinPage } from '../platforms/douyinPage'
import { abortable, cancelBody, readPayload } from '../douyu/actionHttp'
import { DOUYIN_LOGIN_IDENTITY_URL, parseDouyinLoginIdentity } from '../../electron/douyinLoginIdentity'
import { douyinMessageRoom, douyinMessageText, type DouyinMessageInput, type DouyinMessageOutcome, type DouyinSendState } from '../../src/core/douyinMessage'
import { signDouyinHttpQuery } from './httpSigner'
import { acquireDouyinHttpToken, type DouyinHttpTokenDependencies } from './httpToken'
import { douyinBrowserUserAgent, douyinBrowserVersion, douyinGuardDiagnostics } from './httpContext'
import { douyinCookieFingerprint, validateDouyinSigningMaterial, type DouyinSigningMaterial } from './signingMaterial'
import { DouyinSigningResources } from './signingResources'
import { signDouyinPageGuard, signDouyinTicketHeaders } from './ticketSigner'

const ORIGIN = 'https://live.douyin.com'
const SEND_URL = `${ORIGIN}/webcast/room/chat/`
const COOLDOWN_MS = 5_000
const TIMEOUT_MS = 15_000
const STATE_CACHE_MS = 15_000
const STATE_FAILURE_CACHE_MS = 2_500
const UNCERTAIN = '未能确认发送结果。请先到官方直播间核对，不要重复发送。'
const SEND_UNAVAILABLE = '请重新登录抖音后再发送'
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn
const outcome = (status: DouyinMessageOutcome['status'], message: string, nextAllowedAt: number | null = null, detail?: unknown): DouyinMessageOutcome => ({ status, message, nextAllowedAt,
  ...(detail === undefined ? {} : { detail: diagnosticDetails(detail) }) })

function cookies(header: string): Map<string, string> {
  if (typeof header !== 'string' || header.length > 32_768 || /[\x00-\x1f\x7f]/.test(header)) throw new Error('Invalid credentials')
  const values = new Map<string, string>()
  for (const part of header.split(';')) {
    const match = /^\s*([A-Za-z0-9_-]+)=([^;\s]*)\s*$/.exec(part)
    if (!match) { if (part.trim()) throw new Error('Invalid credentials'); continue }
    if (values.has(match[1]!)) throw new Error('Ambiguous credentials')
    values.set(match[1]!, match[2]!)
  }
  return values
}
function authentication(header: string): string {
  const values = cookies(header)
  return JSON.stringify([values.get('sessionid') || '', values.get('sessionid_ss') || ''])
}
function hasAuthentication(header: string): boolean {
  const values = cookies(header)
  return !!(values.get('sessionid') || values.get('sessionid_ss'))
}

export interface DouyinMessageSenderDependencies extends DouyinHttpTokenDependencies {
  cookieHeader: (url: string) => Promise<string>
  isLoginBusy?: () => boolean
  /** Explicit offline experiments only; production credentials must not use this incomplete protocol. */
  syntheticProtocol?: true
  signingMaterial?: (header: string, signal: AbortSignal, accountUid?: string) => Promise<DouyinSigningMaterial|null>
  signingResources?: Pick<DouyinSigningResources,'peerPublicKey'|'timestampSeconds'|'invalidate'|'dispose'>
}
interface SigningContext { material: DouyinSigningMaterial; peerPublicKeyPem: string }

export class DouyinMessageSender {
  private readonly lifetime = new AbortController()
  private active: AbortController | null = null
  private revision = 0
  private nextAllowedAt: number | null = null
  private readonly now: () => number
  private readonly userAgent: string
  private readonly resources: Pick<DouyinSigningResources,'peerPublicKey'|'timestampSeconds'|'invalidate'|'dispose'>
  private cachedState: { authentication: string; revision: number; expiresAt: number; value: DouyinSendState } | null = null
  private readingState: { authentication: string; revision: number; controller: AbortController; promise: Promise<DouyinSendState> } | null = null
  constructor(private readonly deps: DouyinMessageSenderDependencies) {
    this.now = deps.now ?? Date.now
    this.userAgent = douyinBrowserUserAgent(deps.userAgent)
    this.resources=deps.signingResources ?? new DouyinSigningResources({...deps,userAgent:this.userAgent})
  }

  /** Called before account transitions, including a logout while resolving a room. */
  invalidate(): void {
    this.revision++; this.cachedState = null; this.readingState?.controller.abort(); this.readingState = null; this.active?.abort(); this.resources.invalidate()
  }
  dispose(): void { this.invalidate(); this.lifetime.abort(); this.resources.dispose() }

  private signal(parent?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(TIMEOUT_MS), ...(parent ? [parent] : [])])
  }
  private syntheticProtocolReady(): boolean {
    return this.deps.syntheticProtocol === true && typeof this.deps.fetchImpl === 'function' && typeof this.deps.resolve === 'function'
  }
  private async signingContext(header: string, signal: AbortSignal, accountUid?: string): Promise<SigningContext|null> {
    if (!this.deps.signingMaterial) return null
    const captured=await abortable(this.deps.signingMaterial(header,signal,accountUid),signal)
    signal.throwIfAborted()
    if (!captured) return null
    const material=validateDouyinSigningMaterial(captured)
    if (material.cookieFingerprint!==douyinCookieFingerprint(header) || accountUid!==undefined && material.accountUid!==accountUid) {
      throw Object.assign(new Error('暂时不能发送弹幕，请重新登录抖音'),{code:'douyin-signing-material-invalid'})
    }
    return {material,peerPublicKeyPem:await this.resources.peerPublicKey(signal)}
  }
  private async header(url: string, signal: AbortSignal): Promise<string> {
    const result = await abortable(this.deps.cookieHeader(url), signal)
    cookies(result)
    return result
  }
  private async request(url: string, header: string, signal: AbortSignal, referer = `${ORIGIN}/`, signing: SigningContext|null=null,
    dispatch?: () => void): Promise<Response> {
    // A write uses a single proxy candidate and never follows even a same-origin redirect.
    const context = this.deps.network?.() ?? networkContext()
    const network: NetworkContext = { route: async raw => {
      const route = routeCandidates(await context.route(raw)).find(item => item.kind !== 'unsupported')
      return route ?? { kind: 'unsupported' }
    } }
    // F2's current HTTP gateway compatibility value, not an account credential.
    const headers: Record<string,string> = { 'User-Agent': signing?.material.userAgent ?? this.userAgent, Referer: referer, Cookie: header,
      Accept:'application/json', 'Content-Type':'application/json', Origin:ORIGIN, 'x-tt-argus':'1' }
    const values = cookies(header), uifid = values.get('UIFID') || values.get('UIFID_TEMP')
    if (uifid) headers.uifid = uifid
    if (signing) {
      const timestamp=await this.resources.timestampSeconds(signal)
      signal.throwIfAborted()
      headers.Cookie=header.split(';').map(value=>value.trim()).filter(value=>value && !value.startsWith('bd-web-sign-page-guard=')).join('; ')
        + '; ' + signDouyinPageGuard(signing.material,timestamp,signing.peerPublicKeyPem)
      if (new URL(url).pathname==='/webcast/room/chat/') {
        Object.assign(headers,signDouyinTicketHeaders(signing.material,url,timestamp,signing.peerPublicKeyPem))
      }
    }
    signal.throwIfAborted()
    dispatch?.()
    const work = safeFetch(url, { ...this.deps.proxy, maxRedirects: 0 }, { method: 'GET', headers, signal,
      network, fetchImpl: this.deps.fetchImpl, resolve: this.deps.resolve })
    void work.then(result => { if (signal.aborted) cancelBody(result.response) }, () => {})
    const result = await abortable(work, signal)
    if (result.finalUrl.href !== url) { cancelBody(result.response); throw new Error('Unexpected action destination') }
    return result.response
  }
  private async identity(header: string, signal: AbortSignal, signing: SigningContext|null=null) {
    const response = await this.request(DOUYIN_LOGIN_IDENTITY_URL, header, signal,`${ORIGIN}/`,signing)
    if (!response.ok) throw Object.assign(new Error('Identity unavailable'), await httpErrorDetails(response), douyinGuardDiagnostics(response.headers))
    const raw = record(await readPayload(response, signal)), identity = parseDouyinLoginIdentity(raw)
    if (identity.status === 'anonymous') this.cachedState = null
    return { ...identity, ...(identity.status === 'authenticated' ? {} : { detail: diagnosticDetails({
      status: response.status, identityStatus: identity.status, platformCode: raw.status_code, message: raw.status_msg ?? raw.message,
      ...douyinGuardDiagnostics(response.headers) }) }) }
  }
  async state(parent?: AbortSignal, refresh = false): Promise<DouyinSendState> {
    const signal = this.signal(parent), revision = this.revision
    let key: string | null = null
    const busy = (): DouyinSendState => ({loggedIn:false,canSend:false,loginState:'authenticating',message:'正在重新登录抖音'})
    try {
      if (this.deps.isLoginBusy?.()) return busy()
      const header = await this.header(DOUYIN_LOGIN_IDENTITY_URL, signal)
      if (this.deps.isLoginBusy?.()) return busy()
      if (revision !== this.revision || signal.aborted) throw new Error('Account changed')
      if (!hasAuthentication(header)) return { loggedIn:false,canSend:false,loginState:'signed-out',
        message:'登录抖音后可发送弹幕' }
      const authenticationKey = authentication(header)
      key = authenticationKey
      const cached = this.cachedState
      if (!refresh && cached && cached.authentication === authenticationKey && cached.revision === revision && this.now() < cached.expiresAt) return structuredClone(cached.value)
      let reading = this.readingState
      if (!reading || reading.authentication !== authenticationKey || reading.revision !== revision) {
        reading?.controller.abort()
        const controller = new AbortController()
        // A caller closing its panel must not cancel another caller's identity check.
        const sharedSignal = this.signal(controller.signal)
        const promise = this.readState(header, sharedSignal, revision).then(value => {
          if (revision === this.revision && !sharedSignal.aborted && !this.deps.isLoginBusy?.()) {
            this.cachedState = { authentication: authenticationKey, revision, value,
              expiresAt: this.now() + (value.loginState === 'authenticated' ? STATE_CACHE_MS : STATE_FAILURE_CACHE_MS) }
          }
          return value
        }).finally(() => { if (this.readingState?.promise === promise) this.readingState = null })
        reading = { authentication: authenticationKey, revision, controller, promise }
        this.readingState = reading
      }
      const value = await abortable(reading.promise, signal)
      if (this.deps.isLoginBusy?.()) return busy()
      if (revision !== this.revision || signal.aborted) throw new Error('Account changed')
      return structuredClone(value)
    } catch (error) {
      if (this.deps.isLoginBusy?.()) return busy()
      const value: DouyinSendState = { loggedIn:false,canSend:false,loginState:'unavailable',
        message:'暂时无法核对抖音账号状态，请检查网络并刷新后重试',detail:diagnosticDetails(error) }
      if (key !== null && revision === this.revision && !signal.aborted) {
        this.cachedState = { authentication:key,revision,value,expiresAt:this.now() + STATE_FAILURE_CACHE_MS }
      }
      return value
    }
  }

  private async readState(header: string, signal: AbortSignal, revision: number): Promise<DouyinSendState> {
    let signing: SigningContext|null=null, preparationProblem:unknown
    try { signing=await this.signingContext(header,signal) }
    catch (error) { signal.throwIfAborted(); preparationProblem=error }
    const identity = await this.identity(header, signal,signing)
    if (revision !== this.revision || signal.aborted || this.deps.isLoginBusy?.()) throw new Error('Account changed')
    const sendHeader = await this.header(SEND_URL, signal)
    if (revision !== this.revision || authentication(header) !== authentication(sendHeader)) throw new Error('Account changed')
    const canSend = signing!==null || !preparationProblem && this.syntheticProtocolReady()
    if (identity.status === 'anonymous') return { loggedIn:false,canSend:false,loginState:'expired',
      message:canSend ? '暂时无法确认登录，请刷新账号状态' : SEND_UNAVAILABLE,
      detail:diagnosticDetails({ ...identity.detail,...(canSend ? {} : {code:'douyin-signing-material-missing'}),
        ...(preparationProblem ? {preparation:diagnosticDetails(preparationProblem)} : {}) }) }
    if (identity.status !== 'authenticated') return { loggedIn:false,canSend:false,loginState:'unavailable',message:'暂时无法确认抖音账号状态，请刷新后重试', detail: identity.detail }
    if (signing && signing.material.accountUid!==identity.uid) return {loggedIn:true,canSend:false,loginState:'authenticated',uid:identity.uid,nickname:identity.nickname,
      message:'请重新登录抖音后再发送',detail:diagnosticDetails({code:'douyin-signing-material-missing'})}
    // The SDK token can live on .bytedance.com instead of in the saved login cookies.
    // It is prepared anonymously only after an explicit send, never a login requirement.
    return { loggedIn: true, canSend,loginState:'authenticated', uid: identity.uid, nickname: identity.nickname,
      message:canSend ? '可发送普通文字弹幕' : preparationProblem ? '已登录，暂时不能发送弹幕，请刷新后重试' : SEND_UNAVAILABLE,
      ...(canSend ? {} : { detail:preparationProblem ? diagnosticDetails(preparationProblem) : diagnosticDetails({ code:'douyin-signing-material-missing' }) }) }
  }

  async send(input: DouyinMessageInput, parent?: AbortSignal, current: () => boolean = () => true): Promise<DouyinMessageOutcome> {
    const text = douyinMessageText(input?.text)
    if (!text || !douyinMessageRoom(input?.room) || !validId(input?.expectedUid)) return outcome('failed', '弹幕内容或抖音房间无效。普通文字最多 50 字，未发送弹幕。')
    if (this.deps.isLoginBusy?.()) return outcome('waiting-user','抖音正在重新登录，请等待登录完成。未发送弹幕。')
    if (this.lifetime.signal.aborted || parent?.aborted || !current()) return outcome('failed', '发送已取消。未发送弹幕。')
    if (this.active) return outcome('waiting-user', '上一条抖音发送仍在等待结果')
    if (this.nextAllowedAt !== null && this.nextAllowedAt > this.now()) return outcome('waiting-user', '请等待抖音发言冷却结束', this.nextAllowedAt)
    const owner = new AbortController(), signal = this.signal(AbortSignal.any([owner.signal, ...(parent ? [parent] : [])]))
    this.active = owner
    const revision = this.revision
    let dispatched = false
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision || !current() || this.deps.isLoginBusy?.()) throw new Error('Send context changed') }
    try {
      const identityHeader = await this.header(DOUYIN_LOGIN_IDENTITY_URL, signal)
      check()
      if (!hasAuthentication(identityHeader)) return outcome('waiting-user', '请先登录抖音。未发送弹幕。')
      const signing=await this.signingContext(identityHeader,signal,input.expectedUid)
      check()
      if (!signing && !this.syntheticProtocolReady()) return outcome('waiting-user',`${SEND_UNAVAILABLE}，本次未发送`,null,{code:'douyin-signing-material-missing'})
      const identity = await this.identity(identityHeader, signal,signing)
      check()
      if (identity.status === 'anonymous') return outcome('waiting-user', '暂时无法确认登录，未发送弹幕。请刷新账号状态。', null, identity.detail)
      if (identity.status !== 'authenticated') return outcome('waiting-user', '暂时无法核对抖音发送账号，请检查网络并刷新后重试。未发送弹幕。', null, identity.detail)
      if (identity.uid !== input.expectedUid) return outcome('waiting-user', '抖音发送账号已变化，请刷新账号状态。未发送弹幕。')
      const webRoom = input.room.slice(7), pageUrl = `${ORIGIN}/${webRoom}`
      const pageHeader = await this.header(pageUrl, signal)
      check()
      if (authentication(pageHeader) !== authentication(identityHeader)) throw new Error('Account changed')
      const pageResponse = await this.request(pageUrl, pageHeader, signal,`${ORIGIN}/`,signing)
      if (!pageResponse.ok) return outcome('failed', '无法核对抖音目标房间，未发送弹幕', null, await httpErrorDetails(pageResponse))
      const room = parseDouyinPage(await readPlatformText(pageResponse, signal), webRoom)
      check()
      if (!room || room.webRoom !== webRoom || !validId(room.roomId)) return outcome('failed', '无法确认抖音房间身份，未发送弹幕')
      if (room.status !== 2 && room.status !== '2') return outcome('waiting-user', '抖音房间当前未开播，未发送弹幕')
      let header = await this.header(SEND_URL, signal)
      check()
      if (authentication(header) !== authentication(identityHeader)) throw new Error('Account changed')
      const storedToken = cookies(header).get('msToken')
      let token = storedToken && storedToken.length <= 4096 && /^[A-Za-z0-9_+/=-]+$/.test(storedToken) ? storedToken : ''
      if (!token) {
        try { token = await acquireDouyinHttpToken({...this.deps,userAgent:signing?.material.userAgent ?? this.userAgent}, signal) }
        catch (error) { check(); return outcome('failed', '未发送弹幕，请检查网络后重试', null, error) }
        check()
        header = await this.header(SEND_URL, signal)
        check()
        if (authentication(header) !== authentication(identityHeader)) throw new Error('Account changed')
      }
      const userAgent=signing?.material.userAgent ?? this.userAgent
      const params = new URLSearchParams({ aid:'6383', app_name:'douyin_web', live_id:'1', device_platform:'web', language:'zh-CN', enter_from:'web_live', cookie_enabled:'true', screen_width:'1920', screen_height:'1080', browser_language:'zh-CN', browser_platform:'Win32', browser_name:'Chrome', browser_version:douyinBrowserVersion(userAgent), os_name:'Windows', os_version:'10', room_id:room.roomId, content:text, type:'0', rtf_content:'', paste_edit_method:'non_paste', msToken:token })
      const query = params.toString(), signature = signDouyinHttpQuery(query, userAgent)
      const url = `${SEND_URL}?${query}&a_bogus=${encodeURIComponent(signature)}`
      check()
      const response = await this.request(url, header, signal, pageUrl,signing,()=>{
        check(); this.nextAllowedAt=this.now()+COOLDOWN_MS; dispatched=true
      })
      // Never return upstream text, headers or challenge payloads through IPC.
      const report = (value: DouyinMessageOutcome, reason: NonNullable<DouyinMessageOutcome['diagnostic']>['reason'], platformCode?: number): DouyinMessageOutcome => ({
        ...value, diagnostic:{ reason,httpStatus:response.status,...(platformCode === undefined ? {} : { platformCode }), ...douyinGuardDiagnostics(response.headers) },
        ...(value.status === 'accepted' ? {} : { detail: diagnosticDetails(value.detail ?? { reason, status: response.status,
          statusText: response.statusText, ...(platformCode === undefined ? {} : { platformCode }), ...douyinGuardDiagnostics(response.headers) }) }),
      })
      const challenge = !!(response.headers.get('bdturing-verify')?.trim() || response.headers.get('x-tt-verify-passport-decision')?.trim())
      if (challenge) {
        cancelBody(response)
        return report(outcome('waiting-user', '请在官方直播间完成验证并核对本次发送结果。不会自动重发。', this.nextAllowedAt),'verification-required')
      }
      if (response.status === 429) {
        const retry = response.headers.get('retry-after') ?? ''
        const seconds = /^\d{1,5}$/.test(retry) ? Math.max(5,Math.min(300,Number(retry))) : 30
        this.nextAllowedAt = Math.max(this.nextAllowedAt ?? 0,this.now() + seconds * 1000)
        const detail = await httpErrorDetails(response)
        return report(outcome('waiting-user', '发送过于频繁，请稍后再试。不会自动重发。',this.nextAllowedAt, detail),'rate-limited')
      }
      const root = record(await readPayload(response, signal)), data = record(root.data)
      check()
      const platformCode = typeof root.status_code === 'number' && Number.isSafeInteger(root.status_code) ? root.status_code : undefined
      if (data.shark_decision_conf) return report(outcome('waiting-user', '请在官方直播间完成验证并核对本次发送结果。不会自动重发。', this.nextAllowedAt),'verification-required',platformCode)
      const errors: Record<number,string> = { 20003:'抖音发送接口未确认登录，请刷新账号状态', 50001:'抖音提示当前账号已被禁言', 50004:'抖音拒绝了本次弹幕内容', 50008:'抖音提示弹幕超过平台当前长度限制', 40001:'抖音拒绝了本次发言权限' }
      if (platformCode === 20003) this.cachedState = null
      if (platformCode !== undefined && platformCode !== 0) return report(outcome('waiting-user', `${errors[platformCode] ?? '抖音未受理本次弹幕'}。不会自动重发。`, this.nextAllowedAt,
        { status: response.status, statusText: response.statusText, platformCode, message: root.status_msg ?? root.message }),'platform-rejected',platformCode)
      if (!response.ok) return report(outcome('waiting-user', response.status === 403
        ? '抖音拒绝了此次发送。不会自动重发。'
        : `未能确认发送结果。请先到官方直播间核对，不要重复发送。`,this.nextAllowedAt),'http-rejected',platformCode)
      const id = validId(data.msg_id_str) ? data.msg_id_str : typeof data.msg_id === 'number' && Number.isSafeInteger(data.msg_id) && data.msg_id > 0 ? String(data.msg_id) : null
      const responseUser = record(data.user)
      if (root.status_code !== 0 || !id || data.content !== text
        || (responseUser.id_str !== undefined && responseUser.id_str !== identity.uid)
        || (data.room_id_str !== undefined && data.room_id_str !== room.roomId)) return report(outcome('waiting-user', UNCERTAIN, this.nextAllowedAt),'invalid-receipt',platformCode)
      return { ...report(outcome('accepted', '抖音已接收，等待直播间确认。不会自动重发。', this.nextAllowedAt),'receipt-received',platformCode), messageId:id }
    } catch (error) {
      return outcome(dispatched ? 'waiting-user' : 'failed', dispatched ? UNCERTAIN : '无法完成抖音发送前检查，未发送弹幕', dispatched ? this.nextAllowedAt : null, error)
    } finally { if (this.active === owner) this.active = null }
  }
}
