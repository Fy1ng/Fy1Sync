import { createECDH, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, verify, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DOUYIN_USER_AGENT } from '../platforms/douyinDanmaku'
import type { DouyinSigningMaterial } from './signingMaterial'
import { DouyinTicketSigningError, signDouyinPageGuard, signDouyinTicketHeaders } from './ticketSigner'

function syntheticKey(scalar: number) {
  const bytes = Buffer.alloc(32); bytes[31] = scalar
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(bytes)
  const raw = ecdh.getPublicKey(undefined, 'uncompressed')
  const privateKey = createPrivateKey({ format:'jwk', key:{ kty:'EC',crv:'P-256',d:bytes.toString('base64url'),
    x:raw.subarray(1,33).toString('base64url'),y:raw.subarray(33).toString('base64url') } })
  return { privateKey, publicKey:createPublicKey(privateKey), rawPublic:raw.toString('base64') }
}
const client = syntheticKey(1), peer = syntheticKey(2), wrong = syntheticKey(3)
const timestamp = 1_800_000_000, url = 'https://live.douyin.com/webcast/room/chat/?content=synthetic-offline-only'
const material: DouyinSigningMaterial = { schemaVersion:1,origin:'https://live.douyin.com',aid:6383,scene:'web_protect',
  accountUid:'1',cookieFingerprint:'f'.repeat(64),userAgent:DOUYIN_USER_AGENT,
  privateKeyPem:client.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKeyPem:client.publicKey.export({format:'pem',type:'spki'}).toString(),
  ticket:'synthetic-ticket-node-local-only',tsSign:'ts.2.synthetic-server-proof-not-authenticated',clientCertificate:`pub.${client.rawPublic}`,capturedAt:1_794_400_000_000 }
const peerPem = peer.publicKey.export({format:'pem',type:'spki'}).toString()
const payload = (headers: Record<string,string>) => JSON.parse(Buffer.from(headers['bd-ticket-guard-client-data']!,'base64').toString('utf8')) as Record<string,unknown>
const cookiePayload = (cookie: string) => JSON.parse(Buffer.from(decodeURIComponent(cookie.slice(cookie.indexOf('=')+1)),'base64').toString('utf8')) as Record<string,unknown>

describe('Douyin main-process ticket signer', () => {
  it('emits a DER ECDSA signature verifiable independently for exact pathname and timestamp', () => {
    const headers = signDouyinTicketHeaders(material,url,timestamp), data = payload(headers)
    expect(headers).toMatchObject({ 'bd-ticket-guard-version':'2','bd-ticket-guard-web-version':'2','bd-ticket-guard-web-sign-type':'0',
      'bd-ticket-guard-ree-public-key':client.rawPublic })
    expect(data).toMatchObject({ts_sign:material.tsSign,req_content:'ticket,path,timestamp',timestamp,t_trust:1})
    const signature = Buffer.from(data.req_sign as string,'base64')
    expect(signature[0]).toBe(0x30)
    expect(verify('sha256',Buffer.from(`ticket=${material.ticket}&path=/webcast/room/chat/&timestamp=${timestamp}`),client.publicKey,signature)).toBe(true)
    expect(verify('sha256',Buffer.from(`ticket=${material.ticket}&path=/webcast/room/chat&timestamp=${timestamp}`),client.publicKey,signature)).toBe(false)
    expect(verify('sha256',Buffer.from(`ticket=${material.ticket}&path=/webcast/room/chat/&timestamp=${timestamp+1}`),client.publicKey,signature)).toBe(false)
  })
  it('matches the public synthetic HMAC request vector and is stable across calls', async () => {
    const headers = signDouyinTicketHeaders(material,url,timestamp,peerPem), data = payload(headers)
    const imported = await webcrypto.subtle.importKey('pkcs8',client.privateKey.export({format:'der',type:'pkcs8'}),{name:'ECDH',namedCurve:'P-256'},false,['deriveBits'])
    const importedPeer = await webcrypto.subtle.importKey('spki',peer.publicKey.export({format:'der',type:'spki'}),{name:'ECDH',namedCurve:'P-256'},false,[])
    const secret = Buffer.from(await webcrypto.subtle.deriveBits({name:'ECDH',public:importedPeer},imported,256))
    const derived = Buffer.from(hkdfSync('sha256',secret,Buffer.alloc(0),Buffer.alloc(0),32))
    const hmacKey = await webcrypto.subtle.importKey('raw',derived,{name:'HMAC',hash:'SHA-256'},false,['sign'])
    const expected = Buffer.from(await webcrypto.subtle.sign('HMAC',hmacKey,Buffer.from(`ticket=${material.ticket}&path=/webcast/room/chat/&timestamp=${timestamp}`))).toString('base64')
    expect(data.req_sign).toBe(expected)
    expect(headers['bd-ticket-guard-web-sign-type']).toBe('1')
    expect(signDouyinTicketHeaders(material,url,timestamp,peerPem)).toEqual(headers)
    expect(signDouyinTicketHeaders(material,url.replace('synthetic-offline-only','changed-query'),timestamp,peerPem)).toEqual(headers)
  })
  it('matches the PageGuard hostname HMAC and produces only a Cookie pair', () => {
    const cookie = signDouyinPageGuard(material,timestamp,peerPem), data = cookiePayload(cookie)
    const shared = diffieHellman({privateKey:client.privateKey,publicKey:peer.publicKey})
    const key = Buffer.from(hkdfSync('sha256',shared,Buffer.alloc(0),Buffer.alloc(0),32))
    expect(data).toMatchObject({ree_public_key:client.rawPublic,web_version:'2',web_sign_type:'1',req_content:'ticket,domain,timestamp',timestamp,t_trust:1})
    expect(data.req_sign).toBe(createHmac('sha256',key).update(`ticket=${material.ticket}&domain=live.douyin.com&timestamp=${timestamp}`).digest('base64'))
    expect(data.req_sign).not.toBe(payload(signDouyinTicketHeaders(material,url,timestamp,peerPem)).req_sign)
    expect(cookie).toMatch(/^bd-web-sign-page-guard=[A-Za-z0-9%]+$/)
    expect(cookie).not.toMatch(/;|Path=|SameSite=|Secure/)
  })
  it('uses the ts.1 pubKey header and PageGuard versions', () => {
    const value = {...material,tsSign:'ts.1.synthetic-server-proof'}
    expect(signDouyinTicketHeaders(value,url,timestamp,peerPem)['bd-ticket-guard-web-version']).toBe('1')
    expect(cookiePayload(signDouyinPageGuard(value,timestamp,peerPem)).web_version).toBe('1')
  })
  it.each([
    {...material,publicKeyPem:wrong.publicKey.export({format:'pem',type:'spki'}).toString()},
    {...material,clientCertificate:`pub.${wrong.rawPublic}`}, {...material,privateKeyPem:'synthetic-secret-private-key-invalid'},
  ])('rejects missing or mismatched keys without exposing material', value => {
    for (const work of [() => signDouyinTicketHeaders(value,url,timestamp), () => signDouyinPageGuard(value,timestamp,peerPem)]) {
      expect(work).toThrow(DouyinTicketSigningError)
      try { work() } catch(error) { expect((error as Error).message).toBe('douyin-ticket-signing-invalid'); expect(JSON.stringify(error)).not.toMatch(/synthetic|BEGIN|ticket-node/) }
    }
  })
  it.each([{...material,tsSign:'legacy-synthetic'}, {...material,clientCertificate:'legacy-synthetic-cert'},
    {...material,aesSignSafari:'synthetic-safari-proof'}, {...material,certificatePem:'-----BEGIN CERTIFICATE-----legacy'}])('explicitly rejects legacy certificate or Safari branches', value => {
    expect(() => signDouyinTicketHeaders(value,url,timestamp)).toThrow('douyin-ticket-signing-unsupported')
    expect(() => signDouyinPageGuard(value,timestamp,peerPem)).toThrow('douyin-ticket-signing-unsupported')
  })
  it.each([0,-1,NaN,1.5,timestamp*1000])('rejects non-server-second timestamps: %s', value => {
    expect(() => signDouyinTicketHeaders(material,url,value)).toThrow('douyin-ticket-signing-invalid')
    expect(() => signDouyinPageGuard(material,value,peerPem)).toThrow('douyin-ticket-signing-invalid')
  })
  it.each(['http://live.douyin.com/webcast/room/chat/', 'https://www.douyin.com/webcast/room/chat/',
    'https://live.douyin.com:444/webcast/room/chat/', 'https://user:pass@live.douyin.com/webcast/room/chat/',url+'#fragment'])('rejects a URL outside the captured origin: %s', value => {
    expect(() => signDouyinTicketHeaders(material,value,timestamp)).toThrow('douyin-ticket-signing-invalid')
  })
  it('never falls back to ECDSA or another key after a supplied invalid HMAC peer', () => {
    const rsa = generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'pem',type:'spki'}).toString()
    for (const peer of ['', 'synthetic-peer-invalid',rsa]) {
      expect(() => signDouyinTicketHeaders(material,url,timestamp,peer)).toThrow('douyin-ticket-signing-invalid')
      expect(() => signDouyinPageGuard(material,timestamp,peer)).toThrow('douyin-ticket-signing-invalid')
    }
  })
})
