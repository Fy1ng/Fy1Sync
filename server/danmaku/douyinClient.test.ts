import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOUYIN_USER_AGENT, type DouyinDanmakuRoom } from '../platforms/douyinDanmaku'
import { DouyinDanmakuClient, douyinBinaryFrame } from './douyinClient'
import { encodeDouyinAck, encodeDouyinHeartbeat } from './douyinProtocol'
import { syntheticDouyinFrame, syntheticDouyinIds as ids } from './fixtures/douyin-synthetic'
import type { DanmakuClientEvents, WebSocketLike } from './types'

const metadata: DouyinDanmakuRoom = { webRoom: ids.webRoom, roomId: ids.roomId, userUniqueId: ids.userUniqueId, cookie: 'ttwid=synthetic-anonymous', userAgent: DOUYIN_USER_AGENT,
  cursor: 'synthetic-cursor', internalExt: 'synthetic-internal', pushServer: 'wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/', heartbeatMs: 15000 }
function fakeSocket() {
  const listeners = new Map<string, Array<(event: any) => void>>()
  return { sent: [] as Uint8Array[], closed: 0, binaryType: '',
    send(bytes: ArrayBufferView | ArrayBuffer) { this.sent.push(new Uint8Array(bytes as Uint8Array)) },
    close() { this.closed++; this.fire('close', { reason: 'sessionid=synthetic-private' }) },
    addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, [...listeners.get(type) ?? [], listener]) },
    fire(type: string, event: unknown = {}) { for (const listener of listeners.get(type) ?? []) listener(event) },
  } satisfies WebSocketLike & { sent: Uint8Array[]; closed: number; fire(type: string, event?: unknown): void }
}
function setup(resolveRoom: (room: string) => Promise<DouyinDanmakuRoom> = async () => metadata) {
  const sockets: ReturnType<typeof fakeSocket>[] = []
  const events = { onMessage: vi.fn(), onObservedMessage: vi.fn(), onState: vi.fn() } satisfies DanmakuClientEvents
  const resolver = vi.fn(resolveRoom)
  const createSocket = vi.fn(() => { const socket = fakeSocket(); sockets.push(socket); return socket })
  const client = new DouyinDanmakuClient('100', events, { resolveRoom: resolver, createSocket })
  return { client, events, sockets, createSocket, resolver }
}
async function connect(context: ReturnType<typeof setup>) { context.client.connect(); await vi.advanceTimersByTimeAsync(0); const socket = context.sockets.at(-1)!; socket.fire('open'); return socket }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('receive-only Douyin client lifecycle', () => {
  it('waits for valid inbound data and sends only heartbeat and frame ACK', async () => {
    const context = setup(), socket = await connect(context)
    expect(context.client.state).toBe('connecting')
    expect(context.createSocket).toHaveBeenCalledWith(expect.stringContaining('wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/?'), expect.objectContaining({ Cookie: 'ttwid=synthetic-anonymous' }))
    expect(socket.sent).toEqual([encodeDouyinHeartbeat()])
    socket.fire('message', { data: syntheticDouyinFrame() })
    expect(context.client.state).toBe('connected')
    expect(socket.sent).toEqual([encodeDouyinHeartbeat(), encodeDouyinAck(ids.logId, 'synthetic-header-internal')])
    expect(context.events.onMessage).toHaveBeenCalledWith(expect.objectContaining({ platform: 'douyin', room: 'douyin:100', id: `douyin:${ids.roomId}:${ids.messageId}` }))
    expect(context.client.diagnostics).toMatchObject({ frames: 1, chats: 1, acknowledgements: 1, malformedFrames: 0 })
    context.client.close()
  })
  it('deduplicates message IDs while continuing protocol ACK and periodic heartbeat', async () => {
    const context = setup(), socket = await connect(context)
    socket.fire('message', { data: syntheticDouyinFrame() }); socket.fire('message', { data: syntheticDouyinFrame() })
    expect(context.events.onMessage).toHaveBeenCalledTimes(1)
    expect(context.client.diagnostics.acknowledgements).toBe(2)
    await vi.advanceTimersByTimeAsync(15000)
    expect(socket.sent.at(-1)).toEqual(encodeDouyinHeartbeat())
    context.client.close()
    const count = socket.sent.length
    await vi.advanceTimersByTimeAsync(300000)
    expect(socket.sent).toHaveLength(count)
  })
  it('rejects malformed/nonbinary frames as liveness and reconnects after the inbound timeout', async () => {
    const context = setup(), socket = await connect(context)
    socket.fire('message', { data: 'private-upstream-text' })
    socket.fire('message', { data: Uint8Array.from([255]) })
    expect(context.client.diagnostics.malformedFrames).toBe(2)
    expect(context.events.onMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15000)
    expect(context.client.state).toBe('reconnecting')
    expect(JSON.stringify(context.events.onState.mock.calls)).not.toContain('private')
    context.client.close()
  })
  it('isolates stale socket callbacks and late room promises by generation', async () => {
    const context = setup(), first = await connect(context)
    first.fire('error', { message: 'sessionid=synthetic-private' })
    await vi.advanceTimersByTimeAsync(1000)
    const second = context.sockets.at(-1)!
    second.fire('open'); second.fire('message', { data: encodeDouyinHeartbeat() })
    first.fire('message', { data: syntheticDouyinFrame() }); first.fire('close')
    expect(context.client.state).toBe('connected')
    expect(context.events.onMessage).not.toHaveBeenCalled()
    expect(JSON.stringify(context.events.onState.mock.calls)).not.toContain('sessionid')
    context.client.close()
    let finish!: (value: DouyinDanmakuRoom) => void
    const late = setup(() => new Promise(resolve => { finish = resolve }))
    late.client.connect(); await vi.advanceTimersByTimeAsync(0); late.client.close(); finish(metadata); await vi.advanceTimersByTimeAsync(0)
    expect(late.sockets).toHaveLength(0)
    expect(late.client.state).toBe('closed')
  })
  it('uses exponential backoff and never surfaces credential-bearing resolver errors', async () => {
    const context = setup(async () => { throw new Error('Cookie=sessionid=synthetic-private') })
    context.client.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(context.resolver).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(context.resolver).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(context.resolver).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(context.resolver).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(context.events.onState.mock.calls)).not.toContain('sessionid')
    context.client.close()
  })
  it('preserves cross-realm binary bytes and stops reentrant delivery after close', async () => {
    const bytes = syntheticDouyinFrame()
    const foreign = runInNewContext('new Uint8Array(bytes).buffer', { bytes: [...bytes] }) as ArrayBuffer
    expect(douyinBinaryFrame(foreign)).toEqual(bytes)
    expect(douyinBinaryFrame({})).toBeNull()
    const context = setup(), socket = await connect(context)
    context.events.onObservedMessage.mockImplementation(() => context.client.close())
    socket.fire('message', { data: foreign })
    expect(context.events.onObservedMessage).toHaveBeenCalledTimes(1)
    expect(context.events.onMessage).not.toHaveBeenCalled()
    expect(context.client.state).toBe('closed')
  })
  it('does not acquire sockets or retain retry timers after a reentrant state observer closes', async () => {
    const context = setup()
    context.events.onState.mockImplementation(state => { if (state === 'connecting') context.client.close() })
    context.client.connect(); await vi.advanceTimersByTimeAsync(30000)
    expect(context.resolver).not.toHaveBeenCalled()
    expect(context.client.state).toBe('closed')
    expect(vi.getTimerCount()).toBe(0)
  })
})
