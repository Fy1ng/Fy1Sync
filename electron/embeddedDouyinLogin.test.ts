import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, Session, WebContentsView } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserCookie } from './cookies'
import type { LoginCardAction, LoginPageSnapshot } from './loginCardContracts'
import type { LocalLoginCard, LoginCardViewOptions } from './loginCardView'

const fixedAdapter = vi.hoisted(() => ({ entryUrl: 'https://live.douyin.com/',
  acceptsFrame: (raw: string) => raw === 'https://live.douyin.com/',
  inspectScript: 'SYNTHETIC_INSPECT', prepareScript: 'SYNTHETIC_PREPARE',
  presentationScript: (challengeOnly: boolean) => `SYNTHETIC_PRESENT_${challengeOnly}`,
  actionScript: (action: LoginCardAction) => `SYNTHETIC_ACTION(${JSON.stringify(action)})`,
}))
vi.mock('electron', () => ({ session: {}, WebContentsView: class {}, View: class {
  setBounds = vi.fn(); setVisible = vi.fn(); setBackgroundColor = vi.fn(); setBorderRadius = vi.fn()
  addChildView = vi.fn(); removeChildView = vi.fn()
}, nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false, getSize: () => ({ width: 160, height: 160 }),
  toDataURL: () => 'data:image/png;base64,c3ludGhldGljLXFyLWltYWdl',
})) } }))
vi.mock('./loginAdapters', () => ({ LOGIN_ADAPTERS: { douyin: fixedAdapter } }))

import { EmbeddedLoginController } from './embeddedLogin'
import { LoginManager } from './login'
import { CookieStore } from './cookies'

const auth: BrowserCookie = { domain: '.douyin.com', path: '/', name: 'sessionid', value: 'synthetic-private-ticket',
  secure: true, httpOnly: true, session: true }
const controllers: EmbeddedLoginController[] = []
let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-douyin-')) })
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.dispose()))
  fs.rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup(timeoutMs = 5000, options: { initialSnapshot?: LoginPageSnapshot; navigationEvents?: boolean; pollMs?: number } = {}) {
  let snapshot: LoginPageSnapshot = options.initialSnapshot ?? { page: 'form', mode: 'sms', qrStatus: 'unavailable', sms: { canSend: true, cooldownSeconds: 0 } }
  let actionReply: (() => Promise<unknown>) | undefined
  let cookies: BrowserCookie[] = []
  const actions: string[] = []
  const ownerContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'app://app/' },
    isDestroyed: () => false, getZoomFactor: () => 1, focus: vi.fn(), send: vi.fn() })
  const owner = { webContents: ownerContents, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    getContentSize: () => [1000, 700], contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
  const jar = Object.assign(new EventEmitter(), { get: vi.fn(async () => cookies), set: vi.fn(async () => {}) })
  let request: ((details: { url: string; resourceType: string }, callback: (result: { cancel: boolean }) => void) => void) | null = null
  const browserSession = Object.assign(new EventEmitter(), {
    cookies: jar, setProxy: vi.fn(async () => {}), setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn(handler => { request = handler }) },
    closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
    fetch: vi.fn(async (): Promise<Response> => new Response(JSON.stringify({ status: 'unknown' }))),
  })
  const remoteContents = Object.assign(new EventEmitter(), { id: 42, mainFrame: { url: '' }, isDestroyed: () => false,
    close: vi.fn(), capturePage: vi.fn(async () => ({})), getZoomFactor: () => 1,
    getUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Fy1Sync/0.3.2 HeadlessChrome/148.0.0.0 Electron/44.0.0 Safari/537.36',
    setUserAgent: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(), setWindowOpenHandler: vi.fn(), setAudioMuted: vi.fn(),
    loadURL: vi.fn(async (url: string) => {
      if (options.navigationEvents) remoteContents.emit('did-start-navigation', {}, url, false, true)
      remoteContents.mainFrame.url = url
      if (options.navigationEvents) remoteContents.emit('dom-ready')
    }),
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand: vi.fn(async (method: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'official-frame', loaderId: 'loader-1', url: remoteContents.mainFrame.url } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(args?.expression)
      if (expression === fixedAdapter.inspectScript) return { result: { value: structuredClone(snapshot) } }
      if (expression.startsWith('SYNTHETIC_ACTION')) {
        actions.push(expression)
        return { result: { value: actionReply ? await actionReply() : { ok: true } } }
      }
      return { result: { value: { ok: true } } }
    }) },
  })
  const view = { webContents: remoteContents, setVisible: vi.fn(), setBackgroundColor: vi.fn(), setBorderRadius: vi.fn(), setBounds: vi.fn() }
  const createSession = vi.fn((_partition: string) => browserSession as unknown as Session)
  const createView = vi.fn((_options: Electron.WebContentsViewConstructorOptions) => view as unknown as WebContentsView)
  const cardContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, isDestroyed: () => false, close: vi.fn() })
  const card = { url: '', contents: cardContents, open: vi.fn(async () => { owner.contentView.addChildView(card) }), publish: vi.fn(),
    setBounds: vi.fn(), hide: vi.fn(), close: vi.fn(async () => { owner.contentView.removeChildView(card); cardContents.close() }) }
  const createCard = vi.fn((options: LoginCardViewOptions) => {
    card.url = `app://login/${options.id}/`; cardContents.mainFrame.url = card.url
    return card as unknown as LocalLoginCard
  })
  const controller = new EmbeddedLoginController({ owner: () => owner as unknown as BrowserWindow, domesticRouting: () => 'direct',
    cardPreload: '/synthetic/login-card-preload.cjs', createSession, createView, createCard, pollMs: options.pollMs ?? 10, checkTimeoutMs: 1000, timeoutMs })
  controllers.push(controller)
  return { controller, owner, ownerContents, remoteContents, browserSession, jar, view, card, cardContents, createSession, createView, createCard, actions,
    begin: (signal = new AbortController().signal) => { const pending = controller.login({ platform: 'douyin', signal }); void pending.catch(() => {}); return pending },
    setCookies: (value: BrowserCookie[]) => { cookies = value }, setActionReply: (reply: () => Promise<unknown>) => { actionReply = reply },
    setSnapshot: (value: LoginPageSnapshot) => { snapshot = value; remoteContents.emit('dom-ready') },
    request: (url: string, resourceType = 'xhr') => { const result = vi.fn(); request?.({ url, resourceType }, result); return result.mock.calls[0]?.[0] },
  }
}

describe('Douyin isolated local card and official controller', () => {
  describe('official component loading deadline', () => {
    beforeEach(() => { vi.useFakeTimers() })

    function loadingFixture(navigationEvents = true) {
      return setup(120_000, { initialSnapshot: { page: 'loading' }, navigationEvents, pollMs: 400 })
    }

    it('keeps the 30-second deadline through the initial main-frame navigation', async () => {
      const f = loadingFixture()
      f.begin()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.remoteContents.loadURL).toHaveBeenLastCalledWith(fixedAdapter.entryUrl)
      expect(f.controller.cardState()?.stage).not.toBe('form')

      await vi.advanceTimersByTimeAsync(29_999)
      expect(f.controller.cardState()?.stage).not.toBe('failed')
      await vi.advanceTimersByTimeAsync(1)
      expect(f.controller.cardState()).toMatchObject({ stage: 'failed', busy: false })
      expect(f.controller.state()?.phase).toBe('failed')
    })

    it('keeps the original deadline when an unrecognized document replaces loading', async () => {
      // Isolate the unknown-document transition from the separate navigation deadline regression.
      const f = loadingFixture(false)
      f.begin()
      await vi.advanceTimersByTimeAsync(10_000)
      f.setSnapshot({ page: 'unknown' })
      await vi.advanceTimersByTimeAsync(0)
      expect(f.controller.cardState()?.busy).toBe(true)

      await vi.advanceTimersByTimeAsync(19_999)
      expect(f.controller.cardState()?.stage).not.toBe('failed')
      await vi.advanceTimersByTimeAsync(1)
      expect(f.controller.cardState()).toMatchObject({ stage: 'failed', busy: false })
      expect(f.controller.state()?.phase).toBe('failed')
    })

    it('does not let later unknown or loading polls revive a timed-out card', async () => {
      // Keep navigation silent to isolate failure recovery from the navigation deadline regression.
      const f = loadingFixture(false)
      f.begin()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.controller.cardState()).toMatchObject({ stage: 'failed', busy: false })

      for (const snapshot of [{ page: 'unknown' }, { page: 'loading', challengePhase: 'loading' }] satisfies LoginPageSnapshot[]) {
        f.setSnapshot(snapshot)
        await vi.advanceTimersByTimeAsync(400)
        expect(f.controller.cardState()).toMatchObject({ stage: 'failed', busy: false })
        expect(f.controller.state()?.phase).toBe('failed')
      }
    })

    it('reloads after a timeout and stays ready once the retried form is usable', async () => {
      const f = loadingFixture()
      f.begin()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.controller.state()?.phase).toBe('failed')

      await f.controller.retry(f.controller.state()!.id)
      expect(f.remoteContents.loadURL.mock.calls.filter(([url]) => url === fixedAdapter.entryUrl)).toHaveLength(2)
      expect(f.controller.cardState()?.stage).not.toBe('failed')
      await vi.advanceTimersByTimeAsync(20_000)
      f.setSnapshot({ page: 'form', mode: 'password', qrStatus: 'unavailable' })
      await vi.advanceTimersByTimeAsync(0)
      expect(f.controller.cardState()).toMatchObject({ stage: 'form', busy: false })

      await vi.advanceTimersByTimeAsync(31_000)
      expect(f.controller.cardState()).toMatchObject({ stage: 'form', busy: false })
      expect(f.controller.state()?.phase).toBe('ready')
    })

    it('replaces the old deadline when retry starts another still-loading document', async () => {
      const f = loadingFixture()
      f.begin()
      await vi.advanceTimersByTimeAsync(20_000)
      await f.controller.retry(f.controller.state()!.id)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(f.controller.cardState()?.stage).not.toBe('failed')
      await vi.advanceTimersByTimeAsync(19_999)
      expect(f.controller.cardState()?.stage).not.toBe('failed')
      await vi.advanceTimersByTimeAsync(1)
      expect(f.controller.cardState()).toMatchObject({ stage: 'failed', busy: false })
      expect(f.controller.state()?.phase).toBe('failed')
    })

    it.each([false, true])('bounds a stalled SDK submission after a usable form, with official view %s', async official => {
      const f = setup(120_000, { pollMs: 400 })
      f.begin()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.controller.cardState()?.stage).toBe('form')
      if (official) expect(await f.controller.cardAction({ kind: 'official' })).toEqual({ ok: true })
      await vi.advanceTimersByTimeAsync(5000)

      f.setSnapshot({ page: 'loading', submissionPending: true, qrStatus: 'paused' })
      await vi.advanceTimersByTimeAsync(0)
      expect(f.controller.state()?.message).toBe('正在等待抖音处理登录')
      if (!official) expect(f.controller.cardState()).toMatchObject({ stage: 'submitting', busy: true })
      await vi.advanceTimersByTimeAsync(29_999)
      expect(f.controller.state()?.phase).not.toBe('failed')
      await vi.advanceTimersByTimeAsync(1)
      expect(f.controller.state()).toMatchObject({ phase: 'failed', message: expect.stringContaining('尚未返回登录结果') })
      expect(f.controller.cardState()).toMatchObject({ stage: 'failed', busy: false })
      expect(f.actions).toHaveLength(0)

      f.setSnapshot({ page: 'form', mode: 'sms', qrStatus: 'unavailable' })
      await f.controller.retry(f.controller.state()!.id)
      expect(f.controller.cardState()).toMatchObject({ stage: 'form', busy: false })
      expect(f.controller.state()?.phase).toBe('ready')
      expect(f.actions).toHaveLength(0)
    })

    it('releases the submission wait once an interactive verification is ready', async () => {
      const f = setup(120_000, { pollMs: 400 })
      f.begin()
      await vi.advanceTimersByTimeAsync(0)
      f.setSnapshot({ page: 'loading', submissionPending: true })
      await vi.advanceTimersByTimeAsync(10_000)
      f.setSnapshot({ page: 'challenge', challenge: { x: 100, y: 120, width: 340, height: 240 } })
      await vi.advanceTimersByTimeAsync(31_000)
      expect(f.controller.state()).toMatchObject({ phase: 'challenge', presentation: 'captcha' })
      expect(f.actions).toHaveLength(0)
    })

    it.each([
      { page: 'form', mode: 'password', qrStatus: 'unavailable' },
      { page: 'second-factor', verification: { kind: 'sms' } },
      { page: 'challenge', challenge: { x: 100, y: 120, width: 340, height: 240 } },
    ] satisfies LoginPageSnapshot[])('does not time out a usable $page screen', async snapshot => {
      const f = loadingFixture()
      f.begin()
      await vi.advanceTimersByTimeAsync(10_000)
      f.setSnapshot(snapshot)
      await vi.advanceTimersByTimeAsync(0)
      const stage = snapshot.page === 'form' ? 'form' : snapshot.page === 'second-factor' ? 'verification' : 'submitting'
      expect(f.controller.cardState()?.stage).toBe(stage)
      if (snapshot.page === 'challenge') expect(f.controller.state()?.presentation).toBe('captcha')

      await vi.advanceTimersByTimeAsync(31_000)
      expect(f.controller.cardState()?.stage).toBe(stage)
      expect(f.controller.state()?.phase).not.toBe('failed')
    })
  })

  describe('native verification identity gate', () => {
    beforeEach(() => { vi.useFakeTimers() })

    it.each([
      { page: 'loading', challengePhase: 'loading', nativeVerification: true, qrStatus: 'paused' },
      { page: 'challenge', challengePhase: 'interactive', nativeVerification: true, qrStatus: 'paused', challenge: { x: 100, y: 120, width: 726, height: 483 } },
    ] satisfies LoginPageSnapshot[])('does not query identity during native $page and resumes after the form returns', async snapshot => {
      const f = setup(120_000, { pollMs: 400 })
      const pending = f.begin()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.controller.cardState()?.stage).toBe('form')
      f.setSnapshot(snapshot)
      await vi.advanceTimersByTimeAsync(0)
      f.setCookies([auth])
      f.jar.emit('changed', {}, auth)
      f.browserSession.fetch.mockResolvedValue(new Response(JSON.stringify({ status_code: 0, data: { id_str: '1001' } })))
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.browserSession.fetch).not.toHaveBeenCalled()
      expect(f.controller.state()).not.toBeNull()
      expect(f.actions).toHaveLength(0)

      f.setSnapshot({ page: 'form', mode: 'sms', qrStatus: 'unavailable' })
      await vi.advanceTimersByTimeAsync(400)
      expect(await pending).toEqual([auth])
      expect(f.browserSession.fetch).toHaveBeenCalledOnce()
      expect(f.actions).toHaveLength(0)
    })

    it('keeps the native gate through incomplete inspections and releases it when the portal is confirmed absent', async () => {
      const f = setup(120_000, { pollMs: 400 })
      const pending = f.begin()
      await vi.advanceTimersByTimeAsync(0)
      f.setSnapshot({ page: 'loading', nativeVerification: true })
      await vi.advanceTimersByTimeAsync(0)
      f.setCookies([auth])
      f.browserSession.fetch.mockResolvedValue(new Response(JSON.stringify({ status_code: 0, data: { id_str: '1001' } })))
      for (const page of ['loading', 'unknown'] as const) {
        f.setSnapshot({ page })
        await vi.advanceTimersByTimeAsync(400)
        expect(f.browserSession.fetch).not.toHaveBeenCalled()
      }
      f.setSnapshot({ page: 'loading', qrStatus: 'loading', nativeVerification: false })
      await vi.advanceTimersByTimeAsync(400)
      expect(await pending).toEqual([auth])
      expect(f.browserSession.fetch).toHaveBeenCalledOnce()
    })

    it('invalidates an in-flight identity when the native gate changes within the same challenge page', async () => {
      const f = setup(120_000, { pollMs: 400 })
      let release!: (response: Response) => void
      f.browserSession.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      f.browserSession.fetch.mockImplementation(async () => new Response(JSON.stringify({ status_code: 0, data: { id_str: '1001' } })))
      const pending = f.begin()
      await vi.advanceTimersByTimeAsync(0)
      const challenge: LoginPageSnapshot = { page: 'challenge', challengePhase: 'interactive', challenge: { x: 100, y: 120, width: 726, height: 483 } }
      f.setSnapshot(challenge)
      await vi.advanceTimersByTimeAsync(0)
      f.setCookies([auth])
      await vi.advanceTimersByTimeAsync(400)
      expect(f.browserSession.fetch).toHaveBeenCalledOnce()

      f.setSnapshot({ ...challenge, nativeVerification: true })
      await vi.advanceTimersByTimeAsync(0)
      release(new Response(JSON.stringify({ status_code: 0, data: { id_str: '1001' } })))
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.controller.state()).not.toBeNull()
      expect(f.browserSession.fetch).toHaveBeenCalledOnce()

      f.setSnapshot({ page: 'form', mode: 'sms', qrStatus: 'unavailable' })
      await vi.advanceTimersByTimeAsync(3000)
      expect(await pending).toEqual([auth])
      expect(f.browserSession.fetch).toHaveBeenCalledTimes(2)
      expect(f.actions).toHaveLength(0)
    })
  })

  it('keeps the official view bridge-free, gives only the local card a preload and never submits on initialization', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    expect(f.createSession.mock.calls[0]![0]).toMatch(/^fy1sync-login-[a-f0-9-]{36}$/)
    const preferences = f.createView.mock.calls[0]![0].webPreferences!
    expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false })
    expect(preferences).not.toHaveProperty('preload')
    expect(f.createCard.mock.calls[0]![0].preload).toBe('/synthetic/login-card-preload.cjs')
    expect(f.actions).toEqual([])
    expect(f.remoteContents.setAudioMuted).toHaveBeenCalledWith(true)
    const userAgent = f.remoteContents.setUserAgent.mock.calls[0]![0]
    expect(userAgent).toContain('Chrome/148.0.0.0')
    expect(userAgent).not.toMatch(/Electron|Fy1Sync|HeadlessChrome/)
    expect(f.browserSession.setUserAgent).toHaveBeenCalledWith(userAgent)
    expect(f.remoteContents.debugger.sendCommand).toHaveBeenCalledWith('Page.addScriptToEvaluateOnNewDocument', { source: expect.stringContaining('HTMLMediaElement.prototype') })
    expect(f.controller.ownsCard(f.ownerContents as never, f.ownerContents.mainFrame as never)).toBe(false)
    expect(f.controller.ownsCard(f.remoteContents as never, f.remoteContents.mainFrame as never)).toBe(false)
    expect(f.controller.ownsCard(f.cardContents as never, f.cardContents.mainFrame as never)).toBe(true)
    expect(f.request('https://example.invalid/credential')).toEqual({ cancel: true })
    expect(f.request('https://live.douyin.com/example.flv')).toEqual({ cancel: true })
    expect(JSON.stringify(f.controller.state())).not.toContain('synthetic-private-ticket')
  })

  it.each(['cancel', 'abort', 'close', 'timeout'] as const)('releases both views, listeners and sessions on %s', async stop => {
    const f = setup(stop === 'timeout' ? 100 : 5000)
    const signal = new AbortController()
    const pending = f.begin(signal.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    if (stop === 'cancel') await f.controller.cancel(f.controller.state()!.id)
    if (stop === 'abort') signal.abort()
    if (stop === 'close') f.ownerContents.emit('destroyed')
    await rejected
    expect(f.controller.state()).toBeNull()
    expect(f.card.close).toHaveBeenCalledOnce()
    expect(f.remoteContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(f.browserSession.closeAllConnections).toHaveBeenCalledOnce()
    expect(f.browserSession.clearStorageData).toHaveBeenCalledOnce()
    expect(f.browserSession.clearCache).toHaveBeenCalledOnce()
    expect(f.jar.listenerCount('changed')).toBe(0)
    expect(f.ownerContents.listenerCount('will-navigate')).toBe(0)
  })

  it('finishes cleanup and cancellation even if local-card disposal fails', async () => {
    const f = setup()
    const pending = f.begin()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    f.card.close.mockRejectedValue(new Error('synthetic cleanup failure'))
    await f.controller.cancel(f.controller.state()!.id)
    await rejected
    expect(f.browserSession.clearStorageData).toHaveBeenCalledOnce()
    expect(f.controller.state()).toBeNull()
  })

  it.each(['password', 'sms'] as const)('forwards exactly one consented %s action and clears secrets without broadcasting or logging them', async kind => {
    const f = setup()
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    expect(f.request('wss://frontier100-normal.zijieapi.com/ws', 'webSocket')).toEqual({ cancel: false })
    expect(f.request('https://live.douyin.com/passport/web/check_qrconnect/')).toEqual({ cancel: false })
    const action: LoginCardAction = kind === 'password' ? { kind, username: 'synthetic-user', password: 'synthetic-password-secret', accepted: true }
      : { kind, phone: '13800000000', countryCode: '+86', code: '654321', accepted: true }
    const secret = kind === 'password' ? 'synthetic-password-secret' : '654321'
    expect(await f.controller.cardAction(action)).toEqual({ ok: true })
    expect(f.actions).toHaveLength(1)
    expect(f.request('wss://frontier100-normal.zijieapi.com/ws', 'webSocket')).toEqual({ cancel: true })
    expect(f.request('https://live.douyin.com/passport/web/check_qrconnect/')).toEqual({ cancel: true })
    expect(f.actions[0]).toContain(secret)
    if ('password' in action) expect(action.password).toBe('')
    if ('code' in action) expect(action.code).toBe('')
    expect(await f.controller.cardAction(kind === 'password' ? { kind, username: 'other', password: 'other', accepted: true }
      : { kind, phone: '13800000000', countryCode: '+86', code: '111111', accepted: true })).toMatchObject({ ok: false })
    expect(f.actions).toHaveLength(1)
    expect(JSON.stringify(f.card.publish.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(f.controller.state())).not.toContain(secret)
    expect(f.ownerContents.send).not.toHaveBeenCalled()
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it('does not treat a passed captcha or an anonymous marker as authentication', async () => {
    const f = setup()
    f.setCookies([{ ...auth, name: 'ttwid' }, { ...auth, name: 'uid_tt' }])
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    f.setSnapshot({ page: 'loading', challengePhase: 'passed' })
    await vi.waitFor(() => expect(f.controller.cardState()?.message).toContain('人机验证已通过'))
    expect(f.browserSession.fetch).not.toHaveBeenCalled()
    expect(f.controller.state()).not.toBeNull()
  })

  it.each(['anonymous', 'unknown'] as const)('keeps valid cookies pending when the official identity is %s', async status => {
    const f = setup()
    f.setCookies([auth])
    f.browserSession.fetch.mockResolvedValue(new Response(JSON.stringify({ status_code: status === 'anonymous' ? 20003 : 8 })))
    f.begin()
    await vi.waitFor(() => expect(f.browserSession.fetch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(f.controller.state()?.phase).toBe('ready'))
    expect(f.controller.state()).not.toBeNull()
    expect(f.controller.cardState()?.busy).toBe(false)
  })

  it('completes only for authentication and the official same-session identity without comparing opaque uid_tt', async () => {
    const f = setup()
    const cookies = [auth, { ...auth, name: 'uid_tt', value: 'opaque-hash-not-official-uid' }]
    f.setCookies(cookies)
    f.browserSession.fetch.mockResolvedValue(new Response(JSON.stringify({ status_code: 0, data: { id_str: '1001', nickname: '测试账号' } })))
    expect(await f.begin()).toEqual(cookies)
    expect(f.browserSession.fetch).toHaveBeenCalledWith('https://live.douyin.com/webcast/user/me/?aid=6383&app_name=douyin_web&device_platform=web&room_id=0', expect.objectContaining({
      credentials: 'include', redirect: 'manual', method: 'GET', headers: { Accept: 'application/json', Referer: 'https://live.douyin.com/' },
    }))
    expect(f.controller.state()).toBeNull()
    expect(f.card.close).toHaveBeenCalledOnce()
    expect(f.browserSession.clearStorageData).toHaveBeenCalledOnce()
    expect(f.actions).toHaveLength(0)
  })

  it.each(['navigation', 'cookie-change', 'cancel'] as const)('ignores identity success after %s invalidates its generation', async invalidate => {
    const f = setup()
    let release!: (value: Response) => void
    f.setCookies([auth])
    f.browserSession.fetch.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = f.begin()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    await vi.waitFor(() => expect(f.browserSession.fetch).toHaveBeenCalledOnce())
    if (invalidate === 'navigation') f.remoteContents.emit('did-start-navigation', {}, 'https://live.douyin.com/', false, true)
    if (invalidate === 'cookie-change') f.jar.emit('changed', {}, auth)
    if (invalidate === 'cancel') await f.controller.cancel(f.controller.state()!.id)
    release(new Response(JSON.stringify({ status_code: 0, data: { id_str: '1001' } })))
    await new Promise(resolve => setTimeout(resolve, 20))
    if (invalidate !== 'cancel') {
      expect(f.controller.state()).not.toBeNull()
      await f.controller.cancel(f.controller.state()!.id)
    }
    await rejected
  })

  it('allows anonymous tracking-cookie refreshes while binding official identity to the unchanged authentication ticket', async () => {
    const f = setup()
    let release!: (response: Response) => void
    f.setCookies([auth])
    f.browserSession.fetch.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = f.begin()
    await vi.waitFor(() => expect(f.browserSession.fetch).toHaveBeenCalledOnce())
    const visitor = { ...auth, name: 'ttwid', value: 'new-tracking-context' }
    f.setCookies([auth, visitor])
    f.jar.emit('changed', {}, visitor)
    release(new Response(JSON.stringify({ status_code: 0, data: { id_str: '1001' } })))
    expect(await pending).toEqual([auth, visitor])
  })

  it('keeps the complete native challenge within its masked owner while the ordinary official form stays hidden', async () => {
    const f = setup()
    f.begin()
    await vi.waitFor(() => expect(f.controller.cardState()?.stage).toBe('form'))
    f.controller.setViewport({ id: f.controller.state()!.id, visible: true, rect: { x: 30, y: 60, width: 700, height: 480 } })
    expect(f.view.setVisible).not.toHaveBeenCalledWith(true)
    f.setSnapshot({ page: 'challenge', challenge: { x: 100, y: 120, width: 340, height: 240 } })
    await vi.waitFor(() => expect(f.controller.state()?.presentation).toBe('captcha'))
    expect(f.view.setVisible).toHaveBeenCalledWith(true)
    expect(f.card.hide).toHaveBeenCalled()
    expect(f.owner.contentView.addChildView.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(f.actions).toHaveLength(0)
  })
})

describe('Douyin embedded LoginManager integration', () => {
  it('uses only the embedded driver and restores a scoped prior session without finding Chrome or creating its profile', async () => {
    const storage = new CookieStore(root)
    storage.write('douyin', [auth, { ...auth, domain: 'v.douyin.com', name: 'SHARE_ONLY' }, { ...auth, path: '/account', name: 'ACCOUNT_ONLY' }])
    const cookiesSet = vi.fn(async () => {})
    const embeddedDriver = { login: vi.fn(async (request: Parameters<EmbeddedLoginController['login']>[0]) => {
      await request.initializeSession?.({ cookies: { set: cookiesSet } })
      return [auth]
    }) }
    const findChrome = vi.fn(() => 'synthetic-chrome'), browserLogin = vi.fn(async () => [auth])
    const login = new LoginManager(root, { store: storage, embeddedDriver, findChrome, driver: { login: browserLogin } })
    expect(await login.login('douyin')).toEqual({ cookieCount: 1, authKeysPresent: ['sessionid'] })
    expect(findChrome).not.toHaveBeenCalled()
    expect(browserLogin).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, 'browser-profile'))).toBe(false)
    expect(cookiesSet).toHaveBeenCalledExactlyOnceWith({ url: 'https://live.douyin.com/', domain: '.douyin.com', path: '/',
      name: 'sessionid', value: 'synthetic-private-ticket', secure: true, httpOnly: true })
    await login.dispose()
  })

  it('fails without a configured embedded driver instead of silently launching real Chrome', async () => {
    const findChrome = vi.fn(() => 'synthetic-chrome')
    const login = new LoginManager(root, { findChrome })
    await expect(login.login('douyin')).rejects.toMatchObject({ code: 'login-failed', message: '抖音内嵌登录未完成, 请在应用内重试.' })
    expect(findChrome).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
    await login.dispose()
  })

  it('never writes a late embedded result or injects prior credentials after logout', async () => {
    const storage = new CookieStore(root)
    storage.write('douyin', [auth])
    let request!: Parameters<EmbeddedLoginController['login']>[0]
    let release!: (cookies: BrowserCookie[]) => void
    const embeddedDriver = { login: vi.fn(async (value: typeof request) => { request = value; return new Promise<BrowserCookie[]>(resolve => { release = resolve }) }) }
    const login = new LoginManager(root, { store: storage, embeddedDriver })
    const pending = login.login('douyin')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'login-cancelled' })
    const logout = login.logout('douyin')
    const set = vi.fn(async () => {})
    await expect(request.initializeSession?.({ cookies: { set } })).rejects.toThrow('账号数据读写失败')
    expect(set).not.toHaveBeenCalled()
    release([auth])
    await logout
    await rejected
    expect(fs.existsSync(path.join(root, 'cookies', 'douyin.txt'))).toBe(false)
    await login.dispose()
  })
})
