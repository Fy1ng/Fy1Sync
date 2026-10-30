import { WebContentsView, session } from 'electron'
import type { BrowserWindow, WebContentsViewConstructorOptions, Session, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'

// 8K is the largest picture YouTube serves; anything bigger is not a video frame.
const MAX_FRAME_WIDTH = 7680, MAX_FRAME_HEIGHT = 4320
export type YtBrowseErrorCode = 'invalid-arguments' | 'auth-required' | 'bot-challenge' | 'video-unavailable' | 'network' | 'not-ready' | 'ad-playing' | 'snapshot-too-large' | 'snapshot-unavailable' | 'origin-tainted' | 'player-only-failed' | 'closed'
export class YtBrowseError extends Error {
  constructor(readonly code: YtBrowseErrorCode) {
    super({ 'invalid-arguments': 'YouTube 浏览参数无效.', 'auth-required': '请通过应用现有的 YouTube 登录重新验证.',
      'bot-challenge': 'YouTube 要求机器人验证, 请重新登录后重试.', 'video-unavailable': '录像不可用.', network: 'YouTube 页面加载失败.',
      'not-ready': '视频尚未加载完成.', 'ad-playing': '广告播放期间不能截取训练样本.', 'snapshot-too-large': '画面尺寸超出 8K, 无法截取.',
      'snapshot-unavailable': '画面尚未稳定或视频内容未完整显示, 请重试.', 'origin-tainted': '读不到视频画面, YouTube 可能换了播放方式',
      'player-only-failed': '无法只显示播放器, 请重新打开录像', closed: 'YouTube 浏览窗口已关闭.' }[code])
  }
}
export interface YtBrowseState {
  videoId: string | null
  title: string
  duration: number
  currentTime: number
  playing: boolean
  videoWidth: number
  videoHeight: number
  isAd: boolean
  playerOnly: boolean
  errorCode: YtBrowseErrorCode | null
}
export interface YtBrowseCommand { action: 'play' | 'pause' | 'seek'; seconds?: number }
export interface YtBrowseViewport { rect: { x: number; y: number; width: number; height: number }; visible: boolean }
export interface YtBrowseSnapshot {
  /** RGBA, row-major, width * height * 4 bytes: what the editor works on, with no encode or decode. */
  rgba: Uint8Array
  videoId: string
  approximateTime: number
  approximate: true
  videoWidth: number
  videoHeight: number
  width: number
  height: number
  isOneToOne: boolean
}
export interface YouTubeBrowseOptions {
  injectCookies: (target: Session) => Promise<void>
  changed?: (ownerId: number, state: YtBrowseState) => void
  createView?: (options: WebContentsViewConstructorOptions) => WebContentsView
  sessionFromPartition?: (partition: string) => Session
}
const emptyState = (): YtBrowseState => ({ videoId: null, title: '', duration: 0, currentTime: 0, playing: false, videoWidth: 0, videoHeight: 0, isAd: false, playerOnly: false, errorCode: 'closed' })
const finite = (value: unknown, max = 10_000_000): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : 0
const domain = (host: string, base: string) => host === base || host.endsWith(`.${base}`)

export function normalizeYouTubeBrowseUrl(input: string): { url: string; videoId: string } {
  if (typeof input !== 'string' || input.length > 2048) throw new YtBrowseError('invalid-arguments')
  let target: URL
  try { target = new URL(input) } catch { throw new YtBrowseError('invalid-arguments') }
  if (target.protocol !== 'https:' || target.username || target.password || target.port) throw new YtBrowseError('invalid-arguments')
  const id = target.hostname === 'youtu.be' && /^\/[\w-]{11}$/.test(target.pathname) ? target.pathname.slice(1)
    : ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(target.hostname) && target.pathname === '/watch' ? target.searchParams.get('v') : null
  if (!id || !/^[\w-]{11}$/.test(id)) throw new YtBrowseError('invalid-arguments')
  return { url: `https://www.youtube.com/watch?v=${id}`, videoId: id }
}
export function isYouTubeAuthUrl(input: string): boolean {
  try { const url = new URL(input); return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && (['accounts.google.com', 'consent.google.com', 'consent.youtube.com'].includes(url.hostname)
      || url.hostname === 'www.youtube.com' && /^\/(?:signin|login|verify_age|oops)(?:\/|$)/.test(url.pathname)) } catch { return false }
}
export function isYouTubeBrowseNavigation(input: string, videoId: string, mainFrame = true): boolean {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'www.youtube.com') return false
    return mainFrame ? url.pathname === '/watch' && url.searchParams.get('v') === videoId : /^\/embed\/[\w-]{11}$/.test(url.pathname)
  } catch { return false }
}
export function isYouTubeBrowseResource(input: string): boolean {
  try {
    const url = new URL(input)
    if (url.protocol === 'blob:') return url.origin === 'https://www.youtube.com'
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    return ['youtube.com', 'googlevideo.com', 'ytimg.com', 'gstatic.com', 'googleusercontent.com'].some(base => domain(url.hostname, base))
      || ['www.google.com', 'accounts.google.com', 'consent.google.com', 'googleads.g.doubleclick.net', 'static.doubleclick.net'].includes(url.hostname)
  } catch { return false }
}

// These fixed scripts never return source URLs, cookies, page diagnostics or arbitrary DOM data.
export const YT_BROWSE_INPUT_GUARD_SCRIPT = `(() => {
  if (window.fy1syncInputGuard) return;
  window.fy1syncInputGuard = true;
  document.addEventListener('click', event => { if (event.target instanceof HTMLInputElement && event.target.type === 'file') event.preventDefault(); }, true);
  for (const type of ['dragover', 'drop']) document.addEventListener(type, event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
})()`
// YouTube builds the player after the page loads, so wait for it before counting a failure.
export const YT_BROWSE_PLAYER_ONLY_SCRIPT = `(async () => {
  let player = document.querySelector('#movie_player');
  for (let waited = 0; !player && waited < 10000; waited += 250) {
    await new Promise(resolve => setTimeout(resolve, 250));
    player = document.querySelector('#movie_player');
  }
  if (!player) return false;
  try { if (document.fullscreenElement !== player) await player.requestFullscreen(); return document.fullscreenElement === player; }
  catch { return false; }
})()`
export const YT_BROWSE_STATE_SCRIPT = `(() => {
  const video = document.querySelector('#movie_player video') || document.querySelector('video');
  const text = (document.querySelector('.ytp-error')?.textContent || '').slice(0, 2000);
  const errorCode = /not a bot|机器人|機器人/i.test(text) ? 'bot-challenge' : /sign in|登录|登入|verify|验证/i.test(text) ? 'auth-required' : text.trim() ? 'video-unavailable' : null;
  return { title: (document.querySelector('h1.ytd-watch-metadata')?.textContent || document.title || '').slice(0, 500),
    duration: video?.duration, currentTime: video?.currentTime, playing: !!video && !video.paused && !video.ended,
    videoWidth: video?.videoWidth, videoHeight: video?.videoHeight,
    playerOnly: !!document.fullscreenElement && document.fullscreenElement === document.querySelector('#movie_player'),
    isAd: !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting'), errorCode };
})()`
// Pauses on the frame it takes, so the recording waits there while the still is edited. Raw
// pixels, not PNG: encoding a 4K frame on YouTube's busy page thread takes over a second.
export const YT_BROWSE_SNAPSHOT_SCRIPT = `(async () => {
  const video = document.querySelector('#movie_player video') || document.querySelector('video');
  const isAd = () => !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');
  if (isAd()) return { errorCode: 'ad-playing' };
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return { errorCode: 'not-ready' };
  if (video.seeking) return { errorCode: 'snapshot-unavailable' };
  video.pause();
  const currentTime = video.currentTime, videoWidth = video.videoWidth, videoHeight = video.videoHeight;
  if (videoWidth > ${MAX_FRAME_WIDTH} || videoHeight > ${MAX_FRAME_HEIGHT}) return { errorCode: 'snapshot-too-large' };
  const canvas = document.createElement('canvas'); canvas.width = videoWidth; canvas.height = videoHeight;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return { errorCode: 'snapshot-unavailable' };
    context.drawImage(video, 0, 0);
    const pixels = context.getImageData(0, 0, videoWidth, videoHeight).data;
    if (isAd()) return { errorCode: 'ad-playing' };
    if (video.videoWidth !== videoWidth || video.videoHeight !== videoHeight || video.seeking) return { errorCode: 'snapshot-unavailable' };
    return { rgba: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), currentTime, videoWidth, videoHeight };
  } catch (error) { return { errorCode: error?.name === 'SecurityError' ? 'origin-tainted' : 'snapshot-unavailable' }; }
})()`

/** One isolated player view, owned by one admin window. */
export class YouTubeBrowseManager {
  private view: WebContentsView | null = null
  private browserSession: Session | null = null
  private owner: BrowserWindow | null = null
  private ownerId: number | null = null
  private viewport: YtBrowseViewport | null = null
  private value: YtBrowseState = emptyState()
  private generation = 0
  private opening = 0
  private stateTimer: ReturnType<typeof setInterval> | null = null
  private statePending = false
  private snapshotPending = false
  private playerOnlyPending: Promise<void> | null = null
  private playerOnlyFailures = 0
  private readonly injections = new Map<Session, Promise<void>>()
  private readonly cleanups = new Set<Promise<void>>()
  private detachOwner: (() => void) | null = null
  constructor(private readonly options: YouTubeBrowseOptions) {}

  async open(owner: BrowserWindow, input: string): Promise<YtBrowseState> {
    const { url, videoId } = normalizeYouTubeBrowseUrl(input)
    const opening = ++this.opening
    await this.teardown()
    if (opening !== this.opening || owner.isDestroyed()) throw new YtBrowseError('closed')
    const generation = ++this.generation
    const browserSession = (this.options.sessionFromPartition ?? session.fromPartition)(`yt-browse-${randomUUID()}`)
    this.browserSession = browserSession
    this.owner = owner
    const ownerContents = owner.webContents, ownerId = ownerContents.id
    this.ownerId = ownerId
    this.value = { ...emptyState(), videoId, errorCode: null }
    const fullscreenAllowed = (contents: WebContents | null, permission: string, details: { isMainFrame: boolean; requestingUrl?: string }) =>
      generation === this.generation && contents === this.view?.webContents && permission === 'fullscreen'
      && details.isMainFrame === true && isYouTubeBrowseNavigation(details.requestingUrl ?? '', videoId)
      && isYouTubeBrowseNavigation(contents?.getURL() ?? '', videoId)
    browserSession.setPermissionCheckHandler((contents, permission, _origin, details) => fullscreenAllowed(contents, permission, details))
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(fullscreenAllowed(contents, permission, details)))
    browserSession.on('will-download', event => event.preventDefault())
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const document = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
      const allowed = document ? isYouTubeBrowseNavigation(details.url, videoId, details.resourceType === 'mainFrame') : isYouTubeBrowseResource(details.url)
      if (!allowed && isYouTubeAuthUrl(details.url)) this.fail('auth-required', generation)
      callback({ cancel: !allowed })
    })
    try {
      const injecting = Promise.resolve().then(() => this.options.injectCookies(browserSession))
      this.injections.set(browserSession, injecting)
      try { await injecting } finally { this.injections.delete(browserSession) }
      if (generation !== this.generation || owner.isDestroyed()) throw new YtBrowseError('closed')
      const view = (this.options.createView ?? (options => new WebContentsView(options)))({
        webPreferences: { session: browserSession, nodeIntegration: false, nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false, sandbox: true, contextIsolation: true, webSecurity: true, devTools: false,
          backgroundThrottling: false, spellcheck: false, navigateOnDragDrop: false, disableHtmlFullscreenWindowResize: true },
      })
      this.view = view
      view.setVisible(false)
      owner.contentView.addChildView(view)
      this.applyViewport()
      const contents = view.webContents
      contents.setIgnoreMenuShortcuts(true)
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('before-input-event', (event, input) => {
        const key = input.key.toLowerCase()
        if (key === 'f5' || key === 'f12' || input.control && ['r', 'o', 'p', 's'].includes(key)
          || (input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(key)
          || input.meta && input.alt && ['i', 'j', 'c'].includes(key)
          || input.alt && ['arrowleft', 'arrowright'].includes(key)) event.preventDefault()
      })
      const navigation = (event: { preventDefault(): void }, target: string, mainFrame = true) => {
        if (isYouTubeBrowseNavigation(target, videoId, mainFrame)) return
        event.preventDefault()
        if (isYouTubeAuthUrl(target)) this.fail('auth-required', generation)
      }
      contents.on('will-navigate', (event, target) => navigation(event, target))
      contents.on('will-frame-navigate', event => navigation(event, event.url, event.isMainFrame))
      contents.on('will-redirect', (event, target, _inPlace, mainFrame) => navigation(event, target, mainFrame))
      contents.on('did-navigate-in-page', (_event, target, mainFrame) => {
        if (mainFrame && !isYouTubeBrowseNavigation(target, videoId)) this.invalidate(isYouTubeAuthUrl(target) ? 'auth-required' : 'video-unavailable', generation)
      })
      contents.on('will-attach-webview', event => event.preventDefault())
      contents.on('dom-ready', () => { void contents.executeJavaScriptInIsolatedWorld(1001, [{ code: YT_BROWSE_INPUT_GUARD_SCRIPT }]).catch(() => {}) })
      contents.on('leave-html-full-screen', () => {
        if (generation !== this.generation) return
        this.value = { ...this.value, playerOnly: false }
        view.setVisible(false)
        this.emitState()
        void this.ensurePlayerOnly(view, generation)
      })
      contents.on('render-process-gone', () => {
        if (generation !== this.generation) return
        view.setVisible(false)
        this.value = { ...this.value, playerOnly: false }
        this.fail('network', generation)
      })
      contents.once('destroyed', () => { if (generation === this.generation) void this.close() })
      const destroyed = () => { void this.destroyForOwner(ownerId) }
      const navigateOwner = () => { void this.destroyForOwner(ownerId) }
      ownerContents.once('destroyed', destroyed)
      ownerContents.on('will-navigate', navigateOwner)
      ownerContents.on('did-navigate-in-page', navigateOwner)
      this.detachOwner = () => { ownerContents.removeListener('destroyed', destroyed); ownerContents.removeListener('will-navigate', navigateOwner); ownerContents.removeListener('did-navigate-in-page', navigateOwner) }
      await contents.loadURL(url)
      if (generation !== this.generation) throw new YtBrowseError('closed')
      contents.setBackgroundThrottling(false)
      await this.ensurePlayerOnly(view, generation)
      if (generation !== this.generation) throw new YtBrowseError('closed')
      this.stateTimer = setInterval(() => { if (!this.statePending) void this.state().catch(() => {}) }, 1000)
      return await this.state()
    } catch (error) {
      if (generation === this.generation) {
        const code = this.value.errorCode === 'auth-required' ? 'auth-required' : error instanceof YtBrowseError ? error.code : this.view ? 'network' : 'auth-required'
        await this.close(); throw new YtBrowseError(code)
      }
      throw new YtBrowseError('closed')
    }
  }

  setViewport(viewport: YtBrowseViewport): void {
    this.viewport = { rect: { ...viewport.rect }, visible: viewport.visible }
    this.applyViewport()
  }
  private applyViewport(): void {
    if (!this.view || !this.owner || this.owner.isDestroyed()) return
    if (!this.viewport) { this.view.setVisible(false); return }
    const { rect, visible } = this.viewport
    const zoom = this.owner.webContents.getZoomFactor()
    const [width = 0, height = 0] = this.owner.getContentSize()
    const x = Math.max(0, Math.min(width, Math.round(rect.x * zoom)))
    const y = Math.max(0, Math.min(height, Math.round(rect.y * zoom)))
    const right = Math.max(x, Math.min(width, Math.round((rect.x + rect.width) * zoom)))
    const bottom = Math.max(y, Math.min(height, Math.round((rect.y + rect.height) * zoom)))
    this.view.setBounds({ x, y, width: right - x, height: bottom - y })
    this.view.setVisible(visible && right > x && bottom > y && this.value.playerOnly)
  }
  private ensurePlayerOnly(view: WebContentsView, generation: number): Promise<void> {
    if (this.playerOnlyPending) return this.playerOnlyPending
    if (generation !== this.generation || this.playerOnlyFailures >= 3) return Promise.resolve()
    const pending = (async () => {
      while (generation === this.generation && this.playerOnlyFailures < 3) {
        let entered = false
        try { entered = await view.webContents.executeJavaScript(YT_BROWSE_PLAYER_ONLY_SCRIPT, true) === true } catch {}
        if (generation !== this.generation) return
        this.checkIdentity()
        if (generation !== this.generation) return
        if (entered) {
          this.playerOnlyFailures = 0
          this.value = { ...this.value, playerOnly: true }
          this.applyViewport()
          this.emitState()
          return
        }
        this.playerOnlyFailures++
      }
      if (generation === this.generation) this.fail('player-only-failed', generation)
    })()
    this.playerOnlyPending = pending
    const settled = () => { if (this.playerOnlyPending === pending) this.playerOnlyPending = null }
    void pending.then(settled, settled)
    return pending
  }
  private fail(code: YtBrowseErrorCode, generation: number): void {
    if (generation !== this.generation) return
    this.value = { ...this.value, errorCode: code, playing: false }
    this.emitState()
  }
  private invalidate(code: YtBrowseErrorCode, generation: number): void {
    if (generation !== this.generation) return
    const owner = this.owner, ownerId = this.ownerId
    ++this.opening
    const cleanup = this.teardown()
    // Keep the terminal error after destroying the renderer. No old identity survives.
    this.value = { ...emptyState(), errorCode: code }
    if (owner && !owner.isDestroyed() && ownerId !== null) this.options.changed?.(ownerId, { ...this.value })
    void cleanup.catch(() => {})
  }
  private checkIdentity(): void {
    if (this.view && this.value.videoId && !isYouTubeBrowseNavigation(this.view.webContents.getURL(), this.value.videoId)) {
      const code = isYouTubeAuthUrl(this.view.webContents.getURL()) ? 'auth-required' : 'video-unavailable'
      this.invalidate(code, this.generation)
    }
  }
  private emitState(): void {
    if (this.owner && !this.owner.isDestroyed() && this.ownerId !== null) this.options.changed?.(this.ownerId, { ...this.value })
  }
  private current(): { view: WebContentsView; generation: number } {
    this.checkIdentity()
    if (!this.view || this.view.webContents.isDestroyed() || !this.owner || this.owner.isDestroyed()) throw new YtBrowseError(this.value.errorCode ?? 'closed')
    return { view: this.view, generation: this.generation }
  }
  async state(): Promise<YtBrowseState> {
    this.checkIdentity()
    if (!this.view) return { ...this.value }
    const { view, generation } = this.current()
    this.statePending = true
    try {
      const data: unknown = await view.webContents.executeJavaScript(YT_BROWSE_STATE_SCRIPT)
      if (generation !== this.generation) return { ...this.value }
      this.checkIdentity()
      if (generation !== this.generation) return { ...this.value }
      const raw = data && typeof data === 'object' ? data as Record<string, unknown> : {}
      const code = ['auth-required', 'bot-challenge', 'video-unavailable'].includes(String(raw.errorCode)) ? raw.errorCode as YtBrowseErrorCode : null
      this.value = { videoId: this.value.videoId, title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
        duration: finite(raw.duration), currentTime: finite(raw.currentTime), playing: raw.playing === true,
        videoWidth: finite(raw.videoWidth, 32768), videoHeight: finite(raw.videoHeight, 32768), isAd: raw.isAd === true,
        playerOnly: raw.playerOnly === true && this.playerOnlyFailures < 3,
        errorCode: ['auth-required', 'player-only-failed'].includes(this.value.errorCode ?? '') ? this.value.errorCode : code }
      this.applyViewport()
      this.emitState()
      if (!this.value.playerOnly) await this.ensurePlayerOnly(view, generation)
      return { ...this.value }
    } catch { this.fail('network', generation); return { ...this.value } }
    finally { if (generation === this.generation) this.statePending = false }
  }
  async command(command: YtBrowseCommand): Promise<YtBrowseState> {
    const { view, generation } = this.current()
    if (!command || !['play', 'pause', 'seek'].includes(command.action)
      || command.action === 'seek' && (!Number.isFinite(command.seconds) || command.seconds! < 0 || command.seconds! > 10_000_000)) throw new YtBrowseError('invalid-arguments')
    const script = command.action === 'seek' ? `(() => { const v=document.querySelector('video'); if(v && Number.isFinite(v.duration))v.currentTime=Math.min(${command.seconds},v.duration); })()`
      : command.action === 'play' ? `(async () => { const v=document.querySelector('video'); if(v)await v.play(); })()` : `document.querySelector('video')?.pause()`
    try { await view.webContents.executeJavaScript(script, true) } catch { throw new YtBrowseError('not-ready') }
    if (generation !== this.generation) throw new YtBrowseError('closed')
    return this.state()
  }
  async snapshot(): Promise<YtBrowseSnapshot> {
    if (this.snapshotPending) throw new YtBrowseError('snapshot-unavailable')
    const { view, generation } = this.current()
    const videoId = this.value.videoId!
    this.snapshotPending = true
    try {
      const state = await this.state()
      if (generation !== this.generation || state.videoId !== videoId) throw new YtBrowseError('closed')
      if (state.errorCode) throw new YtBrowseError(state.errorCode)
      if (state.isAd) throw new YtBrowseError('ad-playing')
      const data: unknown = await view.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: YT_BROWSE_SNAPSHOT_SCRIPT }])
      if (generation !== this.generation || this.value.videoId !== videoId) throw new YtBrowseError('closed')
      this.checkIdentity()
      if (generation !== this.generation || this.value.videoId !== videoId) throw new YtBrowseError('closed')
      const raw = data && typeof data === 'object' ? data as Record<string, unknown> : {}
      if (['not-ready', 'ad-playing', 'snapshot-unavailable', 'snapshot-too-large', 'origin-tainted'].includes(String(raw.errorCode))) throw new YtBrowseError(raw.errorCode as YtBrowseErrorCode)
      if (!(raw.rgba instanceof Uint8Array)) throw new YtBrowseError('snapshot-unavailable')
      const width = raw.videoWidth, height = raw.videoHeight
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1
        || (width as number) > MAX_FRAME_WIDTH || (height as number) > MAX_FRAME_HEIGHT) throw new YtBrowseError('snapshot-unavailable')
      if (raw.rgba.byteLength !== (width as number) * (height as number) * 4 || width !== state.videoWidth || height !== state.videoHeight
        || typeof raw.currentTime !== 'number' || !Number.isFinite(raw.currentTime) || raw.currentTime < 0) throw new YtBrowseError('snapshot-unavailable')
      const rgba = raw.rgba
      const after = await this.state()
      if (generation !== this.generation || after.videoId !== videoId) throw new YtBrowseError('closed')
      if (after.isAd) throw new YtBrowseError('ad-playing')
      if (after.videoWidth !== width || after.videoHeight !== height) throw new YtBrowseError('snapshot-unavailable')
      return { rgba, videoId, approximateTime: raw.currentTime, approximate: true,
        videoWidth: width as number, videoHeight: height as number, width: width as number, height: height as number, isOneToOne: true }
    } catch (error) { throw error instanceof YtBrowseError ? error : new YtBrowseError('snapshot-unavailable') }
    finally { if (generation === this.generation) this.snapshotPending = false }
  }
  async destroyForOwner(ownerId: number): Promise<void> { if (this.ownerId === ownerId) await this.close() }
  async close(): Promise<void> {
    ++this.opening
    await this.teardown()
    await Promise.allSettled([...this.cleanups])
  }
  private async teardown(): Promise<void> {
    ++this.generation
    const view = this.view, owner = this.owner, browserSession = this.browserSession
    const injection = browserSession ? this.injections.get(browserSession) : undefined
    this.view = null; this.browserSession = null
    this.detachOwner?.(); this.detachOwner = null
    this.owner = null; this.ownerId = null; this.value = emptyState()
    this.statePending = false; this.snapshotPending = false
    this.playerOnlyPending = null; this.playerOnlyFailures = 0
    if (this.stateTimer) clearInterval(this.stateTimer)
    this.stateTimer = null
    let destroyed: Promise<void> = Promise.resolve()
    if (view) {
      view.setVisible(false)
      if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) destroyed = new Promise<void>(resolve => {
        view.webContents.once('destroyed', () => resolve())
        view.webContents.close()
      })
    }
    if (!browserSession) { await destroyed; return }
    const cleanup = (async () => {
      await destroyed
      // Await only this session's credential writer before clearing it.
      await injection?.catch(() => {})
      await browserSession.closeAllConnections().catch(() => {})
      await browserSession.clearStorageData().catch(() => {})
      await browserSession.clearCache().catch(() => {})
      browserSession.webRequest.onBeforeRequest(null)
      browserSession.removeAllListeners('will-download')
      browserSession.setPermissionCheckHandler(null)
      browserSession.setPermissionRequestHandler(null)
    })()
    this.cleanups.add(cleanup)
    try { await cleanup } finally { this.cleanups.delete(cleanup) }
  }
}
