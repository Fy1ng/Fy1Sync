import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { getWindowState, invokeWindowMethod, subscribeWindowState } from './windowControls'

function fixture() {
  const state = { maximized: false, fullscreen: false, focused: true }
  let destroyed = false
  let contentsDestroyed = false
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'app://app/' }, isDestroyed: () => contentsDestroyed, send: vi.fn(),
  })
  const read = <T>(value: T): T => { if (destroyed) throw new Error('Window destroyed'); return value }
  const native = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => destroyed,
    isMaximized: vi.fn(() => read(state.maximized)),
    isFullScreen: vi.fn(() => read(state.fullscreen)),
    isFocused: vi.fn(() => read(state.focused)),
    minimize: vi.fn(() => { state.focused = false }),
    maximize: vi.fn(() => { state.maximized = true }),
    unmaximize: vi.fn(() => { state.maximized = false }),
    close: vi.fn(),
  })
  return {
    native, contents, state, win: native as unknown as BrowserWindow,
    destroy: () => { destroyed = true },
    destroyContents: () => { contentsDestroyed = true },
  }
}

describe('native window controls', () => {
  it('reads the current native state and minimizes through the normal window API', () => {
    const f = fixture()
    expect(getWindowState(f.win)).toEqual({ maximized: false, fullscreen: false, focused: true })
    expect(invokeWindowMethod(f.win, 'getWindowState', undefined)).toEqual({ ok: true, value: f.state })
    expect(invokeWindowMethod(f.win, 'windowControl', { action: 'minimize' }))
      .toEqual({ ok: true, value: { maximized: false, fullscreen: false, focused: false } })
    expect(f.native.minimize).toHaveBeenCalledExactlyOnceWith()
    expect(f.native.close).not.toHaveBeenCalled()
  })

  it('toggles maximize and restore using the current native state', () => {
    const f = fixture()
    expect(invokeWindowMethod(f.win, 'windowControl', { action: 'toggle-maximize' }))
      .toMatchObject({ ok: true, value: { maximized: true } })
    expect(f.native.maximize).toHaveBeenCalledExactlyOnceWith()
    expect(invokeWindowMethod(f.win, 'windowControl', { action: 'toggle-maximize' }))
      .toMatchObject({ ok: true, value: { maximized: false } })
    expect(f.native.unmaximize).toHaveBeenCalledExactlyOnceWith()
  })

  it('closes normally and returns a snapshot without reading a synchronously destroyed window', () => {
    const f = fixture()
    f.state.maximized = true
    f.native.close.mockImplementation(() => { f.destroy(); f.native.emit('closed') })
    expect(invokeWindowMethod(f.win, 'windowControl', { action: 'close' }))
      .toEqual({ ok: true, value: { maximized: true, fullscreen: false, focused: true } })
    expect(f.native.close).toHaveBeenCalledExactlyOnceWith()
  })

  it('allows the existing close handler to cancel closing', () => {
    const f = fixture()
    const cancel = vi.fn()
    f.native.on('close', cancel)
    f.native.close.mockImplementation(() => { f.native.emit('close') })
    expect(invokeWindowMethod(f.win, 'windowControl', { action: 'close' })).toMatchObject({ ok: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect(f.native.isDestroyed()).toBe(false)
  })

  it.each([
    undefined, null, 'minimize', ['close'], {}, { action: 'destroy' }, { action: 'maximize' },
    { action: 'MINIMIZE' }, { action: 1 }, { action: 'close', windowId: 1 },
    Object.create({ action: 'close' }), { action: 'close', [Symbol('target')]: 2 },
  ].map(args => ({ args })))('rejects malformed or target-selecting action arguments: $args', ({ args }) => {
    const f = fixture()
    expect(invokeWindowMethod(f.win, 'windowControl', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(f.native.minimize).not.toHaveBeenCalled()
    expect(f.native.maximize).not.toHaveBeenCalled()
    expect(f.native.unmaximize).not.toHaveBeenCalled()
    expect(f.native.close).not.toHaveBeenCalled()
  })

  it('does not evaluate an action getter', () => {
    const f = fixture()
    const getter = vi.fn(() => 'close')
    const args = Object.defineProperty({}, 'action', { enumerable: true, get: getter })
    expect(invokeWindowMethod(f.win, 'windowControl', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(getter).not.toHaveBeenCalled()
    expect(f.native.close).not.toHaveBeenCalled()
  })

  it.each([null, {}, { windowId: 1 }, []].map(args => ({ args })))('rejects arguments to getWindowState: $args', ({ args }) => {
    const f = fixture()
    expect(invokeWindowMethod(f.win, 'getWindowState', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
  })

  it('does not use missing or destroyed native windows', () => {
    const f = fixture()
    expect(invokeWindowMethod(null, 'getWindowState', undefined)).toMatchObject({ ok: false, code: 'not-available' })
    f.destroy()
    expect(invokeWindowMethod(f.win, 'windowControl', { action: 'close' })).toMatchObject({ ok: false, code: 'not-available' })
    expect(f.native.close).not.toHaveBeenCalled()
  })
})

describe('window state delivery and lifetime', () => {
  const events = ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const

  it.each(events)('publishes fresh native state to only the owning contents on %s', event => {
    const f = fixture()
    const other = fixture()
    const release = subscribeWindowState(f.win)
    Object.assign(f.state, { maximized: true, fullscreen: true, focused: false })
    f.native.emit(event)
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith('stream-syncer:window-state', {
      maximized: true, fullscreen: true, focused: false,
    })
    expect(other.contents.send).not.toHaveBeenCalled()
    release()
  })

  it('does not publish to a destroyed window or webContents', () => {
    const f = fixture()
    const release = subscribeWindowState(f.win)
    f.destroyContents()
    f.native.emit('focus')
    f.destroy()
    f.native.emit('maximize')
    expect(f.contents.send).not.toHaveBeenCalled()
    release()
  })

  it('does not publish native state after navigation to an untrusted document', () => {
    const f = fixture()
    const release = subscribeWindowState(f.win)
    f.contents.mainFrame.url = 'https://example.com/'
    f.native.emit('focus')
    expect(f.contents.send).not.toHaveBeenCalled()
    release()
  })

  it.each(['closed', 'contents-destroyed', 'unsubscribe'])('detaches all event handlers after %s', reason => {
    const f = fixture()
    const release = subscribeWindowState(f.win)
    const stale = f.native.listeners('maximize')[0]!
    if (reason === 'closed') { f.destroy(); f.native.emit('closed') }
    else if (reason === 'contents-destroyed') { f.destroyContents(); f.contents.emit('destroyed') }
    else release()
    for (const event of events) {
      expect(f.native.listenerCount(event)).toBe(0)
      f.native.emit(event)
    }
    stale()
    release()
    release()
    expect(f.native.listenerCount('closed')).toBe(0)
    expect(f.contents.listenerCount('destroyed')).toBe(0)
    expect(f.contents.send).not.toHaveBeenCalled()
  })
})
