import type { BrowserWindow } from 'electron'
import type { ApiResult } from '../src/app/apiClient'
import type { WindowState } from './contracts'
import { isAppDocument } from './security'

export function getWindowState(win: BrowserWindow): WindowState {
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() }
}

export function invokeWindowMethod(win: BrowserWindow | null, method: 'windowControl' | 'getWindowState',
  args: unknown): ApiResult<WindowState> {
  const descriptor = args && typeof args === 'object' && !Array.isArray(args) && Reflect.ownKeys(args).length === 1
    ? Object.getOwnPropertyDescriptor(args, 'action') : undefined
  const action: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
  if (method === 'getWindowState' ? args !== undefined : !['minimize', 'toggle-maximize', 'close'].includes(action as string)) {
    return { ok: false, code: 'invalid-arguments', message: '窗口控制参数无效' }
  }
  if (!win || win.isDestroyed()) return { ok: false, code: 'not-available', message: '窗口已关闭或不可用' }
  if (method === 'getWindowState') return { ok: true, value: getWindowState(win) }
  if (action === 'close') {
    // close() may destroy the native window synchronously. Preserve its last live state,
    // and let the existing close/before-quit handlers own cancellation and cleanup.
    const state = getWindowState(win)
    win.close()
    return { ok: true, value: state }
  }
  if (action === 'minimize') win.minimize()
  else if (win.isMaximized()) win.unmaximize()
  else win.maximize()
  return { ok: true, value: getWindowState(win) }
}

/** Only the main window opts into state notifications; PiP keeps its native chrome. */
export function subscribeWindowState(win: BrowserWindow): () => void {
  const contents = win.webContents
  const emitter: NodeJS.EventEmitter = win
  const events = ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const
  let active = true
  const publish = () => {
    try {
      if (active && !win.isDestroyed() && !contents.isDestroyed() && isAppDocument(contents.mainFrame.url)) {
        contents.send('stream-syncer:window-state', getWindowState(win))
      }
    } catch { /* Native destruction/navigation may race a queued window event. */ }
  }
  const release = () => {
    if (!active) return
    active = false
    for (const event of events) emitter.removeListener(event, publish)
    win.removeListener('closed', release)
    contents.removeListener('destroyed', release)
  }
  if (win.isDestroyed() || contents.isDestroyed()) return release
  for (const event of events) emitter.on(event, publish)
  win.once('closed', release)
  contents.once('destroyed', release)
  return release
}
