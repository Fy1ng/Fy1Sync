import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { DesktopService } from '../server/api'
import { installIpcHandlers, trustedSender } from './ipc'
import { CONTENT_SECURITY_POLICY, isAppDocument, isAppOrigin } from './security'
import type { BufferState } from './bufferManager'
import type { DouyuTasksSnapshot } from '../server/douyu/types'

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'app://app/' }, isDestroyed: () => false, send: vi.fn(),
  }) as unknown as WebContents
  const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) } as unknown as IpcMain
  const release = vi.fn()
  const subscribe = vi.fn((_room: string, subscriber: { write: (event: string, data: unknown) => void }) => {
    subscriber.write('state', { state: 'connecting' })
    return release
  })
  let bufferListener: ((state: BufferState) => void) | undefined
  const bufferRelease = vi.fn()
  let taskListener: ((state: DouyuTasksSnapshot) => void) | undefined
  const taskRelease = vi.fn()
  const setRoom = vi.fn()
  const resolveRoom = vi.fn(async (room: string) => ({ ok: true, identity: { room, inputRoom: room } }))
  const service = { resolveDouyuRoom: resolveRoom, invoke: vi.fn(async () => ({ ok: true, value: {} })), relay: { subscribe }, dispose: vi.fn(),
    subscribeBuffer: (listener: (state: BufferState) => void) => { bufferListener = listener; return bufferRelease },
    subscribeDouyuTasks: (listener: (state: DouyuTasksSnapshot) => void) => { taskListener = listener; return taskRelease },
    setDouyuRoom: setRoom,
  } as unknown as DesktopService
  const installed = installIpcHandlers(ipc, contents, service)
  return { resolveRoom, contents, event, handlers, release, subscribe, service, installed,
    bufferRelease, emitBuffer: (state: BufferState) => bufferListener?.(state),
    taskRelease, setRoom, emitTasks: (state: DouyuTasksSnapshot) => taskListener?.(state),
    call: (channel: string, ...args: unknown[]) => handlers.get('stream-syncer:' + channel)!(event, ...args),
  }
}

describe('app origin and document boundary', async () => {
  it('trusts only the fixed privileged origin', async () => {
    expect(isAppOrigin('app://app/assets/app.js')).toBe(true)
    for (const raw of ['https://app/', 'app://evil/', 'app://app.evil/', 'app://app:80/', 'app://user@app/', 'file:///index.html', 'invalid']) expect(isAppOrigin(raw)).toBe(false)
  })
  it('permits only app document routes to receive IPC', async () => {
    for (const raw of ['app://app/', 'app://app/index.html', 'app://app/admin', 'app://app/admin/']) expect(isAppDocument(raw)).toBe(true)
    for (const raw of ['app://app/media/id', 'app://app/assets/app.js', 'app://app/api/health', 'https://example.com/']) expect(isAppDocument(raw)).toBe(false)
  })
  it('uses a CSP without remote scripts, frames, JS eval or wildcard sources', async () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/(?:^|[\s'])unsafe-eval|https?:|\*/)
    expect(CONTENT_SECURITY_POLICY.split('; ').find((part) => part.startsWith('script-src')))
      .toBe("script-src 'self' 'wasm-unsafe-eval'")
  })
  it('rejects a different webContents even if it claims the same URL', async () => {
    const f = fixture()
    expect(trustedSender(f.event, f.contents)).toBe(true)
    expect(trustedSender({ ...f.event, sender: {} } as IpcMainInvokeEvent, f.contents)).toBe(false)
    f.installed.dispose()
  })
  it('rejects same-origin subframes and stale frames', async () => {
    const f = fixture()
    expect(trustedSender({ ...f.event, senderFrame: { url: 'app://app/' } } as IpcMainInvokeEvent, f.contents)).toBe(false)
    Object.assign(f.contents.mainFrame, { url: 'app://app/media/untrusted' })
    expect(trustedSender(f.event, f.contents)).toBe(false)
    f.installed.dispose()
  })
  it('rejects destroyed windows', async () => {
    const f = fixture()
    vi.spyOn(f.contents, 'isDestroyed').mockReturnValue(true)
    expect(trustedSender(f.event, f.contents)).toBe(false)
    f.installed.dispose()
  })
})

describe('IPC routing and subscription lifecycle', async () => {
  it('delivers task summaries only to app documents and unsubscribes on disposal', () => {
    const f = fixture()
    const state: DouyuTasksSnapshot = { activeAccountId: 'default', currentRoom: null, retainedRooms: [], tasks: [], runtime: { foreground: true, locked: false, suspended: false } }
    f.emitTasks(state)
    expect(f.contents.send).toHaveBeenCalledWith('stream-syncer:douyu-tasks', state)
    vi.mocked(f.contents.send).mockClear()
    Object.assign(f.contents.mainFrame, { url: 'https://untrusted.invalid/' })
    f.emitTasks(state)
    expect(f.contents.send).not.toHaveBeenCalled()
    f.installed.dispose()
    expect(f.taskRelease).toHaveBeenCalledOnce()
    Object.assign(f.contents.mainFrame, { url: 'app://app/' })
    f.emitTasks(state)
    expect(f.contents.send).not.toHaveBeenCalled()
  })
  it('delivers buffer summaries only to a trusted app document and releases on disposal', async () => {
    const f = fixture()
    const state: BufferState = { role: 'official', state: 'buffering', seconds: 3.5 }
    f.emitBuffer(state)
    expect(f.contents.send).toHaveBeenCalledWith('stream-syncer:buffer', state)
    f.contents.send = vi.fn()
    Object.assign(f.contents.mainFrame, { url: 'app://app/buffer/untrusted' })
    f.emitBuffer(state)
    expect(f.contents.send).not.toHaveBeenCalled()
    f.installed.dispose()
    expect(f.bufferRelease).toHaveBeenCalledOnce()
  })
  it('forwards only trusted invokes to the validated service', async () => {
    const f = fixture()
    await f.call('invoke', 'health', undefined)
    expect(f.service.invoke).toHaveBeenCalledWith('health', undefined)
    Object.assign(f.contents.mainFrame, { url: 'https://example.com/' })
    expect(await f.call('invoke', 'health', undefined)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.service.invoke).toHaveBeenCalledTimes(1)
    f.installed.dispose()
  })
  it('denies decoder writes from untrusted frames before reaching storage', async () => {
    const f = fixture()
    const invoke = f.handlers.get('stream-syncer:invoke')!
    expect(await invoke({ ...f.event, senderFrame: { url: 'app://app/' } }, 'setDecoderPreferences', { mode: 'software' }))
      .toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.service.invoke).not.toHaveBeenCalled()
    expect(await f.call('invoke', 'setDecoderPreferences', { mode: 'software' })).toMatchObject({ ok: true })
    expect(f.service.invoke).toHaveBeenCalledExactlyOnceWith('setDecoderPreferences', { mode: 'software' })
    f.installed.dispose()
  })
  it('delivers relay events with isolated subscription identifiers', async () => {
    const f = fixture()
    expect(await f.call('subscribe', '288016', '1')).toMatchObject({ ok: true })
    expect(f.contents.send).toHaveBeenCalledWith('stream-syncer:danmaku', { subscriptionId: '1', event: 'state', data: { state: 'connecting' } })
    expect(f.installed.emitDanmaku('other-room', 'danmaku', {})).toBe(0)
    expect(f.installed.emitDanmaku('288016', 'danmaku', { text: '测试' })).toBe(1)
    f.installed.dispose()
  })
  it('rejects malformed room IDs and subscription IDs before opening upstream', async () => {
    const f = fixture()
    for (const room of ['', 'abc', 'evil.com/1', '../1', '1'.repeat(17), null, {}]) expect(await f.call('subscribe', room, '1')).toMatchObject({ ok: false })
    for (const id of ['', '../1', '1'.repeat(13), null]) expect(await f.call('subscribe', '288016', id)).toMatchObject({ ok: false })
    expect(f.subscribe).not.toHaveBeenCalled()
    f.installed.dispose()
  })
  it('rejects duplicate subscription IDs and limits subscriptions', async () => {
    const f = fixture()
    for (let n = 0; n < 16; n++) expect(await f.call('subscribe', '288016', String(n))).toMatchObject({ ok: true })
    expect(await f.call('subscribe', '288016', '0')).toMatchObject({ ok: false, code: 'subscription-limit' })
    expect(await f.call('subscribe', '288016', '99')).toMatchObject({ ok: false, code: 'subscription-limit' })
    f.installed.dispose()
    expect(f.release).toHaveBeenCalledTimes(16)
  })
  it('reports room-cap exhaustion without registering a subscriber', async () => {
    const f = fixture()
    f.subscribe.mockReturnValueOnce(null as never)
    expect(await f.call('subscribe', '288016', '1')).toMatchObject({ ok: false, code: 'room-limit' })
    expect(f.installed.emitDanmaku('288016', 'danmaku', {})).toBe(0)
    expect(f.setRoom).not.toHaveBeenCalled()
    f.installed.dispose()
  })
  it('releases once when unsubscribed repeatedly', async () => {
    const f = fixture()
    await f.call('subscribe', '288016', '1')
    f.call('unsubscribe', '1')
    f.call('unsubscribe', '1')
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.installed.emitDanmaku('288016', 'danmaku', {})).toBe(0)
    expect(f.setRoom.mock.calls).toEqual([['288016'], [null]])
    f.installed.dispose()
  })
  it('cleans subscriptions on document reload and renderer destruction', async () => {
    const f = fixture()
    await f.call('subscribe', '288016', '1')
    f.contents.emit('did-start-navigation', {}, 'app://app/admin', false, true)
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.setRoom).toHaveBeenLastCalledWith(null)
    await f.call('subscribe', '288016', '2')
    f.contents.emit('destroyed')
    expect(f.release).toHaveBeenCalledTimes(2)
    expect(f.setRoom.mock.calls).toEqual([['288016'], [null], ['288016'], [null]])
    f.installed.dispose()
    expect(f.handlers.size).toBe(0)
  })
  it('does not cancel on hash navigation or a subframe navigation', async () => {
    const f = fixture()
    await f.call('subscribe', '288016', '1')
    f.contents.emit('did-start-navigation', {}, 'app://app/#settings', true, true)
    f.contents.emit('did-start-navigation', {}, 'app://app/', false, false)
    expect(f.release).not.toHaveBeenCalled()
    f.installed.dispose()
  })
  it('refuses subscription mutation from untrusted frames', async () => {
    const f = fixture()
    await f.call('subscribe', '288016', '1')
    Object.assign(f.contents.mainFrame, { url: 'https://evil.example/' })
    expect(await f.call('subscribe', '288016', '2')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await f.call('unsubscribe', '1')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.release).not.toHaveBeenCalled()
    f.installed.dispose()
  })
})


describe('pending canonical-room subscription isolation', () => {
  it('keeps the newest connected room when an older lookup finishes or unsubscribes', async () => {
    const f = fixture()
    let settle!: (value: any) => void
    f.resolveRoom.mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
    const older = f.call('subscribe', '100', '1')
    await f.call('subscribe', '200', '2')
    settle({ ok: true, identity: { room: '100', inputRoom: '100' } })
    expect(await older).toMatchObject({ ok: true })
    expect(f.setRoom.mock.calls).toEqual([['200']])
    await f.call('unsubscribe', '1')
    expect(f.setRoom.mock.calls).toEqual([['200']])
    await f.call('unsubscribe', '2')
    expect(f.setRoom.mock.calls).toEqual([['200'], [null]])
    f.installed.dispose()
  })

  it('keeps an existing room when a new relay cannot be opened', async () => {
    const f = fixture()
    await f.call('subscribe', '100', '1')
    f.subscribe.mockReturnValueOnce(null as never)
    expect(await f.call('subscribe', '200', '2')).toMatchObject({ ok: false, code: 'room-limit' })
    expect(f.setRoom.mock.calls).toEqual([['100']])
    f.installed.dispose()
    expect(f.setRoom).toHaveBeenLastCalledWith(null)
  })

  it.each(['cancel', 'navigation', 'destroy', 'dispose', 'untrusted'])('does not open a ghost relay after %s', async action => {
    const f = fixture()
    let settle!: (value: any) => void
    f.resolveRoom.mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
    const pending = f.call('subscribe', '6657', '1')
    if (action === 'cancel') await f.call('unsubscribe', '1')
    if (action === 'navigation') f.contents.emit('did-start-navigation', {}, 'app://app/admin', false, true)
    if (action === 'destroy') f.contents.emit('destroyed')
    if (action === 'dispose') f.installed.dispose()
    if (action === 'untrusted') Object.assign(f.contents.mainFrame, { url: 'https://evil.invalid/' })
    settle({ ok: true, identity: { room: '6979222', inputRoom: '6657' } })
    expect(await pending).toMatchObject({ ok: false, code: 'subscription-cancelled' })
    expect(f.subscribe).not.toHaveBeenCalled()
    expect(f.contents.send).not.toHaveBeenCalled()
    expect(f.setRoom).not.toHaveBeenCalled()
    f.installed.dispose()
  })
  it('reserves pending IDs and capacity before resolution', async () => {
    const f = fixture()
    const waiters: Array<(value: any) => void> = []
    f.resolveRoom.mockImplementation(() => new Promise(resolve => waiters.push(resolve)))
    const requests = Array.from({ length: 16 }, (_, n) => f.call('subscribe', '6657', String(n)))
    expect(await f.call('subscribe', '6657', '0')).toMatchObject({ ok: false, code: 'subscription-limit' })
    expect(await f.call('subscribe', '6657', '99')).toMatchObject({ ok: false, code: 'subscription-limit' })
    f.installed.dispose()
    waiters.forEach(resolve => resolve({ ok: true, identity: { room: '6979222', inputRoom: '6657' } }))
    await Promise.all(requests)
    expect(f.subscribe).not.toHaveBeenCalled()
  })
  it('does not let a cancelled ID consume a replacement or deliver stale callbacks', async () => {
    const f = fixture()
    let settle!: (value: any) => void
    f.resolveRoom.mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
    const pending = f.call('subscribe', '6657', '1')
    await f.call('unsubscribe', '1')
    f.resolveRoom.mockResolvedValueOnce({ ok: true, identity: { room: '6979222', inputRoom: '6979222' } })
    await f.call('subscribe', '6979222', '1')
    settle({ ok: true, identity: { room: '6979222', inputRoom: '6657' } })
    expect(await pending).toMatchObject({ ok: false })
    expect(f.subscribe).toHaveBeenCalledTimes(1)
    expect(f.installed.emitDanmaku('6979222', 'danmaku', {})).toBe(1)
    const subscriber = f.subscribe.mock.calls[0]![1]
    await f.call('unsubscribe', '1')
    vi.mocked(f.contents.send).mockClear()
    subscriber.write('danmaku', { text: 'late' })
    expect(f.contents.send).not.toHaveBeenCalled()
    f.installed.dispose()
  })
  it('subscribes alias and canonical inputs to the same room and reports final identity', async () => {
    const f = fixture()
    f.resolveRoom.mockImplementation(async inputRoom => ({ ok: true, identity: { room: '6979222', inputRoom } }))
    for (const [room, id] of [['6657', '1'], ['6979222', '2']]) expect(await f.call('subscribe', room, id)).toMatchObject({ ok: true, value: { room: '6979222' } })
    expect(f.subscribe.mock.calls.map(call => call[0])).toEqual(['6979222', '6979222'])
    expect(f.setRoom.mock.calls).toEqual([['6979222']])
    expect(f.contents.send).toHaveBeenCalledWith('stream-syncer:danmaku', { subscriptionId: '1', event: 'state', data: { room: '6979222', state: 'connecting' } })
    f.installed.dispose()
  })
})
