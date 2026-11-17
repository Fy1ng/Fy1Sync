import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import vectors from './fixtures/http-signing-vectors.json'
import { douyinSm3, signDouyinHttpQuery } from './httpSigner'

describe('Douyin local HTTP signing', () => {
  it.each(['', 'abc', 'abcd'.repeat(16), 'x'.repeat(1000)])('matches independent SM3 for %s', value => {
    expect(Buffer.from(douyinSm3(Buffer.from(value))).toString('hex')).toBe(createHash('sm3').update(value).digest('hex'))
  })
  it.each(vectors)('matches the pinned upstream vector for $query', vector => {
    expect(signDouyinHttpQuery(vector.query, vector.userAgent, { ...vector.values, random: vector.values.random as [number,number,number] })).toBe(vector.signature)
  })
  it('rejects unsigned query mutation, malformed input and invalid entropy', () => {
    const vector = vectors[0]!, values = { ...vector.values, random: vector.values.random as [number,number,number] }
    expect(signDouyinHttpQuery(vector.query + '&type=1', vector.userAgent, values)).not.toBe(vector.signature)
    expect(signDouyinHttpQuery(vector.query, vector.userAgent + ' different', values)).not.toBe(vector.signature)
    for (const query of ['', 'content=未编码', 'a=1&a_bogus=old', 'a=\n']) expect(() => signDouyinHttpQuery(query, vector.userAgent, values)).toThrow()
    expect(() => signDouyinHttpQuery(vector.query, vector.userAgent, { ...values, end: values.start - 1 })).toThrow()
  })
  it('does not retain cipher state between requests', () => {
    const vector = vectors[0]!, values = { ...vector.values, random: vector.values.random as [number,number,number] }
    expect(signDouyinHttpQuery(vector.query, vector.userAgent, values)).toBe(signDouyinHttpQuery(vector.query, vector.userAgent, values))
  })
})
