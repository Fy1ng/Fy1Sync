/** Main-process ticket protection, matching the inspected Douyin SecureSDK pubKey branch.
 * Source: https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/2722.06f25cc9.js
 * SHA256: bc8b0308a16f00ccf2a63cd07fd8c573350166186ad7ff75ae1f5de635d75f3d
 * Ticket authenticity and the trusted clock are provided by the owning login/resource services.
 */
import { createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, sign, type KeyObject } from 'node:crypto'
import { validateDouyinSigningMaterial, type DouyinSigningMaterial } from './signingMaterial'

export type DouyinTicketSigningErrorCode = 'douyin-ticket-signing-invalid' | 'douyin-ticket-signing-unsupported'
export class DouyinTicketSigningError extends Error {
  constructor(readonly code: DouyinTicketSigningErrorCode = 'douyin-ticket-signing-invalid') { super(code) }
}

function prepared(material: DouyinSigningMaterial): { material: DouyinSigningMaterial; privateKey: KeyObject; rawPublicKey: string } {
  try {
    if (!material || typeof material !== 'object') throw new DouyinTicketSigningError()
    if (material.aesSignSafari !== undefined
      || typeof material.tsSign === 'string' && !/^ts\.[12]/.test(material.tsSign)
      || typeof material.clientCertificate === 'string' && !material.clientCertificate.startsWith('pub.')
      || material.certificatePem !== undefined && material.certificatePem !== material.clientCertificate) {
      throw new DouyinTicketSigningError('douyin-ticket-signing-unsupported')
    }
    const valid = validateDouyinSigningMaterial(material)
    const privateKey = createPrivateKey(valid.privateKeyPem), jwk = createPublicKey(privateKey).export({ format:'jwk' })
    const rawPublicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64')
    return { material:valid, privateKey, rawPublicKey }
  } catch (error) {
    throw error instanceof DouyinTicketSigningError ? error : new DouyinTicketSigningError()
  }
}

function seconds(value: number): number {
  // Reject millisecond clocks and malformed samples; callers must obtain a trusted server sample.
  if (!Number.isSafeInteger(value) || value < 1_577_836_800 || value >= 4_102_444_800) throw new DouyinTicketSigningError()
  return value
}

function peerKey(raw: string): KeyObject {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('-----BEGIN PUBLIC KEY-----')) throw new DouyinTicketSigningError()
  const key = createPublicKey(raw)
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new DouyinTicketSigningError()
  return key
}

function hmac(privateKey: KeyObject, peerPublicKeyPem: string, raw: string): string {
  const shared = diffieHellman({ privateKey, publicKey:peerKey(peerPublicKeyPem) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32))
  try { return createHmac('sha256', key).update(raw, 'utf8').digest('base64') }
  finally { shared.fill(0); key.fill(0) }
}

const encoded = (value: Record<string,unknown>): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

/** Returns private headers only. The timestamp must come from DouyinSigningResources. */
export function signDouyinTicketHeaders(material: DouyinSigningMaterial, rawUrl: string, timestampSec: number,
  peerPublicKeyPem?: string): Record<string,string> {
  try {
    const input = prepared(material), timestamp = seconds(timestampSec)
    if (typeof rawUrl !== 'string' || rawUrl.length > 16_384) throw new DouyinTicketSigningError()
    const url = new URL(rawUrl)
    if (url.origin !== input.material.origin || url.username || url.password || url.hash) throw new DouyinTicketSigningError()
    // SecureSDK signs pathname as transmitted, including its trailing slash; query/body are handled separately.
    const raw = `ticket=${input.material.ticket}&path=${url.pathname}&timestamp=${timestamp}`
    const reqSign = peerPublicKeyPem === undefined
      ? sign('sha256', Buffer.from(raw, 'utf8'), { key:input.privateKey, dsaEncoding:'der' }).toString('base64')
      : hmac(input.privateKey, peerPublicKeyPem, raw)
    const payload = { ts_sign:input.material.tsSign, req_content:'ticket,path,timestamp', req_sign:reqSign, timestamp, t_trust:1 }
    return { 'bd-ticket-guard-ree-public-key':input.rawPublicKey,
      'bd-ticket-guard-web-version':input.material.tsSign.startsWith('ts.1') ? '1' : '2',
      'bd-ticket-guard-web-sign-type':peerPublicKeyPem === undefined ? '0' : '1',
      'bd-ticket-guard-version':'2', 'bd-ticket-guard-client-data':encoded(payload) }
  } catch (error) {
    throw error instanceof DouyinTicketSigningError ? error : new DouyinTicketSigningError()
  }
}

/** Returns one Cookie pair, never Set-Cookie attributes. SecureSDK PageGuard requires HMAC and a trusted clock. */
export function signDouyinPageGuard(material: DouyinSigningMaterial, timestampSec: number, peerPublicKeyPem: string): string {
  try {
    const input = prepared(material), timestamp = seconds(timestampSec), domain = new URL(input.material.origin).hostname
    const reqSign = hmac(input.privateKey, peerPublicKeyPem, `ticket=${input.material.ticket}&domain=${domain}&timestamp=${timestamp}`)
    const payload = { ts_sign:input.material.tsSign,
      web_version:input.material.tsSign.startsWith('ts.1') ? '1' : '2', ree_public_key:input.rawPublicKey,
      web_sign_type:'1', req_content:'ticket,domain,timestamp', req_sign:reqSign, timestamp, t_trust:1 }
    return `bd-web-sign-page-guard=${encodeURIComponent(encoded(payload))}`
  } catch (error) {
    throw error instanceof DouyinTicketSigningError ? error : new DouyinTicketSigningError()
  }
}
