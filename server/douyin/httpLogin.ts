/** Main-owned HTTP passport login. No webpage, browser SDK, script runner or signing service is used. */
import { createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto'
import type { ProxyConfig } from '../config'
import { ProxyError, safeFetch, type Resolver } from '../safeFetch'
import { networkContext, routeCandidates, type NetworkContext } from '../networkPolicy'
import { classifyNetworkFailure, StreamFailureError } from '../networkFailure'
import { abortable, cancelBody, readPayload } from '../douyu/actionHttp'
import { hasAuthenticationCookies, douyinBrowserCookieFingerprint } from '../../electron/cookies'
import { DOUYIN_LOGIN_IDENTITY_URL, parseDouyinLoginIdentity } from '../../electron/douyinLoginIdentity'
import { DouyinHttpCookies } from './httpLoginCookies'
import { DouyinPassportDtrait } from './passportDtrait'
import { douyinPassportAidSignature, encodeDouyinPassport, generateDouyinVerifyFp, signDouyinPassportParams, signDouyinPassportQuery } from './passportSigner'
import { acquireDouyinPassportToken } from './passportToken'
import { DouyinSigningResources } from './signingResources'
import { parseDouyinSigningSnapshot, type DouyinSigningSnapshot } from './signingMaterial'
import type { DouyinHttpLoginSession, DouyinHttpLoginStep, DouyinHttpPhone, DouyinHttpQr } from './httpLoginContracts'
import { douyinHttpLoginFailureDetails, douyinHttpLoginFailureMessage, type DouyinHttpLoginFailure, type DouyinHttpRequestStage } from './httpLoginFailure'
import browserProfile from './fixtures/passport-dtrait-profile.json'

const WWW = 'https://www.douyin.com'
const LOGIN = 'https://login.douyin.com'
const LIVE = 'https://live.douyin.com'
const APP_KEY = '163e7ce78d58971a41f5b969996d85c2'
const HOSTS = ['www.douyin.com', 'login.douyin.com', 'live.douyin.com', 'sso.douyin.com', 'sso1.douyin.com', 'sso2.douyin.com']
const QR_TTL = 55_000
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn
const form = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')

export class DouyinHttpLoginError extends Error {
  readonly requestStage?: DouyinHttpRequestStage
  readonly networkCode?: DouyinHttpLoginFailure['networkCode']
  constructor(readonly code: string, readonly platformCode?: number, readonly httpStatus?: number, readonly nextAllowedAt?: number,
    diagnostic: Pick<DouyinHttpLoginFailure, 'requestStage' | 'networkCode'> = {}) {
    super(douyinHttpLoginFailureMessage({ code, platformCode, httpStatus, ...diagnostic }))
    this.name = 'DouyinHttpLoginError'
    this.requestStage = diagnostic.requestStage
    this.networkCode = diagnostic.networkCode
  }
}

export interface DouyinHttpLoginDependencies {
  proxy: ProxyConfig
  signal: AbortSignal
  network?: () => NetworkContext
  fetchImpl?: typeof fetch
  resolve?: Resolver
  now?: () => number
  userAgent?: string
  signingResources?: Pick<DouyinSigningResources, 'peerPublicKey' | 'timestampSeconds' | 'dispose'>
}

/** Each instance owns a fresh anonymous jar and one P-256 key until verified or cancelled. */
export class DouyinHttpLogin implements DouyinHttpLoginSession {
  private readonly lifetime = new AbortController()
  private readonly now: () => number
  private readonly jar: DouyinHttpCookies
  private readonly dtrait: DouyinPassportDtrait
  private readonly proxy: ProxyConfig
  private readonly resources: Pick<DouyinSigningResources, 'peerPublicKey' | 'timestampSeconds' | 'dispose'>
  private privateKey: KeyObject | null
  private readonly publicPem: string
  private readonly rawPublic: string
  private readonly fp: string
  private readonly trace = randomBytes(4).toString('hex')
  private readonly portrait = randomUUID() + '.login'
  private readonly sourceInfo: string
  private token = ''
  private msToken = ''
  private qr: DouyinHttpQr | null = null
  private serverProof: string | null = null
  private initialized = false
  private initializing: Promise<DouyinHttpQr> | null = null
  private disposed = false
  private revision = 0
  private pollUntil = 0
  private smsUntil = 0
  private smsPrepared = false
  private writing = false

  constructor(private readonly deps: DouyinHttpLoginDependencies) {
    this.now = deps.now ?? Date.now
    this.jar = new DouyinHttpCookies(this.now)
    this.dtrait = new DouyinPassportDtrait({ userAgent: deps.userAgent, now: this.now })
    this.proxy = { ...deps.proxy, hosts: [...HOSTS, 'mssdk.bytedance.com'], maxRedirects: 0 }
    this.resources = deps.signingResources ?? new DouyinSigningResources({ ...deps, proxy: this.proxy, userAgent: this.dtrait.userAgent })
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.privateKey = pair.privateKey
    this.publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const publicJwk = pair.publicKey.export({ format: 'jwk' })
    this.rawPublic = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, 'base64url'), Buffer.from(publicJwk.y!, 'base64url')]).toString('base64')
    this.fp = generateDouyinVerifyFp(this.now())
    this.sourceInfo = encodeDouyinPassport(JSON.stringify({ hardwareConcurrency: browserProfile.hardware_concurrency, webdriver: false, chromedriver: false, shelldriver: false,
      plugins: 5, innerHeight: 1215, innerWidth: browserProfile.screen_width, outerHeight: browserProfile.avail_height, outerWidth: browserProfile.screen_width,
      automation: { s: '00000000', c: '0000', p: '0000000', s1: '00000000', c1: '0000', p1: '0' },
      performance: { timeOrigin: this.now(), navigationTiming: { entryType: 'navigation', name: WWW + '/' } },
      browser: { t: String(this.now()), bit_protocol: 'false', bit_helper: false } }))
    this.seed()
  }

  private check(revision = this.revision): void {
    if (this.disposed || this.deps.signal.aborted || this.lifetime.signal.aborted || revision !== this.revision) throw new DouyinHttpLoginError('douyin-http-login-cancelled')
  }
  private signal(): AbortSignal { return AbortSignal.any([this.deps.signal, this.lifetime.signal, AbortSignal.timeout(this.proxy.requestTimeoutMs)]) }
  private requestStage(url: URL): DouyinHttpRequestStage {
    if (url.pathname === '/') return 'bootstrap'
    if (url.pathname === '/passport/web/get_qrcode/') return 'qr'
    if (url.pathname === '/passport/web/check_qrconnect/') return 'poll'
    if (url.pathname === '/passport/web/send_code/') return 'sms-send'
    if (url.pathname === '/passport/web/sms_login/') return 'sms-login'
    if (url.pathname === '/passport/web/user/login/') return 'password-login'
    if (url.pathname === '/webcast/user/me/' || url.pathname === '/passport/account/info/v2/') return 'identity'
    return 'redirect'
  }
  private failure(error: unknown, requestStage: DouyinHttpRequestStage, signal?: AbortSignal,
    fallback = 'douyin-http-login-receipt-invalid'): DouyinHttpLoginError {
    if (this.deps.signal.aborted || this.lifetime.signal.aborted || this.disposed) return new DouyinHttpLoginError('douyin-http-login-cancelled', undefined, undefined, undefined, { requestStage })
    if (signal?.aborted) return new DouyinHttpLoginError('douyin-http-login-timeout', undefined, undefined, undefined, { requestStage })
    const value = douyinHttpLoginFailureDetails(error)
    if (value.code !== 'douyin-http-login-failed') return new DouyinHttpLoginError(value.code, value.platformCode, value.httpStatus,
      error instanceof DouyinHttpLoginError ? error.nextAllowedAt : undefined, { requestStage: value.requestStage ?? requestStage, networkCode: value.networkCode })
    if (fallback === 'douyin-http-login-network-unavailable') {
      const classified = error instanceof ProxyError ? error.reason === 'upstream-failed' ? 'upstream-request-failed' : error.reason : classifyNetworkFailure(error).code
      const network = douyinHttpLoginFailureDetails({ code: fallback, networkCode: classified })
      return new DouyinHttpLoginError(fallback, undefined, undefined, undefined, { requestStage, networkCode: network.networkCode ?? 'upstream-request-failed' })
    }
    return new DouyinHttpLoginError(fallback, undefined, undefined, undefined, { requestStage })
  }
  private url(raw: string): URL {
    try {
      const url = new URL(raw)
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.includes(url.hostname) || url.hash) throw new Error()
      return url
    } catch { throw new DouyinHttpLoginError('douyin-http-login-destination-invalid') }
  }
  private seed(): void {
    this.jar.setPublic('s_v_web_id', this.fp)
    this.jar.setPublic('biz_trace_id', this.trace)
    const publicCookie = { 'bd-ticket-guard-version': 2, 'bd-ticket-guard-iteration-version': 1,
      'bd-ticket-guard-ree-public-key': this.rawPublic, 'bd-ticket-guard-web-version': 2 }
    this.jar.setPublic('bd_ticket_guard_client_data', encodeURIComponent(Buffer.from(JSON.stringify(publicCookie)).toString('base64')))
    this.jar.setPublic('bd_ticket_guard_client_web_domain', '2')
    for (const [name, value] of Object.entries({ enter_pc_once: '1', is_support_rtm_web_ts: '1', hevc_supported: 'true', IsDouyinActive: 'true',
      is_dash_user: '1', home_can_add_dy_2_desktop: '%220%22', dy_swidth: '2560', dy_sheight: '1440', device_web_cpu_core: '20',
      device_web_memory_size: '32', architecture: 'amd64', passport_auth_mix_state: randomBytes(24).toString('hex') })) this.jar.setPublic(name, value)
  }

  private parameters(extra: Record<string, string>, body: Record<string, string>, fingerprint: boolean, time: number): Record<string, string> {
    const aid = douyinPassportAidSignature('/passport/web/get_qrcode/', 6383, APP_KEY, time)
    const p: Record<string, string> = { passport_jssdk_version: '3.4.9', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1',
      aid: '6383', language: 'zh', account_app_language: 'zh-CN', ts: aid.ts, ...extra, p_ui: '2.4.10' }
    if (fingerprint) Object.assign(p, { p_ca: '4.0.26', p_ca_real: '1.0.0.938', fp: this.fp, verifyFp: this.fp })
    Object.assign(p, { account_sdk_source: 'web', account_sdk_source_info: this.sourceInfo, p_js_v: '3.4.9', p_js_t: 'pro',
      p_zt: '3.3.30', p_ver: '1.1.4-beta.5', p_ver_real: '0', request_host: encodeURIComponent(WWW), p_bd: '1.0.1.19-fix.01',
      p_ts: String(time), biz_trace_id: this.trace, device_platform: 'web_app' })
    p.p_no = createHash('sha256').update(Object.keys(p).filter(key => ['passport_jssdk_version', 'p_bd', 'p_ca', 'p_ts', 'p_ver', 'p_zt'].includes(key))
      .sort().map(key => key + '=' + p[key]).join('&')).digest('hex')
    Object.assign(p, signDouyinPassportParams(p, body, APP_KEY))
    if (this.msToken) p.msToken = this.msToken
    return p
  }

  private async request(raw: string, method: 'GET' | 'POST' | 'HEAD', body?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    this.check()
    const revision = this.revision, url = this.url(raw), signal = this.signal(), requestStage = this.requestStage(url)
    const context = this.deps.network?.() ?? networkContext()
    const network: NetworkContext = { route: async target => routeCandidates(await context.route(target)).find(route => route.kind !== 'unsupported') ?? { kind: 'unsupported' } }
    const headers: Record<string, string> = { 'User-Agent': this.dtrait.userAgent, Referer: WWW + '/', Origin: WWW,
      Accept: 'application/json, text/javascript', 'Accept-Language': 'zh-CN,zh;q=0.9', 'x-tt-argus': '1',
      Cookie: this.jar.header(url.href), ...extraHeaders }
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const work = safeFetch(url.href, this.proxy, { method, body, headers, signal, manualRedirect: true, network, fetchImpl: this.deps.fetchImpl, resolve: this.deps.resolve })
    void work.then(result => { if (signal.aborted) cancelBody(result.response) }, () => {})
    let result
    try { result = await abortable(work, signal) }
    catch (error) { this.check(revision); throw this.failure(error, requestStage, signal, 'douyin-http-login-network-unavailable') }
    this.check(revision)
    if (result.finalUrl.href !== url.href) { cancelBody(result.response); throw new DouyinHttpLoginError('douyin-http-login-destination-invalid', undefined, undefined, undefined, { requestStage }) }
    try {
      this.jar.receive(url.href, result.response.headers)
      this.absorbProof(url.href, result.response.headers)
      if (url.hostname === 'login.douyin.com') {
        const token = result.response.headers.get('x-ms-token')
        if (token && /^[A-Za-z0-9_+/=-]+$/.test(token) && [164,172,184].includes(token.length)) {
          this.msToken = token
          this.jar.setPublic('msToken', token)
          if (token.length < 170) this.smsPrepared = false
        }
      }
    } catch (error) { cancelBody(result.response); throw this.failure(error, requestStage) }
    return result.response
  }

  private absorbProof(url: string, headers: Headers): void {
    const candidates = [headers.get('bd-ticket-guard-server-data'), this.jar.value('bd_ticket_guard_server_data', url)]
    for (const raw of candidates) {
      if (!raw || raw.length > 32768) continue
      try {
        const proof = record(JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8')))
        if (typeof proof.ticket !== 'string' || typeof proof.ts_sign !== 'string' || typeof proof.client_cert !== 'string') continue
        if (proof.client_cert !== 'pub.' + this.rawPublic) throw new DouyinHttpLoginError('douyin-http-ticket-mismatch')
        this.serverProof = JSON.stringify({ ticket: proof.ticket, ts_sign: proof.ts_sign, client_cert: proof.client_cert,
          ...(typeof proof.aes_sign_safari === 'string' ? { aes_sign_safari: proof.aes_sign_safari } : {}) })
      } catch (error) { if (error instanceof DouyinHttpLoginError) throw error }
    }
  }

  private async passport(path: string, body: Record<string, string> | null, extra: Record<string, string> = {}, fingerprint = true): Promise<Record<string, unknown>> {
    this.check()
    const time = this.now(), params = this.parameters(extra, body || {}, fingerprint, time), encodedBody = body ? form(body) : ''
    const query = form(params), signature = signDouyinPassportQuery(query, encodedBody, this.dtrait.userAgent, 'login.douyin.com')
    const url = LOGIN + path + '?' + query + '&a_bogus=' + encodeURIComponent(signature)
    const headers: Record<string, string> = { 'web-sdk-version': '1', 'x-tt-session-dtrait': this.dtrait.header(path),
      'x-tt-passport-aid-sign': douyinPassportAidSignature(path, 6383, APP_KEY, time).header,
      'x-tt-passport-csrf-token': this.jar.value('passport_csrf_token', url) || this.jar.value('passport_csrf_token_default', url) || '',
      'x-tt-passport-trace-id': this.trace, 'x-tt-passport-verify-portrait': this.portrait }
    // Only login providers negotiate a key; QR creation and SMS sending are not providers.
    if (['/passport/web/check_qrconnect/', '/passport/web/sms_login/', '/passport/web/user/login/'].includes(path)) {
      Object.assign(headers, { 'bd-ticket-guard-ree-public-key': this.rawPublic, 'bd-ticket-guard-web-version': '2',
        'bd-ticket-guard-web-sign-type': '0', 'bd-ticket-guard-version': '2' })
    }
    const response = await this.request(url, body ? 'POST' : 'GET', body ? encodedBody : undefined, headers)
    const httpStatus = response.status, requestStage = this.requestStage(new URL(url))
    this.check()
    if (httpStatus < 200 || httpStatus >= 300) {
      cancelBody(response)
      throw new DouyinHttpLoginError('douyin-http-login-rejected', undefined, httpStatus, undefined, { requestStage })
    }
    return await this.payload(response, requestStage)
  }

  initialize(): Promise<DouyinHttpQr> {
    this.check()
    if (this.initializing) return this.initializing
    if (this.initialized && this.qr) return Promise.resolve({ ...this.qr })
    const work = (async () => {
      const response = await this.request(WWW + '/?recommend=1', 'GET', undefined, { Accept: 'text/html' })
      cancelBody(response)
      if (response.status >= 400) throw new DouyinHttpLoginError('douyin-http-login-rejected', undefined, response.status, undefined, { requestStage: 'bootstrap' })
      const tokenSignal = this.signal()
      try { this.msToken = await acquireDouyinPassportToken({ ...this.deps, proxy: this.proxy, userAgent: this.dtrait.userAgent }, tokenSignal) }
      catch (error) { throw this.failure(error, 'token', tokenSignal, error instanceof ProxyError || error instanceof StreamFailureError || error instanceof TypeError
        ? 'douyin-http-login-network-unavailable' : 'douyin-http-login-token-unavailable') }
      this.check()
      this.jar.setPublic('msToken', this.msToken)
      this.initialized = true
      return await this.refreshQr()
    })()
    this.initializing = work
    void work.finally(() => { if (this.initializing === work) this.initializing = null }).catch(() => {})
    return work
  }

  async refreshQr(): Promise<DouyinHttpQr> {
    this.check()
    if (!this.initialized) return this.initialize()
    this.revision++
    const revision = this.revision
    this.token = ''; this.pollUntil = 0
    const payload = await this.passport('/passport/web/get_qrcode/', null, { next: WWW, need_short_url: 'true', need_logo: 'false', is_new_login: '1', is_from_iesaccountsaas: '1' }, false)
    this.check(revision)
    const data = record(payload.data)
    this.error(data, 'qr')
    const raw = typeof data.qrcode === 'string' ? data.qrcode.replace(/^data:image\/png;base64,/, '') : ''
    const token = typeof data.token === 'string' ? data.token : ''
    if (raw.length > 262144 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || !/^[A-Za-z0-9_+/=-]{1,4096}$/.test(token)) throw new DouyinHttpLoginError('douyin-http-qr-invalid', undefined, undefined, undefined, { requestStage: 'qr' })
    const image = Buffer.from(raw, 'base64')
    if (image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || image.subarray(12, 16).toString('ascii') !== 'IHDR'
      || image.readUInt32BE(16) < 24 || image.readUInt32BE(16) > 1024 || image.readUInt32BE(20) < 24 || image.readUInt32BE(20) > 1024) throw new DouyinHttpLoginError('douyin-http-qr-invalid', undefined, undefined, undefined, { requestStage: 'qr' })
    this.token = token
    this.qr = { image: 'data:image/png;base64,' + raw, expiresAt: this.now() + QR_TTL }
    return { ...this.qr }
  }

  async poll(): Promise<DouyinHttpLoginStep> {
    this.check()
    if (!this.token || this.writing || this.now() < this.pollUntil) return { status: 'waiting' }
    const token = this.token, revision = this.revision
    const payload = await this.passport('/passport/web/check_qrconnect/', { need_logo: 'false', is_frontier: 'true', token,
      is_new_login: '1', next: WWW, need_short_url: 'true' }, { is_from_iesaccountsaas: '1' })
    this.check(revision)
    if (token !== this.token) return { status: 'waiting' }
    const data = record(payload.data)
    if (data.error_code === 7) { this.pollUntil = this.now() + 30000; return { status: 'waiting' } }
    if (this.verification(data)) return { status: 'verification-required', message: '请在抖音 App 完成登录验证后继续等待, 当前二维码会保留.' }
    this.error(data, 'poll')
    if (data.status === 'new' || data.status === '1') return { status: 'waiting' }
    if (data.status === 'scanned' || data.status === '2') return { status: 'scanned' }
    if (data.status === 'expired' || data.status === 'refused' || data.status === '4' || data.status === '5') return { status: 'expired' }
    if (data.status !== 'confirmed' && data.status !== '3') throw new DouyinHttpLoginError('douyin-http-qr-receipt-invalid', undefined, undefined, undefined, { requestStage: 'poll' })
    return this.finish(typeof data.redirect_url === 'string' ? data.redirect_url : undefined, data)
  }

  private phone(input: DouyinHttpPhone): string {
    if (!/^\+[1-9]\d{0,3}$/.test(input.countryCode) || !/^\d{5,16}$/.test(input.phone) || input.countryCode === '+86' && !/^1\d{10}$/.test(input.phone)) throw new DouyinHttpLoginError('douyin-http-login-input-invalid')
    return input.countryCode + ' ' + input.phone
  }
  private async manual(body: () => Record<string, string>, path: string, sms: boolean): Promise<DouyinHttpLoginStep> {
    this.check()
    if (!this.initialized || !this.token) throw new DouyinHttpLoginError('douyin-http-login-not-ready')
    if (this.writing) throw new DouyinHttpLoginError('douyin-http-login-busy')
    if (sms && this.smsUntil > this.now()) throw new DouyinHttpLoginError('douyin-http-sms-cooldown')
    this.writing = true
    try {
      const fields = body()
      if (path !== '/passport/web/user/login/' && !this.smsPrepared) {
        const signal = this.signal()
        try {
          this.msToken = await acquireDouyinPassportToken({ ...this.deps, proxy: this.proxy, userAgent: this.dtrait.userAgent }, signal, this.msToken)
          this.check()
          this.jar.setPublic('msToken', this.msToken)
          this.smsPrepared = true
        } catch (error) { throw this.failure(error, 'token', signal, error instanceof ProxyError || error instanceof StreamFailureError || error instanceof TypeError
          ? 'douyin-http-login-network-unavailable' : 'douyin-http-login-token-unavailable') }
      }
      // Reserve the official UI's SMS cooldown before dispatch; unknown outcomes must not invite repeats.
      if (sms) this.smsUntil = this.now() + 60000
      const payload = await this.passport(path, fields, { is_from_iesaccountsaas: '1' }), data = record(payload.data)
      if (this.verification(data)) return { status: 'verification-required', message: '抖音要求额外安全验证, 请在抖音 App 完成后手动继续.' }
      this.error(data, this.requestStage(new URL(LOGIN + path)))
      if (sms) { this.smsUntil = this.now() + 60000; return { status: 'sms-sent', cooldownSeconds: 60 } }
      return await this.finish(typeof data.redirect_url === 'string' ? data.redirect_url : undefined, data)
    } catch (error) {
      const known = this.failure(error, this.requestStage(new URL(LOGIN + path)))
      if (sms && this.smsUntil > this.now()) throw new DouyinHttpLoginError(known.code, known.platformCode, known.httpStatus, this.smsUntil,
        { requestStage: known.requestStage, networkCode: known.networkCode })
      throw known
    } finally { this.writing = false }
  }
  sendSms(input: DouyinHttpPhone): Promise<DouyinHttpLoginStep> {
    return this.manual(() => ({ is6Digits: '1', mix_mode: '1', mobile: encodeDouyinPassport(this.phone(input)), type: encodeDouyinPassport('24'), fixed_mix_mode: '1' }), '/passport/web/send_code/', true)
  }
  loginSms(input: DouyinHttpPhone & { code: string }): Promise<DouyinHttpLoginStep> {
    if (!/^\d{6}$/.test(input.code)) return Promise.reject(new DouyinHttpLoginError('douyin-http-login-input-invalid'))
    return this.manual(() => ({ mobile: encodeDouyinPassport(this.phone(input)), code: encodeDouyinPassport(input.code), mix_mode: '1',
      fixed_mix_mode: '1', service: WWW, safe_mobile_register_to_login: 'false', login_only: 'true' }), '/passport/web/sms_login/', false)
  }
  loginPassword(input: { username: string; password: string }): Promise<DouyinHttpLoginStep> {
    if (!input.password || input.password.length > 128 || /[\x00-\x1f\x7f]/.test(input.password)) return Promise.reject(new DouyinHttpLoginError('douyin-http-login-input-invalid'))
    return this.manual(() => ({ account: encodeDouyinPassport(this.phone({ countryCode: '+86', phone: input.username })), password: encodeDouyinPassport(input.password),
      mix_mode: '1', fixed_mix_mode: '1', service: WWW, account_type: '0', need_check_base_info: 'true', safe_mobile_register_to_login: 'false' }), '/passport/web/user/login/', false)
  }
  private verification(data: Record<string, unknown>): boolean { return data.error_code === 2046 || !!(data.verify_center_decision_conf || data.shark_decision_conf) }
  private error(data: Record<string, unknown>, requestStage?: DouyinHttpRequestStage): void {
    if (data.error_code !== 0) throw new DouyinHttpLoginError(data.error_code === undefined ? 'douyin-http-login-receipt-invalid' : 'douyin-http-login-rejected',
      typeof data.error_code === 'number' && Number.isSafeInteger(data.error_code) ? data.error_code : undefined, undefined, undefined, { requestStage })
  }

  private async payload(response: Response, requestStage: DouyinHttpRequestStage = 'identity'): Promise<Record<string, unknown>> {
    if (response.status < 200 || response.status >= 300) {
      cancelBody(response)
      throw new DouyinHttpLoginError('douyin-http-login-rejected', undefined, response.status, undefined, { requestStage })
    }
    const signal = this.signal()
    try {
      const payload = await readPayload(response, signal)
      this.check()
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new DouyinHttpLoginError('douyin-http-login-receipt-invalid', undefined, undefined, undefined, { requestStage })
      return payload as Record<string, unknown>
    } catch (error) {
      throw this.failure(error, requestStage, signal, error instanceof TypeError || error instanceof StreamFailureError || error instanceof ProxyError
        ? 'douyin-http-login-network-unavailable' : 'douyin-http-login-receipt-invalid')
    }
  }

  /** A pending server proof can protect identity lookup without inventing an account UID. */
  private async pageGuard(): Promise<string | null> {
    if (!this.serverProof || !this.privateKey) return null
    const proof = record(JSON.parse(this.serverProof))
    if (typeof proof.ticket !== 'string' || !proof.ticket || proof.ticket.length > 4096 || /[\x00-\x1f\x7f]/.test(proof.ticket)
      || typeof proof.ts_sign !== 'string' || !/^ts\.[12]/.test(proof.ts_sign) || proof.ts_sign.length > 8192
      || proof.client_cert !== 'pub.' + this.rawPublic || proof.aes_sign_safari !== undefined) throw new DouyinHttpLoginError('douyin-http-ticket-mismatch')
    const signal = this.signal(), peer = await this.resources.peerPublicKey(signal), timestamp = await this.resources.timestampSeconds(signal)
    this.check()
    const shared = diffieHellman({ privateKey: this.privateKey, publicKey: createPublicKey(peer) })
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32))
    try {
      const reqSign = createHmac('sha256', key).update(`ticket=${proof.ticket}&domain=live.douyin.com&timestamp=${timestamp}`).digest('base64')
      const value = { ts_sign: proof.ts_sign, web_version: proof.ts_sign.startsWith('ts.1') ? '1' : '2', ree_public_key: this.rawPublic,
        web_sign_type: '1', req_content: 'ticket,domain,timestamp', req_sign: reqSign, timestamp, t_trust: 1 }
      return 'bd-web-sign-page-guard=' + encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64'))
    } finally { shared.fill(0); key.fill(0) }
  }

  private snapshot(uid: string): DouyinSigningSnapshot | null {
    if (!this.serverProof || !this.privateKey) return null
    return { accountUid: uid, cookieFingerprint: douyinBrowserCookieFingerprint(this.jar.snapshot(), this.now() / 1000), origin: LIVE,
      userAgent: this.dtrait.userAgent, cryptData: JSON.stringify({ ec_privateKey: this.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), ec_publicKey: this.publicPem }),
      serverData: this.serverProof }
  }
  private async finish(redirect: string | undefined, data: Record<string, unknown>): Promise<DouyinHttpLoginStep> {
    try { return await this.finishIdentity(redirect, data) }
    catch (error) { throw this.failure(error, 'identity') }
  }
  private async finishIdentity(redirect: string | undefined, data: Record<string, unknown>): Promise<DouyinHttpLoginStep> {
    const destination = (raw: string, base: string | URL): URL => {
      try { return this.url(new URL(raw, base).href) }
      catch (error) { throw this.failure(error, 'redirect', undefined, 'douyin-http-login-destination-invalid') }
    }
    let url = redirect ? destination(redirect, LOGIN) : null
    for (let hops = 0; url; hops++) {
      if (hops >= 5) throw new DouyinHttpLoginError('douyin-http-login-redirect-limit', undefined, undefined, undefined, { requestStage: 'redirect' })
      const response = await this.request(url.href, 'GET')
      const location = response.headers.get('location')
      cancelBody(response)
      if (![301, 302, 303, 307, 308].includes(response.status)) { if (!response.ok) throw new DouyinHttpLoginError('douyin-http-login-rejected', undefined, response.status, undefined, { requestStage: 'redirect' }); break }
      if (!location) throw new DouyinHttpLoginError('douyin-http-login-destination-invalid', undefined, undefined, undefined, { requestStage: 'redirect' })
      url = destination(location, url)
    }
    this.check()
    if (!hasAuthenticationCookies(this.jar.snapshot(), 'douyin', this.now() / 1000)) throw new DouyinHttpLoginError('douyin-http-login-identity-unavailable')
    let uid = [data.user_id, data.user_id_str, data.uid, record(data.user_info).user_id, record(data.user_info).id_str].find(numericId)
    if (!uid) {
      const response = await this.request(WWW + '/passport/account/info/v2/?aid=6383&account_sdk_source=web', 'GET')
      const root = await this.payload(response), info = record(root.data)
      uid = [info.user_id, info.user_id_str, info.uid, info.id_str, record(info.user_info).user_id].find(numericId)
    }
    const headers: Record<string, string> = {}
    const pageGuard = await this.pageGuard()
    if (pageGuard) {
      headers.Cookie = this.jar.header(DOUYIN_LOGIN_IDENTITY_URL).split(';').map(value => value.trim()).filter(value => value && !value.startsWith('bd-web-sign-page-guard=')).join('; ')
        + '; ' + pageGuard
    }
    const response = await this.request(DOUYIN_LOGIN_IDENTITY_URL, 'GET', undefined, headers)
    const identityPayload = await this.payload(response), identity = parseDouyinLoginIdentity(identityPayload)
    this.check()
    if (identity.status !== 'authenticated' || !identity.uid || uid && identity.uid !== uid) throw new DouyinHttpLoginError('douyin-http-login-identity-unavailable',
      typeof identityPayload.status_code === 'number' && Number.isSafeInteger(identityPayload.status_code) ? identityPayload.status_code : undefined,
      undefined, undefined, { requestStage: 'identity' })
    const snapshot = this.snapshot(identity.uid)
    if (snapshot) parseDouyinSigningSnapshot(snapshot, this.now())
    return { status: 'authenticated', uid: identity.uid, cookies: this.jar.snapshot(), snapshot }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.revision++; this.lifetime.abort(); this.resources.dispose(); this.dtrait.dispose()
    this.jar.clear(); this.privateKey = null; this.token = ''; this.msToken = ''; this.serverProof = null; this.qr = null; this.smsPrepared = false
  }
}
