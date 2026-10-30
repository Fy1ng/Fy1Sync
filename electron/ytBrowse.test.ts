import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContentsView, WebContentsViewConstructorOptions, Session } from 'electron'
vi.mock('electron', () => ({ WebContentsView: vi.fn(), session: { fromPartition: vi.fn() } }))
import { YouTubeBrowseManager, YT_BROWSE_STATE_SCRIPT, YT_BROWSE_PLAYER_ONLY_SCRIPT, YT_BROWSE_INPUT_GUARD_SCRIPT, YT_BROWSE_SNAPSHOT_SCRIPT, isYouTubeBrowseNavigation, isYouTubeBrowseResource, normalizeYouTubeBrowseUrl } from './ytBrowse'

const videoId = 'abcdefghijk'
const canonical = `https://www.youtube.com/watch?v=${videoId}`
const managers: YouTubeBrowseManager[] = []
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); vi.restoreAllMocks() })
function rgba(width = 3840, height = 2160) {
  return new Uint8Array(width * height * 4)
}
function fixture() {
  const raw = { title: '本地合成视频', duration: 600, currentTime: 10, playing: true, videoWidth: 3840, videoHeight: 2160, isAd: false, errorCode: null, playerOnly: false }
  const frame = { rgba: rgba(), currentTime: 10, videoWidth: 3840, videoHeight: 2160 }
  const contents = Object.assign(new EventEmitter(), {
    setBackgroundThrottling: vi.fn(), setIgnoreMenuShortcuts: vi.fn(), setWindowOpenHandler: vi.fn(),
    isDestroyed: vi.fn(() => false), getURL: vi.fn(() => canonical), loadURL: vi.fn(async (_url: string) => {}),
    executeJavaScript: vi.fn(async (script: string, _gesture?: boolean): Promise<unknown> => {
      if (script === YT_BROWSE_STATE_SCRIPT) return { ...raw }
      if (script === YT_BROWSE_PLAYER_ONLY_SCRIPT) { raw.playerOnly = true; return true }
    }),
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]): Promise<unknown> => frame),
    close: vi.fn(() => { contents.isDestroyed.mockReturnValue(true); contents.emit('destroyed') }),
  })
  const view = { webContents: contents, setVisible: vi.fn(), setBounds: vi.fn() }
  const ownerContents = Object.assign(new EventEmitter(), { id: 42, getZoomFactor: vi.fn(() => 1) })
  const owner = { webContents: ownerContents, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed: vi.fn(() => false), getContentSize: vi.fn(() => [1280, 720]) }
  const ses = Object.assign(new EventEmitter(), { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() }, closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}) })
  const createView = vi.fn((_options: WebContentsViewConstructorOptions) => view as unknown as WebContentsView)
  const sessionFromPartition = vi.fn((_partition: string) => ses as unknown as Session)
  const changed = vi.fn(), injectCookies = vi.fn(async () => {})
  const manager = new YouTubeBrowseManager({ createView, sessionFromPartition, changed, injectCookies })
  managers.push(manager)
  return { contents, view, owner: owner as unknown as BrowserWindow, ownerContents, ownerMock: owner, raw, frame, ses, createView, sessionFromPartition, changed, injectCookies, manager }
}
describe('YouTube browser URL and network boundary', () => {
  it('normalizes only official HTTPS video links and removes incidental parameters', () => {
    expect(normalizeYouTubeBrowseUrl(`https://youtu.be/${videoId}?t=10`)).toEqual({ url: canonical, videoId })
    expect(normalizeYouTubeBrowseUrl(`${canonical}&list=ignored#t=5`)).toEqual({ url: canonical, videoId })
  })
  it.each(['http://www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com.evil/watch?v=abcdefghijk', 'https://user@www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com:8443/watch?v=abcdefghijk', 'file:///video', 'https://www.youtube.com/playlist?list=abcdefghijk'])('rejects %s', url => {
    expect(() => normalizeYouTubeBrowseUrl(url)).toThrow()
  })
  it('separates document navigation and playback resource allowlists', () => {
    expect(isYouTubeBrowseNavigation(canonical, videoId)).toBe(true)
    expect(isYouTubeBrowseNavigation('https://www.youtube.com/watch?v=zzzzzzzzzzz', videoId)).toBe(false)
    expect(isYouTubeBrowseNavigation('https://accounts.google.com/signin', videoId)).toBe(false)
    expect(isYouTubeBrowseResource('https://r1.googlevideo.com/videoplayback')).toBe(true)
    expect(isYouTubeBrowseNavigation('https://r1.googlevideo.com/videoplayback', videoId)).toBe(false)
    for (const url of ['https://googlevideo.com.evil/path', 'http://r1.googlevideo.com/', 'https://127.0.0.1/', 'https://mail.google.com/', 'file:///C:/secret']) expect(isYouTubeBrowseResource(url)).toBe(false)
  })
  it('attaches a hidden sandboxed view after cookies and wakes rendering after load', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    expect(f.sessionFromPartition.mock.calls[0]?.[0]).toMatch(/^yt-browse-/)
    expect(f.sessionFromPartition.mock.calls[0]?.[0]).not.toContain('persist:')
    expect(f.injectCookies).toHaveBeenCalledWith(f.ses)
    expect(f.injectCookies.mock.invocationCallOrder[0]).toBeLessThan(f.contents.loadURL.mock.invocationCallOrder[0]!)
    expect(f.createView).toHaveBeenCalledWith({ webPreferences: expect.objectContaining({ session: f.ses,
      nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true, devTools: false,
      disableHtmlFullscreenWindowResize: true, navigateOnDragDrop: false, backgroundThrottling: false, spellcheck: false }) })
    expect(f.createView.mock.calls[0]?.[0].webPreferences).not.toHaveProperty('preload')
    expect(f.createView.mock.calls[0]?.[0].webPreferences).not.toHaveProperty('offscreen')
    expect(f.view.setVisible).toHaveBeenNthCalledWith(1, false)
    expect(f.ownerMock.contentView.addChildView).toHaveBeenCalledWith(f.view)
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false)
    expect(f.contents.setBackgroundThrottling).toHaveBeenCalledWith(false)
    expect(f.contents.loadURL.mock.invocationCallOrder[0]).toBeLessThan(f.contents.setBackgroundThrottling.mock.invocationCallOrder[0]!)
    expect(f.contents.executeJavaScript).toHaveBeenCalledWith(YT_BROWSE_PLAYER_ONLY_SCRIPT, true)
    f.contents.emit('dom-ready')
    expect(f.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1001, [{ code: YT_BROWSE_INPUT_GUARD_SCRIPT }])
  })
  it('rejects popups, downloads, webviews, navigation and non-allowlisted requests', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    expect(f.contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    f.ses.emit('will-download', event); f.contents.emit('will-attach-webview', event)
    f.contents.emit('will-navigate', event, 'https://evil.invalid/')
    f.contents.emit('will-frame-navigate', { ...event, url: 'https://evil.invalid/', isMainFrame: false })
    expect(event.preventDefault).toHaveBeenCalledTimes(4)
    f.contents.emit('will-redirect', event, 'https://accounts.google.com/signin', false, true)
    expect((await f.manager.state()).errorCode).toBe('auth-required')
    const callback = vi.fn(); f.ses.webRequest.onBeforeRequest.mock.calls[0]?.[0]({ url: 'https://127.0.0.1/', resourceType: 'image' }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })
  it('permits only fullscreen from the current view main watch document', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    const check = f.ses.setPermissionCheckHandler.mock.calls[0]?.[0]
    const request = f.ses.setPermissionRequestHandler.mock.calls[0]?.[0]
    const valid = { isMainFrame: true, requestingUrl: canonical }
    expect(check(f.contents, 'fullscreen', 'https://www.youtube.com', valid)).toBe(true)
    for (const [wc, permission, details] of [[null, 'fullscreen', valid], [{}, 'fullscreen', valid], [f.contents, 'media', valid],
      [f.contents, 'automatic-fullscreen', valid], [f.contents, 'fullscreen', { ...valid, isMainFrame: false }],
      [f.contents, 'fullscreen', { ...valid, requestingUrl: 'https://www.youtube.com/watch?v=zzzzzzzzzzz' }],
      [f.contents, 'fullscreen', { isMainFrame: true }]]) {
      expect(check(wc, permission, 'https://www.youtube.com', details)).toBe(false)
      const callback = vi.fn(); request(wc, permission, callback, details); expect(callback).toHaveBeenCalledWith(false)
    }
    const callback = vi.fn(); request(f.contents, 'fullscreen', callback, valid); expect(callback).toHaveBeenCalledWith(true)
    f.contents.getURL.mockReturnValue('https://www.youtube.com/watch?v=zzzzzzzzzzz')
    expect(check(f.contents, 'fullscreen', 'https://www.youtube.com', valid)).toBe(false)
  })
})

describe('view layout and player fullscreen', () => {
  it('remembers CSS bounds before open, converts zoom to DIP, rounds and clips to content', async () => {
    const f = fixture(); f.ownerContents.getZoomFactor.mockReturnValue(1.25)
    f.manager.setViewport({ rect: { x: -20.4, y: 10.2, width: 1100, height: 700 }, visible: true })
    expect((await f.manager.open(f.owner, canonical)).playerOnly).toBe(true)
    expect(f.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 13, width: 1280, height: 707 })
    expect(f.view.setVisible).toHaveBeenLastCalledWith(true)
    f.manager.setViewport({ rect: { x: 12.2, y: 8.4, width: 100.2, height: 80 }, visible: true })
    expect(f.view.setBounds).toHaveBeenLastCalledWith({ x: 15, y: 11, width: 126, height: 100 })
  })
  it.each([{ x: 10, y: 10, width: 0, height: 300 }, { x: 10, y: 10, width: 300, height: 0 },
    { x: 2000, y: 1000, width: 100, height: 100 }])('hides empty or outside viewport %o', async rect => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.manager.setViewport({ rect, visible: true }); expect(f.view.setVisible).toHaveBeenLastCalledWith(false)
  })
  it('hides for visible false and while playerOnly is false, then restores admin visibility', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    const rect = { x: 0, y: 0, width: 640, height: 360 }
    f.manager.setViewport({ rect, visible: false }); expect(f.view.setVisible).toHaveBeenLastCalledWith(false)
    let release!: (value: boolean) => void
    f.contents.executeJavaScript.mockImplementationOnce(async () => new Promise(resolve => { release = resolve }))
    f.raw.playerOnly = false; f.contents.emit('leave-html-full-screen')
    f.manager.setViewport({ rect, visible: true }); expect(f.view.setVisible).toHaveBeenLastCalledWith(false)
    expect(f.changed).toHaveBeenLastCalledWith(42, expect.objectContaining({ playerOnly: false }))
    f.raw.playerOnly = true; release(true)
    await vi.waitFor(() => expect(f.view.setVisible).toHaveBeenLastCalledWith(true))
    expect((await f.manager.state()).playerOnly).toBe(true)
  })
  it('keeps hidden after recovery if admin requested hidden', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.manager.setViewport({ rect: { x: 0, y: 0, width: 640, height: 360 }, visible: false })
    f.raw.playerOnly = false; f.contents.emit('leave-html-full-screen')
    await vi.waitFor(() => expect(f.raw.playerOnly).toBe(true))
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false)
  })
  it('stops automatic recovery after three consecutive failures and retains the error', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.manager.setViewport({ rect: { x: 0, y: 0, width: 640, height: 360 }, visible: true })
    f.raw.playerOnly = false
    f.contents.executeJavaScript.mockImplementation(async script => script === YT_BROWSE_STATE_SCRIPT ? { ...f.raw } : false)
    f.contents.executeJavaScript.mockClear(); f.contents.emit('leave-html-full-screen')
    await vi.waitFor(() => expect(f.changed).toHaveBeenLastCalledWith(42, expect.objectContaining({ playerOnly: false, errorCode: 'player-only-failed' })))
    await f.manager.state(); await f.manager.state(); f.contents.emit('leave-html-full-screen')
    expect(f.contents.executeJavaScript.mock.calls.filter(([code]) => code === YT_BROWSE_PLAYER_ONLY_SCRIPT)).toHaveLength(3)
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false)
  })
  it('re-enters player fullscreen after SPA replaces the player', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.raw.playerOnly = false
    expect((await f.manager.state()).playerOnly).toBe(true)
    expect(f.contents.executeJavaScript.mock.calls.filter(([code]) => code === YT_BROWSE_PLAYER_ONLY_SCRIPT)).toHaveLength(2)
  })
  it('blocks app and browser shortcuts while preserving player keys', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true)
    for (const input of [{ key: 'F5' }, { key: 'F12' }, ...['r', 'o', 'p', 's'].map(key => ({ key, control: true })),
      ...['i', 'j', 'c'].map(key => ({ key, control: true, shift: true })), { key: 'ArrowLeft', alt: true }, { key: 'ArrowRight', alt: true }]) {
      const event = { preventDefault: vi.fn() }; f.contents.emit('before-input-event', event, input); expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    for (const key of [' ', 'k', 'j', 'l', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '0', '9', 'f', 'm', 'Escape']) {
      const event = { preventDefault: vi.fn() }; f.contents.emit('before-input-event', event, { key }); expect(event.preventDefault).not.toHaveBeenCalled()
    }
  })
  it('guards file inputs and captures drag/drop before page listeners', () => {
    const addEventListener = vi.fn()
    class Input { type = 'file' }
    runInNewContext(YT_BROWSE_INPUT_GUARD_SCRIPT, { window: {}, document: { addEventListener }, HTMLInputElement: Input })
    expect(addEventListener.mock.calls.map(([name, , capture]) => [name, capture])).toEqual([['click', true], ['dragover', true], ['drop', true]])
    const event = { target: new Input(), preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    for (const [, handler] of addEventListener.mock.calls) handler(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(3); expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(2)
  })
})

describe('current video frame snapshot', () => {
  it('reads isolated RGBA pixels and keeps command behavior', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    const { rgba: pixels, ...shot } = await f.manager.snapshot()
    expect(shot).toEqual({ videoId, approximateTime: 10, approximate: true,
      videoWidth: 3840, videoHeight: 2160, width: 3840, height: 2160, isOneToOne: true })
    // The validated buffer itself, not a copy: a 4K frame is 33 MB.
    expect(pixels).toBe(f.frame.rgba)
    expect(f.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1001, [{ code: YT_BROWSE_SNAPSHOT_SCRIPT }])
    await expect(f.manager.command({ action: 'seek', seconds: NaN })).rejects.toMatchObject({ code: 'invalid-arguments' })
    await f.manager.command({ action: 'pause' }); expect(f.contents.executeJavaScript).toHaveBeenCalledWith(`document.querySelector('video')?.pause()`, true)
  })
  it.each(['length', 'dimensions', 'oversize', 'time', 'bytes'])('rejects malformed snapshot: %s', async kind => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    if (kind === 'length') f.frame.rgba = new Uint8Array(f.frame.rgba.length - 4)
    if (kind === 'dimensions') f.frame.rgba = rgba(1920, 1080)
    if (kind === 'oversize') Object.assign(f.frame, { videoWidth: 7681 })
    if (kind === 'time') f.frame.currentTime = NaN
    if (kind === 'bytes') f.contents.executeJavaScriptInIsolatedWorld.mockResolvedValue({ ...f.frame, rgba: [1, 2] })
    await expect(f.manager.snapshot()).rejects.toMatchObject({ code: 'snapshot-unavailable' })
  })
  it.each(['before', 'during', 'after'])('rejects advertisements %s capture', async stage => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    if (stage === 'before') f.raw.isAd = true
    if (stage === 'during') f.contents.executeJavaScriptInIsolatedWorld.mockResolvedValue({ errorCode: 'ad-playing' })
    if (stage === 'after') f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async () => { f.raw.isAd = true; return f.frame })
    await expect(f.manager.snapshot()).rejects.toMatchObject({ code: 'ad-playing' })
    if (stage === 'before') expect(f.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })
  it('rejects dimensions that change while the frame is read', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async () => { f.raw.videoWidth = 1920; return f.frame })
    await expect(f.manager.snapshot()).rejects.toMatchObject({ code: 'snapshot-unavailable' })
  })
  it('rejects quality changes between the initial state read and drawing', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async () => {
      f.raw.videoWidth = 1920; f.raw.videoHeight = 1080
      return { ...f.frame, rgba: rgba(1920, 1080), videoWidth: 1920, videoHeight: 1080 }
    })
    await expect(f.manager.snapshot()).rejects.toMatchObject({ code: 'snapshot-unavailable' })
  })
  it.each(['close', 'identity', 'after-state'])('rejects generation or video identity changes during capture: %s', async stage => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async () => {
      if (stage === 'close') await f.manager.close()
      else if (stage === 'identity') f.contents.getURL.mockReturnValue('https://www.youtube.com/watch?v=zzzzzzzzzzz')
      else f.contents.executeJavaScript.mockImplementationOnce(async () => { await f.manager.close(); return f.raw })
      return f.frame
    })
    await expect(f.manager.snapshot()).rejects.toMatchObject({ code: 'closed' })
  })
  it('allows only one snapshot in flight and releases the lock after failure', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    let release!: (value: unknown) => void
    f.contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async () => new Promise(resolve => { release = resolve }))
    const pending = f.manager.snapshot(); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(f.manager.snapshot()).rejects.toMatchObject({ code: 'snapshot-unavailable' })
    release({ errorCode: 'origin-tainted' }); await expect(pending).rejects.toMatchObject({ code: 'origin-tainted' })
    expect((await f.manager.snapshot()).width).toBe(3840)
  })
  function scriptFixture() {
    const video = { readyState: 2, videoWidth: 4, videoHeight: 2, currentTime: 10, seeking: false, pause: vi.fn() }
    const drawImage = vi.fn()
    const getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }))
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, getImageData }) }
    const ad = { value: false }
    const document = { querySelector: (selector: string) => selector.includes('ad-') ? ad.value : video, createElement: vi.fn(() => canvas) }
    return { video, getImageData, ad, run: () => runInNewContext(YT_BROWSE_SNAPSHOT_SCRIPT, { document, Uint8Array }) }
  }
  it('fixed script pauses on the frame it reads and returns its pixels', async () => {
    const f = scriptFixture()
    const result = await f.run()
    expect(f.video.pause).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ currentTime: 10, videoWidth: 4, videoHeight: 2 })
    expect(result.rgba).toHaveLength(4 * 2 * 4)
  })
  it.each(['ready', 'size', 'seeking', 'ad'])('fixed script leaves playback alone when it cannot take a frame: %s', async kind => {
    const f = scriptFixture()
    if (kind === 'ready') f.video.readyState = 1
    if (kind === 'size') f.video.videoWidth = 0
    if (kind === 'seeking') f.video.seeking = true
    if (kind === 'ad') f.ad.value = true
    expect(await f.run()).toEqual({ errorCode: ({ ready: 'not-ready', size: 'not-ready', seeking: 'snapshot-unavailable', ad: 'ad-playing' })[kind] })
    expect(f.video.pause).not.toHaveBeenCalled()
  })
  it.each(['security', 'changed-size', 'oversize'])('fixed script maps failures: %s', async kind => {
    const f = scriptFixture()
    if (kind === 'security') f.getImageData.mockImplementation(() => { throw Object.assign(new Error('sensitive details'), { name: 'SecurityError' }) })
    if (kind === 'changed-size') f.getImageData.mockImplementation((_x, _y, width, height) => { f.video.videoWidth = 1920; return { data: new Uint8ClampedArray(width * height * 4) } })
    if (kind === 'oversize') f.video.videoWidth = 7681
    expect(await f.run()).toEqual({ errorCode: ({ security: 'origin-tainted', 'changed-size': 'snapshot-unavailable', oversize: 'snapshot-too-large' })[kind] })
  })
})

describe('view and session lifetime', () => {
  it('detaches, closes webContents and waits for destroyed before clearing the session', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.contents.close.mockImplementation(() => {})
    const closing = f.manager.close(), secondClose = f.manager.close()
    let finished = false; void secondClose.then(() => { finished = true })
    await Promise.resolve(); await Promise.resolve()
    expect(f.ownerMock.contentView.removeChildView).toHaveBeenCalledWith(f.view)
    expect(f.contents.close).toHaveBeenCalledOnce(); expect(f.ses.clearStorageData).not.toHaveBeenCalled(); expect(finished).toBe(false)
    expect(f.ownerMock.contentView.removeChildView.mock.invocationCallOrder[0]).toBeLessThan(f.contents.close.mock.invocationCallOrder[0]!)
    f.contents.isDestroyed.mockReturnValue(true); f.contents.emit('destroyed'); await Promise.all([closing, secondClose])
    expect(f.ses.clearStorageData).toHaveBeenCalledOnce()
    expect((await f.manager.state()).errorCode).toBe('closed')
  })
  it.each(['destroyed', 'will-navigate', 'did-navigate-in-page'])('cleans up on owner %s', async event => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.ownerContents.emit(event); await vi.waitFor(() => expect(f.ses.clearStorageData).toHaveBeenCalledOnce())
    expect(f.contents.close).toHaveBeenCalledOnce()
  })
  it('cleans up without reading native properties from an already destroyed owner', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.ownerMock.isDestroyed.mockReturnValue(true)
    Object.defineProperty(f.ownerMock, 'webContents', { get() { throw new Error('Object has been destroyed') } })
    expect(() => f.ownerContents.emit('destroyed')).not.toThrow()
    await vi.waitFor(() => expect(f.ses.clearStorageData).toHaveBeenCalledOnce())
    expect(f.contents.close).toHaveBeenCalledOnce()
  })
  it('awaits delayed cookie injection before clearing, including repeated close calls', async () => {
    const f = fixture(); let release!: () => void
    f.injectCookies.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
    const opening = f.manager.open(f.owner, canonical), rejected = expect(opening).rejects.toMatchObject({ code: 'closed' })
    await vi.waitFor(() => expect(f.injectCookies).toHaveBeenCalledOnce())
    const closing = f.manager.close(), secondClose = f.manager.close()
    expect(f.ses.clearStorageData).not.toHaveBeenCalled(); release(); await Promise.all([closing, secondClose, rejected])
    expect(f.createView).not.toHaveBeenCalled(); expect(f.ses.clearStorageData).toHaveBeenCalledOnce()
    expect(f.ses.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null); expect(f.ses.listenerCount('will-download')).toBe(0)
  })
  it('replaces delayed setup without letting the old generation create a view', async () => {
    const f = fixture(), next = fixture(); let release!: () => void
    f.sessionFromPartition.mockReturnValueOnce(f.ses as unknown as Session).mockReturnValueOnce(next.ses as unknown as Session)
    f.injectCookies.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
    const first = f.manager.open(f.owner, canonical), rejected = expect(first).rejects.toMatchObject({ code: 'closed' })
    await vi.waitFor(() => expect(f.injectCookies).toHaveBeenCalledOnce())
    const second = f.manager.open(f.owner, canonical); release(); await rejected
    expect((await second).videoId).toBe(videoId); expect(f.createView).toHaveBeenCalledOnce()
    expect(f.ses.clearStorageData).toHaveBeenCalledOnce(); expect(next.ses.clearStorageData).not.toHaveBeenCalled()
    await f.manager.close(); expect(next.ses.clearStorageData).toHaveBeenCalledOnce()
  })
  it('ignores fullscreen completions from an old generation while a replacement loads', async () => {
    const f = fixture(), next = fixture(); await f.manager.open(f.owner, canonical)
    let release!: (value: unknown) => void, loaded!: () => void
    f.contents.executeJavaScript.mockImplementationOnce(async () => new Promise(resolve => { release = resolve }))
    f.raw.playerOnly = false; f.contents.emit('leave-html-full-screen')
    f.createView.mockReturnValueOnce(next.view as unknown as WebContentsView)
    next.contents.getURL.mockReturnValue('')
    next.contents.loadURL.mockImplementationOnce(async () => new Promise<void>(resolve => { loaded = resolve }))
    const replacement = f.manager.open(f.owner, canonical)
    await vi.waitFor(() => expect(loaded).toBeTypeOf('function'))
    release(true); await Promise.resolve(); await Promise.resolve()
    expect(next.contents.close).not.toHaveBeenCalled()
    next.contents.getURL.mockReturnValue(canonical); loaded()
    expect((await replacement).videoId).toBe(videoId)
  })
  it.each(['https://www.youtube.com/watch?v=zzzzzzzzzzz', 'https://evil.invalid/'])('invalidates SPA identity: %s', async target => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.contents.getURL.mockReturnValue(target); f.contents.emit('did-navigate-in-page', {}, target, true)
    expect(f.contents.close).toHaveBeenCalledOnce()
    await expect(f.manager.snapshot()).rejects.toMatchObject({ code: 'video-unavailable' })
    await expect(f.manager.command({ action: 'play' })).rejects.toMatchObject({ code: 'video-unavailable' })
    expect(await f.manager.state()).toMatchObject({ videoId: null, playerOnly: false, errorCode: 'video-unavailable' })
  })
  it('checks the actual URL even without a navigation event', async () => {
    const f = fixture(); await f.manager.open(f.owner, canonical)
    f.contents.getURL.mockReturnValue('https://www.youtube.com/watch?v=zzzzzzzzzzz')
    await expect(f.manager.snapshot()).rejects.toMatchObject({ code: 'video-unavailable' })
    expect(f.contents.close).toHaveBeenCalledOnce(); expect(f.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })
})
