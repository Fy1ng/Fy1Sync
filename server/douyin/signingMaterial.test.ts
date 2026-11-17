import { describe,expect,it } from 'vitest'
import { douyinCookieFingerprint,parseDouyinSigningSnapshot,validateDouyinSigningMaterial } from './signingMaterial'
import { syntheticDouyinSigningMaterial } from './fixtures/signingFixture'

describe('private Douyin signing-record binding',()=>{
  it('uses authentication values only and keeps header order and anonymous-cookie refreshes irrelevant',()=>{
    const a=douyinCookieFingerprint('sessionid=synthetic-a; sessionid_ss=synthetic-b; msToken=one')
    expect(douyinCookieFingerprint('msToken=two; sessionid_ss=synthetic-b; sessionid=synthetic-a')).toBe(a)
    expect(douyinCookieFingerprint('sessionid=synthetic-other; sessionid_ss=synthetic-b')).not.toBe(a)
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    expect(()=>douyinCookieFingerprint('sessionid=a; sessionid=b')).toThrow()
    expect(()=>douyinCookieFingerprint('msToken=anonymous')).toThrow()
  })
  it('normalizes a matched snapshot and removes unrecognized page fields',()=>{
    const material=syntheticDouyinSigningMaterial()
    const snapshot={origin:material.origin,accountUid:material.accountUid,cookieFingerprint:material.cookieFingerprint,userAgent:material.userAgent,
      cryptData:JSON.stringify({ec_privateKey:material.privateKeyPem,ec_publicKey:material.publicKeyPem,ignoredSecret:'not-forwarded'}),
      serverData:JSON.stringify({ticket:material.ticket,ts_sign:material.tsSign,client_cert:material.clientCertificate,ignoredSecret:'not-forwarded'})}
    const parsed=parseDouyinSigningSnapshot(snapshot,material.capturedAt)
    expect(parsed).toEqual(material)
    expect(validateDouyinSigningMaterial({...parsed,ignoredSecret:'not-forwarded'})).not.toHaveProperty('ignoredSecret')
  })
  it.each([
    {origin:'https://evil.invalid'},{accountUid:'0'},{accountUid:'18446744073709551616'},
    {cookieFingerprint:'not-a-fingerprint'},{userAgent:'Injected\r\nCookie:private'},
    {tsSign:'unsupported'},{clientCertificate:'pub.wrong'},{privateKeyPem:'PRIVATE_TEST_SECRET'},
    {capturedAt:0},{capturedAt:Infinity},
  ])('rejects invalid or mismatched binding without preserving input errors',patch=>{
    const material=syntheticDouyinSigningMaterial()
    try { validateDouyinSigningMaterial({...material,...patch}); throw new Error('Accepted invalid record') }
    catch(error) {
      expect(error).toMatchObject({code:'douyin-signing-material-invalid'})
      expect(String(error)).not.toContain('PRIVATE_TEST_SECRET')
    }
  })
})
