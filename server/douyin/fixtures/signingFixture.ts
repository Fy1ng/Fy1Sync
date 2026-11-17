/** Public synthetic key material for offline protocol and login fixtures only. */
import { createECDH, createPrivateKey, createPublicKey } from 'node:crypto'
import { douyinCookieFingerprint, validateDouyinSigningMaterial, type DouyinSigningMaterial } from '../signingMaterial'
import { DOUYIN_USER_AGENT } from '../../platforms/douyinDanmaku'

export function syntheticDouyinSigningMaterial(header='sessionid=synthetic-embedded-session', userAgent=DOUYIN_USER_AGENT,
  accountUid='12345'): DouyinSigningMaterial {
  const bytes=Buffer.alloc(32); bytes[31]=1
  const ec=createECDH('prime256v1'); ec.setPrivateKey(bytes)
  const point=ec.getPublicKey(undefined,'uncompressed')
  const key=createPrivateKey({format:'jwk',key:{kty:'EC',crv:'P-256',d:bytes.toString('base64url'),
    x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url')}})
  return validateDouyinSigningMaterial({schemaVersion:1,origin:'https://live.douyin.com',aid:6383,scene:'web_protect',
    accountUid,cookieFingerprint:douyinCookieFingerprint(header),userAgent,
    privateKeyPem:key.export({format:'pem',type:'pkcs8'}).toString(),
    publicKeyPem:createPublicKey(key).export({format:'pem',type:'spki'}).toString(),
    ticket:'synthetic-ticket-node-local-only',tsSign:'ts.2.synthetic-server-proof-not-authenticated',
    clientCertificate:`pub.${point.toString('base64')}`,capturedAt:Date.now()})
}

export function syntheticDouyinSdkStorage(userAgent=DOUYIN_USER_AGENT): Record<string,string> {
  const material=syntheticDouyinSigningMaterial(undefined,userAgent)
  return {
    'security-sdk/s_sdk_crypt_sdk':JSON.stringify({data:JSON.stringify({ec_privateKey:material.privateKeyPem,ec_publicKey:material.publicKeyPem})}),
    'security-sdk/s_sdk_sign_data_key/web_protect':JSON.stringify({data:JSON.stringify({ticket:material.ticket,ts_sign:material.tsSign,client_cert:material.clientCertificate})}),
    'security-sdk/s_sdk_cert_key':JSON.stringify({data:material.clientCertificate}),
  }
}
