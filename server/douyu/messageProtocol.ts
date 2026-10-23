/** Bounded wire helpers for account-owned, one-shot Douyu gateway connections. */
import { createHash } from 'node:crypto'
import { encodeFrame, serializeStt } from '../danmaku/douyuProtocol'

export const MAX_TEXT_UNITS = 500
export const MAX_TEXT_BYTES = 2_000
export const MAX_SIGN_ITERATIONS = 10_000
export const MAX_FRAME_BYTES = 262_144
export const MAX_BUFFER_BYTES = 1_048_576
export const MAX_TOTAL_BYTES = 2_097_152
export const MAX_COOLDOWN_MS = 86_400_000
export type GatewayMessage = Record<string, string>

export class MessageProtocolError extends Error {
  constructor() { super('Unsupported Douyu message protocol.'); this.name = 'MessageProtocolError' }
}
const invalid = (): never => { throw new MessageProtocolError() }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

export function unsigned(value: unknown, maximum: number): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null
}

function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

export function normalizeMessageText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_TEXT_UNITS || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value) || !wellFormed(value)) return null
  const text = value.trim()
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return null
  // Mirrors nodeCombine followed by the gateway's chatmessage hook.
  return text.replace(/\\/g, '\\\\').replace(/\\/g, '\uff3c').replace(/\uff3c\uff3c/g, '\uff3c')
}

export interface MessageCredentials {
  uid: string
  did: string
  username: string
  password: string
  ltkid: string
  biz: string
  stk: string
  jwt: string
}

const COOKIE_NAMES = new Set(['acf_uid', 'acf_did', 'did', 'acf_username', 'acf_auth_wl', 'acf_ltkid', 'acf_biz', 'acf_stk', 'acf_dmjwt_token'])

/** Only known gateway fields leave this parser. Duplicate material is ambiguous. */
export function messageCredentials(header: unknown): MessageCredentials | null {
  if (typeof header !== 'string' || header.length > 32_768 || /[\x00-\x1f\x7f]/.test(header)) return null
  const fields = new Map<string, string>()
  for (const part of header.split(';')) {
    if (!part.trim()) continue
    const separator = part.indexOf('=')
    if (separator <= 0) return null
    const name = part.slice(0, separator).trim()
    if (!COOKIE_NAMES.has(name)) continue
    if (fields.has(name)) return null
    let value: string
    try { value = decodeURIComponent(part.slice(separator + 1).trim()) } catch { return null }
    if (value.length > 4_096 || /[\s\x00-\x1f\x7f-\x9f]/.test(value) || !wellFormed(value) || /^(null|undefined)$/i.test(value)) return null
    fields.set(name, value)
  }
  if (fields.has('acf_did') && fields.has('did')) return null
  const uid = fields.get('acf_uid') ?? ''
  const did = fields.get('acf_did') ?? fields.get('did') ?? ''
  const username = fields.get('acf_username') ?? ''
  if (!/^[1-9][0-9]{0,19}$/.test(uid) || !/^[a-fA-F0-9]{32}$/.test(did) || !username || username.length > 256) return null
  const password = fields.get('acf_auth_wl') ?? ''
  const jwt = fields.get('acf_dmjwt_token') ?? ''
  const ltkid = fields.get('acf_ltkid') ?? ''
  const biz = fields.get('acf_biz') ?? ''
  const stk = fields.get('acf_stk') ?? ''
  if (![password, jwt, ltkid, biz, stk].every(value => !value || /^[A-Za-z0-9._~+\/=:-]+$/.test(value))) return null
  if (!password && !jwt && !(ltkid && biz && stk)) return null
  return { uid, did, username, password, ltkid, biz, stk, jwt }
}

type SigningKey = { key: string; version: string }
export type MessageSigningKeys = { nonce: string; iterations: number; login: SigningKey; heartbeat: SigningKey }
export type MessageChallenge = { nonce: string; iterations: number }

const boundedAscii = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x21-\x7e]+$/.test(value)
function keyPart(value: unknown): SigningKey {
  const data = object(value)
  if (!boundedAscii(data?.key, 1_024) || !boundedAscii(data?.key_ver, 32) || !/^[A-Za-z0-9_.-]+$/.test(data.key_ver)) return invalid()
  return { key: data.key, version: data.key_ver }
}

export function messageSigningKeys(payload: unknown): MessageSigningKeys {
  const envelope = object(payload)
  const data = object(envelope?.data)
  const cpp = object(data?.cpp)
  const iterations = unsigned(data?.enc_time, MAX_SIGN_ITERATIONS)
  if (envelope?.error !== 0 || !boundedAscii(data?.rand_str, 512) || iterations === null) return invalid()
  return { nonce: data.rand_str, iterations, login: keyPart(cpp?.danmu), heartbeat: keyPart(cpp?.heartbeat) }
}

export function messageChallenge(message: GatewayMessage): MessageChallenge {
  const iterations = unsigned(message.its, MAX_SIGN_ITERATIONS)
  if (!boundedAscii(message.nonce, 512) || iterations === null) return invalid()
  return { nonce: message.nonce, iterations }
}

const md5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex')

/** Official common_17eee4a, modules 1a0dd/9b112. No remote code is evaluated. */
export function signMessageGateway(type: 'login' | 'heartbeat', keys: MessageSigningKeys, room: string, did: string, timestamp: number, challenge?: MessageChallenge): { alg_ver: string; key_ver: string; sig: string } {
  const part = keys[type]
  const iterations = challenge?.iterations ?? keys.iterations
  if (unsigned(iterations, MAX_SIGN_ITERATIONS) === null || !Number.isSafeInteger(timestamp) || timestamp < 0) return invalid()
  let hash = challenge?.nonce ?? keys.nonce
  for (let index = 0; index < iterations; index++) hash = md5(hash + part.key)
  return { alg_ver: '1.0', key_ver: part.version, sig: md5(hash + part.key + room + did + timestamp) }
}

export function messageLogin(room: string, credentials: MessageCredentials, timestamp: number): Record<string, string | number> {
  const salt = "r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p["
  return {
    type: 'loginreq', roomid: room, dfl: '', username: credentials.username,
    password: credentials.password, ltkid: credentials.ltkid, biz: credentials.biz,
    stk: credentials.stk, jwt: credentials.jwt, devid: credentials.did,
    ct: 0, pt: 2, cvr: '0', tvr: '7', apd: '', rt: timestamp,
    vk: md5(String(timestamp) + salt + credentials.did), ver: '20220825', aver: '218101901',
    dmbt: 'chrome', dmbv: '144',
  }
}

export function gatewayAddress(payload: unknown): string {
  const envelope = object(payload)
  const gateways = object(envelope?.data)?.wss
  if (envelope?.error !== 0 || !Array.isArray(gateways) || gateways.length < 1 || gateways.length > 16) return invalid()
  const addresses: string[] = []
  for (const item of gateways) {
    const gateway = object(item)
    const port = unsigned(gateway?.port, 6_675)
    if (gateway?.domain !== 'wsproxy.douyu.com' || port === null || port < 6_671) return invalid()
    const url = new URL(`wss://${gateway.domain}:${port}/`)
    if (url.protocol !== 'wss:' || url.hostname !== 'wsproxy.douyu.com' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port !== String(port)) return invalid()
    addresses.push(url.href)
  }
  return addresses[0]!
}

export function encodeMessageFrame(fields: Record<string, string | number>): Buffer {
  const frame = encodeFrame(serializeStt(fields))
  if (frame.byteLength > MAX_FRAME_BYTES) return invalid()
  return frame
}

function unescape(value: string): string {
  if (/@(?![AS])/u.test(value)) return invalid()
  return value.replace(/@S/g, '/').replace(/@A/g, '@')
}

export function parseMessagePayload(payload: string): GatewayMessage {
  if (!payload.endsWith('/') || payload.includes('\0')) return invalid()
  const parts = payload.slice(0, -1).split('/')
  if (parts.length > 1_024) return invalid()
  const fields: GatewayMessage = Object.create(null) as GatewayMessage
  for (const part of parts) {
    const separator = part.indexOf('@=')
    if (separator < 1) return invalid()
    const name = unescape(part.slice(0, separator))
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || Object.hasOwn(fields, name)) return invalid()
    fields[name] = unescape(part.slice(separator + 2))
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(fields.type ?? '')) return invalid()
  return fields
}

export class MessageFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private totalBytes = 0
  private frames = 0
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })

  feed(value: unknown): GatewayMessage[] {
    const data = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null
    if (!data || data.byteLength > MAX_BUFFER_BYTES) return invalid()
    this.totalBytes += data.byteLength
    if (this.totalBytes > MAX_TOTAL_BYTES || this.buffer.byteLength + data.byteLength > MAX_BUFFER_BYTES) return invalid()
    this.buffer = Buffer.concat([this.buffer, data])
    const messages: GatewayMessage[] = []
    let offset = 0
    while (offset + 4 <= this.buffer.byteLength) {
      const length = this.buffer.readUInt32LE(offset)
      if (length < 9 || length + 4 > MAX_FRAME_BYTES) return invalid()
      const end = offset + 4 + length
      if (end > this.buffer.byteLength) break
      if (this.buffer.readUInt32LE(offset + 4) !== length || this.buffer.readUInt16LE(offset + 8) !== 690 || this.buffer[offset + 10] !== 0 || this.buffer[offset + 11] !== 0 || this.buffer[end - 1] !== 0) return invalid()
      if (++this.frames > 1_024) return invalid()
      try { messages.push(parseMessagePayload(this.decoder.decode(this.buffer.subarray(offset + 12, end - 1)))) } catch { return invalid() }
      offset = end
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset))
    return messages
  }

  clear(): void { this.buffer = Buffer.alloc(0) }
}

export function receiptMatch(message: GatewayMessage, expected: { uid: string; room: string; text: string; cst: string }): 'match' | 'mismatch' | 'unassociated' {
  for (const name of ['uid', 'userid', 'sender']) if (Object.hasOwn(message, name) && message[name] !== expected.uid) return 'mismatch'
  for (const name of ['rid', 'roomid']) if (Object.hasOwn(message, name) && message[name] !== expected.room) return 'mismatch'
  for (const name of ['txt', 'content']) if (Object.hasOwn(message, name) && message[name] !== expected.text) return 'mismatch'
  if (Object.hasOwn(message, 'cst')) return message.cst === expected.cst ? 'match' : 'mismatch'
  return message.uid === expected.uid && message.rid === expected.room && (message.txt === expected.text || message.content === expected.text) ? 'match' : 'unassociated'
}
