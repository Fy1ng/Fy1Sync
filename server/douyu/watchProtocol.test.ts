import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeFrame, serializeStt } from '../danmaku/douyuProtocol'
import { MAX_BUFFER_BYTES, MessageProtocolError } from './messageProtocol'
import { DouyuWatchFrameDecoder, parseDouyuWatchKdTransform, readWatchHeartbeatChallenge, readWatchKd } from './watchProtocol'
import pcReference from './fixtures/watch-kd-pc-vectors.json'

const frame = (padding = '') => encodeFrame(serializeStt({ type: 'fixture', payload: padding }), 690)
const pcTemplate = readFileSync(new URL('./fixtures/watch-kd-pc-template.txt', import.meta.url), 'utf8')
const payload = (source: unknown = pcTemplate, room = '6979222') => ({ error: 0, data: { ['room' + room]: source } })

describe('long viewing gateway framing', () => {
  it('preserves fragmented frames across traffic windows', () => {
    const decoder = new DouyuWatchFrameDecoder(), value = frame('split')
    expect(decoder.feed(value.subarray(0, 9), 0)).toEqual([])
    expect(decoder.feed(value.subarray(9), 60_000)).toEqual([{ type: 'fixture', payload: 'split' }])
  })

  it('accepts over 1024 frames and 2 MiB during a healthy long connection', () => {
    const decoder = new DouyuWatchFrameDecoder(), value = frame('x'.repeat(3_000))
    for (let index = 0; index < 1_200; index++) expect(decoder.feed(value, index * 100)).toHaveLength(1)
  })

  it('rejects excess traffic inside one minute', () => {
    const decoder = new DouyuWatchFrameDecoder(), value = frame('x'.repeat(200_000))
    expect(() => { for (let index = 0; index < 50; index++) decoder.feed(value, 0) }).toThrow(MessageProtocolError)
  })

  it('rejects malformed headers, unbounded input and excessive frame counts', () => {
    const bad = frame(); bad.writeUInt32LE(4, 0)
    expect(() => new DouyuWatchFrameDecoder().feed(bad, 0)).toThrow(MessageProtocolError)
    expect(() => new DouyuWatchFrameDecoder().feed(Buffer.alloc(MAX_BUFFER_BYTES + 1), 0)).toThrow(MessageProtocolError)
    const decoder = new DouyuWatchFrameDecoder()
    expect(() => decoder.feed(Buffer.concat(Array.from({ length: 8_193 }, () => frame())), 0)).toThrow(MessageProtocolError)
  })

  it('validates the separate signing challenge and bounded complete kd blocks', () => {
    expect(readWatchHeartbeatChallenge({ type: 'keeplive', kd: '0123456789abcdef' })).toBeUndefined()
    expect(readWatchKd('0123456789abcdef')).toBe('0123456789abcdef')
    expect(() => readWatchKd('00000000')).toThrow(MessageProtocolError)
    expect(readWatchHeartbeatChallenge({ type: 'keeplive', kd: '', nonce: 'synthetic-next', its: '0' })).toEqual({ nonce: 'synthetic-next', iterations: 0 })
    expect(() => readWatchHeartbeatChallenge({ type: 'keeplive', nonce: 'missing-iterations' })).toThrow(MessageProtocolError)
  })
})

describe('PC kd static parsing and local integer transform', () => {
  it('unpacks the known PC function as inert text and matches independent integer vectors', () => {
    const transform = parseDouyuWatchKdTransform(payload(), '6979222')
    for (const vector of pcReference.vectors) expect(transform(vector.inputHex)).toBe(vector.outputHex)
    expect(transform('')).toBe('')
    expect(transform(pcReference.vectors[1]!.inputHex.toUpperCase())).toBe(pcReference.vectors[1]!.outputHex)
  })

  it('supports the same known PC template under a different explicitly requested room', () => {
    const transform = parseDouyuWatchKdTransform(payload(pcTemplate, '9999'), '9999')
    expect(transform(pcReference.vectors[0]!.inputHex)).toBe(pcReference.vectors[0]!.outputHex)
  })

  it.each([
    (source: string) => source.replace('0x22375bae', '0x22375baf'),
    (source: string) => source.replace('0x174d4dc8', '0xbb32ea6'),
    (source: string) => source.replace('O<102', 'O<999999999'),
    (source: string) => source.replace('return eval(strc)', 'return (globalThis.__watchKdExecuted=true,eval(strc))'),
    (source: string) => source + source,
    (source: string) => source + ';var tdd6j4a3805151e6611=[];',
    (source: string) => source.replace('for(var I=0;I<102;I+=2)', 'for(;;)'),
  ])('rejects altered or adversarial wrappers without running any downloaded code %#', mutate => {
    expect(() => parseDouyuWatchKdTransform(payload(mutate(pcTemplate)), '6979222')).toThrow(MessageProtocolError)
    expect(Object.hasOwn(globalThis, '__watchKdExecuted')).toBe(false)
  })

  it.each([{}, { error: 1, data: { room6979222: pcTemplate } }, payload(pcTemplate, '9999'), payload('x'.repeat(60_001)), payload(42)])('rejects missing/wrong room mappings, errors and oversized source %#', value => {
    expect(() => parseDouyuWatchKdTransform(value, '6979222')).toThrow(MessageProtocolError)
  })

  it('rejects accessor/proxy payloads before reading their values', () => {
    let accessed = false
    expect(() => parseDouyuWatchKdTransform({ get error() { accessed = true; return 0 } }, '6979222')).toThrow(MessageProtocolError)
    const proxied = new Proxy(payload(), { getOwnPropertyDescriptor() { accessed = true; return undefined } })
    expect(() => parseDouyuWatchKdTransform(proxied, '6979222')).toThrow(MessageProtocolError)
    expect(accessed).toBe(false)
  })

  it.each(['not-hex', '00', 'ffffffff', '0'.repeat(4_112)])('rejects invalid or excessive kd input %#', input => {
    const transform = parseDouyuWatchKdTransform(payload(), '6979222')
    expect(() => transform(input)).toThrow(MessageProtocolError)
  })
})
