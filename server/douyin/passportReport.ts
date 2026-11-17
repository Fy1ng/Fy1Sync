/** Anonymous device reports adapted from cv-cat/catbus (MIT), commit 48a27b9b62c41580cc61edfba767b1ff0a2cb8c3.
 * Copyright (c) 2026 cv-cat. See fixtures/catbus-LICENSE.txt and catbus-NOTICE.txt.
 * Only public historical device fields are used; no browser storage or account inputs are read.
 */
import { randomInt, randomUUID } from 'node:crypto'
import initialProfile from './fixtures/passport-mstoken-profile.json'
import commonProfile from './fixtures/passport-mstoken-common-profile.json'
import browserProfile from './fixtures/passport-dtrait-profile.json'

const ALPHABET = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe'
type Fields = Record<string, any>
export interface DouyinPassportReportOptions { userAgent: string; now?: number; nonce?: number; uuid?: string }

/** The report codec uses standard RC4, distinct from the A-Bogus RC4 variant. */
export function encodeDouyinPassportReport(plaintext: string, nonce: number): string {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 255 || Buffer.byteLength(plaintext) > 65536) throw new TypeError('Invalid anonymous report')
  const s = Uint8Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) { j = (j + s[i]! + nonce) & 255; [s[i], s[j]] = [s[j]!, s[i]!] }
  const bytes = Buffer.from(plaintext, 'utf8'), cipher = Buffer.alloc(bytes.length + 2)
  cipher[0] = 0x41; cipher[1] = nonce
  let i = 0; j = 0
  for (let at = 0; at < bytes.length; at++) {
    i = (i + 1) & 255; j = (j + s[i]!) & 255; [s[i], s[j]] = [s[j]!, s[i]!]
    cipher[at + 2] = bytes[at]! ^ s[(s[i]! + s[j]!) & 255]!
  }
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  return cipher.toString('base64').replace(/[A-Za-z0-9+/]/g, char => ALPHABET[standard.indexOf(char)]!)
}

export function createDouyinPassportReport(kind: 'initial' | 'sms', options: DouyinPassportReportOptions): string {
  const now = options.now ?? Date.now(), nonce = options.nonce ?? randomInt(256), uuid = options.uuid ?? randomUUID()
  if (!Number.isSafeInteger(now) || now < 0 || options.userAgent.length > 512 || /[\x00-\x1f\x7f]/.test(options.userAgent)
    || !/^[a-f0-9-]{36}$/i.test(uuid)) throw new TypeError('Invalid anonymous report context')
  const sms = kind === 'sms'
  const p: Fields = structuredClone(sms ? commonProfile : initialProfile), n: Fields = p.nWID
  const width = browserProfile.screen_width, height = browserProfile.screen_height
  const availWidth = browserProfile.avail_width, availHeight = browserProfile.avail_height
  const cpu = browserProfile.hardware_concurrency, agent = options.userAgent
  const vendor = n.webgl.vendor, renderer = n.webgl.renderer
  Object.assign(n.screen, { height, width, availHeight, availWidth, availTop: 0, availLeft: 0 })
  Object.assign(n.navigator, { userAgent: agent, hardwareConcurrency: cpu })
  n.audio.audioContext.state = 'running'
  const msVersion = n.ms_version ?? '0.0.0.1'
  delete n.ms_version
  if (sms) {
    p.ubCode = 12; n.ubCode = 12; n.canvas.crc32 = 'A7996F6A'
    const custom: Fields = typeof n.custom === 'string' ? JSON.parse(n.custom) : { ...n.custom }
    custom.version ??= msVersion; custom.fxgDid ??= ''; custom.uuid = uuid; custom.collectTime = 23.799999952316284
    n.custom = JSON.stringify(custom)
    Object.assign(p.wID, { msgType: 1, timestamp: String(now), aid: 6383, pageId: 6241, nap: '11311144242322244122' })
    Object.assign(p.navigator, { appVersion: agent.replace(/^Mozilla\//, ''), deviceMemory: String(browserProfile.device_memory), hardwareConcurrency: cpu })
    Object.assign(p.webgl, { vendor, renderer })
    Object.assign(p.screen, { innerWidth: width, innerHeight: 1215, outerWidth: width, outerHeight: availHeight,
      screenX: 0, screenY: 0, availWidth, availHeight, sizeWidth: width, sizeHeight: height, clientWidth: width, clientHeight: 1215 })
  } else n.custom = JSON.stringify({ version: msVersion, fxgDid: '', uuid, collectTime: 23.799999952316284, aid: 6383, pageId: 6241 })
  n.ms_version = msVersion
  const plaintext = JSON.stringify(sms ? p : { nWID: n, wID: p.wID })
  return JSON.stringify({ magic: 538969122, version: 1, dataType: 8, strData: encodeDouyinPassportReport(plaintext, nonce),
    tspFromClient: now + (sms ? 11 : 0), ulr: 0 })
}
