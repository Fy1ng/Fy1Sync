/** Private main-process signing records. None of these fields belong in renderer contracts. */
import { createHash, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto'
import { douyinBrowserUserAgent } from './httpContext'

export const DOUYIN_SIGNING_ORIGIN = 'https://live.douyin.com' as const
export const DOUYIN_SIGNING_AID = 6383 as const
export const DOUYIN_SIGNING_SCENE = 'web_protect' as const

export interface DouyinSigningCaptureContext {
  accountUid: string
  cookieFingerprint: string
  userAgent: string
}

export interface DouyinSigningSnapshot extends DouyinSigningCaptureContext {
  origin: typeof DOUYIN_SIGNING_ORIGIN
  cryptData: string
  serverData: string
  certificate?: string
}

export interface DouyinSigningMaterial extends DouyinSigningCaptureContext {
  schemaVersion: 1
  origin: typeof DOUYIN_SIGNING_ORIGIN
  aid: typeof DOUYIN_SIGNING_AID
  scene: typeof DOUYIN_SIGNING_SCENE
  privateKeyPem: string
  publicKeyPem: string
  ticket: string
  tsSign: string
  clientCertificate: string
  certificatePem?: string
  aesSignSafari?: string
  capturedAt: number
}

export interface DouyinSigningLookup {
  cookieFingerprint: string
  accountUid?: string
}

export class DouyinSigningMaterialError extends Error {
  readonly code = 'douyin-signing-material-invalid'
  constructor() { super('抖音发送签名材料缺失或不匹配.') }
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value)
const uid = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
  && BigInt(value) <= 0xffff_ffff_ffff_ffffn
const record = (value: unknown): Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {}

/** Bind the exact authentication selection, while never persisting its cleartext values twice. */
export function douyinCookieFingerprint(header: string): string {
  if (typeof header!=='string' || header.length>32768 || /[\x00-\x1f\x7f]/.test(header)) throw new DouyinSigningMaterialError()
  const values = new Map<string,string>()
  for (const part of header.split(';')) {
    const matched=/^\s*(sessionid|sessionid_ss)=([^;\s]+)\s*$/.exec(part)
    if (!matched) continue
    if (values.has(matched[1]!)) throw new DouyinSigningMaterialError()
    values.set(matched[1]!,matched[2]!)
  }
  if (!values.get('sessionid') && !values.get('sessionid_ss')) throw new DouyinSigningMaterialError()
  return createHash('sha256').update(JSON.stringify([values.get('sessionid')||'',values.get('sessionid_ss')||''])).digest('hex')
}

/** Validate cryptographic binding before a record is saved or used for an HTTP signature. */
export function validateDouyinSigningMaterial(value: unknown): DouyinSigningMaterial {
  try {
    const data=record(value)
    if (data.schemaVersion!==1 || data.origin!==DOUYIN_SIGNING_ORIGIN || data.aid!==DOUYIN_SIGNING_AID
      || data.scene!==DOUYIN_SIGNING_SCENE || !uid(data.accountUid) || typeof data.cookieFingerprint!=='string'
      || !/^[a-f0-9]{64}$/.test(data.cookieFingerprint) || !text(data.userAgent,512)
      || douyinBrowserUserAgent(data.userAgent)!==data.userAgent
      || !text(data.ticket,4096) || !text(data.tsSign,8192) || !/^ts\.[12]/.test(data.tsSign)
      || !text(data.clientCertificate,8192) || typeof data.privateKeyPem!=='string' || data.privateKeyPem.length>8192
      || typeof data.publicKeyPem!=='string' || data.publicKeyPem.length>4096
      || !Number.isSafeInteger(data.capturedAt) || (data.capturedAt as number)<=0
      || data.certificatePem!==undefined && (typeof data.certificatePem!=='string' || data.certificatePem.length>16384)
      || data.aesSignSafari!==undefined && !text(data.aesSignSafari,8192)) throw new DouyinSigningMaterialError()
    const privateKey=createPrivateKey(data.privateKeyPem), supplied=createPublicKey(data.publicKeyPem)
    if (privateKey.asymmetricKeyType!=='ec' || privateKey.asymmetricKeyDetails?.namedCurve!=='prime256v1'
      || supplied.asymmetricKeyType!=='ec' || supplied.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new DouyinSigningMaterialError()
    const derived=createPublicKey(privateKey), a=derived.export({format:'der',type:'spki'}), b=supplied.export({format:'der',type:'spki'})
    if (a.length!==b.length || !timingSafeEqual(a,b)) throw new DouyinSigningMaterialError()
    const publicJwk=derived.export({format:'jwk'})
    const raw=Buffer.concat([Buffer.from([4]),Buffer.from(publicJwk.x!,'base64url'),Buffer.from(publicJwk.y!,'base64url')]).toString('base64')
    if (data.clientCertificate!==`pub.${raw}`) throw new DouyinSigningMaterialError()
    // Normalize and allow only the private record schema, not arbitrary SDK or page objects.
    return {
      schemaVersion:1,origin:DOUYIN_SIGNING_ORIGIN,aid:DOUYIN_SIGNING_AID,scene:DOUYIN_SIGNING_SCENE,
      accountUid:data.accountUid,cookieFingerprint:data.cookieFingerprint,userAgent:data.userAgent,
      privateKeyPem:privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKeyPem:derived.export({format:'pem',type:'spki'}).toString(),
      ticket:data.ticket,tsSign:data.tsSign,clientCertificate:data.clientCertificate,capturedAt:data.capturedAt as number,
      ...(data.certificatePem===undefined ? {} : {certificatePem:data.certificatePem as string}),
      ...(data.aesSignSafari===undefined ? {} : {aesSignSafari:data.aesSignSafari as string}),
    }
  } catch { throw new DouyinSigningMaterialError() }
}

export function parseDouyinSigningSnapshot(snapshot: DouyinSigningSnapshot, capturedAt=Date.now()): DouyinSigningMaterial {
  try {
    if (typeof snapshot.cryptData!=='string' || snapshot.cryptData.length>32768
      || typeof snapshot.serverData!=='string' || snapshot.serverData.length>32768) throw new DouyinSigningMaterialError()
    const crypt=record(JSON.parse(snapshot.cryptData)), server=record(JSON.parse(snapshot.serverData))
    const privatePem=crypt.ec_privateKey ?? server.private_key
    const privateKey=createPrivateKey(String(privatePem ?? ''))
    const publicPem=typeof crypt.ec_publicKey==='string' ? crypt.ec_publicKey : createPublicKey(privateKey).export({format:'pem',type:'spki'}).toString()
    return validateDouyinSigningMaterial({
      schemaVersion:1,origin:snapshot.origin,aid:DOUYIN_SIGNING_AID,scene:DOUYIN_SIGNING_SCENE,
      accountUid:snapshot.accountUid,cookieFingerprint:snapshot.cookieFingerprint,userAgent:snapshot.userAgent,
      privateKeyPem:privatePem,publicKeyPem:publicPem,ticket:server.ticket,tsSign:server.ts_sign,
      clientCertificate:server.client_cert,capturedAt,
      ...(snapshot.certificate ? {certificatePem:snapshot.certificate} : {}),
      ...(server.aes_sign_safari ? {aesSignSafari:server.aes_sign_safari} : {}),
    })
  } catch { throw new DouyinSigningMaterialError() }
}
