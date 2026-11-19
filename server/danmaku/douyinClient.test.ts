import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOUYIN_USER_AGENT, type DouyinDanmakuRoom } from '../platforms/douyinDanmaku'
import { DouyinDanmakuClient, douyinBinaryFrame, type DouyinLotteryRead } from './douyinClient'
import { douyinProtoField as field, encodeDouyinAck, encodeDouyinHeartbeat } from './douyinProtocol'
import { joinDouyinBytes as join, syntheticDouyinFrame, syntheticDouyinIds as ids } from './fixtures/douyin-synthetic'
import type { DanmakuClientEvents, WebSocketLike } from './types'
import type { DouyinLotterySnapshot } from '../../src/core/douyinLottery'

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
  it('delivers native emoji and gift metadata through both callbacks without mutating quantities on duplicate frames', async () => {
    const context = setup(), socket = await connect(context)
    const common = (messageId: bigint) => join(field(2, messageId), field(3, BigInt(ids.roomId)))
    const emoji = join(field(1, 'WebcastEmojiChatMessage'), field(2, join(field(1, common(1n)), field(2, field(3, 'synthetic-viewer')),
      field(3, 77n), field(5, '[合成表情]'))))
    const gift = join(field(1, 'WebcastGiftMessage'), field(2, join(field(1, common(2n)), field(2, 88n), field(7, field(3, 'synthetic-viewer')),
      field(15, join(field(5, 88n), field(12, 10n), field(16, '合成礼物'))), field(44, 3n), field(5, 9n))))
    const frame = syntheticDouyinFrame({ messages: [emoji, gift] })
    socket.fire('message', { data: frame }); socket.fire('message', { data: frame })
    expect(context.events.onMessage).toHaveBeenCalledTimes(2)
    expect(context.events.onObservedMessage).toHaveBeenCalledTimes(2)
    expect(context.events.onMessage.mock.calls).toEqual(context.events.onObservedMessage.mock.calls)
    expect(context.events.onMessage.mock.calls[0]?.[0]).toMatchObject({ douyin: { emoji: { id: '77', fallback: '[合成表情]' } } })
    expect(context.events.onMessage.mock.calls[1]?.[0]).toMatchObject({ douyin: { gift: { id: '88', count: '3', repeatCount: '9', totalDiamonds: null } } })
    expect(context.client.diagnostics).toMatchObject({ chats: 2, acknowledgements: 2 })
    context.client.close()
  })
  it('refreshes room session and anchor context on reconnect and rejects old-session payloads', async () => {
    const firstAnchor = '9000000000000000100', secondAnchor = '9000000000000000101', secondRoomId = '9000000000000000011'
    let calls = 0
    const context = setup(async () => ++calls === 1 ? { ...metadata, anchorId: firstAnchor } : { ...metadata, roomId: secondRoomId, anchorId: secondAnchor })
    const makeChat = (roomId: string, anchorId: string) => join(field(1, 'WebcastChatMessage'), field(2, join(
      field(1, join(field(2, 33n), field(3, BigInt(roomId)))), field(2, field(24, field(1, join(field(6, BigInt(anchorId)), field(3, 1n))))), field(3, '合成聊天'))))
    const oldFrame = syntheticDouyinFrame({ messages: [makeChat(ids.roomId, firstAnchor)] })
    const firstSocket = await connect(context)
    firstSocket.fire('message', { data: oldFrame })
    expect(context.events.onMessage.mock.calls[0]?.[0]).toMatchObject({ douyin: { roomId: ids.roomId, sender: { liveFansClub: { anchorId: firstAnchor, currentRoom: true } } } })
    firstSocket.fire('error')
    await vi.advanceTimersByTimeAsync(1000)
    const secondSocket = context.sockets.at(-1)!
    secondSocket.fire('open')
    secondSocket.fire('message', { data: oldFrame }); firstSocket.fire('message', { data: oldFrame })
    expect(context.events.onMessage).toHaveBeenCalledTimes(1)
    secondSocket.fire('message', { data: syntheticDouyinFrame({ messages: [makeChat(secondRoomId, firstAnchor)] }) })
    expect(context.events.onMessage.mock.calls[1]?.[0]).toMatchObject({ douyin: { roomId: secondRoomId, sender: { liveFansClub: { anchorId: firstAnchor, currentRoom: false } } } })
    context.client.close()
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
  it('reads lottery only in the connected scene and discards late results after a reconnect', async () => {
    const nextRoomId = '9000000000000000021'
    let visits = 0
    const context = setup(async () => visits++ ? { ...metadata, roomId: nextRoomId } : metadata)
    const first = await connect(context)
    const empty: DouyinLotterySnapshot = { room: 'douyin:100', roomId: ids.roomId, observedAt: 0, status: 'empty', activity: null }
    let finish!: (snapshot: DouyinLotterySnapshot) => void
    const read = vi.fn<DouyinLotteryRead>(() => new Promise(resolve => { finish = resolve }))
    await expect(context.client.readLottery(read)).resolves.toBeNull()
    expect(read).not.toHaveBeenCalled()
    first.fire('message', { data: encodeDouyinHeartbeat() })
    const pending = context.client.readLottery(read)
    expect(read.mock.calls[0]![0].roomId).toBe(ids.roomId)
    first.fire('error')
    expect(read.mock.calls[0]![1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const second = context.sockets.at(-1)!
    second.fire('open')
    second.fire('message', { data: encodeDouyinHeartbeat() })
    finish(empty)
    await expect(pending).resolves.toBeNull()
    await expect(context.client.readLottery(async () => empty)).resolves.toBeNull()
    await expect(context.client.readLottery(async room => ({ ...empty, roomId: room.roomId })))
      .resolves.toEqual({ ...empty, roomId: nextRoomId })
    context.client.close()
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
