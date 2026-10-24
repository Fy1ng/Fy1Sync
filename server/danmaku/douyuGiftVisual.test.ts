import { describe, expect, it } from 'vitest'
import { DouyuDanmakuClient, MAX_GIFT_MESSAGES_PER_SECOND, type WebSocketLike } from './douyuClient'
import { encodeFrame, parseStt, serializeStt, SERVER_MESSAGE_TYPE, toChatMessage, toGiftMessage } from './douyuProtocol'

const gift = {
  type: 'dgb', rid: '1234', uid: '42', nn: '观众', level: '28', nl: '3',
  gfid: '824', gfcnt: '2', gpf: '0', hits: '99', bcnt: '999',
}

describe('Douyu real gift traffic for optional local visuals', () => {
  it('retains the real sender and per-event count, without treating gifts as chat', () => {
    const raw = Object.freeze({ ...gift })
    expect(toChatMessage(raw, '1234', 100)).toBeNull()
    expect(toGiftMessage(raw, '1234', 100)).toMatchObject({
      username: '观众', text: '粉丝荧光棒 x 2', system: true, room: '1234', receivedAt: 100,
      gift: { kind: 'gift', id: '824', count: 2 }, sender: { uid: '42', level: 28, nobleLevel: 3 },
    })
    expect(raw).toEqual(gift)
  })

  it('selects pid only for a backpack prop and does not reuse its gfid namespace', () => {
    const result = toGiftMessage({ ...gift, gpf: '1', pid: '268' }, '1234', 100)
    expect(result).toMatchObject({ gift: { kind: 'prop', id: '268', count: 2 }, text: '粉丝荧光棒 x 2' })
    expect(toGiftMessage({ ...gift, gpf: '1' }, '1234', 100)).toBeNull()
    expect(toGiftMessage({ ...gift, gpf: '1', pid: '824' }, '1234', 100)?.text).toBe('道具 #824 x 2')
  })

  it('uses the documented count default only when gfcnt is absent', () => {
    const { gfcnt: _count, ...withoutCount } = gift
    expect(toGiftMessage(withoutCount, '1234', 100)?.gift?.count).toBe(1)
    expect(toGiftMessage({ ...gift, gfcnt: '' }, '1234', 100)).toBeNull()
  })

  it.each(['0', '-1', '1.5', '1e2', '02', 'Infinity', '1000001', '999999999999999999999'])('rejects invalid gift count %s', count => {
    expect(toGiftMessage({ ...gift, gfcnt: count }, '1234', 100)).toBeNull()
  })

  it.each(['0', '-824', '0824', '8.24e2', 'constructor', '../824', '1'.repeat(21)])('rejects invalid gift id %s', id => {
    expect(toGiftMessage({ ...gift, gfid: id }, '1234', 100)).toBeNull()
  })

  it('requires a matching source room and known protocol flag', () => {
    expect(toGiftMessage({ ...gift, rid: '9999' }, '1234', 100)).toBeNull()
    expect(toGiftMessage({ ...gift, gpf: '2' }, '1234', 100)).toBeNull()
    expect(toGiftMessage({ ...gift, type: 'bdgb' }, '1234', 100)).toBeNull()
    expect(toGiftMessage({ ...gift, type: 'spbc' }, '1234', 100)).toBeNull()
    const { rid: _room, ...withoutRoom } = gift
    expect(toGiftMessage(withoutRoom, '1234', 100)?.room).toBe('1234')
  })

  it('forwards only allowed metadata and bounds gift labels without interpreting HTML', () => {
    const result = toGiftMessage({ ...gift, nn: '\u0000<img src=x>' + 'a'.repeat(100),
      eci: 'synthetic-encrypted-data', txt: 'forged message', url: 'https://untrusted.invalid/' }, '1234', 100)!
    expect(result.username).toHaveLength(64)
    expect(result.username).toMatch(/^<img src=x>/)
    expect(result).not.toHaveProperty('eci')
    expect(result).not.toHaveProperty('url')
    expect(result.text).toBe('粉丝荧光棒 x 2')
  })

  it('retains real chat text and sender facts independently from the gift projection', () => {
    const result = toChatMessage({ type: 'chatmsg', txt: '超级火箭 x 100', uid: '42', nn: '原昵称', level: '28', nl: '3' }, '1234', 100)
    expect(result).toMatchObject({ text: '超级火箭 x 100', username: '原昵称', sender: { uid: '42', level: 28, nobleLevel: 3 }, system: false })
    expect(result).not.toHaveProperty('gift')
    const invalid = toChatMessage({ type: 'chatmsg', txt: 'x', uid: '042', level: 'NaN', nl: '-1' }, '1234', 100)
    expect(invalid).not.toHaveProperty('sender')
  })
})

describe('gift burst limit', () => {
  it('caps gifts separately, keeps chat flowing and permits gifts again in the next window', () => {
    let now = 1_000
    const received: Array<ReturnType<typeof toGiftMessage>> = []
    const listeners = new Map<string, (event: any) => void>()
    const socket: WebSocketLike = {
      send: () => {}, close: () => {},
      addEventListener: (name, callback) => { listeners.set(name, callback) },
    }
    const client = new DouyuDanmakuClient('1234', {
      onMessage: message => received.push(message), onState: () => {},
    }, { createSocket: () => socket, now: () => now, setTimer: () => 0, clearTimer: () => {} })
    client.connect()
    listeners.get('open')!({})
    const frame = encodeFrame(serializeStt(gift), SERVER_MESSAGE_TYPE)
    listeners.get('message')!({ data: Buffer.concat([
      ...Array.from({ length: 200 }, () => frame),
      encodeFrame(serializeStt({ type: 'chatmsg', txt: '聊天仍正常', nn: '另一个观众' }), SERVER_MESSAGE_TYPE),
    ]) })
    expect(received.filter(message => message?.gift)).toHaveLength(MAX_GIFT_MESSAGES_PER_SECOND)
    expect(received.at(-1)?.text).toBe('聊天仍正常')
    now += 1_000
    listeners.get('message')!({ data: frame })
    expect(received.filter(message => message?.gift)).toHaveLength(MAX_GIFT_MESSAGES_PER_SECOND + 1)
    client.close()
  })

  it('decodes escaped gift names using the existing STT boundary', () => {
    expect(toGiftMessage(parseStt(serializeStt({ ...gift, nn: 'a/@S' })), '1234', 0)?.username).toBe('a/@S')
  })
})
