import { afterEach, expect, it, vi } from 'vitest'
import { brotliCompressSync, deflateSync } from 'node:zlib'
import { bilibiliPacket, BilibiliDanmakuClient, decodeBilibiliPackets, isBilibiliDanmakuEndpoint, signBilibili } from './bilibiliClient'
import { parseBilibiliRoomEvent } from './bilibiliEvents'
import { bilibiliReplay, bilibiliReplayAt, bilibiliReplayRoom } from './bilibiliReplayFixture'
import type { WebSocketLike } from './types'

afterEach(() => vi.useRealTimers())

it('decodes grouped zlib and Brotli packets and rejects an invalid envelope', () => {
  const inner = Buffer.concat([bilibiliPacket(5, '{"cmd":"DANMU_MSG"}'), bilibiliPacket(3, 'heat')])
  for (const [version, compress] of [[2, deflateSync], [3, brotliCompressSync]] as const) {
    const compressed = compress(inner)
    const outer = Buffer.from(bilibiliPacket(5, ''))
    outer.writeUInt16BE(version, 6)
    outer.writeUInt32BE(16 + compressed.length, 0)
    const received: number[] = []
    decodeBilibiliPackets(Buffer.concat([outer, compressed]), op => received.push(op))
    expect(received).toEqual([5, 3])
  }
  expect(() => decodeBilibiliPackets(new Uint8Array([1]), () => {})).toThrow()
})

it('signs sorted query values and only allows Bilibili chat WSS targets', () => {
  expect(signBilibili({ z: "a!'()*b", a: '1' }, 'key')).toMatch(/^a=1&z=ab&w_rid=[a-f0-9]{32}$/)
  expect(isBilibiliDanmakuEndpoint('wss://broadcastlv.chat.bilibili.com/sub')).toBe(true)
  expect(isBilibiliDanmakuEndpoint('wss://broadcastlv.chat.bilibili.com:2245/sub')).toBe(true)
  for (const url of ['wss://chat.bilibili.com.evil.test/sub', 'wss://x.chat.bilibili.com:80/sub', 'wss://user@x.chat.bilibili.com/sub',
    'wss://x.chat.bilibili.com/sub?tag=1', 'https://x.chat.bilibili.com/sub', 'wss://x.chat.bilibili.com/']) {
    expect(isBilibiliDanmakuEndpoint(url)).toBe(false)
  }
})

it('parses plain, inline and whole image chat with independent identity fields', () => {
  const parse = (raw: unknown) => parseBilibiliRoomEvent(raw, bilibiliReplayRoom, bilibiliReplayAt)
  expect(parse(bilibiliReplay.text)).toMatchObject({ text: '测试文字', color: 0x12ab34, receivedAt: bilibiliReplayAt })
  expect(parse(bilibiliReplay.text)).not.toHaveProperty('emotes')
  expect(parse(bilibiliReplay.inline)).toMatchObject({
    text: '你好[笑]', bilibiliUid: '42', bilibiliEmoteKind: 'inline',
    emotes: [{ text: '[笑]', url: expect.stringContaining('i0.hdslb.com') }],
    bilibiliSender: { admin: true, gloryLevel: 18, siteLevel: 6, guardLevel: 3, medal: { level: 13, anchorUid: '1001', worn: false } },
  })
  expect(parse(bilibiliReplay.image)).toMatchObject({ bilibiliEmoteKind: 'image', emotes: [{ text: '[整条表情]' }] })
  expect(parse({ cmd: 'DANMU_MSG', info: [[], '测试文字', [42, '测试观众'], [12, '测试牌'], [42]] }))
    .toMatchObject({ bilibiliSender: { medal: { level: 12, worn: undefined }, gloryLevel: undefined, siteLevel: undefined } })
})

it('uses the actual gift quantity and keeps payment, bag and combo separate', () => {
  const parse = (raw: unknown) => parseBilibiliRoomEvent(raw, bilibiliReplayRoom, bilibiliReplayAt)
  expect(parse(bilibiliReplay.gift)).toMatchObject({
    bilibiliGift: { quantity: 2, payment: 'paid', fromBag: true, comboId: 'combo-fixture', comboTotal: 12 },
  })
  const raw = { cmd: 'SEND_GIFT', data: { giftName: '测试礼物', coin_type: 'gold', total_coin: 300 } }
  expect(parse(raw)).toMatchObject({ bilibiliGift: { payment: 'unknown', quantity: undefined, fromBag: undefined } })
  expect(parse({ ...raw, data: { ...raw.data, coin_type: 'silver' } })).toMatchObject({ bilibiliGift: { payment: 'free' } })
  expect(parse({ ...bilibiliReplay.gift, cmd: 'COMBO_SEND' })).toBeNull()
  expect(parseBilibiliRoomEvent(bilibiliReplay.watched, '123457', bilibiliReplayAt)).toBeNull()
})

function fakeSocket() {
  const listeners = new Map<string, (event: unknown) => void>()
  const socket: WebSocketLike = { send: vi.fn(), close: vi.fn(), addEventListener: (name, listener) => { listeners.set(name, listener) } }
  return { socket, emit: (name: string, arg: unknown = {}) => listeners.get(name)?.(arg) }
}

it('authenticates, timestamps, deduplicates SC, emits a scoped tombstone and cancels on close', async () => {
  vi.useFakeTimers()
  const { socket, emit } = fakeSocket()
  const events = { onMessage: vi.fn(), onObservedMessage: vi.fn(), onSignal: vi.fn(), onState: vi.fn() }
  const resolveRoom = vi.fn(async () => ({ room: bilibiliReplayRoom, token: 'fixture', uid: 0, buvid: 'visitor', endpoint: 'wss://x.chat.bilibili.com/sub' }))
  const client = new BilibiliDanmakuClient('6', events, { resolveRoom, createSocket: () => socket, now: () => bilibiliReplayAt })
  client.connect()
  await vi.advanceTimersByTimeAsync(0)
  const packet = (op: number, raw: unknown) => emit('message', { data: bilibiliPacket(op, JSON.stringify(raw)) })
  emit('open')
  const auth = JSON.parse(Buffer.from(vi.mocked(socket.send).mock.calls[0]![0] as Uint8Array).subarray(16).toString())
  expect(auth).toMatchObject({ roomid: Number(bilibiliReplayRoom), key: 'fixture', protover: 3, buvid: 'visitor' })
  packet(5, bilibiliReplay.text)
  expect(events.onMessage).not.toHaveBeenCalled()
  packet(8, { code: 0 })
  expect(client.state).toBe('connected')
  packet(5, bilibiliReplay.superChat)
  packet(5, bilibiliReplay.superChat)
  packet(5, bilibiliReplay.deleteSuperChat)
  packet(5, bilibiliReplay.superChat)
  packet(5, bilibiliReplay.watched)
  expect(events.onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    room: `bilibili:${bilibiliReplayRoom}`, receivedAt: bilibiliReplayAt, superChat: { id: '99', price: 30, duration: 90,
      endsAt: bilibiliReplayAt + 90_000, background: '#1565c0', color: '#ffffff' },
  }))
  expect(events.onObservedMessage).toHaveBeenCalledTimes(1)
  expect(events.onSignal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'super-chat-delete', ids: ['99'] }))
  expect(events.onSignal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'watched', count: 1024 }))
  emit('close')
  expect(client.state).toBe('reconnecting')
  client.close()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(client.state).toBe('closed')
  expect(resolveRoom).toHaveBeenCalledTimes(1)
  expect(socket.close).toHaveBeenCalledTimes(1)
})

it('aborts a pending lookup and never opens a stale socket', async () => {
  let finish: (() => void) | undefined
  let signal: AbortSignal | undefined
  const createSocket = vi.fn()
  const client = new BilibiliDanmakuClient('6', { onMessage: vi.fn(), onState: vi.fn() }, {
    createSocket,
    resolveRoom: (_room, current) => new Promise(resolve => {
      signal = current
      finish = () => resolve({ room: '123456', token: 'fixture', uid: 0, buvid: 'visitor', endpoint: 'wss://x.chat.bilibili.com/sub' })
    }),
  })
  client.connect()
  await Promise.resolve()
  client.close()
  finish?.()
  await Promise.resolve()
  await Promise.resolve()
  expect(signal?.aborted).toBe(true)
  expect(createSocket).not.toHaveBeenCalled()
})
