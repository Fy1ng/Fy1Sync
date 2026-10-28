import { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopService } from '../server/api'
import { installIpcHandlers, type IpcHandlerOptions } from './ipc'

function windowFixture(id: number) {
  const contents = Object.assign(new EventEmitter(), {
    id, mainFrame: { url: 'app://app/' }, isDestroyed: () => false, send: vi.fn(),
  }) as unknown as WebContents
  const native = {
    webContents: contents, isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false), isFullScreen: vi.fn(() => false), isFocused: vi.fn(() => true),
    minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(), close: vi.fn(),
  }
  return { contents, native, win: native as unknown as BrowserWindow }
}

const disposals: Array<() => void> = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose() })

function fixture(options: IpcHandlerOptions = {}) {
  const main = windowFixture(1)
  const pip = windowFixture(2)
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = {
    handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain
  const invoke = vi.fn(async () => ({ ok: true, value: {} }))
  const service = { invoke, relay: { subscribe: vi.fn() } } as unknown as DesktopService
  const windowForContents = vi.fn((contents: WebContents) =>
    contents === main.contents ? main.win : contents === pip.contents ? pip.win : null)
  const installed = installIpcHandlers(ipc, main.contents, service, { windowForContents, ...options })
  disposals.push(() => installed.dispose())
  return {
    main, pip, invoke, installed, windowForContents,
    call: (contents: WebContents, method: string, args?: unknown, frame = contents.mainFrame) =>
      handlers.get('stream-syncer:invoke')!({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, method, args),
  }
}

describe('window IPC sender ownership', () => {
  it('resolves the exact sender and handles state without forwarding to the account service', async () => {
    const f = fixture()
    expect(await f.call(f.main.contents, 'getWindowState')).toEqual({
      ok: true, value: { maximized: false, fullscreen: false, focused: true },
    })
    expect(f.windowForContents).toHaveBeenCalledExactlyOnceWith(f.main.contents)
    expect(await f.call(f.main.contents, 'windowControl', { action: 'minimize' })).toMatchObject({ ok: true })
    expect(f.main.native.minimize).toHaveBeenCalledExactlyOnceWith()
    expect(f.pip.native.minimize).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('uses the requesting additional window rather than the main window when explicitly granted', async () => {
    const f = fixture({ allowMethod: (_id, method) => method === 'windowControl' || method === 'getWindowState' })
    f.installed.registerWindow(f.pip.contents)
    expect(await f.call(f.pip.contents, 'windowControl', { action: 'close' })).toMatchObject({ ok: true })
    expect(f.windowForContents).toHaveBeenCalledExactlyOnceWith(f.pip.contents)
    expect(f.pip.native.close).toHaveBeenCalledExactlyOnceWith()
    expect(f.main.native.close).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('preserves denial of ungranted PiP controls despite the shared preload', async () => {
    const f = fixture({ allowMethod: (_id, method) => method === 'getEnhancedPip' })
    f.installed.registerWindow(f.pip.contents)
    expect(await f.call(f.pip.contents, 'windowControl', { action: 'close' }))
      .toMatchObject({ ok: false, code: 'forbidden' })
    expect(await f.call(f.pip.contents, 'getWindowState')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.windowForContents).not.toHaveBeenCalled()
    expect(f.main.native.close).not.toHaveBeenCalled()
    expect(f.pip.native.close).not.toHaveBeenCalled()
  })

  it('rejects unregistered windows, forged sender identities, and same-origin subframes before lookup', async () => {
    const f = fixture()
    expect(await f.call(f.pip.contents, 'windowControl', { action: 'close' })).toMatchObject({ code: 'forbidden' })
    const forged = windowFixture(1)
    expect(await f.call(forged.contents, 'windowControl', { action: 'close' })).toMatchObject({ code: 'forbidden' })
    expect(await f.call(f.main.contents, 'windowControl', { action: 'close' }, { url: 'app://app/' } as WebContents['mainFrame']))
      .toMatchObject({ code: 'forbidden' })
    expect(f.windowForContents).not.toHaveBeenCalled()
    expect(f.main.native.close).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('rejects destroyed or navigated senders before lookup', async () => {
    const f = fixture()
    vi.spyOn(f.main.contents, 'isDestroyed').mockReturnValue(true)
    expect(await f.call(f.main.contents, 'getWindowState')).toMatchObject({ code: 'forbidden' })
    vi.spyOn(f.main.contents, 'isDestroyed').mockReturnValue(false)
    Object.assign(f.main.contents.mainFrame, { url: 'https://example.com/' })
    expect(await f.call(f.main.contents, 'windowControl', { action: 'close' })).toMatchObject({ code: 'forbidden' })
    expect(f.windowForContents).not.toHaveBeenCalled()
  })

  it('reports an unavailable native window without falling back to the service or main window', async () => {
    const f = fixture({ windowForContents: () => null })
    expect(await f.call(f.main.contents, 'windowControl', { action: 'close' }))
      .toMatchObject({ ok: false, code: 'not-available' })
    expect(f.main.native.close).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('returns invalid-arguments for bad actions through the actual IPC handler', async () => {
    const f = fixture()
    for (const args of [undefined, { action: 'destroy' }, { action: 'close', senderId: 2 }]) {
      expect(await f.call(f.main.contents, 'windowControl', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    expect(await f.call(f.main.contents, 'getWindowState', {})).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(f.main.native.close).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
  })
})
