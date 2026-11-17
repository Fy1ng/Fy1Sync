import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { chromiumCookieValue, chromiumMasterKey } from './browserCookieCrypto'

function encrypt(key: Buffer, payload: Buffer, algorithm: 'aes-256-gcm' | 'chacha20-poly1305' = 'aes-256-gcm'): Buffer {
  const nonce = randomBytes(12)
  const cipher = algorithm === 'aes-256-gcm' ? createCipheriv('aes-256-gcm', key, nonce)
    : createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  return Buffer.concat([nonce, cipher.update(payload), cipher.final(), cipher.getAuthTag()])
}
describe('browser cookie authenticated decryption', () => {
  it('supports Edge direct keys and rejects unknown Chrome wrappers', () => {
    const key = randomBytes(32)
    expect(chromiumMasterKey(key)).toEqual(key)
    for (const content of [Buffer.alloc(0), Buffer.alloc(33), Buffer.alloc(93, 5), Buffer.alloc(61, 4)]) {
      expect(() => chromiumMasterKey(content)).toThrow('无法读取浏览器登录凭据')
    }
  })
  it.each([1, 2])('authenticates wrapping version %i', version => {
    const constant = Buffer.from(version === 1 ? 'b31c6e241ac846728da9c1fac4936651cffb944d143ab816276bcdd6da284787'
      : 'e98f37d7f4e1fa433d19303dd2c58042090e2d1d7eea7670d41f738d08729660', 'hex')
    const key = randomBytes(32)
    const content = Buffer.concat([Buffer.from([version]), encrypt(constant, key, version === 1 ? 'aes-256-gcm' : 'chacha20-poly1305')])
    expect(chromiumMasterKey(content)).toEqual(key)
    content[content.length - 1] = content[content.length - 1]! ^ 1
    expect(() => chromiumMasterKey(content)).toThrow()
  })
  it.each([3, 4])('authenticates CNG wrapping version %i and preserves input buffers', version => {
    const cng = randomBytes(32)
    const original = Buffer.from(cng)
    const mask = Buffer.from(version === 3 ? 'ccf8a1cec56605b8517552ba1a2d061c03a29e90274fb2fcf59ba4b75c392390'
      : '208a6da7114a44e6b463114bd9da397e939adefedbf4588117926b0f2c503158', 'hex')
    const derived = Buffer.from(cng.map((byte, index) => byte ^ mask[index]!))
    const key = randomBytes(32)
    const content = Buffer.concat([Buffer.from([version]), randomBytes(32), encrypt(derived, key)])
    expect(chromiumMasterKey(content, cng)).toEqual(key)
    expect(cng).toEqual(original)
    expect(() => chromiumMasterKey(content)).toThrow()
    content[content.length - 1] = content[content.length - 1]! ^ 1
    expect(() => chromiumMasterKey(content, cng)).toThrow()
  })
  it.each(['v20', 'v10', 'v11'])('verifies the host binding and AEAD tag for %s', version => {
    const key = randomBytes(32)
    const host = '.bilibili.com'
    const payload = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('synthetic-cookie')])
    const blob = Buffer.concat([Buffer.from(version), encrypt(key, payload)])
    const keys = version === 'v20' ? { master: key } : { legacy: key }
    expect(chromiumCookieValue(blob, host, 24, keys)).toBe('synthetic-cookie')
    expect(() => chromiumCookieValue(blob, '.other.com', 24, keys)).toThrow()
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1
    expect(() => chromiumCookieValue(blob, host, 24, keys)).toThrow()
  })
})
