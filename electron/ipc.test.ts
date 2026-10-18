import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { DesktopService } from '../server/api'
import { installIpcHandlers, trustedSender } from './ipc'
import { CONTENT_SECURITY_POLICY, isAppDocument, isAppOrigin } from './security'

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
  const service = { invoke: vi.fn(async () => ({ ok: true, value: {} })), relay: { subscribe }, dispose: vi.fn() } as unknown as DesktopService
  const installed = installIpcHandlers(ipc, contents, service)
  return { contents, event, handlers, release, subscribe, service, installed,
    call: (channel: string, ...args: unknown[]) => handlers.get('stream-syncer:' + channel)!(event, ...args),
  }
}

describe('app origin and document boundary', () => {
  it('trusts only the fixed privileged origin', () => {
    expect(isAppOrigin('app://app/assets/app.js')).toBe(true)
    for (const raw of ['https://app/', 'app://evil/', 'app://app.evil/', 'app://app:80/', 'app://user@app/', 'file:///index.html', 'invalid']) expect(isAppOrigin(raw)).toBe(false)
  })
  it('permits only app document routes to receive IPC', () => {
    for (const raw of ['app://app/', 'app://app/index.html', 'app://app/admin', 'app://app/admin/']) expect(isAppDocument(raw)).toBe(true)
    for (const raw of ['app://app/media/id', 'app://app/assets/app.js', 'app://app/api/health', 'https://example.com/']) expect(isAppDocument(raw)).toBe(false)
  })
  it('uses a CSP without remote scripts, frames, eval or wildcard sources', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-eval|https?:|\*/)
  })
  it('rejects a different webContents even if it claims the same URL', () => {
    const f = fixture()
    expect(trustedSender(f.event, f.contents)).toBe(true)
    expect(trustedSender({ ...f.event, sender: {} } as IpcMainInvokeEvent, f.contents)).toBe(false)
    f.installed.dispose()
  })
  it('rejects same-origin subframes and stale frames', () => {
    const f = fixture()
    expect(trustedSender({ ...f.event, senderFrame: { url: 'app://app/' } } as IpcMainInvokeEvent, f.contents)).toBe(false)
    Object.assign(f.contents.mainFrame, { url: 'app://app/media/untrusted' })
    expect(trustedSender(f.event, f.contents)).toBe(false)
    f.installed.dispose()
  })
  it('rejects destroyed windows', () => {
    const f = fixture()
    vi.spyOn(f.contents, 'isDestroyed').mockReturnValue(true)
    expect(trustedSender(f.event, f.contents)).toBe(false)
    f.installed.dispose()
  })
})

describe('IPC routing and subscription lifecycle', () => {
  it('forwards only trusted invokes to the validated service', async () => {
    const f = fixture()
    await f.call('invoke', 'health', undefined)
    expect(f.service.invoke).toHaveBeenCalledWith('health', undefined)
    Object.assign(f.contents.mainFrame, { url: 'https://example.com/' })
    expect(await f.call('invoke', 'health', undefined)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.service.invoke).toHaveBeenCalledTimes(1)
    f.installed.dispose()
  })
  it('delivers relay events with isolated subscription identifiers', () => {
    const f = fixture()
    expect(f.call('subscribe', '288016', '1')).toMatchObject({ ok: true })
    expect(f.contents.send).toHaveBeenCalledWith('stream-syncer:danmaku', { subscriptionId: '1', event: 'state', data: { state: 'connecting' } })
    expect(f.installed.emitDanmaku('other-room', 'danmaku', {})).toBe(0)
    expect(f.installed.emitDanmaku('288016', 'danmaku', { text: '测试' })).toBe(1)
    f.installed.dispose()
  })
  it('rejects malformed room IDs and subscription IDs before opening upstream', () => {
    const f = fixture()
    for (const room of ['', 'abc', 'douyu.com/1', '../1', '1'.repeat(17), null, {}]) expect(f.call('subscribe', room, '1')).toMatchObject({ ok: false })
    for (const id of ['', '../1', '1'.repeat(13), null]) expect(f.call('subscribe', '288016', id)).toMatchObject({ ok: false })
    expect(f.subscribe).not.toHaveBeenCalled()
    f.installed.dispose()
  })
  it('rejects duplicate subscription IDs and limits subscriptions', () => {
    const f = fixture()
    for (let n = 0; n < 16; n++) expect(f.call('subscribe', '288016', String(n))).toMatchObject({ ok: true })
    expect(f.call('subscribe', '288016', '0')).toMatchObject({ ok: false, code: 'subscription-limit' })
    expect(f.call('subscribe', '288016', '99')).toMatchObject({ ok: false, code: 'subscription-limit' })
    f.installed.dispose()
    expect(f.release).toHaveBeenCalledTimes(16)
  })
  it('reports room-cap exhaustion without registering a subscriber', () => {
    const f = fixture()
    f.subscribe.mockReturnValueOnce(null as never)
    expect(f.call('subscribe', '288016', '1')).toMatchObject({ ok: false, code: 'room-limit' })
    expect(f.installed.emitDanmaku('288016', 'danmaku', {})).toBe(0)
    f.installed.dispose()
  })
  it('releases once when unsubscribed repeatedly', () => {
    const f = fixture()
    f.call('subscribe', '288016', '1')
    f.call('unsubscribe', '1')
    f.call('unsubscribe', '1')
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.installed.emitDanmaku('288016', 'danmaku', {})).toBe(0)
    f.installed.dispose()
  })
  it('cleans subscriptions on document reload and renderer destruction', () => {
    const f = fixture()
    f.call('subscribe', '288016', '1')
    f.contents.emit('did-start-navigation', {}, 'app://app/admin', false, true)
    expect(f.release).toHaveBeenCalledTimes(1)
    f.call('subscribe', '288016', '2')
    f.contents.emit('destroyed')
    expect(f.release).toHaveBeenCalledTimes(2)
    f.installed.dispose()
    expect(f.handlers.size).toBe(0)
  })
  it('does not cancel on hash navigation or a subframe navigation', () => {
    const f = fixture()
    f.call('subscribe', '288016', '1')
    f.contents.emit('did-start-navigation', {}, 'app://app/#settings', true, true)
    f.contents.emit('did-start-navigation', {}, 'app://app/', false, false)
    expect(f.release).not.toHaveBeenCalled()
    f.installed.dispose()
  })
  it('refuses subscription mutation from untrusted frames', () => {
    const f = fixture()
    f.call('subscribe', '288016', '1')
    Object.assign(f.contents.mainFrame, { url: 'https://evil.example/' })
    expect(f.call('subscribe', '288016', '2')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.call('unsubscribe', '1')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.release).not.toHaveBeenCalled()
    f.installed.dispose()
  })
})
