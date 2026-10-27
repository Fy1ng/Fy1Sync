/** Bounded Huya WebSocket TARS subset. Reference: biliup/biliup (MIT), see fixtures. */
import { createHash } from 'node:crypto'
import { HuyaTarsReader, HuyaTarsWriter } from '../platforms/huyaWup'
import type { HuyaDanmakuRoom } from '../platforms/huyaDanmaku'
import type { ChatMessage, RoomSignal } from './types'

export const MAX_HUYA_FRAME = 1_048_576
const MAX_COLLECTION = 256
const MAX_FIELDS = 4096
const invalid = () => new Error('Invalid Huya danmaku frame')
type Value = bigint | string | Uint8Array | Map<number, Value> | Value[] | null
type Fields = Map<number, Value>

/** Strings/bytes reuse H1's reader; budgets cover even discarded unknown fields. */
class FieldsReader extends HuyaTarsReader {
  private remaining = MAX_FIELDS
  constructor(data: Uint8Array) { super(data, MAX_HUYA_FRAME) }

  fields(nested = false, depth = 0): Fields {
    if (depth > 32) throw invalid()
    const fields: Fields = new Map()
    while (!this.done) {
      const [tag, type] = this.head()
      if (type === 11) { if (nested) return fields; throw invalid() }
      if (fields.has(tag)) throw invalid()
      fields.set(tag, this.value(type, depth))
    }
    if (nested) throw invalid()
    return fields
  }

  private value(type: number, depth: number): Value {
    if (depth > 32 || --this.remaining < 0) throw invalid()
    if (type <= 3 || type === 12) return this.int(type)
    if (type === 6 || type === 7) return this.string(type)
    if (type === 13) return this.bytes(type)
    if (type === 10) return this.fields(true, depth + 1)
    if (type === 4 || type === 5) { this.take(type === 4 ? 4 : 8); return null }
    if (type === 8 || type === 9) {
      const count = this.size(MAX_COLLECTION) * (type === 8 ? 2 : 1)
      const items: Value[] = []
      for (let index = 0; index < count; index++) items.push(this.value(this.head()[1], depth + 1))
      return items
    }
    throw invalid()
  }
}

function int(fields: Fields, tag: number, fallback?: bigint): bigint {
  const value = fields.get(tag)
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'bigint') throw invalid()
  return value
}
function bytes(fields: Fields, tag: number): Uint8Array {
  const value = fields.get(tag)
  if (!(value instanceof Uint8Array)) throw invalid()
  return value
}
function text(fields: Fields, tag: number, max: number, fallback = ''): string {
  const value = fields.get(tag)
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw invalid()
  return value.trim()
}

function command(type: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const writer = new HuyaTarsWriter()
  writer.int(0, type)
  writer.bytes(1, data)
  return new Uint8Array(writer.finish())
}

export function encodeHuyaRegistration(room: HuyaDanmakuRoom): Uint8Array<ArrayBuffer> {
  if (!/^[1-9]\d{0,15}$/.test(room.room) || room.presenterUid <= 0n || room.presenterUid > 0x7fff_ffff_ffff_ffffn
    || room.topSid < 0n || room.subSid < 0n) throw invalid()
  const request = new HuyaTarsWriter()
  request.head(0, 9)
  request.int(0, 2)
  for (const group of ['live', 'chat']) request.string(0, `${group}:${room.presenterUid}`)
  request.string(1, '')
  return command(16, request.finish())
}

/** Upstream's pre-encoded anonymous onlineui.OnUserHeartBeat, without credentials. */
export function encodeHuyaHeartbeat(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from('00031d0000690000006910032c3c4c56086f6e6c696e657569660f4f6e557365724865617274426561747d00003c0800010604745265711d00002f0a0a0c1600260036076164725f77617046000b1203aef00f2203aef00f3c426d5202605c60017c82000bb01f9cac0b8c980ca80c20', 'hex'))
}

export type HuyaDecodeResult = {
  command: number | null
  registered: boolean
  registrationFailed: boolean
  heartbeat: boolean
  messages: ChatMessage[]
  signals: Array<Extract<RoomSignal, { platform: 'huya' }>>
  unknownUris: number
  unknownUriCounts: Record<string, number>
  batch: boolean
  emptyFrame: boolean
  malformed: boolean
  malformedReason: 'invalid-frame' | null
}
function empty(): HuyaDecodeResult {
  return { command: null, registered: false, registrationFailed: false, heartbeat: false, messages: [], signals: [], unknownUris: 0,
    unknownUriCounts: {}, batch: false, emptyFrame: false, malformed: false, malformedReason: null }
}

function push(uri: bigint, body: Uint8Array, pushId: bigint, room: string, now: number, result: HuyaDecodeResult) {
  if (![1400n, 6501n, 6502n, 6507n, 8006n].includes(uri)) {
    result.unknownUris++
    const key = String(uri)
    result.unknownUriCounts[key] = (result.unknownUriCounts[key] ?? 0) + 1
    return
  }
  const fields = new FieldsReader(body).fields()
  if (uri === 8006n) {
    const count = int(fields, 0)
    if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid()
    result.signals.push({ platform: 'huya', kind: 'viewers', room, receivedAt: now, count: Number(count),
      ...(pushId > 0n ? { messageId: String(pushId) } : {}) })
    return
  }
  const base = { platform: 'huya' as const, room, receivedAt: now, color: 0, level: 0 }
  // Only an opaque hash/message sequence is exported. UID, avatar and pay IDs stay private.
  const id = `huya:${room}:${uri}:${pushId > 0n ? pushId : createHash('sha256').update(body).digest('hex').slice(0, 24)}`
  if (uri === 1400n) {
    const user = fields.get(0)
    if (!(user instanceof Map)) throw invalid()
    const content = text(fields, 3, 4096)
    const username = text(user, 2, 256, '匿名') || '匿名'
    if (content) result.messages.push({ ...base, id, text: content, username, system: false })
    return
  }
  // Real 6501 captures confirm tags 0/2/6/20; tag 5 is the presenter, not the sender.
  const giftId = int(fields, 0)
  const count = int(fields, 2)
  if (giftId < 0n || giftId > 2147483647n || count <= 0n || count > 1_000_000n) throw invalid()
  const username = uri === 6501n ? text(fields, 6, 256, '匿名') || '匿名' : '匿名'
  const name = text(fields, 20, 256)
  result.messages.push({ ...base, id, username, text: `${name ? `赠送${name}` : `赠送礼物 ${giftId}`} x${count}`, system: true,
    huyaGift: { id: String(giftId), count: Number(count), ...(name ? { name } : {}) } })
}

/** Malformed frames are a local drop, never exceptions or upstream-derived diagnostics. */
export function decodeHuyaFrame(data: Uint8Array, room: string, now: number, options: { presenterUid?: bigint } = {}): HuyaDecodeResult {
  const result = empty()
  try {
    if (data.length === 0) return { ...result, emptyFrame: true }
    if (data.length > MAX_HUYA_FRAME || !/^[1-9]\d{0,15}$/.test(room) || !Number.isFinite(now)) throw invalid()
    const outer = new FieldsReader(data).fields()
    const cmd = int(outer, 0)
    if (cmd < 0n || cmd > 2147483647n) throw invalid()
    result.command = Number(cmd)
    if (cmd === 2n) {
      const rsp = new FieldsReader(bytes(outer, 1)).fields()
      const code = int(rsp, 0)
      result.registered = code === 0n
      result.registrationFailed = !result.registered
    } else if (cmd === 17n) {
      const rsp = new FieldsReader(bytes(outer, 1)).fields()
      const code = int(rsp, 0)
      const groups = rsp.get(1)
      if (groups !== undefined && (!Array.isArray(groups) || groups.length > 2
        || groups.some(group => typeof group !== 'string' || !/^(live|chat):[1-9]\d{0,18}$/.test(group)))) throw invalid()
      // Captured successes acknowledge chat only, although the request includes both groups.
      result.registrationFailed = code !== 0n
      result.registered = code === 0n && Array.isArray(groups) && groups.length > 0
        && (options.presenterUid === undefined || groups.some(group => group === `chat:${options.presenterUid}` || group === `live:${options.presenterUid}`))
    } else if (cmd === 6n) result.heartbeat = true
    else if (cmd === 4n) {
      const body = bytes(outer, 1)
      if (body.length < 4 || Buffer.from(body.subarray(0, 4)).readUInt32BE() !== body.length) throw invalid()
      const rsp = new FieldsReader(body.subarray(4)).fields()
      result.heartbeat = int(rsp, 1) === 3n && text(rsp, 6, 128) === 'OnUserHeartBeat'
    } else if (cmd === 7n) {
      const message = new FieldsReader(bytes(outer, 1)).fields()
      push(int(message, 1), bytes(message, 2), int(message, 5, 0n), room, now, result)
    } else if (cmd === 22n) {
      result.batch = true
      const batch = new FieldsReader(bytes(outer, 1)).fields()
      const list = batch.get(1)
      if (!Array.isArray(list) || list.length > MAX_COLLECTION) throw invalid()
      for (const item of list) {
        if (!(item instanceof Map)) throw invalid()
        push(int(item, 0), bytes(item, 1), int(item, 2, 0n), room, now, result)
      }
    }
    return result
  } catch { return { ...empty(), malformed: true, malformedReason: 'invalid-frame' } }
}

/** Both transports carry WSPushMessage without a WebSocketCommand wrapper. */
export function decodeHuyaPush(data: Uint8Array, room: string, now: number): HuyaDecodeResult {
  const result = empty()
  try {
    if (data.length === 0 || data.length > MAX_HUYA_FRAME || !/^[1-9]\d{0,15}$/.test(room) || !Number.isFinite(now)) throw invalid()
    const message = new FieldsReader(data).fields()
    push(int(message, 1), bytes(message, 2), int(message, 5, 0n), room, now, result)
    return result
  } catch { return { ...empty(), malformed: true, malformedReason: 'invalid-frame' } }
}
