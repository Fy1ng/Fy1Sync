import { randomUUID } from 'node:crypto'
import { parseSourceInput } from '../src/core/mediaSources'
import { parseDouyinInput } from '../src/core/douyinInput'
import type { SavedRoom, SavedRoomMetadata, SaveRoomInput } from './featureContracts'
import { savedRoomInput, savedRoomKey } from '../src/core/savedRoomIdentity'
import { PrivateJsonStore } from './privateJsonStore'

export interface SavedRoomsStorage { version: 1; rooms: SavedRoom[] }
export interface SavedRoomsOptions {
  store?: { load(): unknown; save(value: SavedRoomsStorage): void }
  now?: () => number
  id?: () => string
}

export const MAX_SAVED_ROOMS = 100
const PLATFORMS = new Set(['youtube', 'twitch', 'douyu', 'bilibili', 'huya', 'douyin', 'direct'])
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)

export class SavedRoomsError extends Error {
  constructor(readonly code: 'invalid-arguments' | 'room-limit' | 'storage-failed') {
    super({ 'invalid-arguments': '收藏信息无效，请检查后重试', 'room-limit': '最多收藏 100 个直播间，请先取消部分收藏',
      'storage-failed': '直播间收藏保存失败，请重试' }[code])
    this.name = 'SavedRoomsError'
  }
}

function fields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null)
      || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !allowed.includes(key))) throw new Error()
    const result: Record<string, unknown> = {}
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)
      if (descriptor && !('value' in descriptor)) throw new Error()
      if (descriptor) result[key] = descriptor.value
    }
    return result
  } catch { throw new SavedRoomsError('invalid-arguments') }
}

function content(raw: unknown): SaveRoomInput {
  const value = fields(raw, ['role', 'input', 'platform', 'label'])
  if ((value.role !== 'official' && value.role !== 'commentary') || !text(value.input, 500)
    || !text(value.label, 100) || typeof value.platform !== 'string' || !PLATFORMS.has(value.platform)) {
    throw new SavedRoomsError('invalid-arguments')
  }
  let input = value.input.trim()
  if (value.platform === 'douyin') {
    const selected = parseDouyinInput(input.replace(/^(?:douyin|抖音)\s*[:：]?\s*/i, ''))
    if (!selected) throw new SavedRoomsError('invalid-arguments')
    input = selected.url
  }
  // Only reusable network sources are eligible. In-app fixtures and filesystem paths are not.
  if (/^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|[a-z]:[\\/])/i.test(input)
    || (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:\/\//i.test(input))) {
    throw new SavedRoomsError('invalid-arguments')
  }
  const parsed = parseSourceInput(savedRoomInput(value.platform, input))
  if (!parsed.ok || parsed.platform !== value.platform || !PLATFORMS.has(parsed.platform)) {
    throw new SavedRoomsError('invalid-arguments')
  }
  return { role: value.role, input: value.input, platform: value.platform, label: value.label }
}

function storedRooms(raw: unknown): SavedRoom[] {
  const value = fields(raw, ['version', 'rooms'])
  if (value.version !== 1 || !Array.isArray(value.rooms) || value.rooms.length > MAX_SAVED_ROOMS
    || Object.getPrototypeOf(value.rooms) !== Array.prototype
    || Reflect.ownKeys(value.rooms).length !== value.rooms.length + 1) throw new Error()
  const ids = new Set<string>(), sources = new Set<string>()
  const rooms: SavedRoom[] = []
  for (let index = 0; index < value.rooms.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.rooms, String(index))
    if (!descriptor || !('value' in descriptor)) throw new Error()
    const record = fields(descriptor.value, ['id', 'role', 'input', 'platform', 'label', 'savedAt', 'metadata', 'lastAttemptAt', 'refreshError'])
    const source = content({ role: record.role, input: record.input, platform: record.platform, label: record.label })
    const key = JSON.stringify([source.role, source.platform, source.input])
    if (!text(record.id, 160) || ids.has(record.id) || sources.has(key)
      || typeof record.savedAt !== 'number' || !Number.isSafeInteger(record.savedAt) || record.savedAt < 0) throw new Error()
    ids.add(record.id)
    sources.add(key)
    const room: SavedRoom = { ...source, id: record.id, savedAt: record.savedAt }
    if (record.metadata !== undefined) room.metadata = validateMetadata(record.metadata)
    if (record.lastAttemptAt !== undefined) {
      if (!timestamp(record.lastAttemptAt)) throw new Error()
      room.lastAttemptAt = record.lastAttemptAt
    }
    if (record.refreshError !== undefined) {
      if (record.refreshError !== null && !text(record.refreshError, 300)) throw new Error()
      room.refreshError = record.refreshError as string | null
    }
    rooms.push(room)
  }
  return rooms
}

/** Main-process favorites with private atomic persistence and detached public snapshots. */
export class SavedRoomsStore {
  private rooms: SavedRoom[] = []
  private readonly store: { load(): unknown; save(value: SavedRoomsStorage): void }
  private readonly now: () => number
  private readonly id: () => string

  constructor(root: string, options: SavedRoomsOptions = {}) {
    this.store = options.store ?? new PrivateJsonStore<SavedRoomsStorage>(root, 'rooms/saved.json')
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
    try {
      const raw = this.store.load()
      if (raw !== undefined) this.rooms = storedRooms(raw)
    } catch {
      // Recover without rewriting the damaged file. Only an explicit later mutation replaces it.
      this.rooms = []
    }
  }

  list(): SavedRoom[] {
    return structuredClone(this.rooms).sort((left, right) => right.savedAt - left.savedAt)
  }

  save(input: unknown): SavedRoom {
    const source = content(input)
    const key = savedRoomKey(source.platform, source.input)
    const existing = this.rooms.find(room => room.role === source.role && room.platform === source.platform
      && (savedRoomKey(room.platform, room.input) === key || (room.metadata && savedRoomKey(room.platform, room.metadata.url) === key)))
    if (existing) {
      const updated = { ...existing, label: source.label }
      this.persist(this.rooms.map(room => room.id === existing.id ? updated : room))
      return structuredClone(updated)
    }
    if (this.rooms.length >= MAX_SAVED_ROOMS) throw new SavedRoomsError('room-limit')
    const id = this.id(), savedAt = this.now()
    if (!text(id, 160) || this.rooms.some(room => room.id === id) || !Number.isSafeInteger(savedAt) || savedAt < 0) {
      throw new SavedRoomsError('invalid-arguments')
    }
    const room = { ...source, id, savedAt }
    this.persist([...this.rooms, room])
    return { ...room }
  }

  remove(input: unknown): { removed: boolean } {
    const { id } = fields(input, ['id'])
    if (!text(id, 160)) throw new SavedRoomsError('invalid-arguments')
    if (!this.rooms.some(room => room.id === id)) return { removed: false }
    this.persist(this.rooms.filter(room => room.id !== id))
    return { removed: true }
  }

  /** A failed attempt never replaces the last successful metadata snapshot. */
  recordAttempt(id: string, attemptedAt: number, result: SavedRoomMetadata | string): void {
    const current = this.rooms.find(room => room.id === id)
    if (!current) return
    if (!timestamp(attemptedAt)) throw new SavedRoomsError('invalid-arguments')
    const updated: SavedRoom = { ...current, lastAttemptAt: attemptedAt, refreshError: typeof result === 'string' ? result : null }
    if (typeof result !== 'string') {
      updated.metadata = validateMetadata(result)
      const canonical = savedRoomKey(current.platform, result.url)
      const aliases = this.rooms.filter(room => room.role === current.role && room.platform === current.platform
        && (room.id === id || savedRoomKey(room.platform, room.metadata?.url ?? room.input) === canonical))
      if (aliases.length > 1) {
        const kept = aliases.reduce((left, right) => left.savedAt <= right.savedAt ? left : right)
        const removed = new Set(aliases.filter(room => room.id !== kept.id).map(room => room.id))
        this.persist(this.rooms.filter(room => !removed.has(room.id)).map(room => room.id === kept.id ? { ...kept, metadata: updated.metadata, lastAttemptAt: attemptedAt, refreshError: null } : room))
        return
      }
    }
    this.persist(this.rooms.map(room => room.id === id ? updated : room))
  }

  private persist(rooms: SavedRoom[]): void {
    const next: SavedRoomsStorage = { version: 1, rooms: structuredClone(rooms) }
    try { this.store.save(next) } catch { throw new SavedRoomsError('storage-failed') }
    this.rooms = structuredClone(rooms)
  }
}

const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function validateMetadata(raw: unknown): SavedRoomMetadata {
  const row = fields(raw, ['roomId', 'url', 'nickname', 'avatarUrl', 'title', 'coverUrl', 'status', 'lastStartedAt', 'startTimeSource', 'collectedAt'])
  const optionalText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
  const image = (value: unknown) => value === null || (typeof value === 'string' && /^\/room-image\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/.test(value))
  if (!text(row.roomId, 160) || !text(row.url, 500) || !/^https:\/\//.test(row.url)
    || !optionalText(row.nickname, 200) || !optionalText(row.title, 500) || !image(row.avatarUrl) || !image(row.coverUrl)
    || !['live', 'offline', 'replay', 'unknown'].includes(String(row.status)) || !timestamp(row.collectedAt)
    || (row.lastStartedAt !== null && (!timestamp(row.lastStartedAt) || row.lastStartedAt > row.collectedAt))
    || ![null, 'platform', 'observed'].includes(row.startTimeSource as null)
    || ((row.lastStartedAt === null) !== (row.startTimeSource === null))) throw new SavedRoomsError('invalid-arguments')
  return structuredClone(row) as unknown as SavedRoomMetadata
}
