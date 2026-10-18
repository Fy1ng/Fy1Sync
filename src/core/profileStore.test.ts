import { beforeEach, describe, expect, it } from 'vitest'

import { packBitmap } from './bitmapCodec'
import { CLOCK_CHARS, createEmptyProfile, TEMPLATE_PIXELS, type RecognitionProfile } from './profileSchema'
import { LEGACY_DONE_KEY, LEGACY_KEY, ProfileStore } from './profileStore'

function withTemplates(id = 'cs2/store'): RecognitionProfile {
  const profile = createEmptyProfile(id, '存储测试')
  const mask = new Uint8Array(TEMPLATE_PIXELS)
  mask.fill(255, 0, 200)
  for (const char of CLOCK_CHARS) {
    profile.templates[char] = [{ id: `${char}-0`, data: packBitmap(mask), createdAt: 1 }]
  }
  return profile
}

class MemoryStorage implements Pick<Storage, 'getItem' | 'removeItem' | 'setItem'> {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

describe('ProfileStore', () => {
  let store: ProfileStore

  beforeEach(async () => {
    store = new ProfileStore()
    await store.clear()
  })

  it('round-trips a profile', async () => {
    const profile = withTemplates()
    await store.save(profile)
    const loaded = await store.get(profile.id)
    expect(loaded?.id).toBe(profile.id)
    expect(loaded?.templates['0']).toHaveLength(1)
  })

  it('stamps updatedAt on save', async () => {
    const saved = await store.save(withTemplates())
    expect(saved.updatedAt).toBeGreaterThan(0)
    expect(saved.profile.updatedAt).toBeGreaterThan(0)
  })

  it('returns null for a missing id', async () => {
    expect(await store.get('nope/nope')).toBeNull()
  })

  it('lists newest first', async () => {
    await store.save(withTemplates('cs2/one'))
    await new Promise((resolve) => setTimeout(resolve, 2))
    await store.save(withTemplates('cs2/two'))
    const rows = await store.list()
    expect(rows.map((row) => row.id)).toEqual(['cs2/two', 'cs2/one'])
  })

  it('overwrites an existing id instead of duplicating', async () => {
    const profile = withTemplates('cs2/same')
    await store.save(profile)
    await store.save({ ...profile, name: '改名' })
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.profile.name).toBe('改名')
  })

  it('removes a profile', async () => {
    const profile = withTemplates()
    await store.save(profile)
    await store.remove(profile.id)
    expect(await store.get(profile.id)).toBeNull()
  })

  it('migrates a localStorage draft once', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_KEY, JSON.stringify(withTemplates('cs2/legacy')))
    const first = await store.migrateLegacy(storage)
    expect(first.migrated).toBe(true)
    expect(await store.get('cs2/legacy')).not.toBeNull()
    expect(storage.getItem(LEGACY_KEY)).toBeNull()
    expect(storage.getItem(LEGACY_DONE_KEY)).toBe('1')

    // A second run must not re-import, even if a draft reappears.
    storage.setItem(LEGACY_KEY, JSON.stringify(withTemplates('cs2/again')))
    const second = await store.migrateLegacy(storage)
    expect(second.migrated).toBe(false)
    expect(await store.get('cs2/again')).toBeNull()
  })

  it('marks migration done when there is nothing to migrate', async () => {
    const storage = new MemoryStorage()
    const result = await store.migrateLegacy(storage)
    expect(result.migrated).toBe(false)
    expect(storage.getItem(LEGACY_DONE_KEY)).toBe('1')
  })

  it('discards an unparsable draft instead of retrying it forever', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_KEY, '{ not json')
    const result = await store.migrateLegacy(storage)
    expect(result.migrated).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(storage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('discards a draft that fails validation', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_KEY, JSON.stringify({ schemaVersion: 2, id: 'BAD ID' }))
    const result = await store.migrateLegacy(storage)
    expect(result.migrated).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(await store.list()).toHaveLength(0)
  })

  it('migrates a v1 draft through the schema migration', async () => {
    const storage = new MemoryStorage()
    const mask = new Uint8Array(TEMPLATE_PIXELS)
    mask.fill(255, 0, 120)
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        id: 'cs2/v1',
        name: 'V1 草稿',
        roi: { x: 0.4, y: 0.02, w: 0.2, h: 0.08 },
        clockFormat: 'm:ss',
        detectWindowSeconds: 3,
        sampleFps: 30,
        scale: 1.5,
        threshold: 140,
        invert: true,
        matchThreshold: 0.8,
        templates: Object.fromEntries(CLOCK_CHARS.map((char) => [char, packBitmap(mask)])),
      }),
    )
    const result = await store.migrateLegacy(storage)
    expect(result.migrated).toBe(true)
    const loaded = await store.get('cs2/v1')
    expect(loaded?.schemaVersion).toBe(2)
    expect(loaded?.preprocess).toMatchObject({ scale: 1.5, threshold: 140, invert: true })
    expect(loaded?.templates['5']?.[0]?.origin).toBe('v1')
  })

  it('skips rows that no longer validate', async () => {
    // Simulate a row written by a future/broken build.
    await store.save(withTemplates('cs2/good'))
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('stream-sync-player', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('profiles', 'readwrite')
      transaction.objectStore('profiles').put({ id: 'cs2/broken', profile: { nope: true }, updatedAt: 5 })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
    const rows = await store.list()
    expect(rows.map((row) => row.id)).toEqual(['cs2/good'])
  })
})
