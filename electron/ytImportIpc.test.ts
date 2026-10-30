import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { installYouTubeAdminIpc } from './ytImportIpc'

function fixture() {
  const owner = Object.assign(new EventEmitter(), { id: 1, mainFrame: { url: 'app://app/admin' }, isDestroyed: () => false, send: vi.fn() })
  const ownerWindow = { webContents: owner } as unknown as BrowserWindow
  const browse = { open: vi.fn(async () => ({ videoId: 'abcdefghijk' })), close: vi.fn(async () => {}), command: vi.fn(),
    state: vi.fn(), snapshot: vi.fn(), setViewport: vi.fn() }
  const imports = { start: vi.fn(() => ({ jobId: 'job-1', state: 'probing' })), cancel: vi.fn(async () => undefined),
    list: vi.fn(() => []), cancelAll: vi.fn(async () => {}) }
  let invoke: (...args: any[]) => Promise<any> = async () => {}
  const ipc = { handle: vi.fn((_channel, handler) => { invoke = handler }), removeHandler: vi.fn() }
  const installed = installYouTubeAdminIpc(ipc, owner as unknown as WebContents, { ownerWindow, browse, imports } as any)
  const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent
  return { owner, ownerWindow, browse, imports, ipc, installed, event,
    call: (method: string, args?: unknown) => invoke(event, method, args),
    from: (sender: unknown, frame: unknown, method: string, args?: unknown) => invoke({ sender, senderFrame: frame }, method, args) }
}

describe('YouTube admin IPC boundary', () => {
  it('rejects non admin documents, foreign native owners and subframes', async () => {
    const f = fixture()
    for (const url of ['app://app/', 'app://app/pip', 'https://www.youtube.com/watch?v=abcdefghijk', 'app://evil/admin']) {
      f.owner.mainFrame.url = url
      expect(await f.call('ytImportList')).toMatchObject({ ok: false, code: 'forbidden' })
    }
    f.owner.mainFrame.url = 'app://app/admin'
    expect(await f.from({ ...f.owner }, f.owner.mainFrame, 'ytImportList')).toMatchObject({ code: 'forbidden' })
    expect(await f.from(f.owner, { url: 'app://app/admin' }, 'ytImportList')).toMatchObject({ code: 'forbidden' })
    expect(await f.from({ ...f.owner }, f.owner.mainFrame, 'ytBrowseSetViewport',
      { rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true })).toMatchObject({ code: 'forbidden' })
    expect(f.browse.setViewport).not.toHaveBeenCalled()
    expect(f.imports.list).not.toHaveBeenCalled()
    await f.installed.dispose()
  })

  it('strictly validates viewport fields, finite coordinates and inclusive bounds', async () => {
    const f = fixture()
    const rect = { x: 0, y: 0, width: 640, height: 360 }
    const invalid = [undefined, null, [], {}, { rect }, { rect, visible: 1 }, { rect, visible: true, viewId: 1 },
      { rect: [], visible: true }, { rect: { ...rect, extra: 1 }, visible: true },
      { rect: { x: 0, y: 0, width: 1 }, visible: true },
      { rect, get visible() { throw new Error('must not read accessors') } },
      { rect: { ...rect, get x() { throw new Error('must not read accessors') } }, visible: true },
      { rect, visible: true, [Symbol('extra')]: 1 },
    ]
    for (const field of ['x', 'y', 'width', 'height']) {
      for (const value of [NaN, Infinity, -Infinity, '1', null, 10001]) invalid.push({ rect: { ...rect, [field]: value }, visible: true })
      invalid.push({ rect: { ...rect, [field]: field === 'x' || field === 'y' ? -10001 : -1 }, visible: true })
    }
    for (const args of invalid) expect(await f.call('ytBrowseSetViewport', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(f.browse.setViewport).not.toHaveBeenCalled()
    for (const viewport of [
      { rect: { x: -10000, y: 10000, width: 10000, height: 0 }, visible: false },
      { rect: { x: 10000, y: -10000, width: 0, height: 10000 }, visible: true },
    ]) {
      expect(await f.call('ytBrowseSetViewport', viewport)).toEqual({ ok: true, value: { ok: true } })
      expect(f.browse.setViewport).toHaveBeenLastCalledWith(viewport)
    }
    expect(await f.call('ytBrowseInput', {})).toMatchObject({ code: 'unknown-method' })
    expect(await f.call('ytBrowsePreviewAck', {})).toMatchObject({ code: 'unknown-method' })
    await f.installed.dispose()
  })

  it('validates exact argument shapes, bounds and no-argument methods', async () => {
    const f = fixture()
    for (const [method, args] of [
      ['ytBrowseOpen', { url: 'x', cookies: 'secret' }], ['ytBrowseOpen', { url: 3 }],
      ['ytBrowseClose', {}], ['ytBrowseState', {}], ['ytBrowseSnapshot', null], ['ytImportList', {}],
      ['ytBrowseCommand', { action: 'eval', seconds: 2 }], ['ytBrowseCommand', { action: 'seek', seconds: NaN }],
      ['ytBrowseCommand', { action: 'pause', seconds: 2 }], ['ytImportCancel', { jobId: '../../file' }],
      ['ytImportStart', { url: 'x', startSeconds: 3, endSeconds: 2 }],
      ['ytImportStart', { url: 'x', startSeconds: 0, endSeconds: 301, output: 'file' }],
    ] as const) expect(await f.call(method, args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await f.call('ytImportStart', { url: 'x', startSeconds: 0, endSeconds: 301 })).toMatchObject({ code: 'too-long' })
    expect(f.imports.start).not.toHaveBeenCalled()
    expect(f.browse.open).not.toHaveBeenCalled()
    expect(await f.call('arbitrary')).toMatchObject({ code: 'unknown-method' })
    await f.installed.dispose()
  })

  it('routes approved operations without exposing native events', async () => {
    const f = fixture()
    expect(await f.call('ytBrowseOpen', { url: 'https://www.youtube.com/watch?v=abcdefghijk' })).toMatchObject({ ok: true, value: { videoId: 'abcdefghijk' } })
    const viewport = { rect: { x: 10, y: 20, width: 640, height: 360 }, visible: true }
    expect(await f.call('ytBrowseSetViewport', viewport)).toEqual({ ok: true, value: { ok: true } })
    await f.call('ytBrowseCommand', { action: 'seek', seconds: 4 })
    await f.call('ytImportStart', { url: 'https://www.youtube.com/watch?v=abcdefghijk', startSeconds: 0, endSeconds: 20 })
    expect(f.imports.start).toHaveBeenCalledWith({ url: 'https://www.youtube.com/watch?v=abcdefghijk', startSeconds: 0, endSeconds: 20 })
    expect(f.browse.open).toHaveBeenCalledWith(f.ownerWindow, 'https://www.youtube.com/watch?v=abcdefghijk')
    expect(f.browse.setViewport).toHaveBeenCalledExactlyOnceWith(viewport)
    expect(f.installed.emit('yt-import-progress', { state: 'ready' })).toBe(true)
    expect(f.owner.send).toHaveBeenCalledWith('stream-syncer:yt-import-progress', { state: 'ready' })
    expect(f.installed.emit('yt-browse-state', {}, 99)).toBe(false)
    await f.installed.dispose()
  })

  it('cleans up on SPA departure, full navigation and owner destruction', async () => {
    const f = fixture()
    f.owner.mainFrame.url = 'app://app/'
    f.owner.emit('did-navigate-in-page', {}, 'app://app/', true)
    expect(f.browse.close).toHaveBeenCalledOnce()
    expect(f.imports.cancelAll).toHaveBeenCalledOnce()
    expect(f.installed.emit('yt-import-progress', {})).toBe(false)
    f.owner.emit('did-start-navigation', {}, 'app://app/admin', false, true)
    f.owner.emit('destroyed')
    await f.installed.dispose()
    expect(f.ipc.removeHandler).toHaveBeenCalledWith('stream-syncer:yt-invoke')
    expect(f.owner.listenerCount('did-navigate-in-page')).toBe(0)
  })

  it('drops pending results when admin ownership changes', async () => {
    const f = fixture()
    let resolve!: (value: any) => void
    f.browse.open.mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = f.call('ytBrowseOpen', { url: 'https://www.youtube.com/watch?v=abcdefghijk' })
    await vi.waitFor(() => expect(f.browse.open).toHaveBeenCalled())
    f.owner.emit('did-start-navigation', {}, 'app://app/', false, true)
    resolve({ videoId: 'abcdefghijk' })
    expect(await pending).toMatchObject({ code: 'forbidden' })
    await f.installed.dispose()
  })

  it('returns fixed messages and error codes, never raw upstream diagnostics', async () => {
    const f = fixture()
    for (const error of [new Error('Cookie=secret https://signed.example/token'),
      { code: 'auth-required', message: 'Cookie=secret', stack: 'private path' }]) {
      f.browse.open.mockRejectedValueOnce(error)
      const result = await f.call('ytBrowseOpen', { url: 'https://www.youtube.com/watch?v=abcdefghijk' })
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/secret|signed|private path/)
    }
    await f.installed.dispose()
  })

  it.each([
    ['origin-tainted', '读不到视频画面，YouTube 可能换了播放方式'],
    ['player-only-failed', '无法只显示播放器，请重新打开录像'],
  ])('returns the fixed message for %s', async (code, message) => {
    const f = fixture()
    f.browse.snapshot.mockRejectedValueOnce({ code, message: 'Cookie=secret', stack: 'private path' })
    expect(await f.call('ytBrowseSnapshot')).toEqual({ ok: false, code, message })
    await f.installed.dispose()
  })
})
