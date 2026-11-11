import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Session, WebContentsView } from 'electron'
import type { BrowserCookie } from './cookies'
import type { EmbeddedLoginPlatform } from './embeddedLoginContracts'
import type { LoginCardAction, LoginPageActionResult, LoginPageSnapshot } from './loginCardContracts'
import type { LocalLoginCard, LoginCardViewOptions } from './loginCardView'

vi.mock('electron', () => ({ session: {}, WebContentsView: class {}, View: class {
  setBounds = vi.fn(); setVisible = vi.fn(); setBackgroundColor = vi.fn(); setBorderRadius = vi.fn(); addChildView = vi.fn(); removeChildView = vi.fn()
}, nativeImage: { createFromBuffer: vi.fn(() => ({
  isEmpty: () => false, getSize: () => ({ width: 160, height: 160 }), toDataURL: () => 'data:image/png;base64,c3ludGhldGljLXFyLWltYWdl',
})) } }))

import { EmbeddedLoginController } from './embeddedLogin'
import { LOGIN_ADAPTERS } from './loginAdapters'

function credentials(platform: EmbeddedLoginPlatform, uid = '1001'): BrowserCookie[] {
  const fields = platform === 'bilibili' ? { DedeUserID: uid, SESSDATA: 'synthetic-ticket' }
    : platform === 'huya' ? { udb_uid: uid, udb_biztoken: 'synthetic-ticket' } : { acf_uid: uid, acf_auth: 'synthetic-ticket' }
  return Object.entries(fields).map(([name, value]) => ({ name, value, domain: `.${platform}.com`, path: '/', secure: true, httpOnly: true, session: true }))
}
function identity(platform: EmbeddedLoginPlatform, uid = 1001): unknown {
  return platform === 'bilibili' ? { code: 0, data: { isLogin: true, mid: uid } }
    : platform === 'huya' ? { isLogined: true, uid } : { error: 0, msg: { uid, info: { uid } } }
}

const controllers: EmbeddedLoginController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.dispose())); vi.restoreAllMocks() })

function setup(captchaReady = true) {
  let platform: EmbeddedLoginPlatform = 'bilibili'
  let snapshot: LoginPageSnapshot = { page: 'form', mode: 'password', qrStatus: 'unavailable' }
  let action: ((expression: string) => Promise<LoginPageActionResult>) | undefined
  const actionExpressions: string[] = []
  const ownerContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'app://app/' }, isDestroyed: () => false, getZoomFactor: () => 1.25, focus: vi.fn(),
  })
  const owner = { webContents: ownerContents, isDestroyed: () => false, isVisible: vi.fn(() => true), isMinimized: vi.fn(() => false), getContentSize: () => [1000, 700],
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
  let cookies: BrowserCookie[] = []
  const jar = Object.assign(new EventEmitter(), { get: vi.fn(async () => cookies), set: vi.fn(async () => {}) })
  let requestHandler: ((details: { id?: number; url: string; resourceType: string; method?: string; webContentsId?: number }, callback: (value: { cancel: boolean }) => void) => void) | undefined
  let completedHandler: ((details: { id: number; statusCode?: number; webContentsId?: number }) => void) | undefined
  let errorHandler: typeof completedHandler
  const browserSession = Object.assign(new EventEmitter(), {
    cookies: jar, setProxy: vi.fn(async () => {}), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn(handler => { requestHandler = handler }),
      onCompleted: vi.fn(handler => { completedHandler = handler }), onErrorOccurred: vi.fn(handler => { errorHandler = handler }) },
    closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
    fetch: vi.fn(async (_url: string, _options: unknown): Promise<Response> => new Response(JSON.stringify({ code: -101, data: { isLogin: false } }))),
  })
  const remoteContents = Object.assign(new EventEmitter(), {
    id: 42, mainFrame: { url: '' }, isDestroyed: () => false, close: vi.fn(), capturePage: vi.fn(async () => ({})), setIgnoreMenuShortcuts: vi.fn(), setWindowOpenHandler: vi.fn(), setAudioMuted: vi.fn(), getZoomFactor: () => 1,
    loadURL: vi.fn(async (url: string) => {
      remoteContents.mainFrame.url = platform === 'douyu' && url === LOGIN_ADAPTERS.douyu.entryUrl ? 'https://passport.douyu.com/member/login' : url
      if (captchaReady && platform === 'bilibili' && url !== 'about:blank') completeCaptchaPreflight()
    }),
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand: vi.fn(async (method: string, args?: unknown): Promise<unknown> => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1', loaderId: 'load-1', url: remoteContents.mainFrame.url },
        ...(platform === 'huya' ? { childFrames: [{ frame: { id: 'frame-2', loaderId: 'load-2', url: 'https://aq.huya.com/p/udb_login.html' } }] } : {}) } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
      if (method === 'Target.getTargets') return { targetInfos: [] }
      if (method === 'Page.enable' || method === 'Page.addScriptToEvaluateOnNewDocument' || method === 'Emulation.setDeviceMetricsOverride') return {}
      const expression = (args as { expression?: string } | undefined)?.expression ?? ''
      if (expression === LOGIN_ADAPTERS[platform].inspectScript) return { result: { value: structuredClone(snapshot) } }
      if (expression === LOGIN_ADAPTERS[platform].prepareScript) return { result: { value: { ok: true } } }
      actionExpressions.push(expression)
      return { result: { value: action ? await action(expression) : { ok: true } } }
    }) },
  })
  const view = { webContents: remoteContents, setVisible: vi.fn(), setBackgroundColor: vi.fn(), setBorderRadius: vi.fn(), setBounds: vi.fn() }
  const createSession = vi.fn((_partition: string) => browserSession as unknown as Session)
  const createView = vi.fn((_options: Electron.WebContentsViewConstructorOptions) => view as unknown as WebContentsView)
  const cardContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, isDestroyed: () => false, close: vi.fn() })
  const card = { url: '', contents: cardContents, open: vi.fn(async () => { owner.contentView.addChildView(card) }), publish: vi.fn(),
    setBounds: vi.fn(), hide: vi.fn(), close: vi.fn(async () => { owner.contentView.removeChildView(card); cardContents.close({ waitForBeforeUnload: false }) }) }
  const createCard = vi.fn((options: LoginCardViewOptions) => {
    card.url = `app://login/${options.id}/`
    cardContents.mainFrame.url = card.url
    return card as unknown as LocalLoginCard
  })
  const controller = new EmbeddedLoginController({ owner: () => owner as unknown as BrowserWindow,
    domesticRouting: () => 'direct', createSession, createView, createCard, cardPreload: '/synthetic/login-card-preload.cjs', pollMs: 20, checkTimeoutMs: 500, timeoutMs: 5000 })
  controllers.push(controller)
  const begin = (selected: EmbeddedLoginPlatform = 'bilibili', signal = new AbortController().signal) => {
    if (!controller.state()) platform = selected
    const promise = controller.login({ platform, signal, accountLabel: '测试账号' })
    void promise.catch(() => {})
    return promise
  }
  const startCaptchaPreflight = (id = 101, webContentsId = 42, url = 'https://passport.bilibili.com/x/safecenter/captcha/pre') => {
    requestHandler?.({ id, webContentsId, url, method: 'POST', resourceType: 'xhr' }, () => {})
  }
  const completeCaptchaPreflight = (id = 101) => {
    startCaptchaPreflight(id)
    completedHandler?.({ id, webContentsId: 42, statusCode: 200 })
  }
  return { controller, owner, ownerContents, view, remoteContents, browserSession, jar, createSession, createView, createCard, card, cardContents, begin,
    startCaptchaPreflight, completeCaptchaPreflight,
    endCaptchaPreflight: (id = 101, statusCode = 200, webContentsId = 42) => completedHandler?.({ id, statusCode, webContentsId }),
    failCaptchaPreflight: (id = 101) => errorHandler?.({ id, webContentsId: 42 }),
    setSnapshot: (value: LoginPageSnapshot) => { snapshot = value; remoteContents.emit('dom-ready') },
    setAction: (value: (expression: string) => Promise<LoginPageActionResult>) => { action = value },
    actionCount: () => actionExpressions.length,
    setCookies: (value: BrowserCookie[]) => { cookies = value }, request: (url: string, resourceType = 'other') => {
      const result = vi.fn(); requestHandler?.({ url, resourceType }, result); return result.mock.calls[0]?.[0]
    } }
}

describe('in-app isolated login lifecycle', () => {
  it('keeps second-factor send disabled until the original captcha initialization request completes', async () => {
    const f = setup(false)
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' }, sms: { canSend: true, cooldownSeconds: 0 } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    expect(f.controller.cardState()?.sms.canSend).toBe(false)
    expect(await f.controller.cardAction({ kind: 'second-send' })).toMatchObject({ ok: false })
    f.startCaptchaPreflight()
    expect(f.controller.cardState()?.sms.canSend).toBe(false)
    expect(f.actionCount()).toBe(0)
    f.endCaptchaPreflight()
    await vi.waitFor(() => expect(f.controller.cardState()?.sms.canSend).toBe(true))
    expect(await f.controller.cardAction({ kind: 'second-send' })).toEqual({ ok: true })
    expect(f.actionCount()).toBe(1)
  })

  it('ignores unrelated and superseded captcha preparation completions', async () => {
    const f = setup(false)
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' }, sms: { canSend: true, cooldownSeconds: 0 } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    f.startCaptchaPreflight(100, 9)
    f.endCaptchaPreflight(100, 200, 9)
    f.startCaptchaPreflight(101, 42, 'https://passport.bilibili.com/x/safecenter/common/sms/send')
    f.endCaptchaPreflight(101)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.controller.cardState()?.sms.canSend).toBe(false)
    f.startCaptchaPreflight(102)
    f.startCaptchaPreflight(103)
    f.endCaptchaPreflight(102)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.controller.cardState()?.sms.canSend).toBe(false)
    f.endCaptchaPreflight(103)
    await vi.waitFor(() => expect(f.controller.cardState()?.sms.canSend).toBe(true))
  })

  it('keeps failed preparation blocked and accepts a later successful official preparation', async () => {
    const f = setup(false)
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' }, sms: { canSend: true, cooldownSeconds: 0 } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    f.startCaptchaPreflight()
    f.failCaptchaPreflight()
    await vi.waitFor(() => expect(f.controller.cardState()?.message).toContain('准备失败'))
    expect(await f.controller.cardAction({ kind: 'second-send' })).toMatchObject({ ok: false })
    f.completeCaptchaPreflight(102)
    await vi.waitFor(() => expect(f.controller.cardState()?.sms.canSend).toBe(true))
    expect(f.actionCount()).toBe(0)
    await f.controller.cancel(f.controller.state()!.id)
    expect(f.browserSession.webRequest.onCompleted).toHaveBeenLastCalledWith(null)
    expect(f.browserSession.webRequest.onErrorOccurred).toHaveBeenLastCalledWith(null)
  })

  it('invalidates captcha preparation after a risk-document navigation', async () => {
    const f = setup(false)
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' }, sms: { canSend: true, cooldownSeconds: 0 } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    f.startCaptchaPreflight()
    f.remoteContents.emit('did-start-navigation', {}, 'https://passport.bilibili.com/pc/passport/riskVerify', false, true)
    f.endCaptchaPreflight()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.controller.cardState()?.sms.canSend).toBe(false)
    f.completeCaptchaPreflight(102)
    await vi.waitFor(() => expect(f.controller.cardState()?.sms.canSend).toBe(true))
  })

  it('keeps the hidden second-factor renderer active without exposing or focusing its page', async () => {
    const f = setup()
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    f.controller.setViewport({ id: f.controller.state()!.id, visible: true, rect: { x: 30, y: 60, width: 700, height: 480 } })
    await vi.waitFor(() => expect(f.remoteContents.capturePage).toHaveBeenCalled())
    expect(f.remoteContents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: false, stayAwake: false })
    expect(f.view.setVisible).not.toHaveBeenCalledWith(true)
    expect(f.actionCount()).toBe(0)
    expect(f.ownerContents.focus).not.toHaveBeenCalled()
    const count = f.remoteContents.capturePage.mock.calls.length
    await f.controller.cancel(f.controller.state()!.id)
    await new Promise(resolve => setTimeout(resolve, 230))
    expect(f.remoteContents.capturePage).toHaveBeenCalledTimes(count)
  })

  it('keeps the hidden Huya renderer painting before and during captcha preparation', async () => {
    const f = setup()
    f.begin('huya')
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    f.controller.setViewport({ id: f.controller.state()!.id, visible: true, rect: { x: 30, y: 60, width: 700, height: 480 } })
    await vi.waitFor(() => expect(f.remoteContents.capturePage).toHaveBeenCalled())
    const count = f.remoteContents.capturePage.mock.calls.length
    f.setSnapshot({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    await vi.waitFor(() => expect(f.controller.cardState()?.message).toBe('正在加载人机验证'))
    await vi.waitFor(() => expect(f.remoteContents.capturePage.mock.calls.length).toBeGreaterThan(count))
    expect(f.controller.state()?.presentation).toBe('form')
    expect(f.view.setVisible).not.toHaveBeenCalledWith(true)
    expect(f.actionCount()).toBe(0)
    expect(f.ownerContents.focus).not.toHaveBeenCalled()
  })

  it('serializes rendering pulses and skips a minimized owner or explicit official page', async () => {
    const f = setup()
    let release!: () => void
    f.remoteContents.capturePage.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}) }))
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    f.owner.isMinimized.mockReturnValue(true)
    f.controller.setViewport({ id: f.controller.state()!.id, visible: true, rect: { x: 30, y: 60, width: 700, height: 480 } })
    await new Promise(resolve => setTimeout(resolve, 230))
    expect(f.remoteContents.capturePage).not.toHaveBeenCalled()
    f.owner.isMinimized.mockReturnValue(false)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await new Promise(resolve => setTimeout(resolve, 230))
    expect(f.remoteContents.capturePage).toHaveBeenCalledTimes(1)
    await f.controller.cardAction({ kind: 'official' })
    release()
    await new Promise(resolve => setTimeout(resolve, 230))
    expect(f.remoteContents.capturePage).toHaveBeenCalledTimes(1)
    expect(f.controller.state()?.presentation).toBe('official')
  })

  it('retries an unavailable rendering surface without retrying the login action', async () => {
    const f = setup()
    f.remoteContents.capturePage.mockRejectedValueOnce(new Error('Surface is not ready'))
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    f.controller.setViewport({ id: f.controller.state()!.id, visible: true, rect: { x: 30, y: 60, width: 700, height: 480 } })
    await vi.waitFor(() => expect(f.remoteContents.capturePage.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(f.controller.state()?.phase).toBe('ready')
    expect(f.actionCount()).toBe(0)
  })

  it('attaches an unprivileged native view to the existing owner with isolated session and route', async () => {
    const fixture = setup()
    fixture.begin()
    await vi.waitFor(() => expect(fixture.controller.state()?.phase).toBe('ready'))
    expect(fixture.owner.contentView.addChildView).toHaveBeenCalledWith(fixture.view)
    expect(fixture.owner.contentView.addChildView).toHaveBeenCalledWith(fixture.card)
    expect(fixture.createCard).toHaveBeenCalledWith(expect.objectContaining({ preload: '/synthetic/login-card-preload.cjs' }))
    expect(fixture.createSession.mock.calls[0]?.[0]).toMatch(/^fy1sync-login-[a-f0-9-]+$/)
    expect(fixture.browserSession.setProxy).toHaveBeenCalledWith({ mode: 'direct' })
    const preferences = fixture.createView.mock.calls[0]?.[0] as unknown as { webPreferences: Record<string, unknown> }
    expect(preferences.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true })
    expect(preferences.webPreferences).not.toHaveProperty('preload')
    expect(fixture.remoteContents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', { width: 760, height: 520, deviceScaleFactor: 0, mobile: false })
    expect(fixture.remoteContents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ contextId: 17 }), undefined)
    expect(fixture.request('https://local.passport.douyu.com:49155/pcclient/getUserInfo')).toEqual({ cancel: true })
    expect(fixture.request('https://example.com/')).toEqual({ cancel: true })
  })

  it('requires an explicit server identity and does not treat cookies as login completion', async () => {
    const fixture = setup()
    fixture.setCookies(credentials('bilibili'))
    fixture.begin()
    await vi.waitFor(() => expect(fixture.browserSession.fetch).toHaveBeenCalled())
    expect(fixture.controller.state()).not.toBeNull()
    expect(fixture.view.webContents.close).not.toHaveBeenCalled()
  })

  it.each(['bilibili', 'huya', 'douyu'] as const)('verifies and returns only %s cookies after closing its view', async platform => {
    const fixture = setup()
    const expected = credentials(platform)
    fixture.setCookies([...expected, { name: 'other', value: 'private', domain: '.example.com' }])
    fixture.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify(identity(platform))))
    const result = fixture.begin(platform)
    await expect(result).resolves.toEqual(expected.map(cookie => expect.objectContaining(cookie)))
    expect(fixture.controller.state()).toBeNull()
    expect(fixture.owner.contentView.removeChildView).toHaveBeenCalledWith(fixture.view)
    expect(fixture.browserSession.clearStorageData).toHaveBeenCalled()
    expect(fixture.remoteContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(fixture.card.close).toHaveBeenCalledOnce()
    expect(fixture.browserSession.fetch).toHaveBeenCalledWith(expect.stringMatching(/^https:/), expect.objectContaining({ credentials: 'include', redirect: 'manual' }))
  })

  it('rejects a mismatching returned account identity', async () => {
    const fixture = setup()
    fixture.setCookies(credentials('bilibili'))
    fixture.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify(identity('bilibili', 1002))))
    fixture.begin()
    await vi.waitFor(() => expect(fixture.browserSession.fetch).toHaveBeenCalled())
    expect(fixture.controller.state()).not.toBeNull()
  })

  it('does not accept an unrelated path cookie as the saved account identity', async () => {
    const fixture = setup()
    fixture.setCookies([...credentials('bilibili', '2002'), { domain: '.bilibili.com', name: 'DedeUserID', value: '1001', path: '/unrelated', session: true }])
    fixture.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify(identity('bilibili'))))
    fixture.begin()
    await vi.waitFor(() => expect(fixture.browserSession.fetch).toHaveBeenCalled())
    expect(fixture.controller.state()).not.toBeNull()
    expect(fixture.remoteContents.close).not.toHaveBeenCalled()
  })

  it('ignores an identity response from before a cookie change', async () => {
    const fixture = setup()
    fixture.setCookies(credentials('bilibili'))
    let respond!: (value: Response) => void
    fixture.browserSession.fetch.mockImplementation(() => new Promise(resolve => { respond = resolve }))
    fixture.begin()
    await vi.waitFor(() => expect(fixture.browserSession.fetch).toHaveBeenCalled())
    fixture.setCookies(credentials('bilibili', '2002'))
    fixture.jar.emit('changed')
    respond(new Response(JSON.stringify(identity('bilibili'))))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fixture.controller.state()).not.toBeNull()
    expect(fixture.remoteContents.close).not.toHaveBeenCalled()
  })

  it('cancels only the matching attempt and prevents late completion after abort', async () => {
    const fixture = setup()
    const abort = new AbortController()
    const result = fixture.begin('bilibili', abort.signal)
    await vi.waitFor(() => expect(fixture.controller.state()?.phase).toBe('ready'))
    await fixture.controller.cancel('other-id')
    expect(fixture.controller.state()).not.toBeNull()
    abort.abort()
    await expect(result).rejects.toMatchObject({ code: 'login-cancelled' })
    fixture.setCookies(credentials('bilibili'))
    fixture.jar.emit('changed')
    expect(fixture.controller.state()).toBeNull()
    expect(fixture.browserSession.fetch).not.toHaveBeenCalled()
  })

  it('does not replace a current card with a second account request', async () => {
    const fixture = setup()
    const first = fixture.begin()
    const id = fixture.controller.state()!.id
    await expect(fixture.begin('huya')).rejects.toMatchObject({ code: 'login-busy' })
    expect(fixture.controller.state()?.id).toBe(id)
    await fixture.controller.cancel(id)
    await expect(first).rejects.toMatchObject({ code: 'login-cancelled' })
  })

  it('clips the native view to the app content at its actual zoom and hides it on close', async () => {
    const fixture = setup()
    fixture.begin()
    await vi.waitFor(() => expect(fixture.controller.state()?.phase).toBe('ready'))
    const id = fixture.controller.state()!.id
    fixture.controller.setViewport({ id, visible: true, rect: { x: -10, y: 100, width: 1000, height: 1000 } })
    expect(fixture.card.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 125, width: 1000, height: 575 }, true)
    expect(fixture.view.setVisible).toHaveBeenLastCalledWith(false)
    await fixture.controller.cardAction({ kind: 'official' })
    expect(fixture.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 125, width: 1000, height: 575 })
    expect(fixture.view.setVisible).toHaveBeenLastCalledWith(true)
    await fixture.controller.cancel(id)
    expect(fixture.view.setVisible).toHaveBeenLastCalledWith(false)
    expect(fixture.card.close).toHaveBeenCalledOnce()
  })

  it('cancels on owner navigation and releases the remote session', async () => {
    const fixture = setup()
    const result = fixture.begin()
    await vi.waitFor(() => expect(fixture.controller.state()?.phase).toBe('ready'))
    fixture.ownerContents.emit('will-navigate')
    await expect(result).rejects.toMatchObject({ code: 'login-cancelled' })
    expect(fixture.browserSession.closeAllConnections).toHaveBeenCalledOnce()
  })

  it('does not replace a successful retry with an older page load failure', async () => {
    const fixture = setup()
    let failOld!: (reason: Error) => void
    fixture.remoteContents.loadURL.mockImplementationOnce(async url => { fixture.remoteContents.mainFrame.url = url })
      .mockImplementationOnce(() => new Promise((_yes, no) => { failOld = no }))
    fixture.begin()
    await vi.waitFor(() => expect(fixture.remoteContents.loadURL).toHaveBeenCalledTimes(2))
    await fixture.controller.retry(fixture.controller.state()!.id)
    expect(fixture.controller.state()?.phase).toBe('ready')
    failOld(new Error('Old navigation failed'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fixture.controller.state()?.phase).toBe('ready')
  })

  it('shares pending session preparation when retry arrives before the view exists', async () => {
    const fixture = setup()
    let prepared!: () => void
    fixture.browserSession.setProxy.mockImplementation(() => new Promise(resolve => { prepared = resolve }))
    fixture.begin()
    const retry = fixture.controller.retry(fixture.controller.state()!.id)
    expect(fixture.browserSession.setProxy).toHaveBeenCalledOnce()
    prepared()
    await retry
    expect(fixture.createView).toHaveBeenCalledOnce()
  })
})

describe('private local login-card transitions', () => {
  it('owns only the current local card exact contents and top frame, never main, remote or copied frames', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    const owns = (contents: unknown, frame: unknown) => f.controller.ownsCard(contents as Electron.WebContents, frame as Electron.WebFrameMain)
    expect(owns(f.cardContents, f.cardContents.mainFrame)).toBe(true)
    expect(owns(f.ownerContents, f.ownerContents.mainFrame)).toBe(false)
    expect(owns(f.remoteContents, f.remoteContents.mainFrame)).toBe(false)
    expect(owns(f.cardContents, { url: f.card.url })).toBe(false)
    expect(owns({ ...f.cardContents }, f.cardContents.mainFrame)).toBe(false)
    f.cardContents.mainFrame.url = 'https://passport.bilibili.com/login'
    expect(owns(f.cardContents, f.cardContents.mainFrame)).toBe(false)
    f.cardContents.mainFrame.url = f.card.url
    await f.controller.cancel(f.controller.state()!.id)
    expect(owns(f.cardContents, f.cardContents.mainFrame)).toBe(false)
  })

  it('keeps QR image and verification details private to the local card', async () => {
    const f = setup()
    f.setSnapshot({ page: 'form', mode: 'password', qrStatus: 'ready', qr: { src: `data:image/png;base64,${Buffer.alloc(32, 1).toString('base64')}` } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.qr.image).toContain('data:image/png'))
    expect(f.controller.state()).not.toHaveProperty('qr')
    expect(f.controller.state()).not.toHaveProperty('mode')
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    expect(f.controller.state()).toMatchObject({ presentation: 'verification' })
    expect(f.controller.state()).not.toHaveProperty('verification')
    expect(JSON.stringify(f.controller.state())).not.toContain('138****0000')
  })

  it('does not complete a pending second-factor form even when authentication cookies exist', async () => {
    const f = setup()
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'email', maskedTarget: 'f***@example.test' } })
    f.setCookies(credentials('bilibili'))
    f.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify(identity('bilibili'))))
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(f.browserSession.fetch).not.toHaveBeenCalled()
    expect(f.controller.state()).not.toBeNull()
    expect(f.request('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=fixture')).toEqual({ cancel: true })
    expect(await f.controller.cardAction({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true })).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(0)
  })

  it('does not finish an older identity check after the page enters second-factor verification', async () => {
    const f = setup()
    f.setCookies(credentials('bilibili'))
    let respond!: (value: Response) => void
    f.browserSession.fetch.mockImplementation(() => new Promise(resolve => { respond = resolve }))
    let completed = false
    void f.begin().then(() => { completed = true }, () => {})
    await vi.waitFor(() => expect(f.browserSession.fetch).toHaveBeenCalled())
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    respond(new Response(JSON.stringify(identity('bilibili'))))
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(completed).toBe(false)
    expect(f.controller.cardState()?.stage).toBe('verification')
    expect(f.remoteContents.close).not.toHaveBeenCalled()
  })

  it('dispatches mode once without implicitly sending SMS or logging in', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    f.setAction(async () => { f.setSnapshot({ page: 'form', mode: 'sms', qrStatus: 'unavailable' }); return { ok: true } })
    expect(await f.controller.cardAction({ kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.controller.cardState()?.mode).toBe('sms'))
    expect(f.actionCount()).toBe(1)
  })

  it.each(['password', 'sms'] as const)('submits %s exactly once and gates a duplicate while waiting for the result', async kind => {
    const f = setup()
    f.setSnapshot({ page: 'form', mode: kind === 'password' ? 'password' : 'sms' })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    const make = (): LoginCardAction => kind === 'password' ? { kind, username: 'fixture-user', password: 'fixture-secret', accepted: true }
      : { kind, phone: '13800000000', countryCode: '+86', code: '123456', accepted: true }
    const value = make()
    expect(await f.controller.cardAction(value)).toEqual({ ok: true })
    expect(await f.controller.cardAction(make())).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(1)
    expect(f.controller.cardState()?.qr.status).toBe('paused')
    expect('password' in value ? value.password : 'code' in value ? value.code : undefined).toBe('')
    expect(JSON.stringify(f.controller.cardState())).not.toMatch(/fixture-secret|123456/)
  })

  it.each(['send-sms', 'second-send'] as const)('waits for the webpage send result and mirrors its cooldown after %s', async kind => {
    const f = setup()
    const base: LoginPageSnapshot = kind === 'second-send' ? { page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } } : { page: 'form', mode: 'sms' }
    f.setSnapshot({ ...base, sms: { canSend: true, cooldownSeconds: 0 } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe(kind === 'second-send' ? 'verification' : 'form'))
    const action: LoginCardAction = kind === 'second-send' ? { kind } : { kind, phone: '13800000000', countryCode: '+86', accepted: true }
    expect(await f.controller.cardAction(action)).toEqual({ ok: true })
    expect(f.controller.cardState()?.sms).toEqual({ canSend: false, cooldownSeconds: null })
    f.setSnapshot({ ...base, sms: { canSend: false, cooldownSeconds: 37 } })
    await vi.waitFor(() => expect(f.controller.cardState()?.sms.cooldownSeconds).toBe(37))
    expect(await f.controller.cardAction({ ...action })).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(1)
    f.setSnapshot({ ...base, sms: { canSend: false, cooldownSeconds: 12 } })
    await vi.waitFor(() => expect(f.controller.cardState()?.sms.cooldownSeconds).toBe(12))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.controller.cardState()?.sms.cooldownSeconds).toBe(12)
  })

  it('only permits second-factor submit in verification and does not resend or return the submitted code', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    expect(await f.controller.cardAction({ kind: 'second-submit', code: '123456' })).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(0)
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    const action: LoginCardAction = { kind: 'second-submit', code: '123456' }
    expect(await f.controller.cardAction(action)).toEqual({ ok: true })
    expect(f.actionCount()).toBe(1)
    expect(action.code).toBe('')
    expect(JSON.stringify(f.controller.cardState())).not.toContain('123456')
  })

  it('rejects a repeated second-factor submit while its one broker action is still in flight', async () => {
    const f = setup()
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    let finish!: (value: LoginPageActionResult) => void
    f.setAction(() => new Promise(resolve => { finish = resolve }))
    const pending = f.controller.cardAction({ kind: 'second-submit', code: '123456' })
    await vi.waitFor(() => expect(f.actionCount()).toBe(1))
    expect(await f.controller.cardAction({ kind: 'second-submit', code: '123456' })).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(1)
    finish({ ok: true })
    expect(await pending).toEqual({ ok: true })
  })

  it('keeps second-factor submission pending until its official result rather than only the click', async () => {
    const f = setup()
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    expect(await f.controller.cardAction({ kind: 'second-submit', code: '123456' })).toEqual({ ok: true })
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    await new Promise(resolve => setTimeout(resolve, 45))
    expect(f.controller.cardState()?.busy).toBe(true)
    expect(await f.controller.cardAction({ kind: 'second-submit', code: '123456' })).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(1)
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' }, error: 'invalid-code' })
    await vi.waitFor(() => expect(f.controller.cardState()?.busy).toBe(false))
  })

  it('does not let a delayed QR image reset a submitted form back to editable', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    let finishQr!: (value: Response) => void
    f.browserSession.fetch.mockImplementation(() => new Promise(resolve => { finishQr = resolve }))
    f.setSnapshot({ page: 'form', mode: 'password', qrStatus: 'ready', qr: { src: 'https://passport.bilibili.com/qr-image.png' } })
    await vi.waitFor(() => expect(finishQr).toBeTypeOf('function'))
    expect(await f.controller.cardAction({ kind: 'password', username: 'fixture-user', password: 'fixture-secret', accepted: true })).toEqual({ ok: true })
    finishQr(new Response(Buffer.alloc(32, 1)))
    await new Promise(resolve => setTimeout(resolve, 45))
    expect(f.controller.cardState()?.stage).toBe('submitting')
    expect(await f.controller.cardAction({ kind: 'password', username: 'fixture-user', password: 'fixture-secret', accepted: true })).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(1)
  })

  it('uses the new page send control when transitioning to second-factor verification', async () => {
    const f = setup()
    f.setSnapshot({ page: 'form', mode: 'sms', sms: { canSend: true, cooldownSeconds: 0 } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    expect(await f.controller.cardAction({ kind: 'send-sms', phone: '13800000000', countryCode: '+86', accepted: true })).toEqual({ ok: true })
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' }, sms: { canSend: false, cooldownSeconds: 17 } })
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    expect(f.controller.cardState()?.sms.cooldownSeconds).toBe(17)
    expect(await f.controller.cardAction({ kind: 'second-send' })).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(1)
  })

  it('returns from a challenge without reloading its document or clearing the SMS handshake', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    const loads = f.remoteContents.loadURL.mock.calls.length
    f.setSnapshot({ page: 'challenge', challenge: { x: 100, y: 80, width: 340, height: 300 } })
    await vi.waitFor(() => expect(f.controller.state()?.presentation).toBe('captcha'))
    await f.controller.back(f.controller.state()!.id)
    expect(f.remoteContents.loadURL).toHaveBeenCalledTimes(loads)
    expect(f.controller.cardState()?.stage).toBe('form')
  })

  it('keeps a login submission locked after captcha completes until the server result arrives', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    expect(await f.controller.cardAction({ kind: 'password', username: 'fixture-user', password: 'fixture-secret', accepted: true })).toEqual({ ok: true })
    f.setSnapshot({ page: 'challenge', challenge: { x: 100, y: 80, width: 340, height: 300 } })
    await vi.waitFor(() => expect(f.controller.state()?.presentation).toBe('captcha'))
    f.setSnapshot({ page: 'form', mode: 'password' })
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('submitting'))
    expect(await f.controller.cardAction({ kind: 'password', username: 'fixture-user', password: 'fixture-secret', accepted: true })).toMatchObject({ ok: false })
    expect(f.actionCount()).toBe(1)
    f.setSnapshot({ page: 'form', mode: 'password', error: 'invalid-credentials' })
    await vi.waitFor(() => expect(f.controller.cardState()?.busy).toBe(false))
  })

  it('finishes after official identity succeeds even if a completed captcha wrapper remains visible', async () => {
    const f = setup()
    f.setSnapshot({ page: 'challenge' })
    const result = f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('submitting'))
    f.setCookies(credentials('bilibili'))
    f.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify(identity('bilibili'))))
    await expect(result).resolves.toHaveLength(2)
  })

  it('verifies exchanged credentials after second-factor completion without waiting for website navigation', async () => {
    const f = setup()
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    const result = f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    const navigationCount = f.remoteContents.loadURL.mock.calls.length
    await f.controller.cardAction({ kind: 'second-submit', code: '123456' })
    f.setCookies(credentials('bilibili'))
    f.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify(identity('bilibili'))))
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' }, verificationCompleted: true })
    await expect(result).resolves.toHaveLength(2)
    expect(f.remoteContents.loadURL).toHaveBeenCalledTimes(navigationCount)
    expect(f.actionCount()).toBe(1)
    expect(f.browserSession.fetch).toHaveBeenCalledWith('https://api.bilibili.com/x/web-interface/nav', expect.objectContaining({ credentials: 'include' }))
  })

  it('does not accept a completion hint alone or an anonymous identity as login success', async () => {
    const f = setup()
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' }, verificationCompleted: true })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.message).toContain('安全验证已完成'))
    expect(f.browserSession.fetch).not.toHaveBeenCalled()
    f.setCookies(credentials('bilibili'))
    await vi.waitFor(() => expect(f.browserSession.fetch).toHaveBeenCalled())
    expect(f.controller.state()).not.toBeNull()
    expect(f.remoteContents.close).not.toHaveBeenCalled()
  })

  it('verifies credentials after the official second-factor document redirects without a visible success toast', async () => {
    const f = setup()
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' } })
    const result = f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    await f.controller.cardAction({ kind: 'second-submit', code: '123456' })
    f.setCookies(credentials('bilibili'))
    f.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify(identity('bilibili'))))
    f.remoteContents.mainFrame.url = 'https://www.bilibili.com/'
    f.remoteContents.emit('did-start-navigation', {}, f.remoteContents.mainFrame.url, false, true)
    f.setSnapshot({ page: 'unknown' })
    await expect(result).resolves.toHaveLength(2)
    expect(f.actionCount()).toBe(1)
  })

  it('does not finish second-factor verification while an overlaid captcha or its loading screen remains', async () => {
    const f = setup()
    f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('verification'))
    await f.controller.cardAction({ kind: 'second-submit', code: '123456' })
    f.setCookies(credentials('bilibili'))
    f.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify(identity('bilibili'))))
    f.setSnapshot({ page: 'challenge', challengePhase: 'interactive', challenge: { x: 100, y: 80, width: 340, height: 300 } })
    await vi.waitFor(() => expect(f.controller.state()?.presentation).toBe('captcha'))
    f.setSnapshot({ page: 'loading', challengePhase: 'passed' })
    await vi.waitFor(() => expect(f.controller.state()?.presentation).toBe('verification'))
    expect(f.browserSession.fetch).not.toHaveBeenCalled()
    expect(f.controller.state()).not.toBeNull()
  })

  it('keeps an oversized challenge from revealing the background website', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    f.controller.setViewport({ id: f.controller.state()!.id, visible: true, rect: { x: 50, y: 70, width: 220, height: 180 } })
    f.setSnapshot({ page: 'challenge', challengePhase: 'interactive', challenge: { x: 100, y: 50, width: 340, height: 410 } })
    await vi.waitFor(() => expect(f.controller.cardState()?.message).toContain('放大窗口'))
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false)
    expect(f.card.setBounds).toHaveBeenLastCalledWith({ x: 63, y: 88, width: 275, height: 225 }, true)
    expect(f.controller.state()?.presentation).toBe('captcha')
  })

  it.each(['password', 'second-submit'] as const)('does not expose the complete website after a slow %s result', async kind => {
    const f = setup()
    if (kind === 'second-submit') f.setSnapshot({ page: 'second-factor', verification: { kind: 'sms' } })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe(kind === 'password' ? 'form' : 'verification'))
    const startedAt = Date.now()
    await f.controller.cardAction(kind === 'password' ? { kind, username: 'fixture', password: 'fixture', accepted: true } : { kind, code: '123456' })
    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 13_000)
    f.setSnapshot(kind === 'password' ? { page: 'form', mode: 'password' } : { page: 'second-factor', verification: { kind: 'sms' } })
    await vi.waitFor(() => expect(f.controller.cardState()?.message).toContain('平台仍在处理'))
    expect(f.controller.state()?.presentation).toBe(kind === 'password' ? 'form' : 'verification')
    expect(f.controller.cardState()?.busy).toBe(true)
    expect(f.view.setVisible).not.toHaveBeenCalledWith(true)
    expect(f.actionCount()).toBe(1)
    await f.controller.cardAction({ kind: 'official' })
    expect(f.controller.state()?.presentation).toBe('official')
  })

  it.each(['loading', 'verifying', 'passed', 'unknown'] as const)('returns a transient captcha %s screen to the local card', async challengePhase => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    await f.controller.cardAction({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true })
    f.setSnapshot({ page: 'challenge', challengePhase: 'interactive', challenge: { x: 100, y: 80, width: 340, height: 300 } })
    await vi.waitFor(() => expect(f.controller.state()?.presentation).toBe('captcha'))
    f.setSnapshot({ page: 'loading', challengePhase, qrStatus: 'paused' })
    await vi.waitFor(() => expect(f.controller.state()?.presentation).toBe('form'))
    expect(f.controller.cardState()?.busy).toBe(true)
    expect(f.actionCount()).toBe(1)
    expect(f.controller.state()).not.toBeNull()
  })

  it('waits in the local form for an unknown page until the user chooses the official view', async () => {
    const f = setup()
    f.setSnapshot({ page: 'unknown' })
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('submitting'))
    expect(f.controller.state()?.presentation).toBe('form')
    expect(f.view.setVisible).not.toHaveBeenCalledWith(true)
    await f.controller.cardAction({ kind: 'official' })
    expect(f.controller.state()?.presentation).toBe('official')
  })

  it('does not discard identity confirmation when only a visitor cookie changed', async () => {
    const f = setup()
    f.setCookies(credentials('bilibili'))
    let respond!: (value: Response) => void
    f.browserSession.fetch.mockImplementation(() => new Promise(resolve => { respond = resolve }))
    const result = f.begin()
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'))
    f.setCookies([...credentials('bilibili'), { domain: '.bilibili.com', name: 'visitor', value: 'new-value' }])
    f.jar.emit('changed')
    respond(new Response(JSON.stringify(identity('bilibili'))))
    await expect(result).resolves.toHaveLength(3)
  })

  it('cancels an in-flight action and ignores its late success without subsequent dispatch', async () => {
    const f = setup()
    const login = f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    let finish!: (value: LoginPageActionResult) => void
    f.setAction(() => new Promise(resolve => { finish = resolve }))
    const pending = f.controller.cardAction({ kind: 'mode', mode: 'sms' })
    await vi.waitFor(() => expect(f.actionCount()).toBe(1))
    expect(await f.controller.cardAction({ kind: 'cancel' })).toEqual({ ok: true })
    await expect(login).rejects.toMatchObject({ code: 'login-cancelled' })
    finish({ ok: true })
    expect(await pending).toMatchObject({ ok: false, message: expect.stringContaining('取消') })
    expect(f.actionCount()).toBe(1)
    expect(f.controller.state()).toBeNull()
    expect(f.card.close).toHaveBeenCalledOnce()
  })
})
