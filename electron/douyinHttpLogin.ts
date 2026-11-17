import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import { hasAuthenticationCookies, type BrowserCookie } from './cookies'
import { LoginError } from './login'
import type { EmbeddedLoginRequest, EmbeddedLoginState, EmbeddedLoginViewport } from './embeddedLoginContracts'
import type { LoginCardAction, LoginCardResult, LoginCardState } from './loginCardContracts'
import { LocalLoginCard, type LoginCardViewOptions } from './loginCardView'
import { isAppDocument } from './security'
import type { DouyinHttpLoginSession, DouyinHttpLoginStep, DouyinHttpQr } from '../server/douyin/httpLoginContracts'
import { douyinHttpLoginFailureDetails, douyinHttpLoginFailureMessage } from '../server/douyin/httpLoginFailure'

export interface DouyinHttpLoginOptions {
  owner: () => BrowserWindow | null
  cardPreload: string
  createSession: (signal: AbortSignal) => DouyinHttpLoginSession
  createCard?: (options: LoginCardViewOptions) => LocalLoginCard
  pollMs?: number
  timeoutMs?: number
  now?: () => number
}

interface Attempt {
  id: string
  request: EmbeddedLoginRequest
  owner: BrowserWindow
  card: LocalLoginCard
  cardValue: LoginCardState
  state: EmbeddedLoginState
  viewport: EmbeddedLoginViewport | null
  session: DouyinHttpLoginSession | null
  abort: AbortController
  revision: number
  queue: Promise<void>
  ready: boolean
  qrExpiresAt: number
  qrNeedsRefresh: boolean
  busy: boolean
  polling: boolean
  closing: boolean
  cancelled: boolean
  verificationRequired: boolean
  phonePrepared: boolean
  cooldownUntil: number
  pollTimer: ReturnType<typeof setTimeout> | null
  cooldownTimer: ReturnType<typeof setTimeout> | null
  timeout: ReturnType<typeof setTimeout> | null
  removeListeners: Array<() => void>
  resolve: (cookies: BrowserCookie[]) => void
  reject: (error: LoginError) => void
}

const APP_VERIFICATION = '抖音要求额外验证, 请在抖音App完成验证后继续等待.'
const FAILED = douyinHttpLoginFailureMessage(undefined)
const safeHttpDetail = douyinHttpLoginFailureDetails

/** Only a network-isolated local card exists; the session owns all HTTP authentication work. */
export class DouyinHttpLoginController {
  private active: Attempt | null = null
  private disposed = false
  private readonly listeners = new Set<(state: EmbeddedLoginState | null) => void>()
  private readonly cleanups = new Set<Promise<void>>()

  constructor(private readonly options: DouyinHttpLoginOptions) {}
  private now(): number { return (this.options.now ?? Date.now)() }
  state(): EmbeddedLoginState | null { return this.active ? structuredClone(this.active.state) : null }
  subscribe(listener: (state: EmbeddedLoginState | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private current(a: Attempt, revision = a.revision): boolean {
    return !this.disposed && this.active === a && !a.closing && a.revision === revision && !a.abort.signal.aborted
      && !a.request.signal.aborted && !a.owner.isDestroyed() && !a.owner.webContents.isDestroyed()
      && isAppDocument(a.owner.webContents.mainFrame.url)
  }
  private publish(a: Attempt, card: Partial<LoginCardState> = {}, state: Partial<EmbeddedLoginState> = {}): void {
    if (!this.current(a)) return
    a.cardValue = { ...a.cardValue, ...card }
    a.state = { ...a.state, ...state }
    a.card.publish(structuredClone(a.cardValue))
    this.applyViewport(a)
    this.emit()
  }
  private emit(): void {
    for (const listener of this.listeners) { try { listener(this.state()) } catch { /* A subscriber cannot interrupt cleanup. */ } }
  }

  login(request: EmbeddedLoginRequest): Promise<BrowserCookie[]> {
    if (this.disposed || request.signal.aborted) return Promise.reject(new LoginError('login-cancelled'))
    if (request.platform !== 'douyin' || request.destination !== undefined) return Promise.reject(new LoginError('login-failed'))
    if (this.active) return Promise.reject(new LoginError('login-busy'))
    const owner = this.options.owner()
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed() || !isAppDocument(owner.webContents.mainFrame.url)) {
      return Promise.reject(new LoginError('login-failed'))
    }
    const id = randomUUID()
    let resolve!: Attempt['resolve'], reject!: Attempt['reject']
    const result = new Promise<BrowserCookie[]>((yes, no) => { resolve = yes; reject = no })
    let card: LocalLoginCard
    try {
      card = (this.options.createCard ?? (options => new LocalLoginCard(options)))({ id, owner, preload: this.options.cardPreload,
        escape: () => { void this.cancel(id) } })
    } catch { return Promise.reject(new LoginError('login-failed', 'douyin')) }
    const a: Attempt = {
      id, request, owner, card,
      cardValue: { platform: 'douyin', transport: 'http', stage: 'loading', mode: 'password', qr: { status: 'loading' },
        sms: { canSend: false, cooldownSeconds: null }, busy: false } as LoginCardState,
      state: { id, platform: 'douyin', purpose: 'login', phase: 'loading', presentation: 'form', accountLabel: request.accountLabel },
      viewport: null, session: null, abort: new AbortController(), revision: 0, queue: Promise.resolve(),
      ready: false, qrExpiresAt: 0, qrNeedsRefresh: false, busy: false, polling: false, closing: false, cancelled: false, verificationRequired: false, phonePrepared: false,
      cooldownUntil: 0, pollTimer: null, cooldownTimer: null, timeout: null, removeListeners: [], resolve, reject,
    }
    this.active = a
    const cancel = () => { a.cancelled = true; void this.finish(a, new LoginError('login-cancelled')) }
    request.signal.addEventListener('abort', cancel, { once: true })
    owner.webContents.once('destroyed', cancel)
    owner.webContents.on('will-navigate', cancel)
    owner.webContents.on('did-navigate-in-page', cancel)
    owner.once('closed', cancel)
    a.removeListeners.push(() => {
      request.signal.removeEventListener('abort', cancel)
      owner.webContents.removeListener('destroyed', cancel)
      owner.webContents.removeListener('will-navigate', cancel)
      owner.webContents.removeListener('did-navigate-in-page', cancel)
      owner.removeListener('closed', cancel)
    })
    a.timeout = setTimeout(cancel, this.options.timeoutMs ?? 300_000)
    this.publish(a)
    // Start the local document immediately; it can show loading before HTTP initialization completes.
    void this.open(a)
    return result
  }

  private async open(a: Attempt): Promise<void> {
    try {
      await a.card.open()
      if (!this.current(a)) return
      const destroyed = () => { if (!a.closing) void this.cancel(a.id) }
      a.card.contents?.once('destroyed', destroyed)
      a.removeListeners.push(() => a.card.contents?.removeListener('destroyed', destroyed))
      this.publish(a)
      await this.restart(a)
    } catch { if (this.current(a)) await this.finish(a, new LoginError('login-failed', 'douyin')) }
  }

  private async restart(a: Attempt): Promise<void> {
    if (!this.current(a)) return
    a.revision++
    a.abort.abort()
    try { a.session?.dispose() } catch { /* A failed session must not survive retry. */ }
    a.session = null
    a.abort = new AbortController()
    a.queue = Promise.resolve()
    a.ready = false
    a.qrExpiresAt = 0
    a.qrNeedsRefresh = false
    a.busy = true
    a.polling = false
    a.verificationRequired = false
    a.phonePrepared = false
    this.clearPoll(a)
    if (a.cooldownTimer) clearTimeout(a.cooldownTimer)
    a.cooldownTimer = null
    const revision = a.revision
    this.publish(a, { stage: 'loading', busy: false, qr: { status: 'loading' }, sms: { canSend: false, cooldownSeconds: null }, message: undefined, errorDetail: undefined },
      { phase: 'loading', message: undefined, errorDetail: undefined, presentation: 'form' })
    try {
      a.session = this.options.createSession(a.abort.signal)
      const qr = await this.enqueue(a, revision, session => session.initialize())
      if (!this.current(a, revision) || !qr) return
      this.showQr(a, qr)
    } catch (error) { if (this.current(a, revision)) this.fail(a, undefined, error) }
    finally { if (this.current(a, revision)) { a.busy = false; this.schedulePoll(a) } }
  }

  /** Each session has a serial queue; refreshing invalidates results before waiting for an old poll. */
  private enqueue<T>(a: Attempt, revision: number, work: (session: DouyinHttpLoginSession) => Promise<T>): Promise<T | undefined> {
    const session = a.session
    const result = a.queue.then(() => this.current(a, revision) && session && a.session === session ? work(session) : undefined)
    a.queue = result.then(() => {}, () => {})
    return result
  }
  private showQr(a: Attempt, qr: DouyinHttpQr, partial = false): void {
    if (!Number.isFinite(qr.expiresAt) || qr.expiresAt <= this.now() || typeof qr.image !== 'string'
      || qr.image.length >= 2_097_152 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(qr.image)) {
      throw new Error('Invalid QR response')
    }
    a.ready = true
    a.qrExpiresAt = qr.expiresAt
    a.qrNeedsRefresh = false
    a.verificationRequired = false
    if (partial) {
      const clearVerification = a.cardValue.message === APP_VERIFICATION
      this.publish(a, { qr: { status: 'ready', image: qr.image }, ...(clearVerification ? { message: undefined, errorDetail: undefined } : {}) },
        clearVerification ? { phase: 'ready', message: undefined, errorDetail: undefined } : {})
      return
    }
    this.publish(a, { stage: 'form', busy: false, qr: { status: 'ready', image: qr.image }, message: undefined, errorDetail: undefined },
      { phase: 'ready', presentation: 'form', message: undefined, errorDetail: undefined })
    this.updateCooldown(a)
  }
  private clearPoll(a: Attempt): void {
    if (a.pollTimer) clearTimeout(a.pollTimer)
    a.pollTimer = null
  }
  private schedulePoll(a: Attempt): void {
    this.clearPoll(a)
    if (!this.current(a) || !a.ready && !a.qrNeedsRefresh || a.busy || a.polling || a.cardValue.stage === 'failed') return
    a.pollTimer = setTimeout(() => { a.pollTimer = null; void this.poll(a) }, this.options.pollMs ?? 5200)
  }
  private async poll(a: Attempt): Promise<void> {
    if (!this.current(a) || a.busy || a.polling || !a.ready && !a.qrNeedsRefresh) return
    a.polling = true
    const revision = a.revision
    try {
      if (a.qrNeedsRefresh) { await this.refresh(a, true); return }
      const step = await this.enqueue(a, revision, session => session.poll())
      if (step && this.current(a, revision)) {
        // Check once before replacing a locally expired QR; scanned tokens stay on their confirmation flow.
        if (step.status === 'waiting' && this.now() >= a.qrExpiresAt && !a.verificationRequired && a.cardValue.qr.status !== 'scanned') await this.refresh(a, true)
        else await this.applyStep(a, step, revision)
      }
    } catch (error) {
      // A failed read is not an identity or a reason to regenerate a live QR token.
      if (this.current(a, revision)) {
        const detail = safeHttpDetail(error)
        if (a.cardValue.stage === 'checking' || !['douyin-http-login-network-unavailable', 'douyin-http-login-timeout'].includes(detail.code)) {
          this.fail(a, undefined, error)
        } else {
          const message = (a.verificationRequired ? APP_VERIFICATION + ' ' : '') + douyinHttpLoginFailureMessage(detail)
          this.publish(a, { message, errorDetail: detail }, { message, errorDetail: detail })
        }
      }
    } finally {
      if (this.current(a, revision)) a.polling = false
      this.schedulePoll(a)
    }
  }

  private async applyStep(a: Attempt, step: DouyinHttpLoginStep, revision: number): Promise<void> {
    if (!this.current(a, revision)) return
    if (step.status === 'authenticated') {
      if (!/^[1-9][0-9]{0,31}$/.test(step.uid) || !hasAuthenticationCookies(step.cookies, 'douyin', this.now() / 1000)) {
        this.fail(a, '未取得经验证且可用的抖音登录凭据, 请重试.')
        return
      }
      this.clearPoll(a)
      a.busy = true
      this.publish(a, { stage: 'checking', busy: true, message: '正在确认登录凭据.' }, { phase: 'verifying' })
      // Capture is main-owned and must complete before the cookie result leaves this controller.
      if (step.snapshot && a.request.captureDouyinSigning) await a.request.captureDouyinSigning(step.snapshot)
      if (this.current(a, revision)) await this.finish(a, structuredClone(step.cookies))
      return
    }
    if (step.status === 'sms-sent') {
      const seconds = Number.isFinite(step.cooldownSeconds) ? Math.min(3600, Math.max(0, Math.ceil(step.cooldownSeconds))) : 60
      a.cooldownUntil = this.now() + seconds * 1000
      this.updateCooldown(a)
      this.publish(a, { stage: 'form', busy: false, message: '验证码已发送, 请填写收到的短信验证码.' }, { phase: 'ready', message: undefined })
      return
    }
    if (step.status === 'verification-required') {
      a.verificationRequired = true
      this.publish(a, { stage: 'form', busy: false, qr: { ...a.cardValue.qr, status: 'scanned' }, message: APP_VERIFICATION },
        { phase: 'challenge', presentation: 'form', message: APP_VERIFICATION })
      return
    }
    if (step.status === 'expired') {
      await this.refresh(a, true)
      return
    }
    if (step.status === 'scanned') {
      this.publish(a, { stage: 'form', busy: false, qr: { ...a.cardValue.qr, status: 'scanned' },
        message: a.verificationRequired ? APP_VERIFICATION : '已扫码, 请在抖音App确认登录.' }, { phase: a.verificationRequired ? 'challenge' : 'ready' })
    } else if (step.status === 'waiting') {
      this.publish(a, { stage: 'form', busy: false, message: a.verificationRequired ? APP_VERIFICATION : undefined, errorDetail: undefined },
        { phase: a.verificationRequired ? 'challenge' : 'ready', errorDetail: undefined })
    } else {
      this.fail(a, '未能确认抖音登录状态, 请重试.')
    }
  }
  private fail(a: Attempt, message?: string, error?: unknown): void {
    a.busy = false
    this.clearPoll(a)
    const errorDetail = safeHttpDetail(error)
    message ??= douyinHttpLoginFailureMessage(errorDetail)
    this.publish(a, { stage: 'failed', busy: false, message, errorDetail, sms: { canSend: false, cooldownSeconds: null } }, { phase: 'failed', message, errorDetail })
  }
  private updateCooldown(a: Attempt): void {
    if (!this.current(a)) return
    if (a.cooldownTimer) clearTimeout(a.cooldownTimer)
    const seconds = Math.max(0, Math.ceil((a.cooldownUntil - this.now()) / 1000))
    this.publish(a, { sms: { canSend: a.phonePrepared && seconds === 0 && a.cardValue.stage !== 'failed', cooldownSeconds: seconds || null } })
    a.cooldownTimer = seconds > 0 ? setTimeout(() => this.updateCooldown(a), 1000) : null
  }

  ownsCard(sender: WebContents, frame: WebFrameMain | null): boolean {
    const a = this.active
    if (!a || !this.current(a) || sender.isDestroyed()) return false
    try { return sender === a.card.contents && frame === sender.mainFrame && frame?.url === a.card.url }
    catch { return false }
  }
  cardState(): LoginCardState | null { return this.active ? structuredClone(this.active.cardValue) : null }

  async cardAction(action: LoginCardAction): Promise<LoginCardResult> {
    try {
      const a = this.active
      if (!a || !this.current(a)) return { ok: false, message: '登录页面已失效.' }
      if (action.kind === 'cancel') { await this.cancel(a.id); return { ok: true } }
      if (action.kind === 'back') { await this.back(a.id); return { ok: true } }
      const qrOnlyBusy = a.busy && a.cardValue.stage === 'form' && a.cardValue.qr.status === 'loading'
      if (a.busy && !(qrOnlyBusy && ['mode', 'prepare-sms'].includes(action.kind)) || ['loading', 'checking', 'submitting'].includes(a.cardValue.stage)) return { ok: false, message: '请先完成当前登录步骤.' }
      if (action.kind === 'mode') {
        if (!['password', 'sms'].includes(action.mode)) return { ok: false }
        this.publish(a, { mode: action.mode })
        return { ok: true }
      }
      if (action.kind === 'prepare-sms') {
        a.phonePrepared = action.accepted === true && validPhone(action.phone, action.countryCode)
        this.updateCooldown(a)
        return { ok: a.phonePrepared, ...(a.phonePrepared ? {} : { message: '请填写有效的手机号和国家区号.' }) }
      }
      if (action.kind === 'refresh-qr') return await this.refresh(a)
      if (action.kind !== 'password' && action.kind !== 'send-sms' && action.kind !== 'sms') {
        return { ok: false, message: '请在抖音App完成验证, 或手动刷新二维码.' }
      }
      if (action.accepted !== true) return { ok: false, message: '请先阅读并同意平台协议.' }
      if (action.kind === 'password' ? !action.username.trim() || action.username.length > 254 || !action.password || action.password.length > 128
        : !validPhone(action.phone, action.countryCode) || action.kind === 'sms' && !/^[0-9]{6}$/.test(action.code.trim())) {
        return { ok: false, message: '请填写有效的登录信息.' }
      }
      if (action.kind === 'send-sms' && (!a.cardValue.sms.canSend || a.cooldownUntil > this.now())) {
        return { ok: false, message: '请等待允许发送验证码.' }
      }
      a.busy = true
      this.clearPoll(a)
      // Supersede a pending read before placing the explicit action behind it.
      const revision = ++a.revision
      a.polling = false
      this.publish(a, { stage: 'submitting', busy: true, message: undefined }, { phase: 'verifying', message: undefined })
      try {
        const step = await this.enqueue(a, revision, session => action.kind === 'password'
          ? session.loginPassword({ username: action.username.trim(), password: action.password })
          : action.kind === 'send-sms' ? session.sendSms({ phone: action.phone.trim(), countryCode: action.countryCode.trim() })
            : session.loginSms({ phone: action.phone.trim(), countryCode: action.countryCode.trim(), code: action.code.trim() }))
        if (!step || !this.current(a, revision)) return { ok: false, message: '登录操作已取消.' }
        await this.applyStep(a, step, revision)
        return { ok: a.cardValue.stage !== 'failed' }
      } catch (error) {
        const detail = safeHttpDetail(error), message = douyinHttpLoginFailureMessage(detail)
        if (this.current(a, revision)) {
          if (a.cardValue.stage === 'checking') this.fail(a, undefined, error)
          else {
            this.publish(a, { stage: 'form', busy: false, message, errorDetail: detail }, { phase: 'ready', message, errorDetail: detail })
            const next = (error as { nextAllowedAt?: unknown })?.nextAllowedAt
            if (action.kind === 'send-sms' && typeof next === 'number' && Number.isFinite(next) && next > this.now()) {
              a.cooldownUntil = next
              this.updateCooldown(a)
            }
          }
        }
        return { ok: false, message, detail }
      } finally {
        if (this.current(a, revision)) { a.busy = false; this.schedulePoll(a) }
      }
    } finally { clearAction(action) }
  }

  private async refresh(a: Attempt, automatic = false): Promise<LoginCardResult> {
    if (a.cardValue.stage === 'failed') {
      await this.restart(a)
      if (!this.current(a)) return { ok: false, message: '登录操作已取消.' }
      return a.ready ? { ok: true } : { ok: false, message: a.cardValue.message ?? FAILED, detail: a.cardValue.errorDetail }
    }
    a.busy = true
    a.polling = false
    a.ready = false
    a.qrNeedsRefresh = false
    this.clearPoll(a)
    const revision = ++a.revision
    if (automatic) this.publish(a, { qr: { status: 'loading' } })
    else this.publish(a, { stage: 'loading', busy: false, qr: { status: 'loading' }, message: undefined, errorDetail: undefined }, { phase: 'loading', message: undefined, errorDetail: undefined })
    try {
      const qr = await this.enqueue(a, revision, session => session.refreshQr())
      if (!qr || !this.current(a, revision)) return { ok: false, message: '登录操作已取消.' }
      this.showQr(a, qr, automatic)
      return { ok: true }
    } catch (error) {
      const detail = safeHttpDetail(error)
      if (this.current(a, revision)) {
        if (automatic) {
          a.qrNeedsRefresh = ['douyin-http-login-network-unavailable', 'douyin-http-login-timeout'].includes(detail.code)
          this.publish(a, { qr: { status: 'unavailable' } })
        } else this.fail(a, undefined, error)
      }
      return { ok: false, message: douyinHttpLoginFailureMessage(detail), detail }
    } finally { if (this.current(a, revision)) { a.busy = false; this.schedulePoll(a) } }
  }
  async back(id: string): Promise<void> {
    const a = this.active
    if (!a || a.id !== id || !this.current(a) || a.busy) return
    this.publish(a, { stage: 'form', busy: false, message: a.verificationRequired ? APP_VERIFICATION : undefined },
      { phase: a.verificationRequired ? 'challenge' : 'ready', presentation: 'form', message: undefined })
  }
  async retry(id: string): Promise<void> {
    const a = this.active
    if (a && a.id === id && this.current(a) && !a.busy) await this.restart(a)
  }
  async cancel(id: string): Promise<void> {
    const a = this.active
    if (a?.id === id) await this.finish(a, new LoginError('login-cancelled'))
  }
  setViewport(viewport: EmbeddedLoginViewport): void {
    const a = this.active
    if (!a || a.id !== viewport.id || !this.current(a)) return
    if (![viewport.rect.x, viewport.rect.y, viewport.rect.width, viewport.rect.height].every(Number.isFinite)) { a.card.hide(); return }
    a.viewport = { ...viewport, rect: { ...viewport.rect } }
    this.applyViewport(a)
  }
  private applyViewport(a: Attempt): void {
    if (a.owner.isDestroyed()) return
    if (!a.viewport) { a.card.hide(); return }
    const rawZoom = a.owner.webContents.getZoomFactor()
    const zoom = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1
    const [width = 0, height = 0] = a.owner.getContentSize()
    const { rect, visible } = a.viewport
    const x = Math.max(0, Math.min(width, Math.round(rect.x * zoom)))
    const y = Math.max(0, Math.min(height, Math.round(rect.y * zoom)))
    const right = Math.max(x, Math.min(width, Math.round((rect.x + Math.max(0, rect.width)) * zoom)))
    const bottom = Math.max(y, Math.min(height, Math.round((rect.y + Math.max(0, rect.height)) * zoom)))
    a.card.setBounds({ x, y, width: right - x, height: bottom - y }, visible && right > x && bottom > y)
  }
  private async finish(a: Attempt, result: BrowserCookie[] | LoginError): Promise<void> {
    if (result instanceof LoginError) a.cancelled = true
    if (a.closing) return
    a.closing = true
    a.revision++
    a.abort.abort()
    this.clearPoll(a)
    if (a.cooldownTimer) clearTimeout(a.cooldownTimer)
    if (a.timeout) clearTimeout(a.timeout)
    try { a.session?.dispose() } catch { /* The local credential view must still close. */ }
    a.session = null
    try { a.card.hide() } catch { /* Card destruction cannot skip cancellation or promise settlement. */ }
    if (this.active === a) { this.active = null; this.emit() }
    const cleanup = Promise.resolve().then(() => a.card.close()).catch(() => {})
    this.cleanups.add(cleanup)
    try { await cleanup } finally {
      this.cleanups.delete(cleanup)
      for (const remove of a.removeListeners) { try { remove() } catch { /* Release every owner listener. */ } }
    }
    if (result instanceof LoginError || a.cancelled || a.request.signal.aborted || this.disposed || a.owner.isDestroyed() || a.owner.webContents.isDestroyed()
      || !isAppDocument(a.owner.webContents.mainFrame.url)) a.reject(result instanceof LoginError ? result : new LoginError('login-cancelled'))
    else a.resolve(result)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.active) await this.finish(this.active, new LoginError('login-cancelled'))
    await Promise.allSettled(this.cleanups)
    this.listeners.clear()
  }
}

function validPhone(phone: string, countryCode: string): boolean {
  return /^[0-9]{5,20}$/.test(phone.trim()) && /^\+?[1-9][0-9]{0,4}$/.test(countryCode.trim())
}
function clearAction(action: LoginCardAction): void {
  if ('password' in action) action.password = ''
  if ('username' in action) action.username = ''
  if ('phone' in action) action.phone = ''
  if ('countryCode' in action) action.countryCode = ''
  if ('code' in action) action.code = ''
}
