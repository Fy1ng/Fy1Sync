import { createHash, randomUUID } from 'node:crypto'
import { nativeImage, session, View, WebContentsView, type BrowserWindow, type Session, type WebContents, type WebFrameMain } from 'electron'
import { authenticationCookieUserId, cookieDomainAllowed, hasAuthenticationCookies, type BrowserCookie } from './cookies'
import { LoginError } from './login'
import type { EmbeddedLoginDriver, EmbeddedLoginRequest, EmbeddedLoginState, EmbeddedLoginViewport } from './embeddedLoginContracts'
import { loginRequestAllowed } from './embeddedLoginPolicy'
import { LOGIN_ADAPTERS } from './loginAdapters'
import { LoginPageBroker } from './loginPageBroker'
import { LocalLoginCard, type LoginCardViewOptions } from './loginCardView'
import type { LoginCardAction, LoginCardResult, LoginCardState, LoginChallengeRegion, LoginPageSnapshot, LoginSmsState } from './loginCardContracts'
import { loginIdentityUrl, parseLoginIdentity } from './loginIdentity'
import { isAppDocument } from './security'
import { LOGIN_MEDIA_GUARD } from './loginMediaGuard'

interface Attempt {
  id: string
  request: EmbeddedLoginRequest
  owner: BrowserWindow
  session: Session
  view: WebContentsView | null
  card: LocalLoginCard | null
  cardValue: LoginCardState
  broker: LoginPageBroker | null
  showingOfficial: boolean
  explicitOfficial: boolean
  returnedToForm: boolean
  challenge: LoginChallengeRegion | null
  challengeHost: View | null
  brokerSize: { width: number; height: number }
  pendingAction: 'login' | 'verification' | 'sms' | null
  verificationCompleted: boolean
  nativeVerification: boolean
  captchaPreflight: 'waiting' | 'pending' | 'ready' | 'failed'
  captchaPreRequest: { id: number; revision: number } | null
  lastError: string | undefined
  qrPaused: boolean
  lastQrSource: string | null
  inspecting: boolean
  actionBusy: boolean
  submittedAt: number
  actionRevision: number
  lastPage: LoginPageSnapshot['page']
  pageRevision: number
  state: EmbeddedLoginState
  viewport: EmbeddedLoginViewport | null
  resolve: (cookies: BrowserCookie[]) => void
  reject: (error: LoginError) => void
  abort: AbortController
  removeListeners: Array<() => void>
  timeout: ReturnType<typeof setTimeout> | null
  pageTimeout: ReturnType<typeof setTimeout> | null
  poll: ReturnType<typeof setInterval> | null
  renderPulse: ReturnType<typeof setInterval> | null
  rendering: boolean
  cookieTimer: ReturnType<typeof setTimeout> | null
  checking: boolean
  closing: boolean
  cookieRevision: number
  loadRevision: number
  nextCheck: number
  initialized: boolean
  preparing: Promise<void> | null
}

export interface EmbeddedLoginOptions {
  owner: () => BrowserWindow | null
  domesticRouting: () => 'direct' | 'system'
  createSession?: (partition: string) => Session
  createView?: (options: Electron.WebContentsViewConstructorOptions) => WebContentsView
  cardPreload: string
  createCard?: (options: LoginCardViewOptions) => LocalLoginCard
  timeoutMs?: number
  pollMs?: number
  checkTimeoutMs?: number
  /** The offline harness intercepts official origins before any page is loaded. */
  fixture?: (request: EmbeddedLoginRequest, target: Session) => Promise<void>
}

/** One local credential card and one isolated official broker share the same visual slot. */
export class EmbeddedLoginController implements EmbeddedLoginDriver {
  private active: Attempt | null = null
  private readonly listeners = new Set<(state: EmbeddedLoginState | null) => void>()
  private readonly cleanups = new Set<Promise<void>>()
  private disposed = false

  constructor(private readonly options: EmbeddedLoginOptions) {}

  state(): EmbeddedLoginState | null { return this.active ? { ...this.active.state } : null }
  subscribe(listener: (state: EmbeddedLoginState | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(): void {
    for (const listener of this.listeners) { try { listener(this.state()) } catch { /* One view cannot interrupt cleanup. */ } }
  }
  private current(attempt: Attempt): boolean {
    return !this.disposed && this.active === attempt && !attempt.closing && !attempt.abort.signal.aborted
      && !attempt.owner.isDestroyed() && !attempt.owner.webContents.isDestroyed()
  }
  private update(attempt: Attempt, patch: Partial<EmbeddedLoginState>): void {
    if (!this.current(attempt)) return
    attempt.state = { ...attempt.state, ...patch }
    if (patch.phase === 'failed') this.clearPageTimeout(attempt)
    this.applyViewport(attempt)
    this.emit()
  }
  private clearPageTimeout(attempt: Attempt): void {
    if (attempt.pageTimeout) clearTimeout(attempt.pageTimeout)
    attempt.pageTimeout = null
  }
  private startPageTimeout(attempt: Attempt, message: string): void {
    this.clearPageTimeout(attempt)
    const revision = attempt.loadRevision
    attempt.pageTimeout = setTimeout(() => {
      if (!this.current(attempt) || revision !== attempt.loadRevision) return
      this.clearPageTimeout(attempt)
      // A visible shell or an unsettled SDK submission cannot disable recovery forever.
      // Invalidate inspections already awaiting a remote frame; retry starts a new load.
      attempt.actionRevision++
      attempt.actionBusy = false
      this.cardUpdate(attempt, { stage: 'failed', busy: false, qr: { status: 'paused' }, message })
      this.update(attempt, { phase: 'failed', message })
    }, 30_000)
  }

  login(request: EmbeddedLoginRequest): Promise<BrowserCookie[]> {
    if (this.disposed || request.signal.aborted) return Promise.reject(new LoginError('login-cancelled'))
    if (!Object.hasOwn(LOGIN_ADAPTERS, request.platform) || request.platform === 'douyin' && request.destination !== undefined) return Promise.reject(new LoginError('login-failed'))
    if (this.active) return Promise.reject(new LoginError('login-busy'))
    const owner = this.options.owner()
    if (!owner || owner.isDestroyed() || !isAppDocument(owner.webContents.mainFrame.url)) return Promise.reject(new LoginError('login-failed'))
    const id = randomUUID()
    const browserSession = (this.options.createSession ?? (partition => session.fromPartition(partition, { cache: false })))(`fy1sync-login-${id}`)
    let resolve!: Attempt['resolve'], reject!: Attempt['reject']
    const result = new Promise<BrowserCookie[]>((yes, no) => { resolve = yes; reject = no })
    const attempt: Attempt = {
      id, request, owner, session: browserSession, view: null, card: null, broker: null,
      cardValue: { platform: request.platform, stage: 'loading', mode: 'password', qr: { status: 'loading' }, sms: unavailableSms(), busy: false },
      showingOfficial: Boolean(request.destination), explicitOfficial: false, qrPaused: false, lastQrSource: null,
      returnedToForm: false, challenge: null, challengeHost: null, brokerSize: request.platform === 'douyin' ? { width: 1280, height: 900 } : { width: 760, height: 520 }, pendingAction: null, verificationCompleted: false, nativeVerification: false,
      captchaPreflight: 'waiting', captchaPreRequest: null, lastError: undefined,
      inspecting: false, actionBusy: false, submittedAt: 0, actionRevision: 0, lastPage: 'loading', pageRevision: 0,
      viewport: null, resolve, reject, abort: new AbortController(),
      state: { id, platform: request.platform, purpose: request.destination ? 'website' : 'login', phase: 'loading',
        ...(request.accountLabel ? { accountLabel: request.accountLabel.slice(0, 80) } : {}) },
      removeListeners: [], timeout: null, pageTimeout: null, poll: null, renderPulse: null, rendering: false, cookieTimer: null, checking: false, closing: false,
      cookieRevision: 0, loadRevision: 0, nextCheck: 0, initialized: false, preparing: null,
    }
    this.active = attempt
    const cancel = () => { void this.finish(attempt, new LoginError('login-cancelled')) }
    request.signal.addEventListener('abort', cancel, { once: true })
    attempt.removeListeners.push(() => request.signal.removeEventListener('abort', cancel))
    owner.webContents.once('destroyed', cancel)
    owner.webContents.on('will-navigate', cancel)
    owner.webContents.on('did-navigate-in-page', cancel)
    attempt.removeListeners.push(() => {
      owner.webContents.removeListener('destroyed', cancel)
      owner.webContents.removeListener('will-navigate', cancel)
      owner.webContents.removeListener('did-navigate-in-page', cancel)
    })
    attempt.timeout = setTimeout(() => { void this.finish(attempt, new LoginError('login-cancelled')) }, this.options.timeoutMs ?? 30 * 60_000)
    this.emit()
    void this.prepare(attempt).catch(() => this.update(attempt, { phase: 'failed', message: '登录页面未能加载, 请检查网络后重试.' }))
    return result
  }

  private async prepare(attempt: Attempt): Promise<void> {
    if (attempt.preparing) return attempt.preparing
    const work = this.initialize(attempt)
    attempt.preparing = work
    try { await work } finally { if (attempt.preparing === work) attempt.preparing = null }
  }

  private async initialize(attempt: Attempt): Promise<void> {
    const browserSession = attempt.session
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    const download = (event: Electron.Event) => event.preventDefault()
    browserSession.on('will-download', download)
    attempt.removeListeners.push(() => browserSession.removeListener('will-download', download))
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const cancel = !this.current(attempt) || !loginRequestAllowed(attempt.request.platform, details.url, details.resourceType)
        || attempt.qrPaused && isQrPolling(attempt.request.platform, details.url)
      if (!cancel && attempt.request.platform === 'bilibili' && isBilibiliCaptchaPreflight(details.url, details.method)
        && details.webContentsId === attempt.view?.webContents.id) {
        attempt.captchaPreflight = 'pending'
        attempt.captchaPreRequest = { id: details.id, revision: attempt.loadRevision }
        if (attempt.cardValue.verification) this.cardUpdate(attempt, { sms: unavailableSms() })
      }
      callback({ cancel })
    })
    if (attempt.request.platform === 'bilibili') {
      const completePreflight = (details: { id: number; statusCode?: number; webContentsId?: number }) => {
        const pending = attempt.captchaPreRequest
        if (!this.current(attempt) || !pending || pending.id !== details.id || pending.revision !== attempt.loadRevision
          || details.webContentsId !== attempt.view?.webContents.id) return
        attempt.captchaPreRequest = null
        attempt.captchaPreflight = details.statusCode === 200 ? 'ready' : 'failed'
      }
      browserSession.webRequest.onCompleted(completePreflight)
      browserSession.webRequest.onErrorOccurred(completePreflight)
      attempt.removeListeners.push(() => {
        browserSession.webRequest.onCompleted(null)
        browserSession.webRequest.onErrorOccurred(null)
      })
    }
    await browserSession.setProxy({ mode: this.options.domesticRouting() === 'direct' ? 'direct' : 'system' })
    if (!this.current(attempt)) return
    await this.options.fixture?.(attempt.request, browserSession)
    if (!this.current(attempt)) return
    if (attempt.request.initializeSession) {
      try { await attempt.request.initializeSession(browserSession) }
      catch {
        // An account without saved credentials can still sign in on its official page.
        await browserSession.clearStorageData()
        if (!this.current(attempt)) return
      }
      if (!this.current(attempt)) { await browserSession.clearStorageData(); return }
    }
    const view = (this.options.createView ?? (options => new WebContentsView(options)))({
      webPreferences: { session: browserSession, nodeIntegration: false, nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false, sandbox: true, contextIsolation: true, webSecurity: true,
        devTools: false, spellcheck: false, navigateOnDragDrop: false, backgroundThrottling: false },
    })
    attempt.view = view
    view.setBackgroundColor('#18181b')
    view.setBorderRadius(8)
    view.setVisible(false)
    attempt.owner.contentView.addChildView(view)
    const contents = view.webContents
    if (attempt.request.platform === 'douyin') {
      const userAgent = contents.getUserAgent().replace(/\b(?:Electron|Fy1Sync|stream-syncer)\/[^\s]+\s*/gi, '')
        .replace(/\bHeadlessChrome\//g, 'Chrome/').trim()
      contents.setUserAgent(userAgent)
      browserSession.setUserAgent(userAgent)
    }
    contents.setAudioMuted(true)
    // Materialize the renderer on an inert document before awaiting its Page domain.
    // A newly allocated WebContentsView has no frame to answer Page.enable yet.
    await contents.loadURL('about:blank')
    if (!this.current(attempt)) return
    const debug = contents.debugger
    if (!debug.isAttached()) debug.attach('1.3')
    await debug.sendCommand('Page.enable')
    // Hidden native views may keep their renderer viewport at 0x0 until first shown.
    // Explicit layout metrics let official controls and transient challenges render offscreen.
    await debug.sendCommand('Emulation.setDeviceMetricsOverride', { ...attempt.brokerSize, deviceScaleFactor: 0, mobile: false })
    await debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: LOGIN_MEDIA_GUARD })
    if (!this.current(attempt)) return
    contents.setIgnoreMenuShortcuts(true)
    contents.setWindowOpenHandler(details => {
      if (loginRequestAllowed(attempt.request.platform, details.url, 'mainFrame')) {
        if (attempt.explicitOfficial || attempt.request.destination) this.showOfficial(attempt, '请在官方页面完成安全验证')
        void contents.loadURL(details.url).catch(() => this.cardUpdate(attempt, { message: '验证页面未能打开, 请重试.' }))
      } else this.update(attempt, { message: '验证页面无法在当前登录会话内打开, 请使用其他登录方式.' })
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-prevent-unload', event => event.preventDefault())
    contents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase()
      if (key === 'escape') { event.preventDefault(); void this.cancel(attempt.id); return }
      if (['f5', 'f12'].includes(key) || (input.control || input.meta) && ['r', 'o', 'p', 's'].includes(key)
        || (input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(key)) event.preventDefault()
    })
    const navigate = (event: { preventDefault(): void }, url: string, mainFrame: boolean) => {
      if (loginRequestAllowed(attempt.request.platform, url, mainFrame ? 'mainFrame' : 'subFrame')) return
      event.preventDefault()
      if (mainFrame) this.update(attempt, { message: '请在卡片内使用扫码, 短信或密码登录.' })
    }
    contents.on('will-navigate', (event, url) => navigate(event, url, true))
    contents.on('will-frame-navigate', event => navigate(event, event.url, event.isMainFrame))
    contents.on('will-redirect', (event, url, _inPlace, mainFrame) => navigate(event, url, mainFrame))
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        attempt.broker?.reset()
        attempt.lastPage = 'loading'
        attempt.pageRevision++
        attempt.challenge = null
        attempt.verificationCompleted = false
        attempt.nativeVerification = false
        attempt.captchaPreflight = 'waiting'
        attempt.captchaPreRequest = null
        if (attempt.card && !attempt.explicitOfficial) this.waitForPlatform(attempt, '正在继续登录')
      }
    })
    contents.on('dom-ready', () => {
      if (attempt.request.destination) this.update(attempt, { phase: 'ready' })
      else void this.inspect(attempt)
    })
    contents.on('did-frame-finish-load', () => { void this.inspect(attempt) })
    contents.on('render-process-gone', () => {
      attempt.broker?.reset()
      attempt.lastPage = 'loading'
      attempt.pageRevision++
      attempt.actionRevision++
      attempt.challenge = null
      attempt.showingOfficial = false
      attempt.explicitOfficial = false
      attempt.pendingAction = null
      attempt.lastError = '登录页面已中断, 请重试.'
      this.cardUpdate(attempt, { stage: 'failed', busy: false, qr: { status: 'paused' }, sms: unavailableSms(), message: attempt.lastError })
      this.update(attempt, { phase: 'failed', presentation: 'form', message: attempt.lastError })
    })
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) this.update(attempt, { phase: 'failed', message: '登录页面未能加载, 请检查网络后重试.' })
    })
    const changed = (_event: unknown, cookie?: Partial<BrowserCookie>) => {
      if (attempt.request.platform !== 'douyin' || !cookie || ['sessionid', 'sessionid_ss'].includes(cookie.name ?? '')
        && (typeof cookie.domain !== 'string' || cookieDomainAllowed(cookie.domain, 'douyin'))) attempt.cookieRevision++
      if (attempt.cookieTimer) clearTimeout(attempt.cookieTimer)
      attempt.cookieTimer = setTimeout(() => { attempt.cookieTimer = null; void this.check(attempt) }, 600)
    }
    browserSession.cookies.on('changed', changed)
    attempt.removeListeners.push(() => browserSession.cookies.removeListener('changed', changed))
    attempt.initialized = true
    if (!attempt.request.destination) {
      view.setBounds({ x: 0, y: 0, ...attempt.brokerSize })
      attempt.broker = new LoginPageBroker(contents, LOGIN_ADAPTERS[attempt.request.platform])
      const card = (this.options.createCard ?? (options => new LocalLoginCard(options)))({ id: attempt.id, owner: attempt.owner,
        preload: this.options.cardPreload, escape: () => { void this.cancel(attempt.id) } })
      attempt.card = card
      await card.open()
      if (!this.current(attempt)) { await card.close(); return }
      this.update(attempt, { phase: 'ready', presentation: 'form' })
      card.publish(attempt.cardValue)
      if (attempt.request.platform === 'bilibili' || attempt.request.platform === 'huya' || attempt.request.platform === 'douyin') {
        attempt.renderPulse = setInterval(() => { void this.renderHiddenPage(attempt) }, 200)
      }
    }
    attempt.poll = setInterval(() => { void this.inspect(attempt); void this.check(attempt) }, this.options.pollMs ?? 400)
    await this.load(attempt)
  }

  /** Chromium can stop painting a hidden native view even with timer throttling disabled. */
  private async renderHiddenPage(attempt: Attempt): Promise<void> {
    if (!this.current(attempt) || !attempt.view || !attempt.card || attempt.rendering || attempt.showingOfficial
      || !attempt.viewport?.visible || !attempt.owner.isVisible() || attempt.owner.isMinimized()
      || !['ready', 'verifying'].includes(attempt.state.phase)) return
    attempt.rendering = true
    try {
      // A tiny temporary capture activates rendering without showing/focusing the official page.
      // Discard the image immediately; never encode, forward or store page pixels.
      await attempt.view.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: false, stayAwake: false })
    } catch { /* A new document can briefly have no capturable surface; the next pulse retries. */ }
    finally { attempt.rendering = false }
  }

  private async load(attempt: Attempt): Promise<void> {
    if (!this.current(attempt) || !attempt.view) return
    const revision = ++attempt.loadRevision
    attempt.broker?.restart()
    attempt.lastPage = 'loading'
    attempt.pageRevision++
    attempt.lastQrSource = null
    attempt.challenge = null
    attempt.returnedToForm = false
    attempt.pendingAction = null
    attempt.verificationCompleted = false
    attempt.nativeVerification = false
    attempt.captchaPreflight = 'waiting'
    attempt.captchaPreRequest = null
    attempt.lastError = undefined
    if (attempt.card) {
      attempt.showingOfficial = false
      attempt.explicitOfficial = false
      this.cardUpdate(attempt, { stage: 'loading', qr: { status: 'loading' }, sms: unavailableSms(), busy: false, verification: undefined, message: undefined })
      this.update(attempt, { phase: 'ready', presentation: 'form', message: undefined })
    } else this.update(attempt, { phase: 'loading', message: undefined })
    this.startPageTimeout(attempt, '官网登录组件未能完成加载, 请重试.')
    const destination = attempt.request.destination
    const url = destination === 'yuba' ? 'https://yuba.douyu.com/'
      : destination?.startsWith('room:') ? `https://www.douyu.com/${destination.slice(5)}`
      : destination?.startsWith('fish-act:') ? `https://www.douyu.com/pages/fish-act?rid=${destination.slice(9)}`
      : LOGIN_ADAPTERS[attempt.request.platform].entryUrl
    // Page subresources may keep loading; dom-ready can present the verified form sooner.
    try { await attempt.view.webContents.loadURL(url) }
    catch {
      if (this.current(attempt) && revision === attempt.loadRevision) this.update(attempt, { phase: 'failed', message: '登录页面未能加载, 请检查网络后重试.' })
      return
    }
    if (!this.current(attempt) || revision !== attempt.loadRevision) return
    if (destination) this.update(attempt, { phase: 'ready' })
    else await this.inspect(attempt)
  }

  private cardUpdate(attempt: Attempt, patch: Partial<LoginCardState>): void {
    if (!this.current(attempt)) return
    const next = { ...attempt.cardValue, ...patch }
    if (JSON.stringify(next) === JSON.stringify(attempt.cardValue)) return
    attempt.cardValue = next
    attempt.card?.publish(next)
  }

  private showOfficial(attempt: Attempt, message = '请在官方页面完成安全验证'): void {
    if (!this.current(attempt)) return
    this.clearPageTimeout(attempt)
    attempt.showingOfficial = true
    this.cardUpdate(attempt, { stage: attempt.explicitOfficial || !attempt.card ? 'official' : attempt.cardValue.verification ? 'verification' : 'submitting',
      busy: !attempt.explicitOfficial, message })
    this.update(attempt, { phase: 'challenge', presentation: attempt.challenge && !attempt.explicitOfficial ? 'captcha' : 'official', message })
  }

  /** Transient SDK screens must not expose a crop of the underlying website. */
  private waitForPlatform(attempt: Attempt, message: string, checking = false): void {
    if (!this.current(attempt) || attempt.explicitOfficial || attempt.state.phase === 'failed') return
    attempt.showingOfficial = false
    attempt.challenge = null
    this.cardUpdate(attempt, { stage: attempt.cardValue.verification ? 'verification' : 'submitting', busy: true, message, qr: { status: 'paused' } })
    this.update(attempt, { phase: checking ? 'verifying' : 'ready', presentation: attempt.cardValue.verification ? 'verification' : 'form', message })
  }

  private awaitingSecondFactor(attempt: Attempt): boolean {
    if (attempt.nativeVerification) return true
    if (attempt.verificationCompleted) return false
    if (attempt.lastPage === 'second-factor') return true
    if (!attempt.cardValue.verification) return false
    if (attempt.lastPage === 'loading' || attempt.lastPage === 'challenge') return true
    if (attempt.request.platform === 'douyin') return attempt.lastPage !== 'form'
    // A successful official redirect can leave the previous code form in our local state.
    // Keep guarding the actual risk page, but allow server verification after it has left.
    try {
      const url = new URL(attempt.view?.webContents.mainFrame.url ?? '')
      return url.origin === 'https://passport.bilibili.com' && url.pathname === '/pc/passport/riskVerify'
    } catch { return true }
  }

  private async inspect(attempt: Attempt): Promise<void> {
    if (!this.current(attempt) || !attempt.broker || attempt.inspecting || attempt.actionBusy || attempt.state.phase === 'failed') return
    attempt.inspecting = true
    const loadRevision = attempt.loadRevision
    const actionRevision = attempt.actionRevision
    try {
      const snapshot = await attempt.broker.inspect()
      if (!this.current(attempt) || loadRevision !== attempt.loadRevision || actionRevision !== attempt.actionRevision) return
      const previousPage = attempt.lastPage
      if (previousPage !== snapshot.page) attempt.pageRevision++
      attempt.lastPage = snapshot.page
      // A transient broker failure must not release the identity gate. An inspected base form
      // or an explicit portal-absence result can release it after the official panel closes.
      const nativeVerification = snapshot.nativeVerification ?? (snapshot.page === 'form' ? false : attempt.nativeVerification)
      if (attempt.nativeVerification !== nativeVerification) {
        attempt.nativeVerification = nativeVerification
        attempt.pageRevision++
        attempt.nextCheck = 0
      }
      if (snapshot.page === 'loading') {
        if (snapshot.submissionPending) {
          if (!attempt.submittedAt) attempt.submittedAt = Date.now()
          attempt.pendingAction ??= 'login'
          attempt.qrPaused = true
          if (!attempt.pageTimeout) this.startPageTimeout(attempt, '抖音尚未返回登录结果, 请重试. 重试只会重新打开登录页面.')
          const message = '正在等待抖音处理登录'
          if (attempt.explicitOfficial) this.update(attempt, { message })
          else this.waitForPlatform(attempt, message)
        } else if (snapshot.challengePhase) {
          attempt.qrPaused = true
          this.waitForPlatform(attempt, snapshot.challengePhase === 'passed' ? '人机验证已通过, 正在继续登录'
            : snapshot.challengePhase === 'verifying' ? '正在等待人机验证结果'
              : snapshot.challengePhase === 'unknown' ? '正在准备人机验证, 如无法显示可使用官方验证页面.' : '正在加载人机验证')
        } else if (attempt.showingOfficial && !attempt.explicitOfficial) this.waitForPlatform(attempt, '正在继续登录')
        return
      }
      const message = snapshot.error ? PAGE_ERRORS[snapshot.error] : undefined
      if (message) { attempt.lastError = message; attempt.verificationCompleted = false }
      const waitingForCaptcha = attempt.request.platform === 'bilibili' && snapshot.page === 'second-factor'
        && attempt.captchaPreflight !== 'ready' && !snapshot.verificationCompleted
      const sms = waitingForCaptcha ? { ...(snapshot.sms ?? unavailableSms()), canSend: false } : snapshot.sms ?? unavailableSms()
      this.cardUpdate(attempt, { sms })
      if (attempt.pendingAction === 'sms' && ((sms.cooldownSeconds ?? 0) > 0 || message)) {
        attempt.pendingAction = null
        attempt.submittedAt = 0
      }
      if (snapshot.page === 'second-factor' && snapshot.verification) {
        this.clearPageTimeout(attempt)
        attempt.qrPaused = true
        if (snapshot.verificationCompleted && !message && !attempt.verificationCompleted) {
          attempt.verificationCompleted = true
          attempt.pageRevision++
          attempt.nextCheck = 0
        }
        const pendingSubmission = !message && (attempt.pendingAction === 'verification' || attempt.pendingAction === 'sms') && attempt.submittedAt > 0
        if (!pendingSubmission) { attempt.submittedAt = 0; attempt.pendingAction = null }
        const waitingMessage = attempt.verificationCompleted ? '安全验证已完成, 正在确认登录状态'
          : pendingSubmission && Date.now() - attempt.submittedAt > 12_000 ? '平台仍在处理验证, 可使用官方验证页面查看进度.'
            : pendingSubmission ? '正在等待平台验证结果' : attempt.lastError ?? (waitingForCaptcha
              ? attempt.captchaPreflight === 'failed' ? '人机验证准备失败, 请检查网络或使用官方验证页面.' : '正在准备人机验证, 请稍候.' : undefined)
        if (!attempt.explicitOfficial) {
          attempt.showingOfficial = false
          attempt.challenge = null
          this.cardUpdate(attempt, { stage: 'verification', busy: attempt.actionBusy || pendingSubmission || attempt.verificationCompleted, qr: { status: 'paused' },
            verification: snapshot.verification, message: waitingMessage })
          this.update(attempt, { phase: attempt.verificationCompleted ? 'verifying' : 'ready', presentation: 'verification', message: waitingMessage })
        }
        if (attempt.verificationCompleted) void this.check(attempt)
        return
      }
      if (snapshot.page === 'challenge' || snapshot.page === 'unknown') {
        if (snapshot.page === 'unknown' || attempt.submittedAt) attempt.qrPaused = true
        attempt.challenge = snapshot.page === 'challenge' ? snapshot.challenge ?? null : null
        if (attempt.explicitOfficial) this.showOfficial(attempt)
        else if (!attempt.returnedToForm && attempt.challenge) {
          const protectedPage = await attempt.broker.presentChallenge(true)
          if (!this.current(attempt) || loadRevision !== attempt.loadRevision || actionRevision !== attempt.actionRevision) return
          if (protectedPage) this.showOfficial(attempt, '请完成人机验证')
          else this.waitForPlatform(attempt, '正在准备人机验证, 如无法显示可使用官方验证页面.')
        }
        else if (!attempt.returnedToForm) this.waitForPlatform(attempt, snapshot.page === 'challenge'
          ? '正在准备人机验证, 如无法显示可使用官方验证页面.' : '平台正在继续登录, 可使用官方验证页面查看进度.')
        else {
          const stage = attempt.cardValue.verification ? 'verification' : 'form'
          this.cardUpdate(attempt, { stage, busy: false, message: '请继续完成人机验证后再提交.' })
          this.update(attempt, { phase: 'ready', presentation: stage, message: '请继续完成人机验证后再提交.' })
        }
        return
      }
      attempt.challenge = null
      attempt.returnedToForm = false
      if (attempt.pendingAction === 'sms' && !message) {
        if ((sms.cooldownSeconds ?? 0) > 0) { attempt.pendingAction = null; attempt.submittedAt = 0 }
        else if (Date.now() - attempt.submittedAt > 12_000) {
          attempt.pendingAction = null; attempt.submittedAt = 0
          attempt.lastError = '平台尚未确认验证码已发送, 请重试或查看官方页面.'
        } else {
          this.waitForPlatform(attempt, '正在等待平台发送结果')
          return
        }
      }
      if (message) { attempt.pendingAction = null; attempt.submittedAt = 0 }
      if (attempt.explicitOfficial) {
        if (!attempt.pendingAction) this.clearPageTimeout(attempt)
        return
      }
      if ((attempt.pendingAction === 'login' || attempt.pendingAction === 'verification') && attempt.submittedAt && !message) {
        if (!attempt.pageTimeout) this.startPageTimeout(attempt, '抖音尚未返回登录结果, 请重试. 重试只会重新打开登录页面.')
        this.waitForPlatform(attempt, Date.now() - attempt.submittedAt > 12_000
          ? '平台仍在处理登录, 可使用官方验证页面查看进度.' : '正在等待平台登录结果')
        return
      }
      if (message) { attempt.submittedAt = 0; attempt.pendingAction = null }
      this.clearPageTimeout(attempt)
      if (previousPage === 'unknown' && !attempt.submittedAt && !attempt.cardValue.verification) attempt.qrPaused = false
      attempt.showingOfficial = false
      attempt.view?.setVisible(false)
      attempt.challengeHost?.setVisible(false)
      const qr = attempt.qrPaused ? { status: 'paused' as const } : await this.readQr(attempt, snapshot)
      if (!this.current(attempt) || loadRevision !== attempt.loadRevision || actionRevision !== attempt.actionRevision) return
      this.cardUpdate(attempt, { stage: 'form', busy: attempt.actionBusy, mode: snapshot.mode ?? attempt.cardValue.mode,
        qr, message: attempt.lastError, verification: undefined })
      this.update(attempt, { phase: 'ready', presentation: 'form', message })
    } catch { /* Navigation can invalidate the official frame between polls. */ }
    finally { attempt.inspecting = false }
  }

  private async readQr(attempt: Attempt, snapshot: LoginPageSnapshot): Promise<LoginCardState['qr']> {
    const status = snapshot.qrStatus ?? (snapshot.qr ? 'ready' : 'loading')
    if (!snapshot.qr || status !== 'ready') return { status }
    const source = snapshot.qr.src
    if (source && source === attempt.lastQrSource && attempt.cardValue.qr.image) return { status, image: attempt.cardValue.qr.image }
    try {
      let bytes: Buffer
      if (source?.startsWith('data:')) bytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
      else if (source && loginRequestAllowed(attempt.request.platform, source, 'image')) {
        const signal = AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(5000)])
        const response = await attempt.session.fetch(source, { credentials: 'include', redirect: 'error', signal })
        if (!response.ok) { await response.body?.cancel(); return { status: 'unavailable' } }
        bytes = await limitedBytes(response, signal, 512_000)
      } else if (snapshot.qr.rect && attempt.view) {
        const rect = snapshot.qr.rect
        if (rect.width < 24 || rect.height < 24 || rect.width > 512 || rect.height > 512) return { status: 'unavailable' }
        bytes = (await attempt.view.webContents.capturePage({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) })).toPNG()
      } else return { status: 'unavailable' }
      if (bytes.length > 512_000 || bytes.length < 16) return { status: 'unavailable' }
      const image = nativeImage.createFromBuffer(bytes)
      const dimensions = image.getSize()
      if (image.isEmpty() || dimensions.width < 24 || dimensions.height < 24 || dimensions.width > 1024 || dimensions.height > 1024) return { status: 'unavailable' }
      attempt.lastQrSource = source ?? null
      return { status, image: image.toDataURL() }
    } catch { return { status: 'unavailable' } }
  }

  private async check(attempt: Attempt, finishWebsite = false): Promise<void> {
    if (!this.current(attempt) || attempt.state.phase === 'failed' || attempt.checking || (!finishWebsite && attempt.request.destination)
      || (!finishWebsite && this.awaitingSecondFactor(attempt))
      || Date.now() < attempt.nextCheck || !attempt.initialized) return
    attempt.checking = true
    const pageRevision = attempt.pageRevision
    const loadRevision = attempt.loadRevision
    const actionRevision = attempt.actionRevision
    const cookieRevision = attempt.cookieRevision
    const currentCheck = () => this.current(attempt) && pageRevision === attempt.pageRevision
      && loadRevision === attempt.loadRevision && actionRevision === attempt.actionRevision
      && (attempt.request.platform !== 'douyin' || cookieRevision === attempt.cookieRevision)
    const signal = AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(this.options.checkTimeoutMs ?? 8000)])
    try {
      const cookies = await this.boundedCookies(attempt, signal)
      if (!currentCheck()) return
      if (!hasAuthenticationCookies(cookies, attempt.request.platform)) {
        if (finishWebsite) await this.finish(attempt, new LoginError('login-incomplete'))
        return
      }
      const credentialFingerprint = authenticationFingerprint(cookies, attempt.request.platform)
      if (!attempt.showingOfficial) {
        this.cardUpdate(attempt, { stage: attempt.cardValue.verification ? 'verification' : 'checking', busy: true, message: '正在确认登录状态' })
        this.update(attempt, { phase: 'verifying', message: '正在确认登录状态' })
      }
      attempt.nextCheck = Date.now() + 2500
      const response = await attempt.session.fetch(loginIdentityUrl(attempt.request.platform), {
        method: 'GET', credentials: 'include', redirect: 'manual', signal,
        headers: { Accept: 'application/json', ...(attempt.request.platform === 'douyin' ? { Referer: 'https://live.douyin.com/' } : attempt.request.platform === 'huya' ? { Referer: 'https://www.huya.com/' } : {}) },
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error('Identity unavailable') }
      const text = await limitedText(response, signal)
      const identity = parseLoginIdentity(attempt.request.platform, JSON.parse(text) as unknown)
      if (!currentCheck()
        || !finishWebsite && this.awaitingSecondFactor(attempt)) return
      // uid_tt is an opaque tracking hash; only the same session's official identity is authoritative.
      const matches = attempt.request.platform === 'douyin' || authenticationCookieUserId(cookies, attempt.request.platform) === identity.uid
      if (identity.status !== 'authenticated' || !identity.uid || !matches) {
        this.restoreCardAfterCheck(attempt, identity.status === 'anonymous' ? '请完成平台官网登录' : '暂时无法确认登录状态, 请稍后重试.')
        if (finishWebsite) await this.finish(attempt, new LoginError('login-incomplete'))
        return
      }
      // Read again after the identity response to include late authentication cookies.
      const finalCookies = await this.boundedCookies(attempt, signal)
      if (!currentCheck()
        || !finishWebsite && this.awaitingSecondFactor(attempt)) return
      if (!hasAuthenticationCookies(finalCookies, attempt.request.platform)
        || attempt.request.platform !== 'douyin' && authenticationCookieUserId(finalCookies, attempt.request.platform) !== identity.uid
        || authenticationFingerprint(finalCookies, attempt.request.platform) !== credentialFingerprint) return
      await this.finish(attempt, finalCookies)
    } catch {
      if (currentCheck()) {
        this.restoreCardAfterCheck(attempt, '暂时无法确认登录状态, 请检查网络后重试.')
        if (finishWebsite) await this.finish(attempt, new LoginError('login-incomplete'))
      }
    } finally { attempt.checking = false }
  }

  private restoreCardAfterCheck(attempt: Attempt, message: string): void {
    if (!this.current(attempt) || attempt.state.phase === 'failed') return
    if (attempt.showingOfficial) { this.update(attempt, { message }); return }
    this.cardUpdate(attempt, { stage: attempt.cardValue.verification ? 'verification' : 'form', busy: false, message })
    this.update(attempt, { phase: 'ready', message })
  }

  private async boundedCookies(attempt: Attempt, signal: AbortSignal): Promise<BrowserCookie[]> {
    const cookies = await abortable(attempt.session.cookies.get({}), signal)
    if (cookies.length > 50_000) throw new Error('Cookie snapshot too large')
    return cookies.flatMap(cookie => typeof cookie.domain !== 'string' || !cookieDomainAllowed(cookie.domain, attempt.request.platform) ? [] : [{
      domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, hostOnly: cookie.hostOnly,
      session: cookie.session, expirationDate: cookie.expirationDate, sameSite: cookie.sameSite, name: cookie.name, value: cookie.value,
    }])
  }

  setViewport(viewport: EmbeddedLoginViewport): void {
    const attempt = this.active
    if (!attempt || attempt.id !== viewport.id || !this.current(attempt)) return
    attempt.viewport = { ...viewport, rect: { ...viewport.rect } }
    this.applyViewport(attempt)
  }
  private applyViewport(attempt: Attempt): void {
    if (!attempt.view || attempt.owner.isDestroyed()) return
    const viewport = attempt.viewport
    if (!viewport) { attempt.view.setVisible(false); attempt.card?.hide(); return }
    const zoom = attempt.owner.webContents.getZoomFactor()
    const [width = 0, height = 0] = attempt.owner.getContentSize()
    const { rect } = viewport
    const x = Math.max(0, Math.min(width, Math.round(rect.x * zoom)))
    const y = Math.max(0, Math.min(height, Math.round(rect.y * zoom)))
    const right = Math.max(x, Math.min(width, Math.round((rect.x + rect.width) * zoom)))
    const bottom = Math.max(y, Math.min(height, Math.round((rect.y + rect.height) * zoom)))
    const rectInWindow = { x, y, width: right - x, height: bottom - y }
    const visible = viewport.visible && ['ready', 'verifying', 'challenge'].includes(attempt.state.phase) && right > x && bottom > y
    if (attempt.showingOfficial) {
      attempt.card?.hide()
      if (!attempt.challenge && !attempt.explicitOfficial && attempt.card) {
        attempt.view.setVisible(false)
        attempt.challengeHost?.setVisible(false)
        attempt.card.setBounds(rectInWindow, visible)
        return
      }
      if (attempt.challenge && !attempt.explicitOfficial) {
        if (this.challengeViewport(attempt, rectInWindow, visible)) return
        // A clipped or oversized challenge never silently turns into the complete website.
        this.restoreRemoteParent(attempt)
        attempt.view.setVisible(false)
        if (visible) this.cardUpdate(attempt, { message: '当前窗口无法完整显示人机验证, 请放大窗口或使用官方验证页面.' })
        attempt.card?.setBounds(rectInWindow, visible)
        return
      }
      this.restoreRemoteParent(attempt)
      if (visible && rectInWindow.width > 0 && rectInWindow.height > 0
        && (attempt.brokerSize.width !== rectInWindow.width || attempt.brokerSize.height !== rectInWindow.height)) {
        attempt.brokerSize = { width: rectInWindow.width, height: rectInWindow.height }
        void attempt.view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { ...attempt.brokerSize, deviceScaleFactor: 0, mobile: false }).catch(() => {})
      }
      attempt.view.setBounds(rectInWindow)
      attempt.view.setVisible(visible)
    } else {
      this.restoreRemoteParent(attempt)
      attempt.view.setVisible(false)
      attempt.card?.setBounds(rectInWindow, visible)
    }
  }

  private challengeViewport(attempt: Attempt, slot: Electron.Rectangle, visible: boolean): boolean {
    const region = attempt.challenge
    if (!region || !attempt.view || slot.width < 1 || slot.height < 1) return false
    const zoom = attempt.view.webContents.getZoomFactor()
    // Round inward so fractional CSS borders cannot expose the underlying website.
    const left = Math.ceil(region.x * zoom), top = Math.ceil(region.y * zoom)
    const width = Math.floor((region.x + region.width) * zoom) - left
    const height = Math.floor((region.y + region.height) * zoom) - top
    if (width > slot.width || height > slot.height || width < 64 || height < 40) return false
    if (!attempt.challengeHost) {
      attempt.view.setVisible(false)
      const host = new View()
      host.setBackgroundColor('#18181b')
      host.setBorderRadius(1)
      attempt.owner.contentView.removeChildView(attempt.view)
      host.addChildView(attempt.view)
      attempt.owner.contentView.addChildView(host)
      attempt.challengeHost = host
    }
    attempt.challengeHost.setBounds({ x: slot.x + Math.floor((slot.width - width) / 2), y: slot.y + Math.floor((slot.height - height) / 2), width, height })
    attempt.view.setBounds({ x: -left, y: -top, ...attempt.brokerSize })
    attempt.challengeHost.setVisible(visible)
    attempt.view.setVisible(visible)
    return true
  }

  private restoreRemoteParent(attempt: Attempt): void {
    if (!attempt.challengeHost || !attempt.view || attempt.owner.isDestroyed()) return
    attempt.view.setVisible(false)
    attempt.challengeHost.setVisible(false)
    attempt.challengeHost.removeChildView(attempt.view)
    attempt.owner.contentView.removeChildView(attempt.challengeHost)
    attempt.owner.contentView.addChildView(attempt.view)
    attempt.challengeHost = null
  }

  ownsCard(sender: WebContents, frame: WebFrameMain | null): boolean {
    const attempt = this.active
    if (!attempt || !this.current(attempt) || !attempt.card || sender.isDestroyed()) return false
    try { return sender === attempt.card.contents && frame === sender.mainFrame && frame?.url === attempt.card.url }
    catch { return false }
  }
  cardState(): LoginCardState | null { return this.active?.card ? structuredClone(this.active.cardValue) : null }

  async cardAction(action: LoginCardAction): Promise<LoginCardResult> {
    const attempt = this.active
    if (!attempt || !this.current(attempt) || !attempt.card || !attempt.broker) return { ok: false, message: '登录页面已失效.' }
    if (action.kind === 'cancel') { await this.cancel(attempt.id); return { ok: true } }
    if (action.kind === 'official') {
      const revision = ++attempt.actionRevision
      attempt.actionBusy = false
      attempt.explicitOfficial = true
      attempt.returnedToForm = false
      attempt.view?.setVisible(false)
      attempt.challengeHost?.setVisible(false)
      const restored = await attempt.broker.presentChallenge(false)
      if (!this.current(attempt) || revision !== attempt.actionRevision) return { ok: false, message: '登录操作已取消.' }
      if (!restored) { attempt.explicitOfficial = false; this.waitForPlatform(attempt, '官方页面暂时无法显示, 请重试.'); return { ok: false } }
      this.showOfficial(attempt)
      return { ok: true }
    }
    if (action.kind === 'back') { await this.back(attempt.id); return { ok: true } }
    if (attempt.actionBusy || attempt.cardValue.busy || attempt.showingOfficial || ['loading', 'submitting', 'checking'].includes(attempt.cardValue.stage)) return { ok: false, message: '请先完成当前登录步骤.' }
    const second = action.kind === 'second-send' || action.kind === 'second-submit'
    if (second !== (attempt.cardValue.stage === 'verification')) return { ok: false, message: '当前验证步骤已变化, 请重试.' }
    if (action.kind === 'second-send' && attempt.request.platform === 'bilibili' && attempt.captchaPreflight !== 'ready') {
      return { ok: false, message: '人机验证尚未准备好, 请稍候.' }
    }
    if ((action.kind === 'send-sms' || action.kind === 'second-send') && !attempt.cardValue.sms.canSend) return { ok: false, message: '请等待平台允许再次发送验证码.' }
    if (action.kind === 'refresh-qr') {
      attempt.lastQrSource = null
      const result = await attempt.broker.act(action)
      if (!result.ok) return { ok: false, message: '当前二维码仍有效, 失效后再刷新.' }
      attempt.qrPaused = false
      void this.inspect(attempt)
      return { ok: true }
    }
    const revision = ++attempt.actionRevision
    attempt.actionBusy = true
    attempt.returnedToForm = false
    attempt.lastError = undefined
    const submit = ['password', 'sms', 'second-submit'].includes(action.kind)
    const sendingSms = action.kind === 'send-sms' || action.kind === 'second-send'
    if (submit || sendingSms) { attempt.qrPaused = true; attempt.submittedAt = Date.now(); attempt.pendingAction = sendingSms ? 'sms' : second ? 'verification' : 'login' }
    if (action.kind === 'second-submit') attempt.verificationCompleted = false
    attempt.nativeVerification = false
    this.cardUpdate(attempt, { stage: second ? 'verification' : submit ? 'submitting' : 'form', busy: true, message: undefined,
      ...(submit ? { qr: { status: 'paused' } } : {}) })
    let payload = action
    if (action.kind === 'prepare-sms' || action.kind === 'send-sms' || action.kind === 'sms') payload = { ...action,
      countryCode: attempt.request.platform === 'bilibili' ? action.countryCode.replace(/^\+/, '') : `+${action.countryCode.replace(/^\+/, '')}` }
    try {
      const result = await attempt.broker.act(payload)
      if (!this.current(attempt) || revision !== attempt.actionRevision) return { ok: false, message: '登录操作已取消.' }
      if (!result.ok) {
        attempt.submittedAt = 0
        attempt.pendingAction = null
        attempt.lastError = result.reason === 'invalid-input' ? '请检查账号, 密码或验证码的格式.' : '当前登录方式暂不可用, 可以使用官方验证页面.'
        this.cardUpdate(attempt, { stage: second ? 'verification' : 'form', busy: false, message: attempt.lastError })
        return { ok: false, message: attempt.cardValue.message }
      }
      if (action.kind === 'mode') this.cardUpdate(attempt, { mode: action.mode })
      if (sendingSms) this.cardUpdate(attempt, { sms: unavailableSms(), message: '正在等待平台发送结果' })
      return { ok: true }
    } finally {
      if ('password' in payload) payload.password = ''
      if ('code' in payload) payload.code = ''
      if ('password' in action) action.password = ''
      if ('code' in action) action.code = ''
      if (revision === attempt.actionRevision) {
        attempt.actionBusy = false
        this.cardUpdate(attempt, { busy: (submit || sendingSms) && attempt.submittedAt > 0 })
        void this.inspect(attempt)
      }
    }
  }

  async back(id: string): Promise<void> {
    const attempt = this.active
    if (!attempt || attempt.id !== id || !this.current(attempt) || !attempt.card) return
    attempt.actionRevision++
    attempt.actionBusy = false
    attempt.submittedAt = 0
    attempt.explicitOfficial = false
    attempt.showingOfficial = false
    attempt.returnedToForm = true
    attempt.pendingAction = null
    const step = attempt.cardValue.verification ? 'verification' : 'form'
    this.cardUpdate(attempt, { stage: step, busy: false, message: attempt.lastPage === 'challenge' ? '人机验证尚未完成, 可继续打开验证.' : undefined })
    this.update(attempt, { phase: 'ready', presentation: step === 'verification' ? 'verification' : 'form', message: undefined })
    await this.inspect(attempt)
  }

  async cancel(id: string): Promise<void> {
    const attempt = this.active
    if (!attempt || attempt.id !== id) return
    if (attempt.request.destination && !attempt.checking && attempt.initialized) {
      attempt.nextCheck = 0
      await this.check(attempt, true)
      if (this.current(attempt)) await this.finish(attempt, new LoginError('login-cancelled'))
      return
    }
    await this.finish(attempt, new LoginError('login-cancelled'))
  }
  async retry(id: string): Promise<void> {
    const attempt = this.active
    if (!attempt || attempt.id !== id || !this.current(attempt)) return
    if (!attempt.initialized) { await this.prepare(attempt); return }
    attempt.actionRevision++
    attempt.actionBusy = false
    attempt.submittedAt = 0
    attempt.qrPaused = false
    await this.load(attempt).catch(() => this.update(attempt, { phase: 'failed', message: '登录页面未能加载, 请检查网络后重试.' }))
  }

  private async finish(attempt: Attempt, result: BrowserCookie[] | LoginError): Promise<void> {
    if (attempt.closing) return
    attempt.closing = true
    attempt.broker?.close()
    attempt.actionRevision++
    attempt.abort.abort()
    if (attempt.timeout) clearTimeout(attempt.timeout)
    if (attempt.pageTimeout) clearTimeout(attempt.pageTimeout)
    if (attempt.poll) clearInterval(attempt.poll)
    if (attempt.renderPulse) { clearInterval(attempt.renderPulse); attempt.renderPulse = null }
    if (attempt.cookieTimer) clearTimeout(attempt.cookieTimer)
    for (const remove of attempt.removeListeners) { try { remove() } catch { /* Keep releasing the remaining resources. */ } }
    try {
      if (attempt.view) {
        attempt.view.setVisible(false)
        if (attempt.challengeHost) {
          attempt.challengeHost.setVisible(false)
          attempt.challengeHost.removeChildView(attempt.view)
          if (!attempt.owner.isDestroyed()) attempt.owner.contentView.removeChildView(attempt.challengeHost)
        } else if (!attempt.owner.isDestroyed()) attempt.owner.contentView.removeChildView(attempt.view)
        if (!attempt.view.webContents.isDestroyed()) attempt.view.webContents.close({ waitForBeforeUnload: false })
      }
    } catch { /* The owner may already have destroyed its views. */ }
    if (this.active === attempt) { this.active = null; this.emit() }
    if (!attempt.owner.isDestroyed() && !attempt.owner.webContents.isDestroyed()) attempt.owner.webContents.focus()
    const cleanup = (async () => {
      await Promise.allSettled([
        Promise.resolve().then(() => attempt.card?.close()),
        (async () => {
          await attempt.session.closeAllConnections().catch(() => {})
          await Promise.allSettled([attempt.session.clearStorageData(), attempt.session.clearCache()])
        })(),
      ])
    })()
    this.cleanups.add(cleanup)
    try { await cleanup } finally { this.cleanups.delete(cleanup) }
    if (result instanceof LoginError || attempt.request.signal.aborted || this.disposed) attempt.reject(result instanceof LoginError ? result : new LoginError('login-cancelled'))
    else attempt.resolve(result)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.active) await this.finish(this.active, new LoginError('login-cancelled'))
    await Promise.allSettled(this.cleanups)
    this.listeners.clear()
  }
}

const PAGE_ERRORS = {
  'invalid-credentials': '账号或密码不正确, 请检查后重试.',
  'invalid-code': '验证码不正确或已失效, 请重试.',
  'rate-limited': '操作过于频繁, 请稍后重试.',
  network: '平台官网连接失败, 请检查网络后重试.',
  unknown: '平台官网未能完成此步骤, 可以使用官方验证页面.',
} as const

function unavailableSms(): LoginSmsState { return { canSend: false, cooldownSeconds: null } }

/** This request initializes the risk-page challenge; it never sends an SMS. */
function isBilibiliCaptchaPreflight(raw: string, method: string): boolean {
  if (method !== 'POST') return false
  try {
    const url = new URL(raw)
    return url.origin === 'https://passport.bilibili.com' && url.pathname === '/x/safecenter/captcha/pre'
      && !url.username && !url.password
  } catch { return false }
}

/** Ignore visitor/tracking refreshes but invalidate every changed authentication ticket. */
function authenticationFingerprint(cookies: BrowserCookie[], platform: EmbeddedLoginRequest['platform']): string {
  const names = platform === 'douyin' ? ['sessionid', 'sessionid_ss'] : platform === 'bilibili' ? ['DedeUserID', 'SESSDATA'] : platform === 'huya' ? ['udb_uid', 'udb_biztoken']
    : ['acf_uid', 'acf_auth', 'acf_auth_wl', 'acf_dmjwt_token', 'acf_ltkid', 'acf_biz', 'acf_stk']
  return createHash('sha256').update(JSON.stringify(cookies.filter(cookie => names.includes(cookie.name)).map(cookie => ({
    domain: cookie.domain, path: cookie.path ?? '/', name: cookie.name, value: cookie.value, hostOnly: cookie.hostOnly,
    secure: cookie.secure, httpOnly: cookie.httpOnly, session: cookie.session, expirationDate: cookie.expirationDate,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex')
}

function isQrPolling(platform: EmbeddedLoginRequest['platform'], raw: string): boolean {
  try {
    const url = new URL(raw)
    if (platform === 'douyin') return url.protocol === 'wss:' && url.hostname === 'frontier100-normal.zijieapi.com'
      || url.origin === 'https://live.douyin.com' && url.pathname === '/passport/web/check_qrconnect/'
    return platform === 'bilibili' ? url.hostname === 'passport.bilibili.com' && url.pathname === '/x/passport-login/web/qrcode/poll'
      : platform === 'douyu' ? url.hostname === 'passport.douyu.com' && url.pathname === '/japi/scan/auth'
        : url.hostname === 'udblgn.huya.com' && url.pathname === '/qrLgn/tryQrLogin'
  } catch { return false }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Aborted')
  let cancel!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Error('Aborted')); signal.addEventListener('abort', cancel, { once: true }) })
  try { return await Promise.race([work, cancelled]) } finally { signal.removeEventListener('abort', cancel) }
}

async function limitedText(response: Response, signal: AbortSignal): Promise<string> {
  return (await limitedBytes(response, signal, 256 * 1024)).toString('utf8')
}

async function limitedBytes(response: Response, signal: AbortSignal, maximum: number): Promise<Buffer> {
  if (!response.body) throw new Error('Empty identity response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      size += value.length
      if (size > maximum) throw new Error('Response too large')
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally { void reader.cancel().catch(() => {}) }
}
