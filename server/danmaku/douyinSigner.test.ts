import { describe, expect, it } from 'vitest'
import { DouyinSigner, douyinSignatureWithValues, douyinSigningStub } from './douyinSigner'

describe('local Douyin signer', () => {
  it('matches native Go / instrumented SDK golden vectors including the plus alphabet', () => {
    const stub = '704f436b2558b0d7a1c7e758527dd8f1'
    expect(douyinSignatureWithValues(stub, 1, true, 63, 63)).toBe('6pt0VC0aRZDP7n07')
    expect(douyinSignatureWithValues(stub, 0, false, 0, 6)).toBe('fD+evFuzasjOC8Uu')
  })
  it('rejects identities and malformed state before signing', () => {
    expect(() => douyinSigningStub('18446744073709551616', '123')).toThrow()
    expect(() => douyinSigningStub('123', '0')).toThrow()
    expect(() => douyinSignatureWithValues('wrong', 1, false, 0, 0)).toThrow()
    const signer = new DouyinSigner(() => 255)
    expect(() => signer.sign('1234567890123456789', '1234567890123456780')).toThrow()
  })
  it('produces local signatures with fresh session sequence values', () => {
    const signer = new DouyinSigner(() => 1)
    const first = signer.sign('1234567890123456789', '1234567890123456780')
    expect(first).toHaveLength(16)
    expect(signer.sign('1234567890123456789', '1234567890123456780')).not.toBe(first)
  })
})
