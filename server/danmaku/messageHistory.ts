import { normalizeDouyuGift, normalizeDouyuSender, normalizeDouyuUid } from '../../src/core/douyuMetadata'
import type { ChatMessage } from './douyuProtocol'

export interface MessageHistoryQuery { room?: string; uid?: string; query?: string; page?: number; pageSize?: number }
export interface MessageHistoryPage {
  items: ChatMessage[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  coverage: 'received-only'
  capacity: number
  truncated: boolean
}
export interface DanmakuRate {
  room: string
  receivedLastMinute: number
  messagesPerMinute: number
  sampleSeconds: number
  since: number | null
}
type RoomRate = { since: number; buckets: Array<{ second: number; count: number }> }

const roomValid = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,11}$/.test(value)
const textValid = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value)

export function readHistoryQuery(raw: unknown = {}): Required<Pick<MessageHistoryQuery, 'query' | 'page' | 'pageSize'>> & Pick<MessageHistoryQuery, 'room' | 'uid'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null)) throw new Error('弹幕查询条件无效.')
  const keys = ['room', 'uid', 'query', 'page', 'pageSize']
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('弹幕查询条件无效.')
  const values: Record<string, unknown> = {}
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(raw, key)
    if (field && !('value' in field)) throw new Error('弹幕查询条件无效.')
    if (field) values[key] = field.value
  }
  const { room, uid } = values
  const query = values.query ?? ''
  const page = values.page ?? 1
  const pageSize = values.pageSize ?? 50
  if ((room !== undefined && !roomValid(room)) || (uid !== undefined && !normalizeDouyuUid(uid))
    || !textValid(query, 200) || typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 100_000
    || typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('弹幕查询条件无效.')
  return { ...(room === undefined ? {} : { room: room as string }), ...(uid === undefined ? {} : { uid: uid as string }), query, page, pageSize }
}

/** Copy only public protocol fields; snapshots never share mutable nested metadata. */
export function copyHistoryMessage(raw: ChatMessage): ChatMessage | null {
  if (!raw || !roomValid(raw.room) || !textValid(raw.id, 160) || !raw.id
    || !textValid(raw.text, 2_000) || !raw.text.trim() || !textValid(raw.username, 128)
    || !Number.isSafeInteger(raw.receivedAt) || raw.receivedAt < 0 || typeof raw.system !== 'boolean'
    || !Number.isInteger(raw.color) || raw.color < 0 || raw.color > 6
    || !Number.isInteger(raw.level) || raw.level < 0 || raw.level > 1_000) return null
  const sender = normalizeDouyuSender(raw.sender)
  const gift = normalizeDouyuGift(raw.gift)
  if (raw.gift !== undefined && !gift) return null
  const dms = typeof raw.dms === 'number' && Number.isSafeInteger(raw.dms) && raw.dms >= 0 && raw.dms <= 1_000_000_000 ? raw.dms : undefined
  return { id: raw.id, text: raw.text, username: raw.username, color: raw.color, level: raw.level,
    receivedAt: raw.receivedAt, room: raw.room, system: raw.system,
    ...(sender ? { sender } : {}), ...(gift ? { gift } : {}), ...(dms === undefined ? {} : { dms }) }
}

/** Raw, in-memory reception history. UI filters, playback delay and relay replay never add records. */
export class MessageHistory {
  private readonly ring: Array<ChatMessage | undefined>
  private readonly seen = new Set<string>()
  private readonly rates = new Map<string, RoomRate>()
  private cursor = 0
  private size = 0
  private evicted = false
  private lastClock = 0
  readonly capacity: number
  private readonly now: () => number

  constructor(options: { capacity?: number; now?: () => number } = {}) {
    this.capacity = options.capacity ?? 10_000
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 50_000) throw new Error('弹幕历史容量无效.')
    this.ring = new Array(this.capacity)
    this.now = options.now ?? Date.now
  }

  observe(raw: ChatMessage): boolean {
    const message = copyHistoryMessage(raw)
    if (!message) return false
    const key = JSON.stringify([message.room, message.id])
    if (this.seen.has(key)) return false
    const previous = this.ring[this.cursor]
    if (previous) {
      this.seen.delete(JSON.stringify([previous.room, previous.id]))
      this.evicted = true
    }
    this.ring[this.cursor] = message
    this.seen.add(key)
    this.cursor = (this.cursor + 1) % this.capacity
    this.size = Math.min(this.capacity, this.size + 1)
    if (!message.system && !message.gift) this.count(message.room)
    return true
  }

  search(query: MessageHistoryQuery = {}): MessageHistoryPage {
    const options = readHistoryQuery(query)
    const needle = options.query.toLowerCase()
    const matching = this.entries().reverse().filter(message => (!options.room || message.room === options.room)
      && (!options.uid || message.sender?.uid === options.uid)
      && (!needle || message.text.toLowerCase().includes(needle) || message.username.toLowerCase().includes(needle)))
    const start = (options.page - 1) * options.pageSize
    return { items: matching.slice(start, start + options.pageSize).map(message => copyHistoryMessage(message)!),
      total: matching.length, page: options.page, pageSize: options.pageSize, hasMore: start + options.pageSize < matching.length,
      coverage: 'received-only', capacity: this.capacity, truncated: this.evicted }
  }

  rate(room: string): DanmakuRate {
    if (!roomValid(room)) throw new Error('房间号无效.')
    const now = this.clock()
    const state = this.rates.get(room)
    if (!state) return { room, receivedLastMinute: 0, messagesPerMinute: 0, sampleSeconds: 0, since: null }
    const second = Math.floor(now / 1_000)
    const count = state.buckets.reduce((total, bucket) => total + (bucket.second > second - 60 && bucket.second <= second ? bucket.count : 0), 0)
    const sampleSeconds = Math.min(60, Math.max(1, (now - state.since) / 1_000))
    return { room, receivedLastMinute: count, messagesPerMinute: Math.round(count * 60 / sampleSeconds), sampleSeconds, since: state.since }
  }

  clear(room?: string): void {
    if (room !== undefined && !roomValid(room)) throw new Error('房间号无效.')
    const retained = room === undefined ? [] : this.entries().filter(message => message.room !== room)
    this.ring.fill(undefined)
    this.seen.clear()
    this.cursor = 0
    this.size = 0
    for (const message of retained) {
      this.ring[this.cursor] = message
      this.cursor = (this.cursor + 1) % this.capacity
      this.size++
      this.seen.add(JSON.stringify([message.room, message.id]))
    }
    if (room === undefined) { this.rates.clear(); this.evicted = false }
    else this.rates.delete(room)
  }

  private entries(): ChatMessage[] {
    const start = (this.cursor - this.size + this.capacity) % this.capacity
    return Array.from({ length: this.size }, (_, index) => this.ring[(start + index) % this.capacity]!)
  }

  private clock(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('弹幕统计时钟无效.')
    if (now < this.lastClock) this.rates.clear()
    this.lastClock = now
    return now
  }

  private count(room: string): void {
    const now = this.clock()
    let state = this.rates.get(room)
    if (!state) {
      if (this.rates.size >= 64) this.rates.delete(this.rates.keys().next().value!)
      state = { since: now, buckets: Array.from({ length: 60 }, () => ({ second: -1, count: 0 })) }
      this.rates.set(room, state)
    }
    const second = Math.floor(now / 1_000)
    const bucket = state.buckets[second % 60]!
    if (bucket.second !== second) { bucket.second = second; bucket.count = 0 }
    bucket.count = Math.min(Number.MAX_SAFE_INTEGER, bucket.count + 1)
  }
}

/** A fixed public destination only. Never accepts a caller-supplied URL or nickname lookup. */
export function doseeingHistoryUrl(uid: string): string {
  if (!normalizeDouyuUid(uid)) throw new Error('用户 ID 无效.')
  return 'https://www.doseeing.com/data/fan/' + uid + '?type=chat&dt=0'
}
