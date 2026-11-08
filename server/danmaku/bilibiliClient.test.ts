import { afterEach, expect, it, vi } from 'vitest'
import { brotliCompressSync, deflateSync } from 'node:zlib'
import { bilibiliPacket, decodeBilibiliPackets, signBilibili } from './bilibiliClient'
import { DanmakuRelay } from './relay'
import type { WebSocketLike } from './types'

afterEach(() => vi.useRealTimers())

it('decodes combined packets inside both supported compression formats', () => {
  const inner = Buffer.concat([bilibiliPacket(5, '{"cmd":"DANMU_MSG"}'), bilibiliPacket(3, 'heat')])
  for (const [version, compress] of [[2, deflateSync], [3, brotliCompressSync]] as const) {
    const compressed = compress(inner)
    const outer = Buffer.from(bilibiliPacket(5, ''))
    outer.writeUInt16BE(version, 6); outer.writeUInt32BE(16 + compressed.length, 0)
    const received: number[] = []
    decodeBilibiliPackets(Buffer.concat([outer, compressed]), op => received.push(op))
    expect(received).toEqual([5, 3])
  }
  expect(() => decodeBilibiliPackets(new Uint8Array([1]), () => {})).toThrow()
})

it('signs sorted and sanitized WBI query values', () => {
  expect(signBilibili({ foo: '114', bar: '514', baz: '1919810' }, 'ea1db124af3c7062474693fa704f4ff8'))
    .toMatch(/^bar=514&baz=1919810&foo=114&w_rid=[a-f0-9]{32}$/)
  expect(signBilibili({ x: "a!'()*b" }, 'key')).toBe(signBilibili({ x: 'ab' }, 'key'))
})

it('authenticates before marking connected, relays chat, retries and closes', async () => {
  vi.useFakeTimers()
  const listeners = new Map<string, (event: any) => void>()
  const socket: WebSocketLike = { send: vi.fn(), close: vi.fn(), addEventListener: (type, cb) => { listeners.set(type, cb) } }
  const states: string[] = []
  const events: unknown[] = []
  const relay = new DanmakuRelay({ bilibili: {
    createSocket: () => socket,
    resolveRoom: async () => ({ room: '123456', token: 'private-token', uid: 0, buvid: 'visitor', endpoint: 'wss://broadcastlv.chat.bilibili.com/sub' }),
  } })
  relay.subscribe('bilibili:6', { write: (type, data) => { if (type === 'state') states.push((data as any).state); else events.push(data) }, close() {} })
  await Promise.resolve(); await Promise.resolve()
  listeners.get('open')?.({})
  expect(states).not.toContain('connected')
  const sent = vi.mocked(socket.send).mock.calls[0]![0] as Uint8Array
  const auth = JSON.parse(Buffer.from(sent).subarray(16).toString())
  expect(auth).toMatchObject({ roomid: 123456, key: 'private-token', protover: 3, buvid: 'visitor' })
  listeners.get('message')?.({ data: bilibiliPacket(8, '{"code":0}') })
  expect(states).toContain('connected')
  listeners.get('message')?.({ data: bilibiliPacket(5, JSON.stringify({ cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [[], '测试弹幕', [42, '观众']] })) })
  expect(events).toEqual([expect.objectContaining({ text: '测试弹幕', platform: 'bilibili', room: 'bilibili:6' })])
  const sc = bilibiliPacket(5, JSON.stringify({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 99, uid: 42, price: 30, time: 60, message: '醒目留言内容', background_bottom_color: '#1565c0', message_font_color: '#ffffff', user_info: { uname: 'SC观众' } } }))
  listeners.get('message')?.({ data: sc })
  listeners.get('message')?.({ data: sc })
  expect(events).toHaveLength(2)
  expect(events[1]).toMatchObject({ text: '醒目留言内容', bilibiliUid: '42', superChat: { id: '99', price: 30, duration: 60 } })
  const info = [[0, 1, 25, 0x12ab34], '你好[笑]', [42, '观众']]
  ;(info[0] as any)[15] = { extra: JSON.stringify({ emots: { '[笑]': { url: 'https://i0.hdslb.com/bfs/emote/test.png' } } }) }
  listeners.get('message')?.({ data: bilibiliPacket(5, JSON.stringify({ cmd: 'DANMU_MSG', info })) })
  expect(events[2]).toMatchObject({ color: 0x12ab34, bilibiliUid: '42', emotes: [{ text: '[笑]', url: 'https://i0.hdslb.com/bfs/emote/test.png' }] })
  listeners.get('close')?.({})
  expect(states).toContain('reconnecting')
  relay.closeAll()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(socket.close).toHaveBeenCalled()
  expect(relay.roomCount).toBe(0)
})
