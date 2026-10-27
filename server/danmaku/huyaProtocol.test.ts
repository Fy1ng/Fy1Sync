import { describe, expect, it, vi } from 'vitest'
import fixtures from './fixtures/huya-synthetic.json'
import { decodeHuyaFrame, encodeHuyaHeartbeat, encodeHuyaRegistration, MAX_HUYA_FRAME, decodeHuyaPush } from './huyaProtocol'
import { HuyaTarsWriter, HuyaTarsReader } from '../platforms/huyaWup'
import { parseHuyaDanmakuPage, resolveHuyaDanmakuRoom } from '../platforms/huyaDanmaku'

const frame = (name: Exclude<keyof typeof fixtures, 'registration' | 'biliupNotice'>) => Buffer.from(fixtures[name].hex, 'hex')
const room = { room: '660002', presenterUid: 12345n, topSid: 456n, subSid: 789n }

function envelope(command: number, body: Buffer): Buffer {
  const writer = new HuyaTarsWriter()
  writer.int(0, command); writer.bytes(1, body)
  return writer.finish()
}

describe('Huya TARS receive-only protocol', () => {
  it('matches an independent cmd16 registration golden with both anonymous groups', () => {
    expect(Buffer.from(encodeHuyaRegistration(room)).toString('hex')).toBe(fixtures.registration.hex)
  })

  it('preserves 64-bit UID and rejects out-of-range registration IDs', () => {
    const encoded = encodeHuyaRegistration({ ...room, presenterUid: 0x1234567890abcdn })
    expect(Buffer.from(encoded).includes(Buffer.from(`live:${0x1234567890abcdn}`))).toBe(true)
    expect(Buffer.from(encoded).includes(Buffer.from(`chat:${0x1234567890abcdn}`))).toBe(true)
    expect(() => encodeHuyaRegistration({ ...room, presenterUid: 1n << 64n })).toThrow()
    expect(() => encodeHuyaRegistration({ ...room, topSid: -1n })).toThrow()
  })

  it('uses the pinned biliup anonymous heartbeat golden', () => {
    expect(Buffer.from(encodeHuyaHeartbeat()).toString('hex')).toBe('00031d0000690000006910032c3c4c56086f6e6c696e657569660f4f6e557365724865617274426561747d00003c0800010604745265711d00002f0a0a0c1600260036076164725f77617046000b1203aef00f2203aef00f3c426d5202605c60017c82000bb01f9cac0b8c980ca80c20')
  })

  it('decodes chat with the nickname nested in sender tag 2 and nonzero sid', () => {
    const result = decodeHuyaFrame(frame('chat'), room.room, 1000)
    expect(result.malformed).toBe(false)
    expect(result.messages).toEqual([{ id: 'huya:660002:1400:123', platform: 'huya', room: '660002', receivedAt: 1000,
      color: 0, level: 0, text: 'hello danmaku', username: 'nickname', system: false }])
    expect(result.messages[0]).not.toHaveProperty('sender')
    expect(result.messages[0]).not.toHaveProperty('gift')
  })

  it.each(['gift6501', 'gift6502', 'gift6507'] as const)('normalizes %s without exporting private sender/payment fields', name => {
    const result = decodeHuyaFrame(frame(name), room.room, 1000)
    expect(result.malformed).toBe(false)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({ platform: 'huya', system: true,
      username: name === 'gift6501' ? 'viewer-placeholder' : '匿名', huyaGift: { id: '4', count: 3 } })
    expect(result.messages[0]!.username).not.toBe('presenter-placeholder')
    expect(JSON.stringify(result)).not.toMatch(/placeholder-pay-id|example\.invalid|sender|token|cookie/i)
  })

  it('decodes the same push body from the HTTP source and WebSocket envelope', () => {
    const reader = new HuyaTarsReader(frame('chat'))
    reader.head(); reader.int(0)
    const [, type] = reader.head()
    const inner = reader.bytes(type)
    expect(decodeHuyaPush(inner, room.room, 1000)).toMatchObject({ malformed: false, messages: decodeHuyaFrame(frame('chat'), room.room, 1000).messages })
    expect(decodeHuyaPush(new Uint8Array([255]), room.room, 1000).malformed).toBe(true)
  })

  it('decodes viewer counts into platform-specific room signals', () => {
    expect(decodeHuyaFrame(frame('viewers'), room.room, 1000).signals).toEqual([
      { platform: 'huya', kind: 'viewers', room: room.room, receivedAt: 1000, count: 12345, messageId: '123' },
    ])
  })

  it('decodes MsgPushReq_V2 and drops/counts unknown URI without decoding its body', () => {
    const result = decodeHuyaFrame(frame('batch'), room.room, 1000)
    expect(result).toMatchObject({ command: 22, batch: true, malformed: false, unknownUris: 1 })
    expect(result.messages.map(message => message.system)).toEqual([false, true])
    expect(result.signals).toHaveLength(1)
  })

  it('handles registration acceptance/rejection and heartbeat acknowledgements', () => {
    expect(decodeHuyaFrame(frame('registered'), room.room, 0).registered).toBe(true)
    expect(decodeHuyaFrame(frame('registrationFailed'), room.room, 0).registrationFailed).toBe(true)
    expect(decodeHuyaFrame(frame('heartbeat'), room.room, 0).heartbeat).toBe(true)
  })

  it('requires a group belonging to the current presenter and accepts a chat-only acknowledgement', () => {
    expect(decodeHuyaFrame(frame('registered'), room.room, 0, { presenterUid: 12345n }).registered).toBe(true)
    expect(decodeHuyaFrame(frame('registered'), room.room, 0, { presenterUid: 54321n }).registered).toBe(false)
    const rsp = new HuyaTarsWriter()
    rsp.int(0, 0); rsp.head(1, 9); rsp.int(0, 0)
    expect(decodeHuyaFrame(envelope(17, rsp.finish()), room.room, 0).registered).toBe(false)
  })

  it('ignores genuine zero-length binary messages without classifying them as malformed', () => {
    expect(decodeHuyaFrame(new Uint8Array(), room.room, 0)).toMatchObject({ emptyFrame: true, malformed: false,
      malformedReason: null, registered: false, heartbeat: false, messages: [], signals: [] })
  })

  it('validates WUP heartbeat responses rather than trusting arbitrary cmd4 traffic', () => {
    const writer = new HuyaTarsWriter()
    writer.int(1, 3); writer.string(6, 'OnUserHeartBeat')
    const body = writer.finish()
    const size = Buffer.alloc(4); size.writeUInt32BE(body.length + 4)
    expect(decodeHuyaFrame(envelope(4, Buffer.concat([size, body])), room.room, 0).heartbeat).toBe(true)
    expect(decodeHuyaFrame(envelope(4, Buffer.from([0, 0, 0, 4])), room.room, 0).heartbeat).toBe(false)
  })

  it('rejects every truncated chat frame without throwing or emitting partial messages', () => {
    const original = frame('chat')
    for (let length = 1; length < original.length; length++) {
      expect(decodeHuyaFrame(original.subarray(0, length), room.room, 0)).toMatchObject({ malformed: true, messages: [], signals: [] })
    }
  })

  it.each([
    Buffer.from('00071d0002ffffffff', 'hex'),
    Buffer.from('00071d0100', 'hex'),
    Buffer.from('00070007', 'hex'),
    Buffer.from('00071d000001ff', 'hex'),
    Buffer.concat([Buffer.from('0007', 'hex'), Buffer.alloc(34, 0x2a), Buffer.alloc(34, 0x0b)]),
    Buffer.from('0007290200000101', 'hex'),
    Buffer.from('0007290200007fff', 'hex'),
    Buffer.alloc(MAX_HUYA_FRAME + 1),
  ])('bounds malformed lengths, duplicate tags, depth, collections and frame size', data => {
    expect(decodeHuyaFrame(data, room.room, 0)).toMatchObject({ malformed: true, messages: [], signals: [] })
  })

  it('drops all partial batch output if a known item is malformed', () => {
    const data = frame('batch')
    const corrupted = Buffer.from(data)
    // Change the final unknown URI 9999 to known chat 1400, leaving its invalid body.
    const position = corrupted.lastIndexOf(Buffer.from('01270f', 'hex'))
    Buffer.from('010578', 'hex').copy(corrupted, position)
    expect(decodeHuyaFrame(corrupted, room.room, 0)).toMatchObject({ malformed: true, messages: [], signals: [] })
  })

  it('terminates on deterministic malformed binary inputs', () => {
    let seed = 17
    for (let count = 0; count < 300; count++) {
      const data = Buffer.alloc(count % 150)
      for (let index = 0; index < data.length; index++) { seed = (seed * 1664525 + 1013904223) >>> 0; data[index] = seed & 255 }
      expect(() => decodeHuyaFrame(data, room.room, 0)).not.toThrow()
    }
  })
})

const page = (room = '660002', uid = '12345', extra = '') => `var TT_ROOM_DATA={"state":"OFF","profileRoom":"${room}","topSid":"456","subSid":"789"${extra}}; var TT_PROFILE_INFO={"uid":"${uid}"};`

describe('Huya public room metadata', () => {
  it('parses chat metadata when offline and without H1 stream/CDN data', () => {
    expect(parseHuyaDanmakuPage(page(), '660002')).toEqual(room)
    expect(parseHuyaDanmakuPage(page('660002', '9007199254740993'), '660002').presenterUid).toBe(9007199254740993n)
  })

  it('uses the upstream zero-channel registration when public metadata omits channel IDs', () => {
    expect(parseHuyaDanmakuPage('var TT_ROOM_DATA={"profileRoom":660002,"uid":"12345"};', '660002'))
      .toEqual({ ...room, topSid: 0n, subSid: 0n })
    expect(() => parseHuyaDanmakuPage('var TT_ROOM_DATA={"profileRoom":660002,"uid":"12345","topSid":-1};', '660002')).toThrow()
  })

  it('confirms aliases against a numeric page and pins the room identity', async () => {
    const fetchText = vi.fn(async (_url: string, _init?: RequestInit) => page())
    expect(await resolveHuyaDanmakuRoom('kpl', fetchText)).toEqual(room)
    expect(fetchText.mock.calls.map(call => call[0])).toEqual(['https://www.huya.com/kpl', 'https://www.huya.com/660002'])
    const changed = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page('999'))
    await expect(resolveHuyaDanmakuRoom('kpl', changed)).rejects.toThrow('无法读取虎牙弹幕房间信息.')
  })

  it.each(['', '../kpl', 'kpl?token=secret', 'https://www.huya.com/kpl', 'a'.repeat(65), '房间'])('rejects an unsafe room without requesting it', async input => {
    const fetchText = vi.fn()
    await expect(resolveHuyaDanmakuRoom(input, fetchText)).rejects.toThrow()
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('rejects invalid metadata and sanitizes upstream errors', async () => {
    expect(() => parseHuyaDanmakuPage(page('660002', '1e100'), '660002')).toThrow()
    expect(() => parseHuyaDanmakuPage(page('660002', '1', ',"topSid":"0"'), '660002')).not.toThrow()
    expect(() => parseHuyaDanmakuPage('x'.repeat(2 * MAX_HUYA_FRAME + 1), '660002')).toThrow()
    await expect(resolveHuyaDanmakuRoom('660002', async () => { throw new Error('Cookie=private; token=secret') })).rejects.toThrow('无法读取虎牙弹幕房间信息.')
    await expect(resolveHuyaDanmakuRoom('660002', async () => page('999'))).rejects.toThrow('无法读取虎牙弹幕房间信息.')
  })
})
