/**
 * Local persistence for recognition profiles.
 *
 * IndexedDB, not localStorage: a profile with multi-sample templates for eleven
 * characters is hundreds of kilobytes of base64, which crowds a 5 MB localStorage
 * quota shared with every other setting. An earlier build did use localStorage, so
 * `migrateLegacy` moves anything it finds there once and marks it done.
 */

import { parseProfile, type RecognitionProfile } from './profileSchema'

/**
 * Kept as-is deliberately. Renaming the database to match the package name would orphan
 * every unpublished draft already sitting in a user's browser, and the name is invisible
 * outside devtools — not worth a migration to fix a cosmetic mismatch.
 */
const DB_NAME = 'stream-sync-player'
const DB_VERSION = 1
const STORE = 'profiles'
export const LEGACY_KEY = 'stream-sync.profile.draft'
export const LEGACY_DONE_KEY = 'stream-sync.profile.migrated'

export interface StoredProfile {
  id: string
  profile: RecognitionProfile
  updatedAt: number
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'))
    request.onblocked = () => reject(new Error('本地数据库被其他标签页占用'))
  })
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = body(transaction.objectStore(STORE))
        transaction.oncomplete = () => {
          db.close()
          resolve(request.result)
        }
        transaction.onerror = () => {
          db.close()
          reject(transaction.error ?? new Error('本地数据库操作失败'))
        }
        transaction.onabort = () => {
          db.close()
          reject(transaction.error ?? new Error('本地数据库操作被中断'))
        }
      }),
  )
}

export class ProfileStore {
  async list(): Promise<StoredProfile[]> {
    const rows = await runTransaction<StoredProfile[]>('readonly', (store) =>
      store.getAll() as IDBRequest<StoredProfile[]>,
    )
    return rows
      .map((row) => sanitize(row))
      .filter((row): row is StoredProfile => row !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<RecognitionProfile | null> {
    const row = await runTransaction<StoredProfile | undefined>('readonly', (store) =>
      store.get(id) as IDBRequest<StoredProfile | undefined>,
    )
    return row ? (sanitize(row)?.profile ?? null) : null
  }

  async save(profile: RecognitionProfile): Promise<StoredProfile> {
    const record: StoredProfile = {
      id: profile.id,
      profile: { ...profile, updatedAt: Date.now() },
      updatedAt: Date.now(),
    }
    await runTransaction('readwrite', (store) => store.put(record))
    return record
  }

  async remove(id: string): Promise<void> {
    await runTransaction('readwrite', (store) => store.delete(id))
  }

  async clear(): Promise<void> {
    await runTransaction('readwrite', (store) => store.clear())
  }

  /**
   * Move a localStorage draft into IndexedDB. Runs at most once; a corrupt draft is
   * dropped rather than retried forever.
   */
  async migrateLegacy(storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>): Promise<
    { migrated: boolean; reason?: string }
  > {
    if (storage.getItem(LEGACY_DONE_KEY)) return { migrated: false }
    const raw = storage.getItem(LEGACY_KEY)
    if (!raw) {
      storage.setItem(LEGACY_DONE_KEY, '1')
      return { migrated: false }
    }
    try {
      const parsed = parseProfile(JSON.parse(raw) as unknown)
      if (!parsed.profile) {
        storage.setItem(LEGACY_DONE_KEY, '1')
        storage.removeItem(LEGACY_KEY)
        return { migrated: false, reason: parsed.issues[0]?.message ?? '旧数据无效' }
      }
      await this.save(parsed.profile)
      storage.setItem(LEGACY_DONE_KEY, '1')
      storage.removeItem(LEGACY_KEY)
      return { migrated: true }
    } catch (error) {
      storage.setItem(LEGACY_DONE_KEY, '1')
      storage.removeItem(LEGACY_KEY)
      return { migrated: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Rows written by an older build (or a corrupted one) must not crash the editor. */
function sanitize(row: StoredProfile | undefined): StoredProfile | null {
  if (!row || typeof row.id !== 'string') return null
  const parsed = parseProfile(row.profile as unknown)
  if (!parsed.profile) return null
  return { id: row.id, profile: parsed.profile, updatedAt: row.updatedAt ?? 0 }
}

export const profileStore = new ProfileStore()
