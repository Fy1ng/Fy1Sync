/** Pure passport signing adapted from cv-cat/catbus (MIT).
 * Source: 48a27b9b62c41580cc61edfba767b1ff0a2cb8c3, web/sign.ts.
 * Copyright (c) 2026 cv-cat. See fixtures/catbus-LICENSE.txt and catbus-NOTICE.txt.
 * No browser, downloaded runtime or remote signer is executed.
 */
import { createHash, createHmac, randomInt } from 'node:crypto'
import profile from './fixtures/passport-dtrait-profile.json'

const APP_KEY = '163e7ce78d58971a41f5b969996d85c2'
const SALT = 'dhzx'
const EPOCH = 1721836800000
const UA_ALPHABET = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe'
const ALPHABET = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe'
const ORDER = [34,44,56,61,73,29,70,45,35,49,38,66,51,68,28,48,64,47,30,71,26,55,31,69,59,40,62,63,27,72,41,74,57,52,42,39,33,67,53,43,65,46,36,24,60,32,79,80,84,85]
const CHECK_FIELDS = [24,26,27,28,29,30,31,32,33,34,35,36,38,39,40,41,42,43,44,45,46,47,48,49,51,52,53,55,56,57,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,79,80,84,85]
const HOSTS: Record<string, { aid: number; page: number; minor: number; flags: readonly [number, number, number]; nrFlags?: number }> = {
  // Browser captures of the page-6241 / detect-14 SDK carry nr()[4] = 0x21.
  'login.douyin.com': { aid: 6383, page: 6241, minor: 14, flags: [0,0,0], nrFlags: 0x21 },
  'www.douyin.com': { aid: 6383, page: 11881, minor: 8, flags: [132,1,1] },
  'live.douyin.com': { aid: 6383, page: 7571, minor: 12, flags: [0,0,0] },
  'creator.douyin.com': { aid: 2906, page: 33638, minor: 12, flags: [0,0,0] },
}
const BROWSER_OFFSETS: Record<string, number> = { Chrome: 0, Firefox: 40, Safari: 81, Edge: 125, Huawei: 170 }

function browserName(ua: string): string {
  if (/\bhuawei\b/i.test(ua)) return 'Huawei'
  if (/(chrome)\/([\w.]+)(?!.*chromium)/i.test(ua)) return 'Chrome'
  if (/(edg|edge)\/([\w.]+)/i.test(ua)) return 'Edge'
  if (/\bfocus\/([\w.]+)|fxios\/([-\w.]+)|mobile vr; rv:([\w.]+)\).+firefox|(firefox)\/([\w.]+)/i.test(ua)) return 'Firefox'
  if (/(msie |trident.*rv:)([\w.]+)/i.test(ua)) return 'IE'
  if (/(opera|opr)\/([\w.]+)/i.test(ua)) return 'Opera'
  if (/(safari)\/([\w.]+)(?!.*chrome)/i.test(ua)) return 'Safari'
  return 'Other'
}

const rotate = (x: number, n: number) => ((x << (n & 31)) | (x >>> ((32 - n) & 31))) >>> 0
const p0 = (x: number) => (x ^ rotate(x, 9) ^ rotate(x, 17)) >>> 0
const p1 = (x: number) => (x ^ rotate(x, 15) ^ rotate(x, 23)) >>> 0

/** Portable SM3; Electron's crypto provider is not required to expose SM3. */
function sm3(value: string | Uint8Array): Uint8Array {
  const input = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  padded.set(input)
  padded[input.length] = 128
  const view = new DataView(padded.buffer)
  view.setBigUint64(padded.length - 8, BigInt(input.length) * 8n)
  let hash = [0x7380166f,0x4914b2b9,0x172442d7,0xda8a0600,0xa96f30bc,0x163138aa,0xe38dee4d,0xb0fb0e4e]
  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = new Uint32Array(68)
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 68; i++) w[i] = (p1(w[i - 16]! ^ w[i - 9]! ^ rotate(w[i - 3]!, 15)) ^ rotate(w[i - 13]!, 7) ^ w[i - 6]!) >>> 0
    let [a,b,c,d,e,f,g,h] = hash as [number,number,number,number,number,number,number,number]
    for (let i = 0; i < 64; i++) {
      const ss1 = rotate((rotate(a, 12) + e + rotate(i < 16 ? 0x79cc4519 : 0x7a879d8a, i)) >>> 0, 7)
      const ss2 = ss1 ^ rotate(a, 12)
      const ff = i < 16 ? a ^ b ^ c : (a & b) | (a & c) | (b & c)
      const gg = i < 16 ? e ^ f ^ g : (e & f) | (~e & g)
      const tt1 = ((ff >>> 0) + d + ss2 + ((w[i]! ^ w[i + 4]!) >>> 0)) >>> 0
      const tt2 = ((gg >>> 0) + h + ss1 + w[i]!) >>> 0
      d = c; c = rotate(b, 9); b = a; a = tt1
      h = g; g = rotate(f, 19); f = e; e = p0(tt2)
    }
    hash = [a,b,c,d,e,f,g,h].map((x, i) => (x ^ hash[i]!) >>> 0)
  }
  const result = new Uint8Array(32), output = new DataView(result.buffer)
  hash.forEach((x, i) => output.setUint32(i * 4, x))
  return result
}

function base64(data: number[] | Uint8Array, alphabet: string): string {
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  return Buffer.from(data).toString('base64').replace(/[A-Za-z0-9+/]/g, ch => alphabet[standard.indexOf(ch)]!)
}

function rc4(key: number[], data: number[] | Uint8Array): number[] {
  const state = Array.from({ length: 256 }, (_, i) => 255 - i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j * state[i]! + j + key[i % key.length]!) % 256
    ;[state[i],state[j]] = [state[j]!,state[i]!]
  }
  let i = 0
  j = 0
  return Array.from(data, byte => {
    i = (i + 1) % 256; j = (j + state[i]!) % 256
    ;[state[i],state[j]] = [state[j]!,state[i]!]
    return byte ^ state[(state[i]! + state[j]!) % 256]!
  })
}

const le = (value: number, count: number) => Array.from({ length: count }, (_, i) => Math.floor(value / 2 ** (8 * i)) & 255)
const blend = (c0: number, c1: number, r0: number, r1: number) => [(r0 & 170) | (c0 & 85), (r0 & 85) | (c0 & 170), (r1 & 170) | (c1 & 85), (r1 & 85) | (c1 & 170)]

function expand(data: number[], random: () => number): number[] {
  const out: number[] = []
  for (let i = 0; i < data.length; i += 3) {
    if (i + 2 < data.length) {
      const r = Math.floor(random() * 1000) & 255
      out.push((r & 145) | (data[i]! & 110), (r & 66) | (data[i + 1]! & 189), (r & 44) | (data[i + 2]! & 211))
      out.push((data[i]! & 145) | (data[i + 1]! & 66) | (data[i + 2]! & 44))
    } else {
      out.push(data[i]!)
      if (i + 1 < data.length && data[i + 1]) out.push(data[i + 1]!)
    }
  }
  return out
}

function escapeDigest(digest: Uint8Array, index: number, reserved: number, fallback: number): number {
  while (digest[index] === reserved) index++
  return digest[index] ?? fallback
}

/** Sign exact wire query/body strings with the modern host-specific dhzx format. */
export function signDouyinPassportQuery(query: string, body: string, userAgent: string, host: string, entropy?: { now: () => number; random: () => number }): string {
  if (typeof query !== 'string' || query.length > 16_384 || /[^\x21-\x7e]/.test(query) || /(?:^|&)a_bogus=/.test(query)
    || typeof body !== 'string' || body.length > 65_536 || typeof userAgent !== 'string' || !userAgent || userAgent.length > 512 || /[^\x20-\x7e]/.test(userAgent)
    || !Object.hasOwn(HOSTS, host)) throw new Error('抖音登录签名参数无效')
  const t = entropy?.now() ?? Date.now()
  if (!Number.isSafeInteger(t) || t < EPOCH || t >= 2 ** 48) throw new Error('抖音登录签名时间无效')
  const random = () => {
    const value = entropy?.random() ?? Math.random()
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('抖音登录签名随机参数无效')
    return value
  }
  const cfg = HOSTS[host]!, name = browserName(userAgent)
  const digest = (value: string) => sm3(sm3(value + SALT))
  const h1 = digest(query), h2 = digest(body)
  const hUa = sm3(base64(rc4([0,1,cfg.minor], Array.from(userAgent.trim(), c => c.charCodeAt(0))), UA_ALPHABET))
  const flags = cfg.nrFlags ?? (1 | (Number(name === 'Firefox') << 5))
  // This stateless entry point represents a new request in call bucket 6.
  const fields: Record<number, number> = {
    24:41,26:Math.trunc((t - EPOCH) / 1000 / 60 / 60 / 24 / 14),27:6,28:3,
    35:1,36:0,38:flags,39:0,40:cfg.flags[0],41:cfg.flags[1],42:cfg.flags[2],43:0,
    48:h1[9]!,49:h1[18]!,51:escapeDigest(h1,3,11,12),52:h2[10]!,53:h2[19]!,55:escapeDigest(h2,4,8,9),
    56:hUa[11]!,57:hUa[21]!,59:escapeDigest(hUa,5,12,13),66:3,
  }
  for (const [start,value,count] of [[29,t,6],[44,cfg.minor,4],[60,t - 1,6],[67,cfg.page,4],[71,cfg.aid,4]] as const) le(value,count).forEach((byte, i) => { fields[start + i] = byte })
  const geometry = Array.from(Buffer.from([profile.screen_width,1215,profile.screen_width,profile.avail_height,profile.avail_width,profile.avail_height,profile.screen_width,profile.screen_height,profile.platform].join('|')))
  const tail = Array.from(Buffer.from(`${(t + 3) & 255},`))
  fields[79] = geometry.length & 255; fields[80] = (geometry.length >> 8) & 255
  fields[84] = tail.length & 255; fields[85] = (tail.length >> 8) & 255
  const v6 = random() * 65535
  const version = blend(1,0,Math.trunc(v6) & 255,(Math.trunc(v6) >> 8) & 255)
  random()
  const r = Math.floor(random() * 240)
  const check = r > 109 ? r + (r % 2) + 1 : r
  const permission = (Math.floor(random() * 255) & 77) | 2 | 16 | 32 | 128
  version.push(...blend(1,0,check,permission))
  const checksum = [...version,...CHECK_FIELDS.map(id => fields[id]!)].reduce((sum,byte) => sum ^ byte,0)
  const data = [...ORDER.map(id => fields[id]!),...geometry,...tail,checksum]
  const hr0 = Math.floor(random() * 65535) & 255
  const offset = Math.floor(random() * 40) + (BROWSER_OFFSETS[name] ?? 210)
  const header = blend(3,82,hr0,offset)
  return base64([...header,...rc4([211],[...version,...expand(data,random)])],ALPHABET)
}

/** Reproduce the SDK's uppercase UUID-variant alphabet; retain one value per session. */
export function generateDouyinVerifyFp(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('抖音设备标识时间无效')
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const chars = new Array<string>(36)
  for (const index of [8,13,18,23]) chars[index] = '_'
  chars[14] = '4'
  for (let i = 0; i < chars.length; i++) if (!chars[i]) {
    const random = randomInt(alphabet.length)
    chars[i] = alphabet[i === 19 ? (random & 3) | 8 : random]!
  }
  return `verify_${now.toString(36)}_${chars.join('')}`
}

/** The public SDK encodes BMP code units and skips surrogate code units before XOR 5. */
export function encodeDouyinPassport(value: string): string {
  if (typeof value !== 'string' || value.length > 65_536) throw new Error('抖音登录编码参数无效')
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c <= 127) bytes.push(c)
    else if (c <= 2047) bytes.push(192 | (c >> 6),128 | (c & 63))
    else if (c < 0xd800 || c >= 0xe000) bytes.push(224 | (c >> 12),128 | ((c >> 6) & 63),128 | (c & 63))
  }
  return bytes.map(byte => (byte ^ 5).toString(16)).join('')
}

function entries(value: Record<string,string>): [string,string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('抖音登录参数无效')
  const result = Object.entries(value)
  if (result.length > 256 || result.some(([key,val]) => key.length > 256 || typeof val !== 'string' || val.length > 65_536)) throw new Error('抖音登录参数无效')
  return result
}

const EXCLUDED = new Set(['sign','qs','msToken','a_bogus'])

/** Sort unencoded field values, take the first ten query keys, then hash with body. */
export function signDouyinPassportParams(query: Record<string,string>, body: Record<string,string>, appKey = APP_KEY): { sign: string; qs: string } {
  if (typeof appKey !== 'string' || !appKey || appKey.length > 256) throw new Error('抖音登录应用参数无效')
  const q = entries(query).filter(([key]) => !EXCLUDED.has(key)).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).slice(0,10)
  const b = entries(body).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
  const join = (pairs: [string,string][]) => pairs.map(([key,value]) => `${key}=${value}`).join('&')
  return { sign:createHash('sha256').update(`${join(q)}&${join(b)}&app_key=${appKey}`).digest('hex'),qs:encodeDouyinPassport(q.map(([key]) => key).join(',')) }
}

/** HKDF-SHA256 with UTC noon as salt, followed by the SDK's aid/path/ts HMAC. */
export function douyinPassportAidSignature(path: string, aid: number, appKey: string, now = Date.now()): { header: string; ts: string } {
  if (typeof path !== 'string' || !/^\/(?!\/)[^?#\s]*$/.test(path) || path.length > 1024 || !Number.isSafeInteger(aid) || aid <= 0
    || typeof appKey !== 'string' || !appKey || appKey.length > 256 || !Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) throw new Error('抖音登录应用签名参数无效')
  const date = new Date(now)
  const ts = String(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),12) / 1000)
  const prk = createHmac('sha256',ts).update(appKey).digest()
  const key = createHmac('sha256',prk).update(Buffer.from([1])).digest()
  try { return { header:createHmac('sha256',key).update(`aid=${aid}&path=${path}&ts=${ts}`).digest('hex'),ts } }
  finally { prk.fill(0); key.fill(0) }
}
