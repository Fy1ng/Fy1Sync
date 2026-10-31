/** IndexedDB persistence for strictly validated HUD style packs. */

import { parseHudStylePack, type HudStylePack } from './hudStylePack'

/** Keep the database name stable; old profile rows are rejected on read. */
const DB_NAME = 'stream-sync-player'
const DB_VERSION = 1
const STORE = 'profiles'

export interface StoredProfile {
  id: string
  profile: HudStylePack
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

  async get(id: string): Promise<HudStylePack | null> {
    const row = await runTransaction<StoredProfile | undefined>('readonly', (store) =>
      store.get(id) as IDBRequest<StoredProfile | undefined>,
    )
    return row ? (sanitize(row)?.profile ?? null) : null
  }

  async save(profile: HudStylePack): Promise<StoredProfile> {
    const parsed = parseHudStylePack(profile)
    if (!parsed.pack) throw new Error(parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '))
    const record: StoredProfile = {
      id: profile.id,
      profile: structuredClone(parsed.pack),
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
}

/** Rows written by an older build (or a corrupted one) must not crash the editor. */
function sanitize(row: StoredProfile | undefined): StoredProfile | null {
  if (!row || typeof row.id !== 'string') return null
  const parsed = parseHudStylePack(row.profile as unknown)
  if (!parsed.pack || row.id !== parsed.pack.id) return null
  return { id: row.id, profile: parsed.pack, updatedAt: row.updatedAt ?? 0 }
}

export const profileStore = new ProfileStore()
