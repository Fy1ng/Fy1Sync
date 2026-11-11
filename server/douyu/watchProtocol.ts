/** Bounded framing and data-only PC heartbeat challenge decoding. */
import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { validDouyuRoom } from '../platforms/douyuRoom'
import {
  MAX_BUFFER_BYTES, MAX_FRAME_BYTES, MessageFrameDecoder, MessageProtocolError,
  messageChallenge, type GatewayMessage, type MessageChallenge,
} from './messageProtocol'

const WINDOW_MS = 60_000
const WINDOW_BYTES = 8 * MAX_BUFFER_BYTES
const WINDOW_FRAMES = 8_192

export class DouyuWatchFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private windowAt: number | null = null
  private bytes = 0
  private frames = 0

  feed(value: unknown, now: number): GatewayMessage[] {
    const data = value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null
    if (!Number.isSafeInteger(now) || now < 0 || !data || data.byteLength > MAX_BUFFER_BYTES) throw new MessageProtocolError()
    if (this.windowAt === null || now < this.windowAt || now - this.windowAt >= WINDOW_MS) {
      this.windowAt = now; this.bytes = 0; this.frames = 0
    }
    if ((this.bytes += data.byteLength) > WINDOW_BYTES || this.buffer.byteLength + data.byteLength > MAX_BUFFER_BYTES) throw new MessageProtocolError()
    this.buffer = Buffer.concat([this.buffer, data])
    const messages: GatewayMessage[] = []
    let offset = 0
    while (offset + 4 <= this.buffer.byteLength) {
      const length = this.buffer.readUInt32LE(offset)
      if (length < 9 || length + 4 > MAX_FRAME_BYTES) throw new MessageProtocolError()
      const end = offset + length + 4
      if (end > this.buffer.byteLength) break
      if (++this.frames > WINDOW_FRAMES) throw new MessageProtocolError()
      // Reuse the audited wire parser per complete frame, so its one-shot counters do not
      // end an otherwise healthy long session. Partial frames stay in our bounded buffer.
      messages.push(...new MessageFrameDecoder().feed(this.buffer.subarray(offset, end)))
      offset = end
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset))
    return messages
  }

  clear(): void { this.buffer = Buffer.alloc(0); this.windowAt = null; this.bytes = 0; this.frames = 0 }
}

/** Signing nonce and kd are separate challenges; the gateway consumes both independently. */
export function readWatchHeartbeatChallenge(message: GatewayMessage): MessageChallenge | undefined {
  if (message.nonce === undefined && message.its === undefined) return undefined
  return messageChallenge(message)
}

const PC_KD_TEMPLATE_SHA256 = 'd12a61c174ca7eb35a819dbd99f2c9c349402387e863e41ef91c3fd50b9520d7'
const PC_KD_DECODED_FUNCTION = '(function (v,rs,k,did,roomid,time){for(var I=0;I<v.length;I+=2){var i,v0=v[I],v1=v[I+1],delta=0x9E3779B9,sum=delta*rs;v0=(v0>>>12)|(v0<<20);v0=(v0>>>9)|(v0<<23);v1-=0x2ad26948;v1-=0x330221a7;for(i=0;i<rs;i++){v1-=(((v0<<4)^(v0>>>5))+v0)^(sum+k[(sum>>>11)&3]);sum-=delta;v0-=(((v1<<4)^(v1>>>5))+v1)^(sum+k[sum&3]);}v0-=0xafb61f3c;v0-=0xdfe46765;v1=(v1>>>4)|(v1<<28);v1=(v1>>>12)|(v1<<20);v[I]=v0;v[I+1]=v1;}})'
const MAX_SOURCE_LENGTH = 60_000
const MAX_TEMPLATE_LENGTH = 8_192
const MAX_KD_HEX_LENGTH = 4_096

function property(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) throw new MessageProtocolError()
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !('value' in descriptor)) throw new MessageProtocolError()
  return descriptor.value
}

function integerArray(text: string | undefined, size: number, hex: boolean): number[] {
  if (text === undefined || text.length > 4_096) throw new MessageProtocolError()
  const parts = text.split(',').map(value => value.trim())
  if (parts.length !== size || parts.some(value => !(hex ? /^0x[0-9a-f]{1,8}$/ : /^\d{1,2}$/).test(value))) throw new MessageProtocolError()
  return parts.map(value => Number(value))
}

function rotateRight(value: number, shift: number): number { return ((value >>> shift) | (value << (32 - shift))) >>> 0 }
function rotateLeft(value: number, shift: number): number { return ((value << shift) | (value >>> (32 - shift))) >>> 0 }

function xteaDecrypt(a: number, b: number, key: readonly number[], rounds: number): [number, number] {
  let sum = (0x9e3779b9 * rounds) >>> 0
  for (let index = 0; index < rounds; index++) {
    b = (b - ((((a << 4) ^ (a >>> 5)) + a) ^ (sum + key[(sum >>> 11) & 3]!))) >>> 0
    sum = (sum - 0x9e3779b9) >>> 0
    a = (a - ((((b << 4) ^ (b >>> 5)) + b) ^ (sum + key[sum & 3]!))) >>> 0
  }
  return [a, b]
}

export function readWatchKd(value: unknown): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > MAX_KD_HEX_LENGTH || !/^(?:[0-9a-fA-F]{16})+$/.test(value)) throw new MessageProtocolError()
  return value
}

/**
 * Verified 2026-11-05: PC /swf_api/homeH5Enc and current common_6a22e8b.
 * Match the known function+encrypted-array fingerprint, then interpret only bounded
 * numeric data/operations. All other downloaded code remains inert text. No script
 * execution is involved. The mobile variant deliberately has a different fingerprint.
 */
export function parseDouyuWatchKdTransform(payload: unknown, room: string): (kd: string) => string {
  if (!validDouyuRoom(room) || property(payload, 'error') !== 0) throw new MessageProtocolError()
  const source = property(property(payload, 'data'), 'room' + room)
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_SOURCE_LENGTH) throw new MessageProtocolError()
  const starts = [...source.matchAll(/\bfunction k927cea2d4369\(/g)]
  if (starts.length !== 1) throw new MessageProtocolError()
  const tail = source.slice(starts[0]!.index, starts[0]!.index + MAX_TEMPLATE_LENGTH)
  const declaration = /\}\s*var ([A-Za-z][A-Za-z0-9]*)=\[([^\]]+)\];/.exec(tail)
  if (!declaration) throw new MessageProtocolError()
  const template = tail.slice(0, declaration.index + declaration[0].length)
  if (createHash('sha256').update(template.replace(/\s+/g, '')).digest('hex') !== PC_KD_TEMPLATE_SHA256) throw new MessageProtocolError()
  const globalName = declaration[1]!
  if ([...source.matchAll(new RegExp('\\b' + globalName + '\\b', 'g'))].length !== 2) throw new MessageProtocolError()
  const key = integerArray(/var k=\[([^\]]+)\]/.exec(template)?.[1], 4, true)
  const localKey = integerArray(/var lk=\[([^\]]+)\]/.exec(template)?.[1], 2, true)
  const blockKey = integerArray(/var k2=\[([^\]]+)\]/.exec(template)?.[1], 2, true)
  const rounds = integerArray(/var rk=\[([^\]]+)\]/.exec(template)?.[1], 51, false)
  if (rounds.some(value => value < 1 || value > 36)) throw new MessageProtocolError()
  const words = integerArray(declaration[2], 102, true).map(value => (value ^ 0x22375bae) >>> 0)
  const firstOperation = template.indexOf('}v[') + 1
  const lastOperation = template.indexOf('for(var I=0;I<102;I+=2)')
  if (firstOperation < 1 || lastOperation <= firstOperation) throw new MessageProtocolError()
  const operations = template.slice(firstOperation, lastOperation).split(';').filter(Boolean)
  if (operations.length !== 102) throw new MessageProtocolError()
  const touched = new Set<number>()
  for (const operation of operations) {
    const simple = /^v\[(\d{1,3})\]([+\-^])=lk\[([01])\]$/.exec(operation)
    const rotation = /^v\[(\d{1,3})\]=\(v\[\1\](<<|>>>)\(lk\[([01])\]%16\)\)\|\(v\[\1\](<<|>>>)\(32-\(lk\[\3\]%16\)\)\)$/.exec(operation)
    const parsed = simple ?? rotation
    if (!parsed) throw new MessageProtocolError()
    const index = Number(parsed[1]), ki = Number(parsed[3])
    if (index >= words.length || touched.has(index)) throw new MessageProtocolError()
    touched.add(index)
    const original = words[index]!, constant = localKey[ki]!
    if (simple) words[index] = (simple[2] === '+' ? original + constant : simple[2] === '-' ? original - constant : original ^ constant) >>> 0
    else {
      if (rotation![2] === rotation![4]) throw new MessageProtocolError()
      words[index] = rotation![2] === '<<' ? rotateLeft(original, constant % 16) : rotateRight(original, constant % 16)
    }
  }
  for (let index = 0; index < words.length; index += 2) {
    const [a, b] = xteaDecrypt((words[index]! ^ blockKey[0]!) >>> 0, (words[index + 1]! ^ blockKey[1]!) >>> 0, key, rounds[index / 2]!)
    words[index] = (a ^ blockKey[1]!) >>> 0; words[index + 1] = (b ^ blockKey[0]!) >>> 0
  }
  for (let index = words.length - 1; index > 0; index--) words[index] = (words[index]! ^ words[index - 1]!) >>> 0
  words[0] = (words[0]! ^ 0x22375bae) >>> 0
  const decoded = Buffer.alloc(words.length * 4)
  words.forEach((value, index) => decoded.writeUInt32LE(value, index * 4))
  if (decoded.toString('utf8') !== PC_KD_DECODED_FUNCTION) throw new MessageProtocolError()

  return (kd: string): string => {
    const checked = readWatchKd(kd)
    if (!checked) return ''
    const input = Buffer.from(checked, 'hex'), output = Buffer.alloc(input.length)
    for (let offset = 0; offset < input.length; offset += 8) {
      const preA = rotateRight(rotateRight(input.readUInt32LE(offset), 12), 9)
      const preB = (input.readUInt32LE(offset + 4) - 0x2ad26948 - 0x330221a7) >>> 0
      const [a, b] = xteaDecrypt(preA, preB, key, 32)
      output.writeUInt32LE((a - 0xafb61f3c - 0xdfe46765) >>> 0, offset)
      output.writeUInt32LE(rotateRight(rotateRight(b, 4), 12), offset + 4)
    }
    return output.toString('hex')
  }
}
