/**
 * Douyu danmaku wire protocol (STT serialisation over a length-prefixed frame).
 *
 * Frame layout, little-endian:
 *   0..3   length  (payload bytes + 9: everything after this field, so the repeated
 *                   length(4) + type(2) + encrypt(1) + reserved(1) + payload + NUL)
 *   4..7   length  (repeated)
 *   8..9   type    (689 = client to server, 690 = server to client)
 *   10     encrypt (0)
 *   11     reserved(0)
 *   12..   payload, NUL-terminated
 *
 * The payload is Douyu's "STT" text format: `key@=value/` pairs, where a literal `@`
 * is escaped as `@A` and `/` as `@S`. Nested structures repeat the escaping, so
 * unescaping must happen exactly once per nesting level.
 */

import {
  douyuGiftLabel,
  MAX_DOUYU_GIFT_COUNT,
  normalizeDouyuGift,
  normalizeDouyuSender,
  normalizeDouyuUid,
} from '../../src/core/douyuMetadata'
import type { DouyuSenderMetadata } from '../../src/core/types'
import type { ChatMessage } from './types'

export const CLIENT_MESSAGE_TYPE = 689
export const SERVER_MESSAGE_TYPE = 690

export type DanmakuMessage = Record<string, string>

export function encodeFrame(payload: string, type = CLIENT_MESSAGE_TYPE): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const frame = Buffer.allocUnsafe(body.byteLength + 13)
  // length covers type(2) + encrypt(1) + reserved(1) + body + NUL, plus one length field.
  frame.writeUInt32LE(body.byteLength + 9, 0)
  frame.writeUInt32LE(body.byteLength + 9, 4)
  frame.writeUInt16LE(type, 8)
  frame.writeUInt8(0, 10)
  frame.writeUInt8(0, 11)
  body.copy(frame, 12)
  frame.writeUInt8(0, frame.byteLength - 1)
  return frame
}

/** Split a possibly-coalesced buffer into payload strings. Returns leftover bytes. */
export function decodeFrames(buffer: Buffer): { payloads: string[]; rest: Buffer } {
  const payloads: string[] = []
  let offset = 0

  while (offset + 12 <= buffer.byteLength) {
    const length = buffer.readUInt32LE(offset)
    // A bogus length would make us hang forever waiting for bytes that never come.
    if (length < 9 || length > 1_048_576) {
      return { payloads, rest: Buffer.alloc(0) }
    }
    const end = offset + 4 + length
    if (end > buffer.byteLength) break
    const payload = buffer.subarray(offset + 12, end - 1).toString('utf8')
    if (payload.length > 0) payloads.push(payload)
    offset = end
  }

  return { payloads, rest: buffer.subarray(offset) }
}

export function unescapeStt(value: string): string {
  return value.replace(/@S/g, '/').replace(/@A/g, '@')
}

export function escapeStt(value: string): string {
  return value.replace(/@/g, '@A').replace(/\//g, '@S')
}

/** Parse one STT payload into a flat map. Nested groups are left as raw strings. */
export function parseStt(payload: string): DanmakuMessage {
  const result: DanmakuMessage = {}
  for (const pair of payload.split('/')) {
    if (pair.length === 0) continue
    const separator = pair.indexOf('@=')
    if (separator < 0) continue
    const key = pair.slice(0, separator)
    const value = pair.slice(separator + 2)
    if (key.length === 0) continue
    result[unescapeStt(key)] = unescapeStt(value)
  }
  return result
}

export function serializeStt(fields: Record<string, string | number>): string {
  return (
    Object.entries(fields)
      .map(([key, value]) => `${escapeStt(key)}@=${escapeStt(String(value))}`)
      .join('/') + '/'
  )
}

export const LOGIN_REQUEST = (roomId: string): string =>
  serializeStt({ type: 'loginreq', roomid: roomId })

export const JOIN_GROUP_REQUEST = (roomId: string): string =>
  serializeStt({ type: 'joingroup', rid: roomId, gid: -9999 })

export const KEEPALIVE_REQUEST = (): string =>
  serializeStt({ type: 'mrkl', tick: Math.floor(Date.now() / 1000) })

const COLOR_MAP: Record<string, string> = {
  '0': '#ffffff',
  '1': '#ff0000',
  '2': '#1e87f0',
  '3': '#7ac84b',
  '4': '#ff7f00',
  '5': '#9b39f4',
  '6': '#ff69b4',
}

export function colorForIndex(index: number): string {
  return COLOR_MAP[String(index)] ?? '#ffffff'
}

/** Convert a parsed payload into a chat message, or null for non-chat traffic. */
export function toChatMessage(
  message: DanmakuMessage,
  room: string,
  now: number,
): ChatMessage | null {
  if (message.type !== 'chatmsg') return null
  const text = message.txt?.trim()
  if (!text) return null
  const sender = senderForMessage(message)
  const dms = decimal(message.dms, 1_000_000_000)
  return {
    id: message.cid || message.cet || `${now}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    username: message.nn?.trim() || '匿名',
    color: Number(message.col ?? '0') || 0,
    level: Number(message.level ?? '0') || 0,
    receivedAt: now,
    room,
    system: false,
    ...(sender ? { sender } : {}),
    ...(dms === undefined ? {} : { dms }),
  }
}

function decimal(value: string | undefined, maximum: number): number | undefined {
  if (value === undefined || !/^(0|[1-9][0-9]{0,11})$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number <= maximum ? number : undefined
}

function senderForMessage(message: DanmakuMessage): DouyuSenderMetadata | undefined {
  return normalizeDouyuSender({
    uid: message.uid,
    level: decimal(message.level, 1_000),
    nobleLevel: decimal(message.nl, 1_000),
    // Official BarrageGroup_c8d2c66_5f8df24 maps bnn/bl/brid to fansMedal.
    fansBadge: { room: message.brid, name: message.bnn, level: decimal(message.bl, 1_000) },
  })
}

/**
 * Public dgb schema confirmed in Douyu common_17eee4a.js SendGiftServices.listenGiftMsg:
 * gfid/gfcnt/uid/nn, and gpf=1 selects pid rather than gfid. The source's combo flow
 * defaults absent gfcnt to one. hits/bcnt are cumulative metadata, not extra gifts.
 * https://shark2.douyucdn.cn/front-publish/live-next-master/js/room/common_17eee4a.js
 * Unknown notice types and nested/batch gift protocols are deliberately not reinterpreted.
 */
export function toGiftMessage(message: DanmakuMessage, room: string, now: number): ChatMessage | null {
  if (message.type !== 'dgb' || !normalizeDouyuUid(room)) return null
  if (message.rid !== undefined && message.rid !== room) return null
  const flag = message.gpf ?? '0'
  if (flag !== '0' && flag !== '1') return null
  const gift = normalizeDouyuGift({
    kind: flag === '1' ? 'prop' : 'gift',
    id: flag === '1' ? message.pid : message.gfid,
    count: message.gfcnt === undefined ? 1 : decimal(message.gfcnt, MAX_DOUYU_GIFT_COUNT),
  })
  if (!gift) return null
  const sender = senderForMessage(message)
  // One bounded label is rendered per event. No remote HTML, images or extra fields pass through.
  const username = (message.nn ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 64) || '匿名'
  return {
    id: `gift-${now}-${Math.random().toString(36).slice(2, 8)}`,
    text: `${douyuGiftLabel(gift)} x ${gift.count}`,
    username,
    color: 0,
    level: sender?.level ?? 0,
    receivedAt: now,
    room,
    system: true,
    ...(sender ? { sender } : {}),
    gift,
  }
}
