/** Bounded receive-only protobuf subset. Field provenance is in fixtures/douyin-LICENSE.txt. */
import { gunzipSync } from 'node:zlib'
import type { ChatMessage } from './types'

export const MAX_DOUYIN_FRAME = 2 * 1_048_576
const MAX_FIELDS = 32_768
const MAX_DEPTH = 8
const MAX_MESSAGES = 512
type Field = { id: number; wire: number; value: bigint | Uint8Array }
type Budget = { remaining: number }
const failure = () => new Error('Invalid Douyin protobuf')
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const uint64 = (value: string): bigint => { if (!/^\d{1,20}$/.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) throw failure(); return BigInt(value) }

function readVarint(bytes: Uint8Array, position: { value: number }): bigint {
  let result = 0n
  for (let index = 0; index < 10; index++) {
    const byte = bytes[position.value++]
    if (byte === undefined || (index === 9 && byte > 1)) throw failure()
    result |= BigInt(byte & 127) << BigInt(index * 7)
    if (!(byte & 128)) return result
  }
  throw failure()
}
function fields(bytes: Uint8Array, budget: Budget, depth: number): Field[] {
  if (bytes.byteLength > MAX_DOUYIN_FRAME || depth > MAX_DEPTH) throw failure()
  const position = { value: 0 }, result: Field[] = []
  while (position.value < bytes.length) {
    if (--budget.remaining < 0) throw failure()
    const key = readVarint(bytes, position)
    const wire = Number(key & 7n), id = Number(key >> 3n)
    if (!id || id > 0x1fff_ffff) throw failure()
    if (wire === 0) result.push({ id, wire, value: readVarint(bytes, position) })
    else if (wire === 2) {
      const length = readVarint(bytes, position)
      if (length > BigInt(bytes.length - position.value)) throw failure()
      const end = position.value + Number(length)
      result.push({ id, wire, value: bytes.subarray(position.value, end) }); position.value = end
    } else if (wire === 1 || wire === 5) {
      position.value += wire === 1 ? 8 : 4
      if (position.value > bytes.length) throw failure()
    } else throw failure()
  }
  return result
}
const entries = (values: Field[], id: number, wire: number): Field[] => values.filter(value => value.id === id && value.wire === wire)
function repeated(values: Field[], id: number, wire: number): Field[] { if (values.some(value => value.id === id && value.wire !== wire)) throw failure(); return entries(values, id, wire) }
function single(values: Field[], id: number, wire: number): Field | undefined { const result = entries(values, id, wire); if (result.length > 1 || values.some(value => value.id === id && value.wire !== wire)) throw failure(); return result[0] }
const integer = (values: Field[], id: number): bigint => single(values, id, 0)?.value as bigint ?? 0n
const bytesOf = (values: Field[], id: number): Uint8Array => single(values, id, 2)?.value as Uint8Array ?? new Uint8Array()
function stringOf(values: Field[], id: number, limit = 8192): string { const bytes = bytesOf(values, id); if (bytes.length > limit) throw failure(); return textDecoder.decode(bytes) }
const nested = (values: Field[], id: number, budget: Budget, depth: number): Field[] => fields(bytesOf(values, id), budget, depth)

export interface DouyinResponse {
  cursor: string; internalExt: string; heartbeatMs: number; needAck: boolean; pushServer: string
  messages: Array<{ method: string; payload: Uint8Array; messageId: string }>
}
function responseFrom(bytes: Uint8Array, budget: Budget, depth: number): DouyinResponse {
  const values = fields(bytes, budget, depth)
  if (!values.some(value => value.id >= 1 && value.id <= 14)) throw failure()
  const messages = repeated(values, 1, 2)
  if (messages.length > MAX_MESSAGES) throw failure()
  const seconds = integer(values, 8)
  return { cursor: stringOf(values, 2), internalExt: stringOf(values, 5), heartbeatMs: seconds ? Math.max(10_000, Math.min(60_000, Number(seconds > 60n ? 60n : seconds) * 1000)) : 10_000,
    needAck: integer(values, 9) === 1n, pushServer: stringOf(values, 14) || stringOf(values, 10) || stringOf(values, 13),
    messages: messages.map(value => { const message = fields(value.value as Uint8Array, budget, depth + 1); return { method: stringOf(message, 1, 128), payload: bytesOf(message, 2), messageId: integer(message, 3).toString() } }) }
}
export function decodeDouyinResponse(bytes: Uint8Array): DouyinResponse { return responseFrom(bytes, { remaining: MAX_FIELDS }, 0) }

export type DouyinChatMessage = Omit<ChatMessage, 'platform'> & { platform: 'douyin' }
export interface DouyinFrameResult { malformed: boolean; messages: DouyinChatMessage[]; ack?: Uint8Array<ArrayBuffer>; heartbeatMs?: number; liveEnded?: boolean; valid: boolean; unknownMessages: number }
export function decodeDouyinFrame(bytes: Uint8Array, webRoom: string, roomId: string, now: number): DouyinFrameResult {
  const invalid: DouyinFrameResult = { malformed: true, messages: [], valid: false, unknownMessages: 0 }
  try {
    if (!/^[1-9]\d{0,19}$/.test(webRoom)) throw failure()
    uint64(roomId)
    if (!bytes.length) return { ...invalid, malformed: false }
    const budget = { remaining: MAX_FIELDS }, values = fields(bytes, budget, 0)
    const kind = stringOf(values, 7, 32)
    if (kind === 'hb') return { malformed: false, messages: [], valid: true, unknownMessages: 0 }
    if (kind !== 'msg') return { ...invalid, malformed: false }
    const headers = new Map<string, string>()
    const rawHeaders = repeated(values, 5, 2)
    if (rawHeaders.length > 64) throw failure()
    for (const value of rawHeaders) { const header = fields(value.value as Uint8Array, budget, 1); const key = stringOf(header, 1, 128); if (headers.has(key)) throw failure(); headers.set(key, stringOf(header, 2)) }
    const encoding = stringOf(values, 6, 32)
    const compression = headers.get('compress_type') || (encoding === 'gzip' ? 'gzip' : '')
    const payload = bytesOf(values, 8)
    if (!payload.length) throw failure()
    const compressed = compression === 'gzip' || (payload[0] === 31 && payload[1] === 139)
    if (!['', 'pb', 'protobuf', 'gzip', 'none'].includes(encoding) || !['', 'gzip', 'none'].includes(compression)) throw failure()
    const decoded = compressed ? gunzipSync(payload, { maxOutputLength: MAX_DOUYIN_FRAME }) : payload
    const response = responseFrom(decoded, budget, 1)
    const result: DouyinFrameResult = { malformed: false, messages: [], valid: true, heartbeatMs: response.heartbeatMs, unknownMessages: 0 }
    const ackExt = headers.get('im-internal_ext') || (response.needAck ? response.internalExt : '')
    if (ackExt) result.ack = encodeDouyinAck(integer(values, 2).toString(), ackExt)
    for (const message of response.messages) {
      if (message.method === 'WebcastChatMessage') {
        const chat = fields(message.payload, budget, 2), common = nested(chat, 1, budget, 3)
        if (integer(common, 3).toString() !== roomId) continue
        const user = nested(chat, 2, budget, 3)
        const text = stringOf(chat, 3, 4096).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
        const username = stringOf(user, 3, 512).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128)
        const id = integer(common, 2) || uint64(message.messageId)
        if (!text || !id) continue
        result.messages.push({ id: `douyin:${roomId}:${id}`, platform: 'douyin', room: `douyin:${webRoom}`, text, username: username || '观众', color: 0xffffff, level: 0, system: false, receivedAt: now })
      } else if (message.method === 'WebcastControlMessage') {
        const control = fields(message.payload, budget, 2), common = nested(control, 1, budget, 3)
        if (integer(common, 3).toString() === roomId && integer(control, 2) === 3n) result.liveEnded = true
      } else result.unknownMessages++
    }
    return result
  } catch { return invalid }
}

export function douyinVarint(value: bigint): Uint8Array<ArrayBuffer> { if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw failure(); const result: number[] = []; do { const byte = Number(value & 127n); value >>= 7n; result.push(byte | (value ? 128 : 0)) } while (value); return Uint8Array.from(result) }
export function douyinProtoField(id: number, value: string | Uint8Array | bigint): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(id) || id < 1 || id > 0x1fff_ffff) throw failure()
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return typeof bytes === 'bigint' ? Uint8Array.from([...douyinVarint(BigInt(id * 8)), ...douyinVarint(bytes)])
    : Uint8Array.from([...douyinVarint(BigInt(id * 8 + 2)), ...douyinVarint(BigInt(bytes.length)), ...bytes])
}
export function encodeDouyinHeartbeat(): Uint8Array<ArrayBuffer> { return douyinProtoField(7, 'hb') }
export function encodeDouyinAck(logId: string, internalExt: string): Uint8Array<ArrayBuffer> {
  if (Buffer.byteLength(internalExt) > 8192) throw failure()
  return Uint8Array.from([...douyinProtoField(2, uint64(logId)), ...douyinProtoField(7, 'ack'), ...douyinProtoField(8, internalExt)])
}
