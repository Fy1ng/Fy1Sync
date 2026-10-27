import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DanmakuRelay } from './relay'
import { HuyaRoomClient } from './huyaRoomClient'
import { safeFetchStream } from '../safeFetchStream'
import { HuyaTarsReader, HuyaTarsWriter } from '../platforms/huyaWup'
import fixtures from './fixtures/huya-synthetic.json'
import type { WebSocketLike } from './types'

const metadata = { room: '660002', presenterUid: 12345n, topSid: 456n, subSid: 789n }
function socket() {
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  return {
    send: vi.fn(), close: vi.fn(), binaryType: '',
    addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, [...listeners.get(type) ?? [], listener]) },
    fire(type: string, event: unknown = {}) { for (const listener of listeners.get(type) ?? []) listener(event) },
  } satisfies WebSocketLike & { fire: (type: string, event?: unknown) => void }
}
function push(id: number): Buffer {
  const envelope = new HuyaTarsReader(Buffer.from(fixtures.chat.hex, 'hex'))
  const [, command] = envelope.head(); envelope.int(command)
  const [, bytes] = envelope.head()
  const original = new HuyaTarsReader(envelope.bytes(bytes))
  let body: Uint8Array | undefined
  while (!original.done) {
    const [tag, type] = original.head()
    if (tag === 2) body = original.bytes(type)
    else original.skip(type)
  }
  const value = new HuyaTarsWriter()
  value.int(0, 0); value.int(1, 1400); value.bytes(2, body!); value.int(5, id)
  return value.finish()
}
function ws(id: number): Buffer {
  const writer = new HuyaTarsWriter()
  writer.int(0, 7); writer.bytes(1, push(id))
  return writer.finish()
}
function slice(id: number): Buffer {
  const compressed = deflateSync(push(id)), frame = Buffer.alloc(18 + 19 + compressed.length)
  frame.writeUInt16LE(frame.length, 8); frame.writeUInt32LE(frame.length - 10, 10); frame.writeUInt32LE(514595, 14)
  frame.set([200, 0, 3], 18); frame.writeUInt16LE(1, 23); frame.writeUInt32LE(id, 25)
  frame.writeUInt16LE(48, 29); frame.writeUInt16LE(compressed.length, 31); frame.set(compressed, 33)
  return frame
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('runs both production clients through the relay, survives either transport loss and suppresses reconnect history', async () => {
  const sockets: ReturnType<typeof socket>[] = [], bodies: ReadableStreamDefaultController<Uint8Array>[] = []
  const requests = vi.fn(async () => ({ url: 'https://fixture.p2p.huya.com/huyalive/chat-fixture.slice?placeholder',
    host: 'fixture.p2p.huya.com', ttlSeconds: 300, issuedAt: Date.now(), expiresAt: Date.now() + 300_000, wsTime: 'placeholder' }))
  const relay = new DanmakuRelay({ huya: { resolveRoom: async () => metadata,
    createSocket: () => { const value = socket(); sockets.push(value); return value },
    slice: { requestSignal: requests, stream: (url, policy, options) => safeFetchStream(url, policy, {
      ...options, resolve: async () => ['1.1.1.1'],
      fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { bodies.push(controller) } }))) as typeof fetch,
    }) },
  } })
  const write = vi.fn(), observed = vi.fn()
  relay.observe(observed)
  relay.subscribe('huya:660002', { write, close() {} })
  const tick = () => vi.advanceTimersByTimeAsync(0)
  const register = () => {
    sockets.at(-1)!.fire('open')
    sockets.at(-1)!.fire('message', { data: Buffer.from(fixtures.registered.hex, 'hex') })
  }
  const messageIds = () => write.mock.calls.filter(([event]) => event === 'danmaku').map(([, message]) => message.id)
  try {
    await tick(); register()
    sockets[0]!.fire('message', { data: ws(101) }); bodies[0]!.enqueue(slice(101)); await tick()
    expect(messageIds()).toEqual(['huya:660002:1400:101'])
    expect(relay.stateOf('huya:660002')).toBe('connected')

    sockets[0]!.fire('close'); bodies[0]!.enqueue(slice(102)); await tick()
    expect(relay.stateOf('huya:660002')).toBe('connected')
    await vi.advanceTimersByTimeAsync(1000); register()
    sockets[1]!.fire('message', { data: ws(102) })
    expect(messageIds()).toHaveLength(2)

    bodies[0]!.error(new Error('private signed URL must not escape')); await tick()
    sockets[1]!.fire('message', { data: ws(103) })
    expect(relay.stateOf('huya:660002')).toBe('connected')
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveBeenCalledTimes(2)
    bodies[1]!.enqueue(slice(103)); await tick()
    expect(messageIds()).toEqual([101, 102, 103].map(id => `huya:660002:1400:${id}`))
    expect(observed.mock.calls.filter(([event]) => event.type === 'message')).toHaveLength(3)
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/private|signed|placeholder/)
  } finally { relay.closeAll(); await tick() }
  expect(vi.getTimerCount()).toBe(0)
})

it('does not open either production source if a connecting observer closes the room synchronously', () => {
  const createSource = vi.fn(() => ({ state: 'idle' as const, connect: vi.fn(), close: vi.fn() }))
  const client = new HuyaRoomClient(metadata.room, { onMessage() {}, onState: state => { if (state === 'connecting') client.close() } }, { createSource })
  client.connect()
  expect(client.state).toBe('closed')
  expect(createSource.mock.results.every(({ value }) => value.connect.mock.calls.length === 0)).toBe(true)
})
