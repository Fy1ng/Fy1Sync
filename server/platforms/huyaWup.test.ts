import { describe, expect, it } from 'vitest'
import golden from './fixtures/huya-biliup-golden.json'
import { decodeHuyaTokenResponse, encodeHuyaTokenRequest } from './huyaWup'

// Original Python-reference golden bytes from biliup (MIT), pinned in fixtures/huya-README.md.
const response = () => Buffer.from(golden.response, 'hex')

describe('Huya WUP TarsV3 subset', () => {
  it('matches the upstream request byte for byte including HUYA.UserId', () => {
    expect(Buffer.from(encodeHuyaTokenRequest(golden.streamName, golden.huyaUA)).toString('hex')).toBe(golden.request)
  })

  it('extracts sFlvToken from the independent upstream response', () => {
    expect(decodeHuyaTokenResponse(response())).toBe(golden.token)
  })

  it('rejects every truncation of the golden packet', () => {
    const bytes = response()
    for (let end = 0; end < bytes.length; end++) expect(decodeHuyaTokenResponse(bytes.subarray(0, end))).toBeNull()
  })

  it('rejects a trailing payload, false frame length and unsupported version', () => {
    expect(decodeHuyaTokenResponse(Buffer.concat([response(), Buffer.from([0])]))).toBeNull()
    const invalidLength = response()
    invalidLength.writeUInt32BE(0xffff_ffff)
    expect(decodeHuyaTokenResponse(invalidLength)).toBeNull()
    const invalidVersion = response()
    invalidVersion[5] = 2
    expect(decodeHuyaTokenResponse(invalidVersion)).toBeNull()
    expect(decodeHuyaTokenResponse(new Uint8Array(65_537))).toBeNull()
  })

  it('rejects negative or oversized byte lengths and invalid element types', () => {
    for (const replacement of [0xff, 0x7f]) {
      const bytes = response()
      const index = bytes.indexOf(Buffer.from('7d000064', 'hex'))
      expect(index).toBeGreaterThan(0)
      bytes[index + 3] = replacement
      expect(decodeHuyaTokenResponse(bytes)).toBeNull()
    }
    const invalidElement = response()
    invalidElement[invalidElement.indexOf(Buffer.from('7d000064', 'hex')) + 1] = 1
    expect(decodeHuyaTokenResponse(invalidElement)).toBeNull()
  })

  it('rejects malformed UTF-8, control characters and unexpected struct endings', () => {
    for (const byte of [0xff, 0x0a]) {
      const bytes = response()
      bytes[bytes.indexOf(Buffer.from('wsSecret'))] = byte
      expect(decodeHuyaTokenResponse(bytes)).toBeNull()
    }
    const wrongStruct = response()
    wrongStruct[wrongStruct.indexOf(Buffer.from('0a064e', 'hex'))] = 0x0b
    expect(decodeHuyaTokenResponse(wrongStruct)).toBeNull()
    const noStructEnd = response()
    noStructEnd[noStructEnd.length - 6] = 0x0c
    expect(decodeHuyaTokenResponse(noStructEnd)).toBeNull()
  })

  it('safely skips an unknown extended-tag field without changing the token', () => {
    const extra = Buffer.from([0xf0, 0x40, 0x01])
    const bytes = Buffer.concat([response(), extra])
    bytes.writeUInt32BE(bytes.length)
    expect(decodeHuyaTokenResponse(bytes)).toBe(golden.token)
  })

  it.each(['', 'x'.repeat(257), 'room/../../secret', 'room\r\nCookie:x'])('rejects an invalid request stream name', name => {
    expect(() => encodeHuyaTokenRequest(name)).toThrow('Invalid Huya WUP packet')
  })

  it('supports the string4 boundary without truncating the stream name', () => {
    const encoded = Buffer.from(encodeHuyaTokenRequest('a'.repeat(256)))
    expect(encoded.readUInt32BE()).toBe(encoded.length)
    expect(encoded.includes(Buffer.concat([Buffer.from([0x17, 0, 0, 1, 0]), Buffer.from('a'.repeat(256))]))).toBe(true)
  })
})
