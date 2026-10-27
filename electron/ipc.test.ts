import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { DesktopService } from '../server/api'
import { installIpcHandlers, trustedSender, type IpcHandlerOptions } from './ipc'
import type { FeatureEvent } from './featureContracts'
import { CONTENT_SECURITY_POLICY, allowsAppPermission, isAppDocument, isAppOrigin } from './security'
import type { BufferState } from './bufferManager'
import type { DouyuTasksSnapshot } from '../server/douyu/types'

function windowFixture(id = 1, url = 'app://app/') {
  return Object.assign(new EventEmitter(), { id, mainFrame: { url }, isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents
}
function eventFor(contents: WebContents) { return { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent }
function fixture(options: IpcHandlerOptions = {}) {
  const contents = windowFixture()
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
  let featureListener: ((event: FeatureEvent) => void) | undefined
  const featureRelease = vi.fn()
  const setRoom = vi.fn()
  const resolveRoom = vi.fn(async (room: string) => ({ ok: true, identity: { room, inputRoom: room } }))
  const resolveHuyaRoom = vi.fn(async (room: string) => ({ room: room === 'kpl' ? '660002' : room, presenterUid: 42n, topSid: 43n, subSid: 44n }))
  const service = { resolveDouyuRoom: resolveRoom, resolveHuyaRoom, invoke: vi.fn(async () => ({ ok: true, value: {} })), relay: { subscribe }, dispose: vi.fn(),
    subscribeBuffer: (listener: (state: BufferState) => void) => { bufferListener = listener; return bufferRelease },
    subscribeDouyuTasks: (listener: (state: DouyuTasksSnapshot) => void) => { taskListener = listener; return taskRelease },
    subscribeFeatures: (listener: (event: FeatureEvent) => void) => { featureListener = listener; return featureRelease },
    setDouyuRoom: setRoom,
  } as unknown as DesktopService
  const installed = installIpcHandlers(ipc, contents, service, options)
  return { resolveRoom, resolveHuyaRoom, contents, event, handlers, release, subscribe, service, installed,
    bufferRelease, emitBuffer: (state: BufferState) => bufferListener?.(state),
    taskRelease, setRoom, emitTasks: (state: DouyuTasksSnapshot) => taskListener?.(state),
    featureRelease, emitFeatures: (event: FeatureEvent) => featureListener?.(event),
    callFrom: (window: WebContents, channel: string, ...args: unknown[]) => handlers.get('stream-syncer:' + channel)!(eventFor(window), ...args),
    call: (channel: string, ...args: unknown[]) => handlers.get('stream-syncer:' + channel)!(event, ...args),
  }
}

describe('app origin and document boundary', async () => {
  it('allows fullscreen only for the trusted main application document', () => {
    const context = { trustedWindow: true, documentUrl: 'app://app/', requestingUrl: 'app://app/', requestingOrigin: 'app://app', isMainFrame: true }
    expect(allowsAppPermission('fullscreen', context)).toBe(true)
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'automatic-fullscreen', 'unknown']) {
      expect(allowsAppPermission(permission, context)).toBe(false)
    }
    for (const overrides of [
      { trustedWindow: false }, { isMainFrame: false }, { isMainFrame: undefined },
      { documentUrl: 'https://example.com/' }, { requestingUrl: 'app://app/media/id' },
      { requestingUrl: 'https://example.com/' }, { requestingUrl: undefined },
      { requestingOrigin: 'https://example.com' },
    ]) expect(allowsAppPermission('fullscreen', { ...context, ...overrides })).toBe(false)
  })
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

describe('Huya read-only subscription boundary', () => {
  it('canonicalizes aliases and never assigns a Huya room to Douyu tasks or activation', async () => {
    const f = fixture()
    await f.call('subscribe', '100', '1')
    expect(f.setRoom).toHaveBeenLastCalledWith('100')
    expect(await f.call('subscribe', 'huya:kpl', '2')).toEqual({ ok: true, value: { ok: true, room: 'huya:660002' } })
    expect(f.resolveHuyaRoom).toHaveBeenCalledWith('kpl')
    expect(f.resolveRoom).toHaveBeenCalledTimes(1)
    expect(f.subscribe).toHaveBeenLastCalledWith('huya:660002', expect.any(Object))
    expect(f.setRoom.mock.calls).toEqual([['100'], [null]])
    expect(await f.call('invoke', 'activateDouyuRoom', { room: '660002' })).toMatchObject({ code: 'room-not-subscribed' })
    expect(await f.call('invoke', 'activateDouyuRoom', { room: 'huya:660002' })).toMatchObject({ code: 'invalid-arguments' })
    expect(f.installed.emitDanmaku('660002', 'danmaku', {})).toBe(0)
    expect(f.installed.emitDanmaku('huya:660002', 'danmaku', {})).toBe(1)
    await f.call('unsubscribe', '2')
    expect(f.setRoom).toHaveBeenLastCalledWith('100')
    f.installed.dispose()
  })

  it('preserves bare numeric Douyu IDs and accepts explicit Douyu room keys', async () => {
    const f = fixture()
    await f.call('subscribe', 'douyu:100', '1')
    await f.call('subscribe', '100', '2')
    expect(f.resolveRoom.mock.calls).toEqual([['100'], ['100']])
    expect(f.subscribe.mock.calls.map(call => call[0])).toEqual(['100', '100'])
    expect(f.resolveHuyaRoom).not.toHaveBeenCalled()
    expect(f.setRoom).toHaveBeenCalledExactlyOnceWith('100')
    f.installed.dispose()
  })

  it.each(['huya:', 'huya:a/b', 'huya:a?token=x', 'huya:https://huya.com/kpl', 'huya:中文', 'huya:a\n', 'huya:' + 'a'.repeat(65), 'twitch:123'])('rejects invalid platform room input %j before lookup', async room => {
    const f = fixture()
    expect(await f.call('subscribe', room, '1')).toMatchObject({ code: 'bad-room' })
    expect(f.resolveHuyaRoom).not.toHaveBeenCalled()
    expect(f.resolveRoom).not.toHaveBeenCalled()
    expect(f.subscribe).not.toHaveBeenCalled()
    f.installed.dispose()
  })

  it('checks grants both before and after alias lookup using namespaced identities', async () => {
    const extra = windowFixture(2)
    const f = fixture({ extraContents: [extra], allowRoom: (_id, room) => room === 'huya:kpl' })
    expect(await f.callFrom(extra, 'subscribe', 'huya:kpl', '1')).toMatchObject({ code: 'forbidden' })
    expect(f.resolveHuyaRoom).toHaveBeenCalledOnce()
    expect(f.subscribe).not.toHaveBeenCalled()
    expect(await f.callFrom(extra, 'subscribe', 'huya:117736', '2')).toMatchObject({ code: 'forbidden' })
    expect(f.resolveHuyaRoom).toHaveBeenCalledOnce()
    f.installed.dispose()
  })

  it('keeps the per-window cap across platforms and reserves pending subscriptions', async () => {
    const f = fixture()
    for (let i = 1; i <= 15; i++) await f.call('subscribe', String(i), String(i))
    let settle!: (value: Awaited<ReturnType<typeof f.resolveHuyaRoom>>) => void
    f.resolveHuyaRoom.mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
    const pending = f.call('subscribe', 'huya:kpl', '16')
    expect(await f.call('subscribe', 'huya:117736', '17')).toMatchObject({ code: 'subscription-limit' })
    expect(await f.call('subscribe', 'huya:117736', '16')).toMatchObject({ code: 'subscription-limit' })
    await f.call('unsubscribe', '16')
    settle({ room: '660002', presenterUid: 42n, topSid: 43n, subSid: 44n })
    expect(await pending).toMatchObject({ code: 'subscription-cancelled' })
    expect(f.subscribe).toHaveBeenCalledTimes(15)
    f.installed.dispose()
  })

  it('sanitizes upstream failures and rejects invalid canonical Huya identities', async () => {
    const f = fixture()
    f.resolveHuyaRoom.mockRejectedValueOnce(new Error('Cookie=secret token=secret raw-frame'))
    const failed = await f.call('subscribe', 'huya:kpl', '1')
    expect(failed).toMatchObject({ code: 'upstream-error' })
    expect(JSON.stringify(failed)).not.toMatch(/Cookie|secret|raw-frame/)
    f.resolveHuyaRoom.mockResolvedValueOnce({ room: 'douyu:100', presenterUid: 1n, topSid: 1n, subSid: 1n })
    expect(await f.call('subscribe', 'huya:kpl', '1')).toMatchObject({ code: 'upstream-error' })
    expect(f.subscribe).not.toHaveBeenCalled()
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
    expect(f.service.invoke).toHaveBeenCalledWith('health', undefined, { senderId: 1 })
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
    expect(f.service.invoke).toHaveBeenCalledExactlyOnceWith('setDecoderPreferences', { mode: 'software' }, { senderId: 1 })
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

describe('explicit multi-window IPC authority', () => {
  it('denies unregistered and ungranted windows before any service call or notification', async () => {
    const extra = windowFixture(2)
    const f = fixture({ extraContents: [extra] })
    expect(await f.callFrom(extra, 'invoke', 'health', undefined)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await f.callFrom(extra, 'subscribe', '100', '1')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await f.callFrom(extra, 'unsubscribe', '1')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await f.callFrom(windowFixture(3), 'invoke', 'health', undefined)).toMatchObject({ ok: false, code: 'forbidden' })
    f.emitFeatures({ topic: 'account', data: { accountId: 'default' } })
    f.emitBuffer({ role: 'official', state: 'buffering', seconds: 1 })
    f.emitTasks({ activeAccountId: 'default', currentRoom: null, retainedRooms: [], tasks: [], runtime: { foreground: true, locked: false, suspended: false } })
    expect(extra.send).not.toHaveBeenCalled()
    expect(f.contents.send).toHaveBeenCalledTimes(3)
    expect(f.service.invoke).not.toHaveBeenCalled()
    expect(f.resolveRoom).not.toHaveBeenCalled()
    f.installed.dispose()
  })

  it('requires the registered instance and current main frame even with a permissive method grant', async () => {
    const extra = windowFixture(2)
    const f = fixture({ extraContents: [extra], allowMethod: () => true })
    const invoke = f.handlers.get('stream-syncer:invoke')!
    expect(await f.callFrom(windowFixture(2), 'invoke', 'health', undefined)).toMatchObject({ code: 'forbidden' })
    expect(await invoke({ ...eventFor(extra), senderFrame: { url: 'app://app/' } }, 'health', undefined)).toMatchObject({ code: 'forbidden' })
    Object.assign(extra.mainFrame, { url: 'https://untrusted.invalid/' })
    expect(await f.callFrom(extra, 'invoke', 'health', undefined)).toMatchObject({ code: 'forbidden' })
    expect(f.service.invoke).not.toHaveBeenCalled()
    f.installed.dispose()
  })

  it('constructs immutable caller context from the window, ignoring renderer context claims', async () => {
    const extra = windowFixture(2)
    const allowMethod = vi.fn((id, method) => id === 2 && method === 'reportDouyuPlayback')
    const f = fixture({ extraContents: [extra], allowMethod })
    const args = { room: '100', playing: true, senderId: 1 }
    await f.callFrom(extra, 'invoke', 'reportDouyuPlayback', args, { senderId: 1 })
    expect(f.service.invoke).toHaveBeenCalledExactlyOnceWith('reportDouyuPlayback', args, { senderId: 2 })
    expect(Object.isFrozen(vi.mocked(f.service.invoke).mock.calls[0]![2])).toBe(true)
    expect(allowMethod).toHaveBeenCalledWith(2, 'reportDouyuPlayback', args)
    expect(await f.callFrom(extra, 'invoke', 'listDouyuAccounts', undefined)).toMatchObject({ code: 'forbidden' })
    f.installed.dispose()
  })

  it('fails closed when a permission callback throws', async () => {
    const extra = windowFixture(2)
    const fail = () => { throw new Error('private backend failure') }
    const f = fixture({ extraContents: [extra], allowMethod: fail, allowRoom: fail, allowEvent: fail })
    expect(await f.callFrom(extra, 'invoke', 'health', undefined)).toMatchObject({ code: 'forbidden' })
    expect(await f.callFrom(extra, 'subscribe', '100', '1')).toMatchObject({ code: 'forbidden' })
    f.emitFeatures({ topic: 'pip', data: {} })
    expect(extra.send).not.toHaveBeenCalled()
    expect(f.contents.send).toHaveBeenCalledOnce()
    f.installed.dispose()
  })

  it('keeps equal subscription IDs and relay callbacks local to their owners', async () => {
    const extra = windowFixture(2)
    const f = fixture({ extraContents: [extra], allowRoom: (id, room) => id === 2 && room === '200' })
    await f.call('subscribe', '100', '1')
    await f.callFrom(extra, 'subscribe', '200', '1')
    vi.mocked(f.contents.send).mockClear()
    vi.mocked(extra.send).mockClear()
    expect(f.installed.emitDanmaku('100', 'danmaku', { text: 'main' })).toBe(1)
    expect(extra.send).not.toHaveBeenCalled()
    expect(f.installed.emitDanmaku('200', 'danmaku', { text: 'extra' })).toBe(1)
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith('stream-syncer:danmaku', { subscriptionId: '1', event: 'danmaku', data: { text: 'main' } })
    expect(extra.send).toHaveBeenCalledExactlyOnceWith('stream-syncer:danmaku', { subscriptionId: '1', event: 'danmaku', data: { text: 'extra' } })
    await f.callFrom(extra, 'unsubscribe', '1')
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.installed.emitDanmaku('100', 'danmaku', {})).toBe(1)
    expect(f.installed.emitDanmaku('200', 'danmaku', {})).toBe(0)
    f.installed.dispose()
    expect(f.release).toHaveBeenCalledTimes(2)
  })

  it('applies room grants both before lookup and to the canonical identity', async () => {
    const extra = windowFixture(2)
    const f = fixture({ extraContents: [extra], allowRoom: (id, room) => id === 2 && room === '100' })
    expect(await f.callFrom(extra, 'subscribe', '200', '1')).toMatchObject({ code: 'forbidden' })
    expect(f.resolveRoom).not.toHaveBeenCalled()
    f.resolveRoom.mockResolvedValueOnce({ ok: true, identity: { room: '999', inputRoom: '100' } })
    expect(await f.callFrom(extra, 'subscribe', 'https://www.douyu.com/100', '1')).toMatchObject({ code: 'forbidden' })
    expect(f.subscribe).not.toHaveBeenCalled()
    expect(extra.send).not.toHaveBeenCalled()
    f.installed.dispose()
  })

  it('does not let one window consume another window subscription capacity', async () => {
    const extra = windowFixture(2)
    const f = fixture({ extraContents: [extra], allowRoom: () => true })
    for (let id = 0; id < 16; id++) await f.call('subscribe', '100', String(id))
    expect(await f.callFrom(extra, 'subscribe', '100', '0')).toMatchObject({ ok: true })
    expect(await f.call('subscribe', '100', '99')).toMatchObject({ code: 'subscription-limit' })
    f.installed.dispose()
    expect(f.release).toHaveBeenCalledTimes(17)
  })

  it('sends only explicitly permitted global events to additional windows and rechecks permission', () => {
    const extra = windowFixture(2)
    let permitted = true
    const f = fixture({ extraContents: [extra], allowEvent: (id, event) => permitted && id === 2 && event.topic === 'pip' })
    const event = { topic: 'pip', data: { phase: 'ready' } }
    f.emitFeatures(event)
    f.emitFeatures({ topic: 'accounts', data: {} })
    f.emitBuffer({ role: 'official', state: 'buffering', seconds: 2 })
    expect(extra.send).toHaveBeenCalledExactlyOnceWith('stream-syncer:features', event)
    permitted = false
    f.emitFeatures(event)
    expect(extra.send).toHaveBeenCalledTimes(1)
    f.installed.dispose()
    f.emitFeatures(event)
    expect(extra.send).toHaveBeenCalledTimes(1)
    expect(f.featureRelease).toHaveBeenCalledOnce()
  })

  it.each(['navigation', 'destroy', 'unregister'])('clears only the affected window on %s', async action => {
    const extra = windowFixture(2)
    const f = fixture({ allowRoom: () => true, allowMethod: () => true })
    const unregister = f.installed.registerWindow(extra)
    expect(f.handlers.size).toBe(3)
    expect(f.installed.registerWindow(extra)).toBe(unregister)
    expect(extra.listenerCount('did-start-navigation')).toBe(1)
    await f.call('subscribe', '100', '1')
    await f.callFrom(extra, 'subscribe', '200', '1')
    if (action === 'navigation') extra.emit('did-start-navigation', {}, 'app://app/', false, true)
    if (action === 'destroy') extra.emit('destroyed')
    if (action === 'unregister') { unregister(); unregister() }
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.installed.emitDanmaku('100', 'danmaku', {})).toBe(1)
    expect(f.installed.emitDanmaku('200', 'danmaku', {})).toBe(0)
    expect(f.setRoom).toHaveBeenLastCalledWith('100')
    if (action !== 'navigation') {
      expect(extra.listenerCount('did-start-navigation')).toBe(0)
      expect(await f.callFrom(extra, 'invoke', 'health', undefined)).toMatchObject({ code: 'forbidden' })
    }
    expect(await f.call('invoke', 'health', undefined)).toMatchObject({ ok: true })
    f.installed.dispose()
    f.installed.dispose()
    expect(f.release).toHaveBeenCalledTimes(2)
    expect(f.contents.listenerCount('did-start-navigation')).toBe(0)
    expect(f.bufferRelease).toHaveBeenCalledOnce()
    expect(f.taskRelease).toHaveBeenCalledOnce()
    expect(f.featureRelease).toHaveBeenCalledOnce()
  })

  it('rejects a duplicate window identity and does not resurrect a released registration', async () => {
    const extra = windowFixture(2)
    const f = fixture({ allowRoom: () => true, allowMethod: () => true })
    const unregister = f.installed.registerWindow(extra)
    expect(() => f.installed.registerWindow(windowFixture(2))).toThrow(/already owns/)
    let settle!: (value: any) => void
    f.resolveRoom.mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
    const pending = f.callFrom(extra, 'subscribe', '100', '1')
    unregister()
    f.installed.registerWindow(extra)
    await f.callFrom(extra, 'subscribe', '200', '1')
    settle({ ok: true, identity: { room: '100', inputRoom: '100' } })
    expect(await pending).toMatchObject({ code: 'subscription-cancelled' })
    expect(f.subscribe).toHaveBeenCalledTimes(1)
    expect(f.installed.emitDanmaku('200', 'danmaku', {})).toBe(1)
    f.installed.dispose()
  })

  it.each(['navigation', 'unregister', 'permission'])('discards a late invoke response after %s', async action => {
    const extra = windowFixture(2)
    let allowed = true
    const f = fixture({ allowMethod: () => allowed })
    const unregister = f.installed.registerWindow(extra)
    let settle!: (value: any) => void
    vi.mocked(f.service.invoke).mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
    const pending = f.callFrom(extra, 'invoke', 'health', undefined)
    if (action === 'navigation') extra.emit('did-start-navigation', {}, 'app://app/', false, true)
    if (action === 'unregister') unregister()
    if (action === 'permission') allowed = false
    settle({ ok: true, value: { privateData: 'stale account data' } })
    expect(await pending).toEqual(expect.objectContaining({ ok: false, code: 'forbidden' }))
    expect(await pending).not.toHaveProperty('value')
    f.installed.dispose()
  })

  it('releases a relay returned after a synchronous window destruction', async () => {
    const f = fixture()
    f.subscribe.mockImplementationOnce(() => { f.contents.emit('destroyed'); return f.release })
    expect(await f.call('subscribe', '100', '1')).toMatchObject({ code: 'subscription-cancelled' })
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.setRoom).not.toHaveBeenCalled()
    f.installed.dispose()
  })

  it('finishes all cleanup even if a relay or task-room cleanup fails', async () => {
    const extra = windowFixture(2)
    const f = fixture({ extraContents: [extra], allowRoom: () => true })
    await f.call('subscribe', '100', '1')
    await f.callFrom(extra, 'subscribe', '200', '1')
    f.release.mockImplementation(() => { throw new Error('closed relay') })
    f.setRoom.mockImplementation(() => { throw new Error('closed task service') })
    expect(() => f.installed.dispose()).not.toThrow()
    expect(f.release).toHaveBeenCalledTimes(2)
    expect(f.handlers.size).toBe(0)
    expect(f.contents.listenerCount('did-start-navigation')).toBe(0)
    expect(extra.listenerCount('did-start-navigation')).toBe(0)
  })
})

describe('canonical room activation ownership', () => {
  it('keeps PiP subscriptions and activation from switching the main task room', async () => {
    const pip = windowFixture(2, 'app://app/pip')
    const f = fixture({ extraContents: [pip], allowMethod: () => true, allowRoom: () => true })
    await f.call('subscribe', '100', '1')
    await f.callFrom(pip, 'subscribe', '200', '1')
    expect(f.setRoom).toHaveBeenCalledExactlyOnceWith('100')
    expect(await f.callFrom(pip, 'invoke', 'activateDouyuRoom', { room: '200' })).toMatchObject({ code: 'room-changed' })
    expect(f.setRoom).toHaveBeenCalledTimes(1)
    expect(f.installed.emitDanmaku('200', 'danmaku', { text: 'PiP room' })).toBe(1)
    await f.call('unsubscribe', '1')
    expect(f.setRoom).toHaveBeenLastCalledWith(null)
    expect(await f.callFrom(pip, 'invoke', 'activateDouyuRoom', { room: '200' })).toMatchObject({ code: 'room-changed' })
    f.installed.dispose()
  })

  it('allows same-room PiP activation without changing main selection order', async () => {
    const pip = windowFixture(2, 'app://app/pip')
    const f = fixture({ extraContents: [pip], allowMethod: () => true, allowRoom: () => true })
    await f.call('subscribe', '100', '1')
    await f.call('subscribe', '200', '2')
    await f.callFrom(pip, 'subscribe', '200', '1')
    expect(await f.callFrom(pip, 'invoke', 'activateDouyuRoom', { room: '200' })).toEqual({ ok: true, value: { room: '200' } })
    expect(f.setRoom).toHaveBeenCalledTimes(2)
    await f.call('unsubscribe', '2')
    expect(f.setRoom).toHaveBeenLastCalledWith('100')
    expect(await f.callFrom(pip, 'invoke', 'activateDouyuRoom', { room: '200' })).toMatchObject({ code: 'room-changed' })
    expect(f.service.invoke).not.toHaveBeenCalled()
    f.installed.dispose()
  })

  it('activates only established canonical subscriptions and remembers explicit selection', async () => {
    const f = fixture()
    f.resolveRoom.mockResolvedValueOnce({ ok: true, identity: { room: '6979222', inputRoom: '6657' } })
    await f.call('subscribe', '6657', '1')
    await f.call('subscribe', '200', '2')
    expect(await f.call('invoke', 'activateDouyuRoom', { room: '6657' })).toMatchObject({ code: 'room-not-subscribed' })
    expect(await f.call('invoke', 'activateDouyuRoom', { room: '6979222' })).toEqual({ ok: true, value: { room: '6979222' } })
    expect(f.setRoom).toHaveBeenLastCalledWith('6979222')
    await f.call('unsubscribe', '2')
    expect(f.setRoom).toHaveBeenCalledTimes(3)
    await f.call('unsubscribe', '1')
    expect(await f.call('invoke', 'activateDouyuRoom', { room: '6979222' })).toMatchObject({ code: 'room-not-subscribed' })
    expect(f.service.invoke).not.toHaveBeenCalled()
    f.installed.dispose()
  })

  it('cannot activate another window subscription or a pending subscription', async () => {
    const extra = windowFixture(2)
    const f = fixture({ extraContents: [extra], allowMethod: () => true, allowRoom: () => true })
    await f.callFrom(extra, 'subscribe', '200', '1')
    expect(await f.call('invoke', 'activateDouyuRoom', { room: '200' })).toMatchObject({ code: 'room-not-subscribed' })
    let settle!: (value: any) => void
    f.resolveRoom.mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
    const pending = f.call('subscribe', '100', '1')
    expect(await f.call('invoke', 'activateDouyuRoom', { room: '100' })).toMatchObject({ code: 'room-not-subscribed' })
    settle({ ok: true, identity: { room: '100', inputRoom: '100' } })
    await pending
    expect(await f.call('invoke', 'activateDouyuRoom', { room: '100', senderId: 2 })).toMatchObject({ code: 'invalid-arguments' })
    f.installed.dispose()
  })
})
