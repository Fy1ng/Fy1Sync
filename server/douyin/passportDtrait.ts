/** Pure dtrait generation adapted from cv-cat/catbus (MIT).
 * Source: 48a27b9b62c41580cc61edfba767b1ff0a2cb8c3, web/dtrait.ts and web/crypto.ts.
 * Copyright (c) 2026 cv-cat. See fixtures/catbus-LICENSE.txt and catbus-NOTICE.txt.
 * Historical rendering hashes are a public upstream profile, not local device measurements.
 */
import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto'
import profile from './fixtures/passport-dtrait-profile.json'

const PUBLIC_KEY = Buffer.from(
  'LS0tLS1CRUdJTiBSU0EgUFVCTElDIEtFWS0tLS0tCk1JSUJDZ0tDQVFFQTQrZHZ2WTd1TStvcGMrbkxHL0R1bVNlRm83YVZjSW0xTE8rbVVJcldwclJ6UDBhMUdwRVEKNHF0TzlN' +
  'UmYvbHdFSXgzOCs0Qlo0WE9HemV2VnR1VXZmSU9VRTdBVHRRVzdGS0pmNVBuU0xDSTYvazB2bDFGQwpMVVNWbUVQNnFQSnJJalo0elhvcWkzeXVOWisxb2RiUkEvL0dIZ2NnU3l5' +
  'eWFMcXp3amtwV0dYb3VNWW12WXNTCnBway9mdjJFV0FCc3RQTnhXYTRFT0JDYWRUVVBrWE5RNzZOQkVQOXh6ZkpTMjB3aUR2MW9TL3ZLdnJTVXBXY0oKbmF6a2tCdnFRYmJBcVZi' +
  'UUZURi9EUGlrcHB1NlpUNmxHSVh2SktDcmVlRmlIQTJxSzZ0UzE4U1dWSFc5QVJ6MQorcGpCMWVxSUlZdG9oV3BUMkI0ME9DNE84dFZlQkFuYmlRSURBUUFCCi0tLS0tRU5EIFJT' +
  'QSBQVUJMSUMgS0VZLS0tLS0=',
  'base64',
).toString('ascii')

/** MurmurHash3 x86 32-bit hashes the exact UTF-8 feature string. */
function murmur3(value: string): number {
  const data = Buffer.from(value,'utf8')
  const c1 = 0xcc9e2d51, c2 = 0x1b873593
  let h = 0
  const n = data.length & ~3
  for (let i = 0; i < n; i += 4) {
    let k = Math.imul(data.readUInt32LE(i),c1)
    k = (k << 15) | (k >>> 17)
    h ^= Math.imul(k,c2)
    h = (h << 13) | (h >>> 19)
    h = (Math.imul(h,5) + 0xe6546b64) | 0
  }
  if (n < data.length) {
    let k = 0
    for (let i = n; i < data.length; i++) k |= data[i]! << (8 * (i - n))
    k = Math.imul(k,c1)
    k = (k << 15) | (k >>> 17)
    h ^= Math.imul(k,c2)
  }
  h ^= data.length
  h ^= h >>> 16; h = Math.imul(h,0x85ebca6b)
  h ^= h >>> 13; h = Math.imul(h,0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

function buildBlob(userAgent: string): string {
  // Keep historical Chrome/V8 math values instead of depending on Node's libm.
  const p = profile
  const features: Record<number,string> = {
    11:'-1.4214488238747245,0.5493061443340549,0.5493061443340549,-0.8390715290095377',
    12:'1.7182818284590453,1.9275814160560206e-50,0.8178819121159085,-1.4214488238747245',
    14:`${p.downlink},${p.effective_type}`,
    15:`${p.language},${p.languages.join(',')}`,
    16:`${p.str16_list.join(',')},${p.vendor}`,
    17:`${p.platform},${p.str17_tail}`,
    18:p.str18_list.join(','),
    19:userAgent,
    27:`${p.locale}+${p.timezone}`,
    28:p.notification_permission,
    29:`${p.str29_head},${p.device_memory},${p.hardware_concurrency},${p.max_touch_points}`,
    30:`${p.avail_height},${p.avail_left},${p.avail_top},${p.avail_width}`,
    31:`${p.screen_height},${p.screen_width}`,
    32:`${p.color_depth},${p.pixel_depth},${p.device_pixel_ratio}`,
  }
  const values = new Map(Object.entries(p.render_hashes).map(([key,value]) => [Number(key),value]))
  for (const [index,value] of Object.entries(features)) values.set(Number(index),murmur3(value))
  const bools = Object.entries(p.bools).map(([key,value]) => [Number(key),value] as const)
  const bitmap = Buffer.alloc((Math.floor(Math.max(...bools.map(([index]) => index)) / 32) + 1) * 5)
  for (const [index,value] of bools) {
    if (index % 32 === 0) bitmap[index / 32] = index / 8
    if (value) {
      const at = 5 * (Math.floor(index / 32) + 1) - Math.floor((index % 32) / 8) - 1
      bitmap[at] = bitmap[at]! | (1 << (index % 8))
    }
  }
  const strings = Buffer.alloc(34 * 5)
  for (let index = 1; index <= 34; index++) {
    const value = values.get(index)
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('抖音设备档案无效')
    strings[(index - 1) * 5] = index <= 33 ? 31 + index : 71
    strings.writeUInt32BE(value,(index - 1) * 5 + 1)
  }
  const head = ((p.reserved & 3) << 6) | ((p.dtrait_type & 1) << 5) | (p.version & 15)
  return Buffer.concat([Buffer.from([head]),bitmap,strings]).toString('base64')
}

/** One anonymous passport session; no AES key or private state is exposed to renderers. */
export class DouyinPassportDtrait {
  readonly userAgent: string
  #now: () => number
  #key: Buffer
  #encryptedKey: Buffer
  #blob: string
  #disposed = false

  constructor(options: { userAgent?: string; now?: () => number } = {}) {
    const ua = options.userAgent ?? profile.ua
    if (typeof ua !== 'string' || !ua || ua.length > 512 || /[^\x20-\x7e]/.test(ua)) throw new Error('抖音设备档案参数无效')
    this.userAgent = ua
    this.#now = options.now ?? Date.now
    this.#blob = buildBlob(ua)
    this.#key = randomBytes(16)
    const keyText = Buffer.from(this.#key.toString('hex'),'ascii')
    try { this.#encryptedKey = publicEncrypt({ key:PUBLIC_KEY,padding:constants.RSA_PKCS1_PADDING },keyText) }
    catch { this.#key.fill(0); throw new Error('抖音设备保护初始化失败') }
    finally { keyText.fill(0) }
  }

  /** The public key is d0; each request gets a fresh IV and pathname-bound payload. */
  header(pathname: string): string {
    if (this.#disposed) throw new Error('抖音设备保护会话已释放')
    if (typeof pathname !== 'string' || !/^\/(?!\/)[^?#\s]*$/.test(pathname) || pathname.length > 1024 || /[\x00-\x1f\x7f]/.test(pathname)) throw new Error('抖音设备保护路径无效')
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) throw new Error('抖音设备保护时间无效')
    const iv = randomBytes(16)
    const payload = JSON.stringify({ dtrait:this.#blob,timestamp:Math.floor(now / 1000),sdkVersion:'1.0.0.16',path:pathname })
    try {
      const cipher = createCipheriv('aes-128-cbc',this.#key,iv)
      const encrypted = Buffer.concat([cipher.update(payload,'utf8'),cipher.final()])
      return `d0_${this.#encryptedKey.toString('base64')}_${Buffer.concat([iv,encrypted]).toString('base64')}`
    } catch { throw new Error('抖音设备保护生成失败') }
    finally { iv.fill(0) }
  }

  dispose(): void {
    this.#disposed = true
    this.#key.fill(0)
    this.#encryptedKey.fill(0)
    this.#blob = ''
    this.#now = () => 0
  }
}
