import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/huya-real.json'
import { decodeHuyaFrame } from './huyaProtocol'

describe('Huya anonymized host captures', () => {
  it.each(fixtures.samples)('decodes $name from the recorded wire structure', sample => {
    const result = decodeHuyaFrame(Buffer.from(sample.hex, 'hex'), '660002', 1000)
    expect(result).toMatchObject({
      command: sample.expected.command,
      registered: sample.expected.registered,
      malformed: sample.expected.malformed,
      emptyFrame: sample.expected.emptyFrame,
      unknownUriCounts: sample.expected.unknownUriCounts,
    })
    expect(result.messages).toHaveLength(sample.expected.messages.length)
    expect(result.messages).toMatchObject(sample.expected.messages)
    expect(result.signals.map(signal => signal.count)).toEqual(sample.expected.viewers)
    expect(result.unknownUris).toBe(Object.values(sample.expected.unknownUriCounts).reduce((sum, count) => sum + count, 0))
    for (const message of result.messages) {
      expect(message).toMatchObject({ platform: 'huya', room: '660002', receivedAt: 1000 })
      expect(message).not.toHaveProperty('sender')
      expect(message).not.toHaveProperty('gift')
      expect(message).not.toHaveProperty('payId')
      expect(message).not.toHaveProperty('uid')
      expect(message).not.toHaveProperty('avatar')
      if (message.system) {
        expect(message.username).toBe('viewer-placeholder')
        expect(message.username).not.toBe('presenter-placeholder')
      }
    }
  })

  it('uses the observed gift-name field and preserves item counts', () => {
    const namesAndCounts = fixtures.samples.filter(sample => /^cmd7Gift/.test(sample.name)).flatMap(sample => {
      return decodeHuyaFrame(Buffer.from(sample.hex, 'hex'), '660002', 0).messages.map(message => message.huyaGift)
    })
    expect(namesAndCounts).toEqual([
      { id: '4', name: '虎粮', count: 25 },
      { id: '20699', name: '超粉虎粮', count: 50 },
      { id: '20865', name: '热火', count: 10 },
      { id: '22003', name: '3倍亲密12', count: 1 },
    ])
  })

  it('reclassifies captured empty binary messages independently from malformed frames', () => {
    expect(fixtures.audit.reduce((sum, file) => sum + file.frames, 0)).toBe(578)
    expect(fixtures.audit.reduce((sum, file) => sum + file.empty, 0)).toBe(127)
    expect(fixtures.audit.every(file => file.empty === file.previouslyMalformed)).toBe(true)
    const empty = fixtures.samples.find(sample => sample.name === 'emptyBinaryFrame')
    expect(empty).toMatchObject({ kind: 'captured-empty-binary', hex: '', expected: { emptyFrame: true, malformed: false } })
  })

  it('distinguishes the derived gift batch from independently captured frames', () => {
    const derived = fixtures.samples.filter(sample => sample.kind === 'derived-recombined')
    expect(derived.map(sample => sample.name)).toEqual(['derivedBatchChatGiftViewers'])
    const result = decodeHuyaFrame(Buffer.from(derived[0]!.hex, 'hex'), '660002', 0)
    expect(result).toMatchObject({ command: 22, batch: true, malformed: false })
    expect(result.messages.map(message => message.system)).toEqual([false, true])
    expect(result.signals).toHaveLength(1)
  })
})
