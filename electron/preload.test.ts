import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopMethod, StreamSyncerBridge, WindowState } from './contracts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('electron', () => electron)

async function loadBridge(): Promise<StreamSyncerBridge> {
  await import('./preload')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('streamSyncer', expect.any(Object))
  return electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as StreamSyncerBridge
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  electron.ipcRenderer.invoke.mockResolvedValue({ ok: true, value: { maximized: false, fullscreen: false, focused: true } })
})

describe('window controls preload boundary', () => {
  it('routes embedded login controls separately and never exposes the credential card bridge', async () => {
    const bridge = await loadBridge()
    await bridge.invoke('getEmbeddedLogin', undefined)
    await bridge.invoke('cancelEmbeddedLogin', { id: 'fixture-attempt' })
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['stream-syncer:embedded-login-invoke', 'getEmbeddedLogin', undefined],
      ['stream-syncer:embedded-login-invoke', 'cancelEmbeddedLogin', { id: 'fixture-attempt' }],
    ])
    expect(bridge).not.toHaveProperty('loginCard')
    await expect(bridge.invoke('loginCardAction' as DesktopMethod, undefined)).resolves.toMatchObject({ code: 'unknown-method' })
    const listener = vi.fn()
    const release = bridge.subscribeEmbeddedLogin!(listener)
    const receive = electron.ipcRenderer.on.mock.calls[0]![1] as (_event: unknown, state: unknown) => void
    receive({}, { id: 'fixture-attempt', platform: 'douyin', purpose: 'login', phase: 'ready' })
    release()
    receive({}, null)
    expect(listener).toHaveBeenCalledOnce()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('stream-syncer:embedded-login', receive)
  })
  it('exposes a frozen bridge and allows both window methods on the existing invoke channel', async () => {
    const bridge = await loadBridge()
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(bridge.platform).toBe(process.platform)
    await expect(bridge.invoke('getWindowState', undefined)).resolves.toMatchObject({ ok: true })
    await expect(bridge.invoke('windowControl', { action: 'minimize' })).resolves.toMatchObject({ ok: true })
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['stream-syncer:invoke', 'getWindowState', undefined],
      ['stream-syncer:invoke', 'windowControl', { action: 'minimize' }],
    ])
  })

  it('keeps arbitrary native window methods outside the whitelist', async () => {
    const bridge = await loadBridge()
    await expect(bridge.invoke('destroyWindow' as DesktopMethod, undefined))
      .resolves.toMatchObject({ ok: false, code: 'unknown-method' })
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('delivers only the state payload and stops even queued callbacks after unsubscribe', async () => {
    const bridge = await loadBridge()
    const listener = vi.fn()
    const release = bridge.subscribeWindowState!(listener)
    expect(electron.ipcRenderer.on).toHaveBeenCalledExactlyOnceWith('stream-syncer:window-state', expect.any(Function))
    const receive = electron.ipcRenderer.on.mock.calls[0]![1] as (event: unknown, state: WindowState) => void
    const state: WindowState = { maximized: true, fullscreen: false, focused: true }
    receive({ sender: { privileged: true } }, state)
    expect(listener).toHaveBeenCalledExactlyOnceWith(state)
    release()
    release()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('stream-syncer:window-state', receive)
    receive({}, { ...state, focused: false })
    expect(listener).toHaveBeenCalledOnce()
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('unsubscribes only its own listener when multiple subscribers exist', async () => {
    const bridge = await loadBridge()
    const first = vi.fn()
    const second = vi.fn()
    const releaseFirst = bridge.subscribeWindowState!(first)
    const releaseSecond = bridge.subscribeWindowState!(second)
    const firstReceive = electron.ipcRenderer.on.mock.calls[0]![1] as (event: unknown, state: WindowState) => void
    const secondReceive = electron.ipcRenderer.on.mock.calls[1]![1] as (event: unknown, state: WindowState) => void
    const state: WindowState = { maximized: false, fullscreen: true, focused: true }
    releaseFirst()
    firstReceive({}, state)
    secondReceive({}, state)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith(state)
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith('stream-syncer:window-state', firstReceive)
    releaseSecond()
  })
})

describe('YouTube admin preload boundary', () => {
  it('uses the dedicated admin invoke channel', async () => {
    const bridge = await loadBridge()
    await bridge.invoke('ytBrowseOpen', { url: 'https://www.youtube.com/watch?v=abcdefghijk' })
    await bridge.invoke('ytBrowseSetViewport', { rect: { x: 10, y: 20, width: 640, height: 360 }, visible: true })
    await bridge.invoke('ytImportList', undefined)
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['stream-syncer:yt-invoke', 'ytBrowseOpen', { url: 'https://www.youtube.com/watch?v=abcdefghijk' }],
      ['stream-syncer:yt-invoke', 'ytBrowseSetViewport', { rect: { x: 10, y: 20, width: 640, height: 360 }, visible: true }],
      ['stream-syncer:yt-invoke', 'ytImportList', undefined],
    ])
  })

  it('does not expose the removed preview and input methods', async () => {
    const bridge = await loadBridge()
    expect(bridge).not.toHaveProperty('subscribeYtBrowsePreview')
    for (const method of ['ytBrowseInput', 'ytBrowsePreviewAck']) {
      await expect(bridge.invoke(method as DesktopMethod, undefined)).resolves.toMatchObject({ ok: false, code: 'unknown-method' })
    }
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('removes state and progress listeners independently', async () => {
    const bridge = await loadBridge()
    const state = vi.fn(), progress = vi.fn()
    const releaseState = bridge.subscribeYtBrowseState!(state)
    const releaseProgress = bridge.subscribeYtImportProgress!(progress)
    const stateReceive = electron.ipcRenderer.on.mock.calls[0]![1] as (event: unknown, data: any) => void
    const progressReceive = electron.ipcRenderer.on.mock.calls[1]![1] as (event: unknown, data: any) => void
    stateReceive({}, { videoWidth: 3840, playerOnly: true })
    progressReceive({}, { jobId: 'test', state: 'ready' })
    expect(state).toHaveBeenCalledExactlyOnceWith({ videoWidth: 3840, playerOnly: true })
    expect(progress).toHaveBeenCalledExactlyOnceWith({ jobId: 'test', state: 'ready' })
    releaseState(); releaseProgress()
    stateReceive({}, {}); progressReceive({}, {})
    expect(state).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledOnce()
  })
})

describe('editor project preload boundary', () => {
  it('routes project persistence and the native media picker through the admin channel', async () => {
    const bridge = await loadBridge()
    await bridge.invoke('editorProjectLoad', undefined)
    await bridge.invoke('editorMediaChoose', { relinkId: 'local-one' })
    await bridge.invoke('editorMediaRestore', { id: 'local-one' })
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['stream-syncer:editor-invoke', 'editorProjectLoad', undefined],
      ['stream-syncer:editor-invoke', 'editorMediaChoose', { relinkId: 'local-one' }],
      ['stream-syncer:editor-invoke', 'editorMediaRestore', { id: 'local-one' }],
    ])
  })
})
