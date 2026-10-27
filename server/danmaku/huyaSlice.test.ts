import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { HUYA_SLICE_LIMITS, HuyaSliceParser } from './huyaSlice'
import { decodeHuyaPush } from './huyaProtocol'

type Expected = { uri: string; messageId: string; username?: string; text?: string
  presenter?: string; giftId?: string; count?: number; name?: string }
type Sample = { name: string; hex: string; expected: Expected[]; fragmentCount?: number }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/huya-slice-real.json', import.meta.url), 'utf8')) as { samples: Sample[] }
const sample = (name: string) => fixture.samples.find(value => value.name === name)!
const bytes = (name: string) => Buffer.from(sample(name).hex, 'hex')

function packet(payload: Uint8Array, uri = 514595): Buffer {
  const buffer = Buffer.alloc(18 + payload.length)
  buffer.writeUInt16LE(buffer.length, 8)
  buffer.writeUInt32LE(buffer.length - 10, 10)
  buffer.writeUInt32LE(uri, 14)
  buffer.set(payload, 18)
  return buffer
}
function block(payload: Uint8Array, count = 1, sequence = 10, ordinal = 4000): Buffer {
  const buffer = Buffer.alloc(19 + payload.length)
  buffer.set([200, 0, 3])
  buffer.writeUInt16LE(ordinal, 3)
  buffer.writeUInt16LE(count, 5)
  buffer.writeUInt32LE(sequence, 7)
  buffer.writeUInt16LE(48, 11)
  buffer.writeUInt16LE(payload.length, 13)
  buffer.set(payload, 15)
  return buffer
}
function splitPackets(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = []
  for (let offset = 0; offset < buffer.length;) {
    const size = buffer.readUInt16LE(offset + 8)
    parts.push(buffer.subarray(offset, offset + size))
    offset += size
  }
  return parts
}
function parse(data: Uint8Array, chunkSize = data.length) {
  const pushes: Array<{ bytes: Buffer; sequence: number }> = []
  const parser = new HuyaSliceParser((value, sequence) => pushes.push({ bytes: Buffer.from(value), sequence }))
  for (let offset = 0; offset < data.length; offset += chunkSize) parser.feed(data.subarray(offset, offset + chunkSize))
  return { parser, pushes }
}

describe('Huya HTTP slice real anonymized fixtures', () => {
  for (const source of fixture.samples) {
    it(`decodes ${source.name} across every possible two-way input split`, () => {
      const data = Buffer.from(source.hex, 'hex')
      const baseline = parse(data)
      expect(baseline.pushes).toHaveLength(source.expected.length)
      expect(baseline.parser.diagnostics).toMatchObject({
        malformedPackets: 0, malformedBlocks: 0, inflateFailures: 0, fragmentFailures: 0,
        sequenceGaps: 0, bufferedBytes: 0, pendingFragments: 0,
      })
      for (let split = 1; split < data.length; split++) {
        const emitted: Buffer[] = []
        const parser = new HuyaSliceParser(value => emitted.push(Buffer.from(value)))
        parser.feed(data.subarray(0, split))
        parser.feed(data.subarray(split))
        expect(emitted.length).toBe(baseline.pushes.length)
        expect(emitted.every((value, index) => value.equals(baseline.pushes[index]!.bytes))).toBe(true)
        expect(parser.diagnostics).toEqual(baseline.parser.diagnostics)
      }
      expect(parse(data, 1).pushes).toEqual(baseline.pushes)
    })
  }

  it('reuses the bounded push decoder for chat and gift bodies', () => {
    for (const source of fixture.samples) {
      const { pushes } = parse(Buffer.from(source.hex, 'hex'))
      for (const [index, value] of pushes.entries()) {
        const expected = source.expected[index]!
        const result = decodeHuyaPush(value.bytes, '528300', 1000)
        expect(result.malformed).toBe(false)
        if (expected.uri === '1400') {
          expect(result.messages).toHaveLength(1)
          expect(result.messages[0]).toMatchObject({
            id: `huya:528300:1400:${expected.messageId}`,
            username: 'viewer-placeholder', text: 'sanitized chat', system: false,
          })
        } else if (expected.uri === '6501') {
          expect(result.messages).toHaveLength(1)
          expect(expected.presenter).toBe('presenter-placeholder')
          expect(result.messages[0]).toMatchObject({ id: `huya:528300:6501:${expected.messageId}`,
            username: 'viewer-placeholder', huyaGift: { id: expected.giftId, count: expected.count, name: 'gift-placeholder' } })
        } else {
          expect(result.messages).toEqual([])
          expect(result.unknownUriCounts).toEqual({ [expected.uri]: 1 })
        }
      }
    }
  })

  it('recognizes padding without exposing payloads', () => {
    const { parser, pushes } = parse(bytes('padding'), 3)
    expect(pushes).toEqual([])
    expect(parser.diagnostics).toMatchObject({ packets: 1, paddingPackets: 1, blocks: 0, messages: 0 })
  })

  it('reassembles fragments by ordinal and strips each trailing config map', () => {
    const fragments = splitPackets(bytes('fragmented'))
    const baseline = parse(bytes('fragmented'))
    const actual = parse(Buffer.concat([...fragments].reverse()), 7)
    expect(actual.pushes).toEqual(baseline.pushes)
    expect(actual.parser.diagnostics).toMatchObject({
      blocks: sample('fragmented').fragmentCount, messages: 1, fragmentMessages: 1, fragmentFailures: 0,
    })
  })

  it('ignores duplicate fragment retransmissions and fails conflicting duplicates', () => {
    const fragments = splitPackets(bytes('fragmented'))
    const good = parse(Buffer.concat([fragments[0]!, fragments[0]!, ...fragments.slice(1)]))
    expect(good.pushes).toHaveLength(1)
    const conflicting = Buffer.from(fragments[0]!)
    conflicting[33] = conflicting[33]! ^ 1
    const bad = parse(Buffer.concat([fragments[0]!, conflicting]))
    expect(bad.pushes).toHaveLength(0)
    expect(bad.parser.diagnostics).toMatchObject({ fragmentFailures: 1, pendingFragments: 0, bufferedBytes: 0 })
  })

  it('keeps framing when a block crosses transport packets', () => {
    const { parser, pushes } = parse(bytes('crossPacketBlock'), 2)
    expect(pushes).toHaveLength(1)
    expect(parser.diagnostics).toMatchObject({ packets: 3, blocks: 1, malformedBlocks: 0, bufferedBytes: 0 })
  })
})

describe('Huya HTTP slice bounds and recovery', () => {
  it('recovers from garbage packet and block headers', () => {
    const valid = bytes('singleChat')
    const { parser, pushes } = parse(Buffer.concat([Buffer.alloc(300, 0xfe), packet(Buffer.alloc(200, 0xee)), valid]), 13)
    expect(pushes).toHaveLength(1)
    expect(parser.diagnostics.malformedPackets).toBeGreaterThan(0)
    expect(parser.diagnostics.malformedBlocks).toBeGreaterThan(0)
    expect(parser.diagnostics.bufferedBytes).toBe(0)
  })

  it('does not consume a truncated advertised packet until the remainder arrives', () => {
    const good = bytes('singleChat')
    const spy = vi.fn()
    const parser = new HuyaSliceParser(spy)
    parser.feed(good.subarray(0, good.length - 1))
    expect(spy).not.toHaveBeenCalled()
    expect(parser.diagnostics.bufferedBytes).toBeLessThanOrEqual(HUYA_SLICE_LIMITS.packetBytes)
    parser.feed(good.subarray(good.length - 1))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('rejects excessive config counts and still finds a later valid block', () => {
    const bad = block(deflateSync(Buffer.from([1])))
    bad.writeUInt32LE(HUYA_SLICE_LIMITS.configEntries + 1, bad.length - 4)
    const { parser, pushes } = parse(Buffer.concat([packet(bad), bytes('singleChat')]))
    expect(parser.diagnostics.malformedBlocks).toBeGreaterThan(0)
    expect(pushes).toHaveLength(1)
  })

  it('drops invalid zlib and zip bombs without leaking errors', () => {
    const bomb = deflateSync(Buffer.alloc(HUYA_SLICE_LIMITS.inflatedBytes + 1, 65))
    const { parser, pushes } = parse(Buffer.concat([packet(block(Buffer.from([1, 2, 3]))), packet(block(bomb)), bytes('singleChat')]))
    expect(pushes).toHaveLength(1)
    expect(parser.diagnostics.inflateFailures).toBe(2)
  })

  it('validates every merged record before emitting any', () => {
    const invalid = Buffer.alloc(20)
    invalid.writeUInt32LE(9)
    invalid.writeUInt32LE(1, 4)
    invalid[8] = 1
    invalid.writeUInt32LE(1000, 9)
    const { parser, pushes } = parse(packet(block(deflateSync(invalid), 0)))
    expect(pushes).toEqual([])
    expect(parser.diagnostics.malformedBlocks).toBe(1)
    const tooMany = Buffer.alloc((HUYA_SLICE_LIMITS.records + 1) * 9)
    for (let offset = 0; offset < tooMany.length; offset += 9) {
      tooMany.writeUInt32LE(9, offset); tooMany[offset + 8] = 1
    }
    const actual = parse(packet(block(deflateSync(tooMany), 0)))
    expect(actual.pushes).toEqual([])
    expect(actual.parser.diagnostics.malformedBlocks).toBe(1)
  })

  it('bounds fragment counts, pending groups, bytes and age', () => {
    const spy = vi.fn()
    let now = 0
    const parser = new HuyaSliceParser(spy, () => now)
    parser.feed(packet(block(Buffer.from([1]), HUYA_SLICE_LIMITS.fragments + 1)))
    expect(parser.diagnostics.fragmentFailures).toBe(1)
    for (let index = 0; index <= HUYA_SLICE_LIMITS.pendingMessages; index++) parser.feed(packet(block(Buffer.from([1]), 2, index)))
    expect(parser.diagnostics.pendingFragments).toBe(HUYA_SLICE_LIMITS.pendingMessages)
    expect(parser.diagnostics.fragmentFailures).toBe(2)
    now = HUYA_SLICE_LIMITS.fragmentLifetimeMs
    parser.feed(new Uint8Array())
    expect(parser.diagnostics.pendingFragments).toBe(0)
    expect(parser.diagnostics.bufferedBytes).toBe(0)
    expect(parser.diagnostics.fragmentFailures).toBe(HUYA_SLICE_LIMITS.pendingMessages + 2)
    const large = Buffer.alloc(60_000, 1)
    for (let index = 0; index < 9; index++) parser.feed(packet(block(large, 10, 100, index)))
    expect(parser.diagnostics.bufferedBytes).toBeLessThanOrEqual(HUYA_SLICE_LIMITS.compressedBytes)
    expect(parser.diagnostics.fragmentFailures).toBeGreaterThan(HUYA_SLICE_LIMITS.pendingMessages + 2)
    expect(spy).not.toHaveBeenCalled()
  })

  it('counts a failed complete fragmented zlib stream', () => {
    const { parser, pushes } = parse(Buffer.concat([
      packet(block(Buffer.from([1]), 2, 1, 4000)),
      packet(block(Buffer.from([2]), 2, 1, 4008)),
    ]))
    expect(pushes).toEqual([])
    expect(parser.diagnostics).toMatchObject({ inflateFailures: 1, fragmentFailures: 1, pendingFragments: 0 })
  })

  it('tracks forward gaps, duplicate sequences, wrap and connection reset', () => {
    const values: number[] = []
    const parser = new HuyaSliceParser((_data, sequence) => values.push(sequence))
    for (const sequence of [65534, 65535, 0, 2, 2]) parser.feed(packet(block(deflateSync(Buffer.from([1])), 1, sequence)))
    expect(values).toEqual([65534, 65535, 0, 2, 2])
    expect(parser.diagnostics).toMatchObject({ messages: 5, sequenceGaps: 1, sequenceDuplicates: 1 })
    parser.feed(splitPackets(bytes('fragmented'))[0]!)
    parser.reset()
    expect(parser.diagnostics).toMatchObject({ messages: 5, sequenceGaps: 1, fragmentFailures: 1, bufferedBytes: 0 })
    parser.feed(packet(block(deflateSync(Buffer.from([1])), 1, 2000)))
    expect(parser.diagnostics.sequenceGaps).toBe(1)
  })

  it('ignores unsupported packet/codec types and consumer exceptions', () => {
    const otherCodec = block(deflateSync(Buffer.from([1])))
    otherCodec.writeUInt16LE(49, 11)
    const parser = new HuyaSliceParser(() => { throw Error('private consumer detail') })
    expect(() => parser.feed(Buffer.concat([packet(Buffer.from([1]), 999), packet(otherCodec), bytes('singleChat')]))).not.toThrow()
    expect(parser.diagnostics).toMatchObject({ messages: 1, unhandledPackets: 1, unhandledBlocks: 1 })
  })
})
