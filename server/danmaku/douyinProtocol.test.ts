import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeDouyinFrame, decodeDouyinResponse, douyinProtoField as field, encodeDouyinAck, encodeDouyinHeartbeat, MAX_DOUYIN_FRAME } from './douyinProtocol'
import { joinDouyinBytes as join, syntheticDouyinChat, syntheticDouyinFrame, syntheticDouyinIds as ids, syntheticDouyinResponse } from './fixtures/douyin-synthetic'

const decode = (bytes: Uint8Array) => decodeDouyinFrame(bytes, ids.webRoom, ids.roomId, 1234)
describe('bounded Douyin receive protobuf', () => {
  it('decodes the observed pb + gzip framing and echoes push-header ACK ext with 64-bit IDs', () => {
    const result = decode(syntheticDouyinFrame())
    expect(result).toMatchObject({ malformed: false, valid: true, heartbeatMs: 15_000 })
    expect(result.ack).toEqual(encodeDouyinAck(ids.logId, 'synthetic-header-internal'))
    expect(result.messages).toEqual([{ id: `douyin:${ids.roomId}:${ids.messageId}`, platform: 'douyin', room: 'douyin:100', receivedAt: 1234,
      text: 'synthetic-chat', username: 'synthetic-viewer', color: 0xffffff, level: 0, system: false }])
    expect(JSON.stringify(result.messages)).not.toContain('synthetic-private-profile')
    expect(JSON.stringify(result.messages)).not.toContain('9000000000000000099')
  })
  it('reads dynamic IM state and clamps upstream heartbeat durations', () => {
    const result = decodeDouyinResponse(syntheticDouyinResponse([]))
    expect(result).toMatchObject({ cursor: 'synthetic-cursor', internalExt: 'synthetic-internal', heartbeatMs: 15000, needAck: true, messages: [] })
    expect(decodeDouyinResponse(join(field(8, 18446744073709551615n))).heartbeatMs).toBe(60000)
    expect(decodeDouyinResponse(join(field(8, 1n))).heartbeatMs).toBe(10000)
  })
  it('ignores gifts and other-room chat while accepting plain protobuf frames', () => {
    const gift = join(field(1, 'WebcastGiftMessage'), field(2, Uint8Array.from([255])))
    const result = decode(syntheticDouyinFrame({ compressed: false, messages: [gift, syntheticDouyinChat({ roomId: '999' })] }))
    expect(result).toMatchObject({ malformed: false, valid: true, messages: [], unknownMessages: 1 })
  })
  it('recognizes only matching-room live-end control and never emits it as a chat', () => {
    const control = join(field(1, 'WebcastControlMessage'), field(2, join(field(1, field(3, BigInt(ids.roomId))), field(2, 3n))))
    expect(decode(syntheticDouyinFrame({ messages: [control] }))).toMatchObject({ liveEnded: true, messages: [] })
  })
  it('rejects oversized frames, decompression bombs, field floods and invalid wire types', () => {
    expect(decode(new Uint8Array(MAX_DOUYIN_FRAME + 1)).malformed).toBe(true)
    const bomb = join(field(6, 'pb'), field(7, 'msg'), field(8, gzipSync(new Uint8Array(MAX_DOUYIN_FRAME + 1))))
    expect(decode(bomb).malformed).toBe(true)
    const flood = Uint8Array.from({ length: 65_538 }, (_, i) => i % 2 ? 0 : 120)
    expect(decode(syntheticDouyinFrame({ payload: flood, compressed: false })).malformed).toBe(true)
    for (const bytes of [Uint8Array.from([0]), Uint8Array.from([11]), Uint8Array.from([8, ...new Array(11).fill(255)]), Uint8Array.from([66, 9, 0])]) expect(decode(bytes).malformed).toBe(true)
  })
  it('rejects conflicting singleton chat/header fields and unsupported encodings without partial delivery', () => {
    expect(decode(syntheticDouyinFrame({ messages: [syntheticDouyinChat(), syntheticDouyinChat({ duplicateContent: true })] }))).toMatchObject({ malformed: true, messages: [] })
    expect(decode(syntheticDouyinFrame({ duplicateHeader: true })).malformed).toBe(true)
    expect(decode(syntheticDouyinFrame({ encoding: 'json' })).malformed).toBe(true)
    expect(decode(syntheticDouyinFrame({ payload: field(15, 1n), compressed: false })).malformed).toBe(true)
    expect(() => decodeDouyinResponse(field(1, 123n))).toThrow()
  })
  it('writes only the fixed application heartbeat and bounded ACK', () => {
    expect(Buffer.from(encodeDouyinHeartbeat()).toString('hex')).toBe('3a026862')
    expect(decode(encodeDouyinHeartbeat())).toMatchObject({ valid: true, messages: [] })
    expect(() => encodeDouyinAck('18446744073709551616', 'safe')).toThrow()
    expect(() => encodeDouyinAck('1', 'x'.repeat(8193))).toThrow()
    expect(decode(new Uint8Array())).toMatchObject({ valid: false, malformed: false })
  })
})
