import { EventEmitter } from 'node:events'
import type { BrowserWindow, Session, WebContentsView } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: {}, WebContentsView: class {} }))
import { LocalLoginCard } from './loginCardView'

function fixture() {
  const owner = { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, isDestroyed: () => false,
    loadURL: vi.fn(async (url: string) => { contents.mainFrame.url = url }), close: vi.fn(), send: vi.fn(),
    setWindowOpenHandler: vi.fn((_handler: (request: { url: string }) => { action: string }) => {}), setIgnoreMenuShortcuts: vi.fn(),
  })
  const view = { webContents: contents, setBounds: vi.fn(), setVisible: vi.fn(), setBackgroundColor: vi.fn(), setBorderRadius: vi.fn() }
  const browserSession = Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    protocol: { handle: vi.fn(async (_scheme: string, _handler: (request: Request) => Response) => {}), unhandle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn((_handler: (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) => {}) },
    closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
  })
  const createSession = vi.fn(() => browserSession as unknown as Session)
  const createView = vi.fn((_options: Electron.WebContentsViewConstructorOptions) => view as unknown as WebContentsView)
  const escape = vi.fn()
  const card = new LocalLoginCard({ id: '00000000-0000-4000-8000-000000000001', owner: owner as unknown as BrowserWindow,
    preload: '/synthetic/login-card-preload.cjs', createSession, createView, escape })
  return { owner, contents, view, browserSession, createSession, createView, escape, card }
}

describe('isolated network-disabled local login card', () => {
  it('uses a separate ephemeral session and exposes its bridge only in the sandboxed local card', async () => {
    const f = fixture()
    await f.card.open()
    expect(f.createSession).toHaveBeenCalledWith('fy1sync-login-card-00000000-0000-4000-8000-000000000001')
    expect(f.createView.mock.calls[0]![0].webPreferences).toMatchObject({ session: f.browserSession,
      preload: '/synthetic/login-card-preload.cjs', sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    })
    expect(f.contents.loadURL).toHaveBeenCalledWith(f.card.url)
    expect(f.contents.setWindowOpenHandler.mock.calls[0]![0]({ url: 'https://live.douyin.com/' })).toEqual({ action: 'deny' })
    await f.card.close()
  })

  it('permits only its own static assets and serves a CSP without network, frames or inline scripts', async () => {
    const f = fixture()
    await f.card.open()
    const handler = f.browserSession.webRequest.onBeforeRequest.mock.calls[0]![0]
    const response = vi.fn()
    handler({ url: f.card.url }, response)
    expect(response).toHaveBeenLastCalledWith({ cancel: false })
    for (const url of ['https://live.douyin.com/', 'app://app/', `${f.card.url}?password=synthetic`, `${f.card.url}unknown.js`]) {
      handler({ url }, response)
      expect(response).toHaveBeenLastCalledWith({ cancel: true })
    }
    const protocol = f.browserSession.protocol.handle.mock.calls[0]![1] as (request: Request) => Response
    const document = protocol(new Request(f.card.url))
    expect(document.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(document.headers.get('content-security-policy')).toContain("frame-src 'none'")
    expect(document.headers.get('content-security-policy')).not.toContain('unsafe-inline')
    expect(protocol(new Request(f.card.url, { method: 'POST' })).status).toBe(404)
    await f.card.close()
  })

  it('blocks navigation and cancels on Escape without opening an external account window', async () => {
    const f = fixture()
    await f.card.open()
    const event = { preventDefault: vi.fn() }
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) f.contents.emit(name, event)
    expect(event.preventDefault).toHaveBeenCalledTimes(4)
    f.contents.emit('before-input-event', event, { key: 'Escape' })
    expect(f.escape).toHaveBeenCalledOnce()
    await f.card.close()
  })

  it('clears the private card storage even when detaching its native view fails and closes only once', async () => {
    const f = fixture()
    await f.card.open()
    f.owner.contentView.removeChildView.mockImplementation(() => { throw new Error('synthetic owner already closed') })
    await f.card.close()
    await f.card.close()
    expect(f.contents.close).toHaveBeenCalledOnce()
    expect(f.browserSession.closeAllConnections).toHaveBeenCalledOnce()
    expect(f.browserSession.clearStorageData).toHaveBeenCalledOnce()
    expect(f.browserSession.clearCache).toHaveBeenCalledOnce()
    expect(f.browserSession.protocol.unhandle).toHaveBeenCalledWith('app')
    const handler = f.browserSession.webRequest.onBeforeRequest.mock.calls[0]![0]
    const response = vi.fn()
    handler({ url: f.card.url }, response)
    expect(response).toHaveBeenCalledWith({ cancel: true })
  })
})
