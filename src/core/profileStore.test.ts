import { beforeEach, describe, expect, it } from 'vitest'

import { packBitmap } from './bitmapCodec'
import { CLOCK_CHARS, TEMPLATE_PIXELS } from './profileSchema'
import { createEmptyHudStylePack, type HudStylePack } from './hudStylePack'
import { ProfileStore } from './profileStore'

function withTemplates(id = 'cs2/store'): HudStylePack {
  const profile = createEmptyHudStylePack(id, '存储测试')
  const mask = new Uint8Array(TEMPLATE_PIXELS)
  mask.fill(255, 0, 200)
  for (const char of CLOCK_CHARS) {
    const id = `glyph-${char === ':' ? 'colon' : char}`
    profile.bitmaps[id] = { width: 32, height: 48, data: packBitmap(mask) }
    profile.variants[0]!.fields.clock!.glyphs[char] = [id]
  }
  return profile
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
    expect(loaded?.variants[0]?.fields.clock?.glyphs['0']).toHaveLength(1)
  })

  it('stamps updatedAt on save', async () => {
    const saved = await store.save(withTemplates())
    expect(saved.updatedAt).toBeGreaterThan(0)
    expect(saved.profile).not.toHaveProperty('updatedAt')
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

  it.each([1, 2])('rejects old v%s profiles without migrating them', async version => {
    await expect(store.save({ schemaVersion: version, id: 'cs2/old', templates: {} } as unknown as HudStylePack)).rejects.toThrow('重新制作')
    expect(await store.list()).toHaveLength(0)
  })

  it('rejects an invalid pack before writing it', async () => {
    const invalid = withTemplates()
    invalid.variants[0]!.fields.clock!.roi.w = 0
    await expect(store.save(invalid)).rejects.toThrow('roi.w')
    expect(await store.list()).toHaveLength(0)
  })

  it('snapshots the submitted pack before the database opens', async () => {
    const pack = withTemplates()
    const pending = store.save(pack)
    pack.name = 'Changed after save'
    await pending
    expect((await store.get(pack.id))?.name).toBe('存储测试')
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
