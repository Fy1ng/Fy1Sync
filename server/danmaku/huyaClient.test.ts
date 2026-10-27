import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { HuyaDanmakuClient, huyaBinaryFrame } from './huyaClient'
import { encodeHuyaHeartbeat, encodeHuyaRegistration } from './huyaProtocol'
import { HuyaTarsWriter } from '../platforms/huyaWup'
import fixtures from './fixtures/huya-synthetic.json'
import type { HuyaDanmakuRoom } from '../platforms/huyaDanmaku'
import type { DanmakuClientEvents, WebSocketLike } from './types'

const metadata = { room: '660002', presenterUid: 12345n, topSid: 456n, subSid: 789n }
const fixture = (name: 'chat' | 'gift6501' | 'registered' | 'registrationFailed' | 'heartbeat' | 'batch') => Buffer.from(fixtures[name].hex, 'hex')

function fakeSocket() {
  const listeners = new Map<string, Array<(event: any) => void>>()
  const socket = {
    sent: [] as Buffer[], closed: 0, binaryType: '',
    send(data: ArrayBufferView | ArrayBuffer) { this.sent.push(Buffer.from(data as Uint8Array)) },
    close() { this.closed++; this.fire('close', { reason: 'token=private upstream reason' }) },
    addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, [...listeners.get(type) ?? [], listener]) },
    fire(type: string, event: unknown = {}) { for (const listener of listeners.get(type) ?? []) listener(event) },
    receive(name: Parameters<typeof fixture>[0]) { this.fire('message', { data: fixture(name) }) },
  } satisfies WebSocketLike & { sent: Buffer[]; closed: number; fire: (type: string, event?: unknown) => void; receive: (name: Parameters<typeof fixture>[0]) => void }
  return socket
}

function setup(resolveRoom: (room: string) => Promise<HuyaDanmakuRoom> = async () => metadata) {
  const sockets: ReturnType<typeof fakeSocket>[] = []
  const events = { onMessage: vi.fn(), onObservedMessage: vi.fn(), onState: vi.fn(), onSignal: vi.fn() } satisfies DanmakuClientEvents
  const resolver = vi.fn(resolveRoom)
  const createSocket = vi.fn(() => { const socket = fakeSocket(); sockets.push(socket); return socket })
  const client = new HuyaDanmakuClient(metadata.room, events, { createSocket, resolveRoom: resolver })
  return { client, events, sockets, createSocket, resolver }
}

async function connect(context: ReturnType<typeof setup>, register = true) {
  context.client.connect()
  await vi.advanceTimersByTimeAsync(0)
  const socket = context.sockets.at(-1)!
  socket.fire('open')
  if (register) socket.receive('registered')
  return socket
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('Huya receive-only client', () => {
  it('resolves room identity, registers once and waits for successful acknowledgement', async () => {
    const context = setup()
    const socket = await connect(context, false)
    expect(context.resolver).toHaveBeenCalledWith('660002')
    expect(context.createSocket).toHaveBeenCalledWith('wss://cdnws.api.huya.com')
    expect(socket.sent).toEqual([Buffer.from(encodeHuyaRegistration(metadata))])
    expect(context.client.state).toBe('connecting')
    socket.receive('chat')
    expect(context.events.onMessage).not.toHaveBeenCalled()
    socket.receive('registered')
    expect(context.client.state).toBe('connected')
    context.client.close()
  })

  it('delivers platform-tagged chat and viewer signals with unknown URI diagnostics', async () => {
    const context = setup()
    const socket = await connect(context)
    socket.receive('batch')
    expect(context.events.onMessage.mock.calls.map(call => call[0].platform)).toEqual(['huya', 'huya'])
    expect(context.events.onMessage.mock.calls[1]![0]).toMatchObject({ system: true, username: 'viewer-placeholder' })
    expect(context.events.onSignal).toHaveBeenCalledWith({ platform: 'huya', kind: 'viewers', room: '660002', receivedAt: 0, count: 12345, messageId: '113' })
    expect(context.client.diagnostics).toMatchObject({ chats: 1, gifts: 1, batches: 1, unknownUris: 1, viewerCount: 12345, viewerSignals: 1 })
    expect(context.client.diagnostics.unknownUriCounts).toEqual({ '9999': 1 })
    const snapshot = context.client.diagnostics
    snapshot.unknownUriCounts['9999'] = 999
    expect(context.client.diagnostics.unknownUriCounts).toEqual({ '9999': 1 })
    context.client.close()
  })

  it('does not accept a legacy cmd2 or another presenter acknowledgement for cmd16', async () => {
    const context = setup()
    const socket = await connect(context, false)
    socket.fire('message', { data: Buffer.from('00021d0000010c', 'hex') })
    expect(context.client.state).toBe('connecting')
    const reply = new HuyaTarsWriter()
    reply.int(0, 0); reply.head(1, 9); reply.int(0, 1); reply.string(0, 'chat:54321')
    const outer = new HuyaTarsWriter()
    outer.int(0, 17); outer.bytes(1, reply.finish())
    socket.fire('message', { data: outer.finish() })
    socket.receive('chat')
    expect(context.events.onMessage).not.toHaveBeenCalled()
    expect(context.client.state).toBe('connecting')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(context.client.state).toBe('reconnecting')
    context.client.close()
  })

  it('preserves cross-realm binary payloads and counts empty/nonbinary payloads separately', async () => {
    const context = setup()
    const socket = await connect(context)
    const data = runInNewContext('new Uint8Array(bytes).buffer', { bytes: [...fixture('chat')] }) as ArrayBuffer
    expect(data instanceof ArrayBuffer).toBe(false)
    socket.fire('message', { data })
    expect(context.events.onMessage).toHaveBeenCalledOnce()
    socket.fire('message', { data: new ArrayBuffer(0) })
    socket.fire('message', { data: 'not binary' })
    expect(context.client.diagnostics).toMatchObject({ chats: 1, malformedFrames: 1, emptyFrames: 1, nonBinaryFrames: 1 })
    expect(huyaBinaryFrame('not binary')).toBeNull()
    expect(huyaBinaryFrame(null)).toBeNull()
    context.client.close()
  })

  it.each([false, true])('ignores empty binary frames without refreshing the watchdog, registered=%s', async registered => {
    const context = setup()
    const socket = await connect(context, registered)
    const deadline = registered ? 135_000 : 15_000
    await vi.advanceTimersByTimeAsync(deadline - 1)
    for (let i = 0; i < 20; i++) socket.fire('message', { data: new ArrayBuffer(0) })
    expect(context.client.diagnostics).toMatchObject({ emptyFrames: 20, malformedFrames: 0, nonBinaryFrames: 0 })
    expect(context.events.onMessage).not.toHaveBeenCalled()
    expect(context.events.onSignal).not.toHaveBeenCalled()
    expect(context.client.state).toBe(registered ? 'connected' : 'connecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(context.client.state).toBe('reconnecting')
    context.client.close()
  })

  it('bounds URI diagnostic cardinality while retaining the total unknown count', async () => {
    const context = setup()
    const socket = await connect(context)
    for (let uri = 100_000; uri < 100_080; uri++) {
      const push = new HuyaTarsWriter()
      push.int(1, uri); push.bytes(2, new Uint8Array())
      const frame = new HuyaTarsWriter()
      frame.int(0, 7); frame.bytes(1, push.finish())
      socket.fire('message', { data: frame.finish() })
    }
    expect(context.client.diagnostics.unknownUris).toBe(80)
    expect(Object.keys(context.client.diagnostics.unknownUriCounts).length).toBeLessThanOrEqual(65)
    expect(context.client.diagnostics.unknownUriCounts.other).toBe(16)
    expect(context.events.onMessage).not.toHaveBeenCalled()
    context.client.close()
  })

  it('sends only registration and a heartbeat every 60 seconds', async () => {
    const context = setup()
    const socket = await connect(context)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(socket.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.sent).toEqual([Buffer.from(encodeHuyaRegistration(metadata)), Buffer.from(encodeHuyaHeartbeat())])
    socket.receive('heartbeat')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.sent).toHaveLength(3)
    context.client.close()
  })

  it('times out a silent connection after two heartbeat periods plus slack and reconnects', async () => {
    const context = setup()
    const socket = await connect(context)
    await vi.advanceTimersByTimeAsync(134_999)
    expect(context.client.state).toBe('connected')
    await vi.advanceTimersByTimeAsync(1)
    expect(context.client.state).toBe('reconnecting')
    expect(socket.closed).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(context.sockets).toHaveLength(2)
    expect(context.resolver).toHaveBeenCalledTimes(2)
    context.client.close()
  })

  it('keeps a quiet registered room alive when heartbeat replies arrive', async () => {
    const context = setup()
    const socket = await connect(context)
    for (let index = 0; index < 5; index++) { await vi.advanceTimersByTimeAsync(60_000); socket.receive('heartbeat') }
    expect(context.client.state).toBe('connected')
    expect(context.sockets).toHaveLength(1)
    context.client.close()
  })

  it('handles registration rejection without leaking the upstream packet', async () => {
    const context = setup()
    const socket = await connect(context, false)
    socket.receive('registrationFailed')
    expect(context.client.state).toBe('reconnecting')
    expect(context.events.onState).toHaveBeenLastCalledWith('reconnecting', '虎牙未接受弹幕注册, 正在重新连接.')
    expect(context.events.onMessage).not.toHaveBeenCalled()
    context.client.close()
  })

  it('times out a socket opening or registration that never completes', async () => {
    const first = setup()
    first.client.connect()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(first.client.state).toBe('reconnecting')
    first.client.close()
    const second = setup()
    await connect(second, false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(second.client.state).toBe('reconnecting')
    second.client.close()
  })

  it('bounds metadata resolution and ignores a late resolve after closing', async () => {
    let resolve!: (value: HuyaDanmakuRoom) => void
    const context = setup(() => new Promise(done => { resolve = done }))
    context.client.connect()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(context.client.state).toBe('reconnecting')
    context.client.close()
    resolve(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(context.sockets).toHaveLength(0)
  })

  it('uses bounded exponential delays and ignores stale socket close/errors', async () => {
    const context = setup()
    let socket = await connect(context, false)
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      socket.fire('error', { message: 'Cookie=private; token=secret' })
      socket.fire('close', { reason: 'raw private frame' })
      const previous = context.sockets.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(context.sockets).toHaveLength(previous)
      await vi.advanceTimersByTimeAsync(1)
      expect(context.sockets).toHaveLength(previous + 1)
      socket = context.sockets.at(-1)!
      socket.fire('open')
    }
    expect(JSON.stringify(context.events.onState.mock.calls)).not.toMatch(/Cookie|token|secret|raw private/i)
    context.client.close()
  })

  it('resets backoff only after stable valid traffic', async () => {
    const context = setup()
    const old = await connect(context, false)
    old.fire('close')
    await vi.advanceTimersByTimeAsync(1_000)
    const socket = context.sockets.at(-1)!
    socket.fire('open'); socket.receive('registered')
    await vi.advanceTimersByTimeAsync(30_000)
    socket.receive('chat'); socket.fire('close')
    const count = context.sockets.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(context.sockets).toHaveLength(count + 1)
    context.client.close()
  })

  it('drops malformed frames without refreshing the watchdog or exposing them', async () => {
    const context = setup()
    const socket = await connect(context)
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(40_000)
      socket.fire('message', { data: Buffer.from('Cookie=private; token=secret') })
    }
    expect(context.client.diagnostics.malformedFrames).toBe(3)
    expect(context.events.onMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(context.client.state).toBe('reconnecting')
    expect(JSON.stringify(context.events.onState.mock.calls)).not.toMatch(/private|secret/)
    context.client.close()
  })

  it('throttles gift presentation while observing all upstream gifts', async () => {
    const context = setup()
    const socket = await connect(context)
    for (let index = 0; index < 20; index++) socket.receive('gift6501')
    expect(context.events.onObservedMessage).toHaveBeenCalledTimes(20)
    expect(context.events.onMessage).toHaveBeenCalledTimes(12)
    await vi.advanceTimersByTimeAsync(1_000)
    socket.receive('gift6501')
    expect(context.events.onMessage).toHaveBeenCalledTimes(13)
    socket.receive('chat')
    expect(context.events.onMessage).toHaveBeenCalledTimes(14)
    context.client.close()
  })

  it('cancels timers and ignores callbacks after closing', async () => {
    const context = setup()
    const socket = await connect(context)
    context.client.close()
    socket.receive('chat'); socket.fire('open'); socket.fire('error')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(context.sockets).toHaveLength(1)
    expect(socket.sent).toHaveLength(1)
    expect(context.client.state).toBe('closed')
    expect(context.events.onMessage).not.toHaveBeenCalled()
  })

  it('deduplicates connect calls while metadata or socket is active', async () => {
    const context = setup()
    context.client.connect(); context.client.connect()
    await vi.advanceTimersByTimeAsync(0)
    context.client.connect()
    expect(context.resolver).toHaveBeenCalledTimes(1)
    expect(context.sockets).toHaveLength(1)
    context.client.close()
  })

  it('sanitizes resolver errors and rejects resolver identity drift', async () => {
    const context = setup(async () => { throw new Error('Cookie=private; token=secret') })
    context.client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(context.client.state).toBe('reconnecting')
    expect(JSON.stringify(context.events.onState.mock.calls)).not.toMatch(/Cookie|token|private|secret/)
    context.client.close()
    const drift = setup(async () => ({ ...metadata, room: '999' }))
    drift.client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(drift.sockets).toHaveLength(0)
    expect(drift.client.state).toBe('reconnecting')
    drift.client.close()
  })

  it('reconnects after write failure without exposing exception details', async () => {
    const context = setup()
    const socket = await connect(context)
    socket.send = () => { throw new Error('token=secret') }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.client.state).toBe('reconnecting')
    expect(context.events.onState).toHaveBeenLastCalledWith('reconnecting', '虎牙弹幕连接写入失败, 正在重新连接.')
    context.client.close()
  })
})
