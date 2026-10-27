/** Minimal Huya TarsV3 codec. Protocol reference: biliup/biliup (MIT).
 * Copyright (c) 2019 ForgQi. License and pinned golden source: fixtures/huya-README.md.
 */

const MAX_PACKET = 65_536
const MAX_STRING = 16_384
const invalid = () => new Error('Invalid Huya WUP packet')

export class HuyaTarsWriter {
  private parts: Buffer[] = []
  head(tag: number, type: number) { this.parts.push(Buffer.from(tag < 15 ? [(tag << 4) | type] : [0xf0 | type, tag])) }
  int(tag: number, value: number) {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw invalid()
    if (value === 0) { this.head(tag, 12); return }
    const size = value >= -128 && value <= 127 ? 1 : value >= -32768 && value <= 32767 ? 2 : 4
    this.head(tag, size === 1 ? 0 : size === 2 ? 1 : 2)
    const bytes = Buffer.alloc(size)
    bytes.writeIntBE(value, 0, size)
    this.parts.push(bytes)
  }
  int64(tag: number, value: bigint) {
    if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) throw invalid()
    if (value >= -2147483648n && value <= 2147483647n) { this.int(tag, Number(value)); return }
    this.head(tag, 3)
    const bytes = Buffer.alloc(8)
    bytes.writeBigInt64BE(value)
    this.parts.push(bytes)
  }
  string(tag: number, value: string) {
    const bytes = Buffer.from(value)
    if (bytes.length > MAX_STRING) throw invalid()
    this.head(tag, bytes.length <= 255 ? 6 : 7)
    const size = Buffer.alloc(bytes.length <= 255 ? 1 : 4)
    size.writeUIntBE(bytes.length, 0, size.length)
    this.parts.push(size, bytes)
  }
  bytes(tag: number, bytes: Uint8Array) {
    if (bytes.length > 1_048_576) throw invalid()
    this.head(tag, 13)
    this.head(0, 0)
    this.int(0, bytes.length)
    this.parts.push(Buffer.from(bytes))
  }
  finish() { return Buffer.concat(this.parts) }
}

const Writer = HuyaTarsWriter

/** Anonymous HUYA.UserId only; no login token, cookie or device identity is sent. */
export function encodeHuyaTokenRequest(streamName: string, huyaUA = 'pc_exe&7000000&official'): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(streamName) || !/^[A-Za-z0-9&._-]{1,128}$/.test(huyaUA)) throw invalid()
  const req = new Writer()
  req.head(0, 10)
  req.string(0, '')
  req.string(1, streamName)
  req.int(2, 0)
  req.head(3, 10)
  req.int(0, 0)
  req.string(1, '')
  req.string(2, '')
  req.string(3, huyaUA)
  req.string(4, '')
  req.int(5, 0)
  req.string(6, '')
  req.string(7, '')
  req.head(0, 11)
  req.int(4, 66)
  req.head(0, 11)
  const payload = new Writer()
  payload.head(0, 8)
  payload.int(0, 1)
  payload.string(0, 'tReq')
  payload.bytes(1, req.finish())
  const packet = new Writer()
  packet.int(1, 3)
  packet.int(2, 0)
  packet.int(3, 0)
  packet.int(4, 1)
  packet.string(5, 'liveui')
  packet.string(6, 'getCdnTokenInfoEx')
  packet.bytes(7, payload.finish())
  packet.int(8, 0)
  for (const tag of [9, 10]) { packet.head(tag, 8); packet.int(0, 0) }
  const body = packet.finish()
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length + 4)
  return new Uint8Array(Buffer.concat([length, body]))
}

/** Every read/skip is bounded, including unknown fields in a future upstream packet. */
export class HuyaTarsReader {
  private pos = 0
  constructor(private data: Uint8Array, private maxPacket = MAX_PACKET) {
    if (data.length > maxPacket || maxPacket > 1_048_576) throw invalid()
  }
  get done() { return this.pos === this.data.length }
  take(size: number) {
    if (!Number.isInteger(size) || size < 0 || this.pos + size > this.data.length) throw invalid()
    const bytes = this.data.subarray(this.pos, this.pos + size)
    this.pos += size
    return bytes
  }
  head(): [number, number] {
    const byte = this.take(1)[0]!
    return [byte >> 4 === 15 ? this.take(1)[0]! : byte >> 4, byte & 15]
  }
  int(type: number): bigint {
    if (type === 12) return 0n
    if (type < 0 || type > 3) throw invalid()
    const bytes = Buffer.from(this.take(2 ** type))
    return type === 3 ? bytes.readBigInt64BE() : BigInt(bytes.readIntBE(0, bytes.length))
  }
  size(max = this.maxPacket) {
    const [tag, type] = this.head()
    const value = this.int(type)
    if (tag !== 0 || value < 0n || value > BigInt(max)) throw invalid()
    return Number(value)
  }
  string(type: number) {
    const size = type === 6 ? this.take(1)[0]! : type === 7 ? Buffer.from(this.take(4)).readUInt32BE() : -1
    if (size < 0 || size > MAX_STRING) throw invalid()
    return new TextDecoder('utf-8', { fatal: true }).decode(this.take(size))
  }
  bytes(type: number) {
    if (type !== 13) throw invalid()
    const [tag, element] = this.head()
    if (tag !== 0 || element !== 0) throw invalid()
    return this.take(this.size())
  }
  skip(type: number, depth = 0): void {
    if (depth > 32) throw invalid()
    if (type <= 3 || type === 12) { this.int(type); return }
    if (type === 4 || type === 5) { this.take(type === 4 ? 4 : 8); return }
    if (type === 6 || type === 7) { this.string(type); return }
    if (type === 13) { this.bytes(type); return }
    if (type === 8 || type === 9) {
      const count = this.size() * (type === 8 ? 2 : 1)
      for (let i = 0; i < count; i++) this.skip(this.head()[1], depth + 1)
      return
    }
    if (type === 10) {
      while (!this.done) {
        const [, child] = this.head()
        if (child === 11) return
        this.skip(child, depth + 1)
      }
    }
    throw invalid()
  }
}

const Reader = HuyaTarsReader

/** Returns only sFlvToken; packet contents and errors never reach logs or the UI. */
export function decodeHuyaTokenResponse(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 4 || bytes.length > MAX_PACKET || Buffer.from(bytes.subarray(0, 4)).readUInt32BE() !== bytes.length) return null
    const packet = new Reader(bytes.subarray(4))
    let payload: Uint8Array | undefined
    let version = 0n
    while (!packet.done) {
      const [tag, type] = packet.head()
      if (tag === 1) version = packet.int(type)
      else if (tag === 7) { if (payload) return null; payload = packet.bytes(type) }
      else packet.skip(type)
    }
    if (version !== 3n || !payload) return null
    const map = new Reader(payload)
    const [tag, type] = map.head()
    if (tag !== 0 || type !== 8) return null
    const count = map.size()
    let token: string | null = null
    for (let i = 0; i < count; i++) {
      const [keyTag, keyType] = map.head()
      if (keyTag !== 0) return null
      const key = map.string(keyType)
      const [valueTag, valueType] = map.head()
      if (valueTag !== 1) return null
      const value = map.bytes(valueType)
      if (key !== 'tRsp') continue
      if (token !== null) return null
      const rsp = new Reader(value)
      const [structTag, structType] = rsp.head()
      if (structTag !== 0 || structType !== 10) return null
      let ended = false
      while (!rsp.done) {
        const [field, fieldType] = rsp.head()
        if (fieldType === 11) { ended = true; break }
        if (field === 0) { if (token !== null) return null; token = rsp.string(fieldType) }
        else rsp.skip(fieldType)
      }
      if (!ended || !rsp.done) return null
    }
    return map.done && token && !/[\r\n\x00-\x1f\x7f]/.test(token) ? token : null
  } catch { return null }
}
