import { session, WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { LoginCardState } from './loginCardContracts'
import { loginCardHtml, LOGIN_CARD_CSS, LOGIN_CARD_SCRIPT } from './loginCardDocument'

export interface LoginCardViewOptions {
  id: string
  owner: BrowserWindow
  preload: string
  escape: () => void
  createSession?: (partition: string) => Session
  createView?: (options: Electron.WebContentsViewConstructorOptions) => WebContentsView
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"

/** The credential DOM cannot contact the network or share the remote site's session. */
export class LocalLoginCard {
  readonly url: string
  private view: WebContentsView | null = null
  private session: Session | null = null
  private closed = false

  constructor(private readonly options: LoginCardViewOptions) { this.url = `app://login/${options.id}/` }
  get contents(): WebContents | null { return this.view?.webContents ?? null }

  async open(): Promise<void> {
    const browserSession = (this.options.createSession ?? (partition => session.fromPartition(partition, { cache: false })))(`fy1sync-login-card-${this.options.id}`)
    this.session = browserSession
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.on('will-download', event => event.preventDefault())
    const resources = new Map([
      [this.url, { content: loginCardHtml(), type: 'text/html; charset=utf-8' }],
      [this.url + 'card.js', { content: LOGIN_CARD_SCRIPT, type: 'application/javascript; charset=utf-8' }],
      [this.url + 'card.css', { content: LOGIN_CARD_CSS, type: 'text/css; charset=utf-8' }],
    ])
    browserSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: this.closed || !resources.has(details.url) }))
    await browserSession.protocol.handle('app', request => {
      const resource = resources.get(request.url)
      if (this.closed || request.method !== 'GET' || !resource) return new Response(null, { status: 404 })
      return new Response(resource.content, { headers: { 'content-type': resource.type, 'content-security-policy': CSP, 'cache-control': 'no-store' } })
    })
    if (this.closed || this.options.owner.isDestroyed()) return
    const view = (this.options.createView ?? (options => new WebContentsView(options)))({ webPreferences: {
      session: browserSession, preload: this.options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, spellcheck: false, devTools: false,
      backgroundThrottling: false, navigateOnDragDrop: false,
    } })
    this.view = view
    view.setBackgroundColor('#18181b')
    view.setBorderRadius(8)
    view.setVisible(false)
    this.options.owner.contentView.addChildView(view)
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.setIgnoreMenuShortcuts(true)
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-redirect', event => event.preventDefault())
    contents.on('will-frame-navigate', event => event.preventDefault())
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase()
      if (key === 'escape') { event.preventDefault(); this.options.escape(); return }
      if (['f5', 'f12'].includes(key) || (input.control || input.meta) && ['r', 'o', 'p', 's'].includes(key)) event.preventDefault()
    })
    await contents.loadURL(this.url)
  }

  publish(state: LoginCardState): void {
    const contents = this.contents
    if (!this.closed && contents && !contents.isDestroyed() && contents.mainFrame.url === this.url) contents.send('stream-syncer:login-card-state', state)
  }
  setBounds(rect: Electron.Rectangle, visible: boolean): void {
    if (this.closed || !this.view) return
    this.view.setBounds(rect)
    this.view.setVisible(visible && rect.width > 0 && rect.height > 0)
  }
  hide(): void { if (!this.closed) this.view?.setVisible(false) }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const view = this.view
    if (view) {
      try { view.setVisible(false) } catch { /* Keep clearing the isolated credential session. */ }
      try { if (!this.options.owner.isDestroyed()) this.options.owner.contentView.removeChildView(view) } catch { /* The owner may have destroyed its views. */ }
      try { if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false }) } catch { /* Storage must still be cleared. */ }
    }
    if (this.session) {
      await this.session.closeAllConnections().catch(() => {})
      await Promise.allSettled([this.session.clearStorageData(), this.session.clearCache()])
      try { this.session.protocol.unhandle('app') } catch { /* The session may already have released its handler. */ }
    }
  }
}
