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

export interface DouyinRoomContext { anchorId?: string }
export interface DouyinSenderMetadata {
  consumptionLevel?: number
  liveFansClub?: {
    name?: string; level?: number; anchorId?: string; statusCode?: number
    membership: 'member' | 'non-member' | 'unknown'
    lit: boolean | null; currentRoom: boolean | null
  }
}
export interface DouyinEmojiMetadata {
  id?: string
  fallback: string
  images: Array<{ url?: string; fallback: string; width?: number; height?: number; animated?: boolean }>
}
export interface DouyinGiftMetadata {
  id: string; name?: string; recipient?: { id?: string; name?: string }
  count?: string; totalCount?: string; groupCount?: string; repeatCount?: string; comboCount?: string
  groupId?: string; repeatEnd?: number; combo?: boolean; type?: number
  fanTicketCount?: string; unitDiamonds?: string
  totalDiamonds: null
  valueReason: 'missing-unit-price' | 'unverified-count-semantics' | 'gift-id-mismatch'
}
export interface DouyinMessageMetadata {
  roomId: string
  method: 'WebcastChatMessage' | 'WebcastEmojiChatMessage' | 'WebcastGiftMessage' | 'WebcastRoomMessage'
  sender?: DouyinSenderMetadata
  emoji?: DouyinEmojiMetadata
  gift?: DouyinGiftMetadata
  chatBy?: string
  plainTextExact?: boolean
  roomMessage?: { type?: number; bizScene?: string }
}
export type DouyinChatMessage = Omit<ChatMessage, 'platform'> & { platform: 'douyin'; douyin: DouyinMessageMetadata }
export interface DouyinFrameResult { malformed: boolean; messages: DouyinChatMessage[]; ack?: Uint8Array<ArrayBuffer>; heartbeatMs?: number; liveEnded?: boolean; valid: boolean; unknownMessages: number }

const cleanText = (value: string): string => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
function optionalInteger(values: Field[], id: number): bigint | undefined { return single(values, id, 0)?.value as bigint | undefined }
function safeNumber(values: Field[], id: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = optionalInteger(values, id)
  return value !== undefined && value <= BigInt(maximum) ? Number(value) : undefined
}
function optionalBool(values: Field[], id: number): boolean | undefined {
  const value = optionalInteger(values, id)
  return value === 0n ? false : value === 1n ? true : undefined
}
function usernameOf(values: Field[]): string { return stringOf(values, 3, 512).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128) }
function senderFrom(user: Field[], budget: Budget, context: DouyinRoomContext): DouyinSenderMetadata | undefined {
  const consumptionLevel = safeNumber(nested(user, 23, budget, 4), 6)
  const fans = nested(nested(user, 24, budget, 4), 1, budget, 5)
  if (!fans.length && consumptionLevel === undefined) return undefined
  const sender: DouyinSenderMetadata = { ...(consumptionLevel === undefined ? {} : { consumptionLevel }) }
  if (fans.length) {
    const anchor = optionalInteger(fans, 6)
    const anchorId = anchor ? anchor.toString() : undefined
    const statusCode = safeNumber(fans, 3, 0x7fff_ffff)
    const name = cleanText(stringOf(fans, 1, 512)), level = safeNumber(fans, 2, 0x7fff_ffff)
    sender.liveFansClub = {
      ...(name ? { name } : {}), ...(level === undefined ? {} : { level }),
      ...(anchorId ? { anchorId } : {}), ...(statusCode === undefined ? {} : { statusCode }),
      membership: statusCode === 1 || statusCode === 2 ? 'member' : statusCode === 0 ? 'non-member' : 'unknown',
      lit: statusCode === 1 ? true : statusCode === 0 || statusCode === 2 ? false : null,
      currentRoom: anchorId && context.anchorId ? anchorId === context.anchorId : null,
    }
  }
  return sender
}
function imageFrom(values: Field[], budget: Budget): DouyinEmojiMetadata['images'][number] {
  const urls = repeated(values, 1, 2)
  if (urls.length > 16) throw failure()
  let url: string | undefined
  for (const value of urls) {
    const bytes = value.value as Uint8Array
    if (bytes.length > 2048) throw failure()
    const raw = textDecoder.decode(bytes)
    if (url || /[\x00-\x20\x7f]/.test(raw)) continue
    try {
      const parsed = new URL(raw)
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && !parsed.hash
        && /(?:^|\.)(?:douyinpic\.com|byteimg\.com|bytetos\.com)$/.test(parsed.hostname)) url = parsed.href
    } catch {}
  }
  const content = nested(values, 8, budget, 7)
  const fallback = cleanText(stringOf(content, 4, 512)) || cleanText(stringOf(content, 1, 512)) || '[表情]'
  const width = safeNumber(values, 4, 4096), height = safeNumber(values, 3, 4096), animated = optionalBool(values, 9)
  return { ...(url ? { url } : {}), fallback, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(animated === undefined ? {} : { animated }) }
}
function emojiFrom(chat: Field[], budget: Budget): DouyinEmojiMetadata {
  const rich = nested(chat, 4, budget, 3), pieces = repeated(rich, 4, 2)
  if (pieces.length > 64) throw failure()
  const images: DouyinEmojiMetadata['images'] = []
  const strings: string[] = []
  for (const value of pieces) {
    const piece = fields(value.value as Uint8Array, budget, 4)
    const text = cleanText(stringOf(piece, 11, 4096))
    if (text) strings.push(text)
    const imageValue = single(piece, 25, 2)
    if (imageValue) {
      const image = nested(fields(imageValue.value as Uint8Array, budget, 5), 1, budget, 6)
      const decoded = imageFrom(image, budget)
      images.push(decoded)
      strings.push(decoded.fallback)
    }
  }
  const pattern = cleanText(stringOf(rich, 2, 4096))
  const fallback = cleanText(stringOf(chat, 5, 4096)) || cleanText(strings.join('')) || (/[{}]/.test(pattern) ? '' : pattern) || '[表情]'
  if (Buffer.byteLength(fallback) > 4096) throw failure()
  const id = optionalInteger(chat, 3)
  return { ...(id ? { id: id.toString() } : {}), fallback, images }
}
function giftFrom(values: Field[], budget: Budget): DouyinGiftMetadata | undefined {
  const id = optionalInteger(values, 2)
  if (!id) return undefined
  const gift = nested(values, 15, budget, 3), recipient = nested(values, 8, budget, 3)
  const giftId = optionalInteger(gift, 5), recipientId = optionalInteger(recipient, 1), recipientName = usernameOf(recipient)
  const mismatch = giftId !== undefined && giftId !== id
  const unitDiamonds = giftId === id ? safeNumber(gift, 12, 0x7fff_ffff)?.toString() : undefined
  const result: DouyinGiftMetadata = { id: id.toString(), totalDiamonds: null,
    valueReason: mismatch ? 'gift-id-mismatch' : unitDiamonds === undefined ? 'missing-unit-price' : 'unverified-count-semantics' }
  for (const [key, fieldId] of [['count', 44], ['totalCount', 29], ['groupCount', 4], ['repeatCount', 5], ['comboCount', 6], ['groupId', 11], ['fanTicketCount', 3]] as const) {
    const value = optionalInteger(values, fieldId)
    if (value !== undefined) result[key] = value.toString()
  }
  const repeatEnd = safeNumber(values, 9, 0x7fff_ffff), combo = optionalBool(gift, 10), type = safeNumber(gift, 11, 0x7fff_ffff)
  if (repeatEnd !== undefined) result.repeatEnd = repeatEnd
  if (!mismatch) {
    const name = cleanText(stringOf(gift, 16, 512))
    if (name) result.name = name
    if (unitDiamonds !== undefined) result.unitDiamonds = unitDiamonds
    if (combo !== undefined) result.combo = combo
    if (type !== undefined) result.type = type
  }
  if (recipientId || recipientName) result.recipient = { ...(recipientId ? { id: recipientId.toString() } : {}), ...(recipientName ? { name: recipientName } : {}) }
  return result
}

export function decodeDouyinFrame(bytes: Uint8Array, webRoom: string, roomId: string, now: number, context: DouyinRoomContext = {}): DouyinFrameResult {
  const invalid: DouyinFrameResult = { malformed: true, messages: [], valid: false, unknownMessages: 0 }
  try {
    if (!/^[1-9]\d{0,19}$/.test(webRoom)) throw failure()
    uint64(roomId)
    if (context.anchorId !== undefined) uint64(context.anchorId)
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
      if (message.method === 'WebcastChatMessage' || message.method === 'WebcastEmojiChatMessage' || message.method === 'WebcastGiftMessage' || message.method === 'WebcastRoomMessage') {
        const chat = fields(message.payload, budget, 2), common = nested(chat, 1, budget, 3)
        if (integer(common, 3).toString() !== roomId) continue
        const id = integer(common, 2) || uint64(message.messageId)
        if (!id) continue
        const system = message.method === 'WebcastGiftMessage' || message.method === 'WebcastRoomMessage'
        const user = message.method === 'WebcastRoomMessage' ? [] : nested(chat, message.method === 'WebcastGiftMessage' ? 7 : 2, budget, 3)
        const username = usernameOf(user)
        const douyin: DouyinMessageMetadata = { roomId, method: message.method }
        const sender = senderFrom(user, budget, context)
        if (sender) douyin.sender = sender
        let text: string
        if (message.method === 'WebcastEmojiChatMessage') {
          douyin.emoji = emojiFrom(chat, budget)
          text = douyin.emoji.fallback
        } else if (message.method === 'WebcastGiftMessage') {
          const gift = giftFrom(chat, budget)
          if (!gift) continue
          douyin.gift = gift
          text = `送出 ${gift.name || `礼物 ${gift.id}`}${gift.count === undefined ? '' : ` x${gift.count}`}${gift.recipient?.name ? ` 给 ${gift.recipient.name}` : ''}`
        } else {
          const rawText = stringOf(chat, message.method === 'WebcastRoomMessage' ? 2 : 3, 4096)
          text = cleanText(rawText)
          if (message.method === 'WebcastChatMessage') {
            douyin.plainTextExact = rawText === text
            const chatBy = optionalInteger(chat, 20)
            if (chatBy !== undefined) douyin.chatBy = chatBy.toString()
          } else {
            const type = safeNumber(chat, 4, 0x7fff_ffff), bizScene = cleanText(stringOf(chat, 20, 512))
            douyin.roomMessage = { ...(type === undefined ? {} : { type }), ...(bizScene ? { bizScene } : {}) }
          }
        }
        if (!text || !id) continue
        result.messages.push({ id: `douyin:${roomId}:${id}`, platform: 'douyin', room: `douyin:${webRoom}`, text,
          username: username || (message.method === 'WebcastRoomMessage' ? '系统' : '观众'), color: 0xffffff,
          level: sender?.consumptionLevel ?? 0, system, receivedAt: now, douyin })
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
