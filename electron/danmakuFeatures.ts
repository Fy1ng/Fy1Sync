import { randomUUID } from 'node:crypto'
import { DEFAULT_DANMAKU_PREFERENCES, readDanmakuPreferences, type DanmakuPreferences } from '../src/core/danmakuProcessing'
import { DEFAULT_MESSAGE_AFFIXES, readMessageAffixes, type MessageAffixes } from '../src/core/messageComposition'
import { normalizeDouyuUid } from '../src/core/douyuMetadata'
import { MessageHistory, doseeingHistoryUrl, readHistoryQuery, type MessageHistoryQuery } from '../server/danmaku/messageHistory'
import { DeliveryTracker } from '../server/danmaku/deliveryTracker'
import type { ChatMessage } from '../server/danmaku/types'

export interface FavoriteDanmaku {
  id: string
  text: string
  room: string | null
  uid: string | null
  username: string | null
  createdAt: number
}
export interface AddFavoriteDanmaku { text: string; room?: string; uid?: string; username?: string }
export interface DanmakuFeaturesStorage {
  version: 1
  preferences: DanmakuPreferences
  affixes: MessageAffixes
  favorites: FavoriteDanmaku[]
}
export interface DanmakuFeaturesSnapshot { preferences: DanmakuPreferences; affixes: MessageAffixes; favoriteCount: number }
export interface FavoriteDanmakuPage { items: FavoriteDanmaku[]; total: number; page: number; pageSize: number; hasMore: boolean }
export interface DanmakuFeaturesOptions {
  /** Main injects PrivateJsonStore in its existing private userData subtree. */
  load: () => unknown
  save: (data: DanmakuFeaturesStorage) => void
  now?: () => number
  id?: () => string
  history?: MessageHistory
  deliveryTracker?: DeliveryTracker
}

export class DanmakuFeaturesError extends Error {
  constructor(readonly code: 'invalid-arguments' | 'not-found' | 'favorite-limit' | 'storage-failed') {
    super({ 'invalid-arguments': '弹幕功能参数无效.', 'not-found': '未找到该条弹幕收藏.',
      'favorite-limit': '本地弹幕收藏已达到容量上限, 请先删除部分收藏.', 'storage-failed': '弹幕本地设置读取或保存失败, 原文件已保留.' }[code])
    this.name = 'DanmakuFeaturesError'
  }
}

export const MAX_DANMAKU_FAVORITES = 1_000
const MAX_STORE_BYTES = 900 * 1024
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= max && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)

function dataFields(raw: unknown, keys: string[]): Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null)
      || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error()
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(raw, key)
      if (field && !('value' in field)) throw new Error()
      if (field) result[key] = field.value
    }
    return result
  } catch { throw new DanmakuFeaturesError('invalid-arguments') }
}

function favoriteInput(raw: unknown): Omit<FavoriteDanmaku, 'id' | 'createdAt'> {
  const value = dataFields(raw, ['text', 'room', 'uid', 'username'])
  const room = value.room ?? null
  const uid = value.uid ?? null
  const username = value.username ?? null
  if (!text(value.text, 2_000) || (room !== null && (typeof room !== 'string' || !/^[1-9][0-9]{0,11}$/.test(room)))
    || (uid !== null && !normalizeDouyuUid(uid)) || (username !== null && !text(username, 128))) throw new DanmakuFeaturesError('invalid-arguments')
  return { text: value.text, room: room as string | null, uid: uid as string | null, username: username as string | null }
}

function readStored(raw: unknown): DanmakuFeaturesStorage {
  const fields = dataFields(raw, ['version', 'preferences', 'affixes', 'favorites'])
  const preferences = readDanmakuPreferences(fields.preferences)
  const affixes = readMessageAffixes(fields.affixes)
  const favorites = fields.favorites
  if (fields.version !== 1 || !preferences || !affixes || !Array.isArray(favorites)
    || Object.getPrototypeOf(favorites) !== Array.prototype || favorites.length > MAX_DANMAKU_FAVORITES
    || Reflect.ownKeys(favorites).length !== favorites.length + 1) throw new DanmakuFeaturesError('storage-failed')
  const items: FavoriteDanmaku[] = []
  const ids = new Set<string>()
  for (let index = 0; index < favorites.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(favorites, String(index))
    if (!descriptor || !('value' in descriptor)) throw new DanmakuFeaturesError('storage-failed')
    const item = dataFields(descriptor.value, ['id', 'text', 'room', 'uid', 'username', 'createdAt'])
    const content = favoriteInput({ text: item.text, room: item.room, uid: item.uid, username: item.username })
    if (!text(item.id, 160) || ids.has(item.id) || typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt)
      || item.createdAt < 0) throw new DanmakuFeaturesError('storage-failed')
    ids.add(item.id)
    items.push({ ...content, id: item.id, createdAt: item.createdAt })
  }
  const result: DanmakuFeaturesStorage = { version: 1, preferences, affixes, favorites: items }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_STORE_BYTES) throw new DanmakuFeaturesError('storage-failed')
  return result
}

/** Small persistent preferences/explicit favorites, separate from transient receive history. */
export class DanmakuFeatures {
  readonly history: MessageHistory
  readonly deliveries: DeliveryTracker
  private state: DanmakuFeaturesStorage = { version: 1, preferences: { ...DEFAULT_DANMAKU_PREFERENCES },
    affixes: { ...DEFAULT_MESSAGE_AFFIXES }, favorites: [] }
  private readonly now: () => number
  private readonly id: () => string
  private readonly listeners = new Set<(snapshot: DanmakuFeaturesSnapshot) => void>()

  constructor(private readonly options: DanmakuFeaturesOptions) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
    this.history = options.history ?? new MessageHistory({ now: this.now })
    this.deliveries = options.deliveryTracker ?? new DeliveryTracker({ now: this.now })
    try {
      const stored = options.load()
      if (stored !== undefined) this.state = readStored(stored)
    } catch { throw new DanmakuFeaturesError('storage-failed') }
  }

  snapshot(): DanmakuFeaturesSnapshot {
    return { preferences: { ...this.state.preferences }, affixes: { ...this.state.affixes }, favoriteCount: this.state.favorites.length }
  }

  subscribe(listener: (snapshot: DanmakuFeaturesSnapshot) => void): () => void {
    this.listeners.add(listener)
    try { listener(this.snapshot()) } catch { /* UI teardown cannot prevent later persistence. */ }
    return () => { this.listeners.delete(listener) }
  }

  updatePreferences(patch: Partial<DanmakuPreferences>): DanmakuFeaturesSnapshot {
    const parsed = readDanmakuPreferences(patch)
    if (!parsed) throw new DanmakuFeaturesError('invalid-arguments')
    const fields = dataFields(patch, Object.keys(DEFAULT_DANMAKU_PREFERENCES))
    const preferences = readDanmakuPreferences({ ...this.state.preferences, ...fields })!
    this.persist({ ...this.state, preferences })
    return this.snapshot()
  }

  updateAffixes(patch: Partial<MessageAffixes>): DanmakuFeaturesSnapshot {
    const fields = dataFields(patch, ['enabled', 'prefix', 'suffix'])
    const affixes = readMessageAffixes({ ...this.state.affixes, ...fields })
    if (!affixes) throw new DanmakuFeaturesError('invalid-arguments')
    this.persist({ ...this.state, affixes })
    return this.snapshot()
  }

  observe(message: ChatMessage): boolean {
    if (message?.platform === 'huya' || (typeof message?.room === 'string' && message.room.startsWith('huya:'))) return false
    if (!this.history.observe(message)) return false
    this.deliveries.observe(message)
    return true
  }

  searchHistory(query: MessageHistoryQuery = {}) { return this.history.search(query) }
  rate(room: string) { return this.history.rate(room) }
  externalHistoryUrl(uid: string): string { return doseeingHistoryUrl(uid) }

  userDetails(room: string, uid: string) {
    readHistoryQuery({ room, uid })
    if (!this.state.preferences.showUserDetails) return null
    const message = this.history.search({ room, uid, pageSize: 1 }).items[0]
    return message ? { room, uid, username: message.username, observedAt: message.receivedAt, ...message.sender } : null
  }

  searchFavorites(query: MessageHistoryQuery = {}): FavoriteDanmakuPage {
    const options = readHistoryQuery(query)
    const needle = options.query.toLowerCase()
    const items = this.state.favorites.filter(item => (!options.room || item.room === options.room)
      && (!options.uid || item.uid === options.uid) && (!needle || item.text.toLowerCase().includes(needle)
        || item.username?.toLowerCase().includes(needle)))
    const start = (options.page - 1) * options.pageSize
    return { items: items.slice(start, start + options.pageSize).map(item => ({ ...item })), total: items.length,
      page: options.page, pageSize: options.pageSize, hasMore: start + options.pageSize < items.length }
  }

  addFavorite(input: AddFavoriteDanmaku): FavoriteDanmaku {
    const content = favoriteInput(input)
    const existing = this.state.favorites.find(item => item.text === content.text && item.room === content.room && item.uid === content.uid)
    if (existing) return { ...existing }
    if (this.state.favorites.length >= MAX_DANMAKU_FAVORITES) throw new DanmakuFeaturesError('favorite-limit')
    const id = this.id()
    const createdAt = this.now()
    if (!text(id, 160) || this.state.favorites.some(item => item.id === id) || !Number.isSafeInteger(createdAt) || createdAt < 0) throw new DanmakuFeaturesError('invalid-arguments')
    const favorite = { ...content, id, createdAt }
    this.persist({ ...this.state, favorites: [favorite, ...this.state.favorites] })
    return { ...favorite }
  }

  updateFavorite(id: string, patch: { text: string }): FavoriteDanmaku {
    const value = dataFields(patch, ['text'])
    if (!text(value.text, 2_000)) throw new DanmakuFeaturesError('invalid-arguments')
    const existing = this.state.favorites.find(item => item.id === id)
    if (!existing) throw new DanmakuFeaturesError('not-found')
    const favorite = { ...existing, text: value.text }
    this.persist({ ...this.state, favorites: this.state.favorites.map(item => item.id === id ? favorite : item) })
    return { ...favorite }
  }

  removeFavorite(id: string): void {
    if (!text(id, 160)) throw new DanmakuFeaturesError('invalid-arguments')
    if (!this.state.favorites.some(item => item.id === id)) throw new DanmakuFeaturesError('not-found')
    this.persist({ ...this.state, favorites: this.state.favorites.filter(item => item.id !== id) })
  }

  dispose(): void { this.history.clear(); this.deliveries.clear(); this.listeners.clear() }

  private persist(next: DanmakuFeaturesStorage): void {
    // Save a detached snapshot first. Failed disk writes must not change in-memory preferences.
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_STORE_BYTES) throw new DanmakuFeaturesError('favorite-limit')
    try { this.options.save(readStored(next)) } catch { throw new DanmakuFeaturesError('storage-failed') }
    this.state = readStored(next)
    for (const listener of this.listeners) try { listener(this.snapshot()) } catch { /* Ignore destroyed subscribers. */ }
  }
}
