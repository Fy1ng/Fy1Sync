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
  it('exposes a frozen bridge and allows both window methods on the existing invoke channel', async () => {
    const bridge = await loadBridge()
    expect(Object.isFrozen(bridge)).toBe(true)
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
