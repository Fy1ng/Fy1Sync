import { randomUUID } from 'node:crypto'
import { parseSourceInput } from '../src/core/mediaSources'
import type { SavedRoom } from './featureContracts'
import { PrivateJsonStore } from './privateJsonStore'
import type { PrivatePermissions } from './privateStorage'

export interface SavedRoomsStorage { version: 1; rooms: SavedRoom[] }
export interface SavedRoomsOptions {
  store?: { load(): unknown; save(value: SavedRoomsStorage): void }
  permissions?: PrivatePermissions
  now?: () => number
  id?: () => string
}

export const MAX_SAVED_ROOMS = 100
const PLATFORMS = new Set(['youtube', 'twitch', 'douyu', 'bilibili', 'huya', 'direct'])
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)

export class SavedRoomsError extends Error {
  constructor(readonly code: 'invalid-arguments' | 'room-limit' | 'storage-failed') {
    super({ 'invalid-arguments': '收藏直播间参数无效.', 'room-limit': '最多收藏100个直播间, 请先删除部分收藏.',
      'storage-failed': '直播间收藏保存失败, 请重试.' }[code])
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

function content(raw: unknown): Omit<SavedRoom, 'id' | 'savedAt'> {
  const value = fields(raw, ['role', 'input', 'platform', 'label'])
  if ((value.role !== 'official' && value.role !== 'commentary') || !text(value.input, 500)
    || !text(value.label, 100) || typeof value.platform !== 'string' || !PLATFORMS.has(value.platform)) {
    throw new SavedRoomsError('invalid-arguments')
  }
  const input = value.input.trim()
  // Only reusable network sources are eligible. In-app fixtures and filesystem paths are not.
  if (/^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|[a-z]:[\\/])/i.test(input)
    || (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:\/\//i.test(input))) {
    throw new SavedRoomsError('invalid-arguments')
  }
  const parsed = parseSourceInput(input)
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
    const record = fields(descriptor.value, ['id', 'role', 'input', 'platform', 'label', 'savedAt'])
    const source = content({ role: record.role, input: record.input, platform: record.platform, label: record.label })
    const key = JSON.stringify([source.role, source.platform, source.input])
    if (!text(record.id, 160) || ids.has(record.id) || sources.has(key)
      || typeof record.savedAt !== 'number' || !Number.isSafeInteger(record.savedAt) || record.savedAt < 0) throw new Error()
    ids.add(record.id)
    sources.add(key)
    rooms.push({ ...source, id: record.id, savedAt: record.savedAt })
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
    this.store = options.store ?? new PrivateJsonStore<SavedRoomsStorage>(root, 'rooms/saved.json', options.permissions)
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
    return this.rooms.map(room => ({ ...room })).sort((left, right) => right.savedAt - left.savedAt)
  }

  save(input: unknown): SavedRoom {
    const source = content(input)
    const existing = this.rooms.find(room => room.role === source.role && room.platform === source.platform && room.input === source.input)
    if (existing) {
      const updated = { ...existing, label: source.label }
      this.persist(this.rooms.map(room => room.id === existing.id ? updated : room))
      return { ...updated }
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

  private persist(rooms: SavedRoom[]): void {
    const next: SavedRoomsStorage = { version: 1, rooms: rooms.map(room => ({ ...room })) }
    try { this.store.save(next) } catch { throw new SavedRoomsError('storage-failed') }
    this.rooms = rooms.map(room => ({ ...room }))
  }
}
