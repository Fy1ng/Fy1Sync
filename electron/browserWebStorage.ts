import fs from 'node:fs/promises'
import path from 'node:path'
import type { DiscoveredBrowserProfile } from './browserProfiles'
import { importAbort } from './browserImportError'
import { readLevelDbEntries, snappyUncompress } from './leveldbReader'

export interface BrowserOriginStorageEntry {
  origin: string
  source: 'local-storage' | 'indexed-db'
  values: Record<string, string>
}

export interface BrowserWebStorageQuery {
  hostSuffix: string
  keys: readonly string[]
  idbDatabase?: string
  idbStore?: string
}

const MAX_VALUE_CHARS = 32768
const MAX_SQLITE_BYTES = 32 * 1024 * 1024

function hostMatches(host: string, suffix: string): boolean {
  const clean = host.toLowerCase()
  const base = suffix.replace(/^\./, '').toLowerCase()
  if (!clean || clean.length > 253 || !clean.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part) && part.length <= 63)) {
    return false
  }
  return clean === base || clean.endsWith(`.${base}`)
}

function allowedHttpsOrigin(raw: string, suffix: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null
    return hostMatches(url.hostname, suffix) ? url.origin : null
  } catch { return null }
}

function parseChromiumStorageScope(scope: string, suffix: string): string | null {
  const parts = scope.split('/^')
  const origin = allowedHttpsOrigin(parts[0]!, suffix)
  if (!origin) return null
  for (const field of parts.slice(1)) {
    if (field.startsWith('0')) {
      if (!allowedHttpsOrigin(field.slice(1), suffix)) return null
    }
  }
  return origin
}

function decodeDomStorageString(buf: Buffer): string | null {
  if (!buf.length) return null
  const tag = buf[0]!
  const body = buf.subarray(1)
  if (tag === 1) {
    if (body.length > MAX_VALUE_CHARS) return null
    return body.toString('latin1')
  }
  if (tag === 0) {
    if (body.length % 2 !== 0 || body.length > MAX_VALUE_CHARS * 2) return null
    return body.toString('utf16le')
  }
  return null
}

function varint(buf: Uint8Array, offset: number): { value: number; next: number } | null {
  let result = 0
  for (let shift = 0; shift <= 28 && offset < buf.length; shift += 7) {
    const byte = buf[offset++]!
    if (shift === 28 && byte > 0x0f) return null
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result >>> 0, next: offset }
  }
  return null
}

function decodeLittleInt(buf: Uint8Array): number | null {
  if (buf.length > 6) return null
  let value = 0
  for (let i = buf.length - 1; i >= 0; i--) value = value * 256 + buf[i]!
  return Number.isSafeInteger(value) ? value : null
}

function decodeUtf16BeWithLength(buf: Uint8Array, offset: number): { value: string; next: number } | null {
  const len = varint(buf, offset)
  if (!len || len.value > MAX_VALUE_CHARS) return null
  const byteLen = len.value * 2
  if (len.next + byteLen > buf.length) return null
  let out = ''
  for (let pos = len.next; pos < len.next + byteLen; pos += 2) {
    out += String.fromCharCode((buf[pos]! << 8) | buf[pos + 1]!)
  }
  return { value: out, next: len.next + byteLen }
}

function decodeBlinkStringValue(buf: Buffer): string | null {
  const version = varint(buf, 0)
  if (!version) return null
  let pos = version.next
  if (pos >= buf.length || buf[pos] !== 0xff) return null
  const blinkVer = varint(buf, pos + 1)
  if (!blinkVer) return null
  pos = blinkVer.next
  while (pos < buf.length && buf[pos] !== 0xff) {
    if (buf[pos] === 0xfe) {
      if (pos + 13 > buf.length) return null
      pos += 13
    } else if (buf[pos] === 0x00) {
      pos += 1
    } else return null
  }
  if (pos >= buf.length || buf[pos] !== 0xff) return null
  const v8Ver = varint(buf, pos + 1)
  if (!v8Ver) return null
  pos = v8Ver.next
  while (pos < buf.length && buf[pos] === 0x00) pos++
  if (pos >= buf.length) return null
  const tag = buf[pos++]!
  if (tag === 0x22) {
    const byteLen = varint(buf, pos)
    if (!byteLen || byteLen.value > MAX_VALUE_CHARS || byteLen.next + byteLen.value > buf.length) return null
    return buf.subarray(byteLen.next, byteLen.next + byteLen.value).toString('latin1')
  }
  if (tag === 0x63) {
    const byteLen = varint(buf, pos)
    if (!byteLen || byteLen.value % 2 !== 0 || byteLen.value > MAX_VALUE_CHARS * 2 || byteLen.next + byteLen.value > buf.length) return null
    return buf.subarray(byteLen.next, byteLen.next + byteLen.value).toString('utf16le')
  }
  return null
}

async function readChromiumLocalStorage(profileDir: string, query: BrowserWebStorageQuery, signal?: AbortSignal): Promise<BrowserOriginStorageEntry[]> {
  const keySet = new Set(query.keys)
  const leveldbDir = path.join(profileDir, 'Local Storage', 'leveldb')
  const entries = await readLevelDbEntries(leveldbDir, signal)
  const grouped = new Map<string, Record<string, string>>()
  for (const entry of entries) {
    if (entry.key.length < 4 || entry.key[0] !== 0x5f) continue
    const sep = entry.key.indexOf(0x00, 1)
    if (sep < 2 || sep + 1 >= entry.key.length) continue
    const scope = entry.key.subarray(1, sep).toString('latin1')
    const origin = parseChromiumStorageScope(scope, query.hostSuffix)
    if (!origin) continue
    const itemKey = decodeDomStorageString(entry.key.subarray(sep + 1))
    if (!itemKey || !keySet.has(itemKey)) continue
    const itemValue = decodeDomStorageString(entry.value)
    if (itemValue === null || itemValue.length > MAX_VALUE_CHARS) continue
    let bucket = grouped.get(origin)
    if (!bucket) { bucket = {}; grouped.set(origin, bucket) }
    bucket[itemKey] = itemValue
  }
  return [...grouped.entries()].map(([origin, values]) => ({ origin, source: 'local-storage', values }))
}

async function readChromiumIndexedDb(profileDir: string, query: BrowserWebStorageQuery, signal?: AbortSignal): Promise<BrowserOriginStorageEntry[]> {
  if (!query.idbDatabase || !query.idbStore) return []
  const idbRoot = path.join(profileDir, 'IndexedDB')
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>
  try { rootStat = await fs.lstat(idbRoot) } catch { return [] }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return []

  const names = await fs.readdir(idbRoot).catch(() => [] as string[])
  const keySet = new Set(query.keys)
  const results: BrowserOriginStorageEntry[] = []

  for (const dirName of names) {
    importAbort(signal)
    const match = /^https_([a-z0-9.-]+)_0\.indexeddb\.leveldb$/i.exec(dirName)
    if (!match || !hostMatches(match[1]!, query.hostSuffix)) continue
    const origin = `https://${match[1]!.toLowerCase()}`
    const entries = await readLevelDbEntries(path.join(idbRoot, dirName), signal)
    let targetDbId: number | null = null
    const storeIds = new Map<string, number>()

    const parsed = entries.flatMap(entry => {
      if (entry.key.length < 4) return []
      const b0 = entry.key[0]!
      const dbBytes = ((b0 & 0xe0) >>> 5) + 1
      const storeBytes = ((b0 & 0x1c) >>> 2) + 1
      const indexBytes = (b0 & 0x03) + 1
      const headerLen = 1 + dbBytes + storeBytes + indexBytes
      if (headerLen > entry.key.length) return []
      const dbId = decodeLittleInt(entry.key.subarray(1, 1 + dbBytes))
      const storeId = decodeLittleInt(entry.key.subarray(1 + dbBytes, 1 + dbBytes + storeBytes))
      const indexId = decodeLittleInt(entry.key.subarray(1 + dbBytes + storeBytes, headerLen))
      if (dbId === null || storeId === null || indexId === null) return []
      return [{ dbId, storeId, indexId, rest: entry.key.subarray(headerLen), value: entry.value }]
    })

    for (const row of parsed) {
      if (row.dbId === 0 && row.storeId === 0 && row.indexId === 0 && row.rest[0] === 201) {
        const originPart = decodeUtf16BeWithLength(row.rest, 1)
        const dbName = originPart ? decodeUtf16BeWithLength(row.rest, originPart.next) : null
        const id = varint(row.value, 0)?.value ?? decodeLittleInt(row.value)
        if (dbName?.value === query.idbDatabase && id && id > 0) targetDbId = id
      }
    }
    if (!targetDbId) continue

    for (const row of parsed) {
      if (row.dbId === targetDbId && row.storeId === 0 && row.indexId === 0 && row.rest[0] === 200) {
        const storeName = decodeUtf16BeWithLength(row.rest, 1)
        const id = varint(row.value, 0)?.value ?? decodeLittleInt(row.value)
        if (storeName?.value && id && id > 0) storeIds.set(storeName.value, id)
      }
    }
    const targetStoreId = storeIds.get(query.idbStore)
    if (!targetStoreId) continue

    const values: Record<string, string> = {}
    for (const row of parsed) {
      if (row.dbId !== targetDbId || row.storeId !== targetStoreId || row.indexId !== 1 || row.rest[0] !== 1) continue
      const decodedKey = decodeUtf16BeWithLength(row.rest, 1)
      if (!decodedKey || !keySet.has(decodedKey.value)) continue
      const decodedValue = decodeBlinkStringValue(row.value)
      if (decodedValue !== null && decodedValue.length <= MAX_VALUE_CHARS) values[decodedKey.value] = decodedValue
    }
    if (Object.keys(values).length) results.push({ origin, source: 'indexed-db', values })
  }
  return results
}

function parseFirefoxOriginDir(name: string, suffix: string): string | null {
  const [base, attr] = name.split('^', 2)
  const match = /^https\+\+\+([a-z0-9.-]+)$/i.exec(base ?? '')
  if (!match || !hostMatches(match[1]!, suffix)) return null
  if (attr) {
    if (attr.includes('userContextId=')) return null
    const partMatch = /(?:^|&)partitionKey=([^&]+)/.exec(attr)
    if (partMatch) {
      try {
        const decoded = decodeURIComponent(partMatch[1]!)
        const siteMatch = /^\(https,([a-z0-9.-]+)\)$/i.exec(decoded)
        if (!siteMatch || !hostMatches(siteMatch[1]!, suffix)) return null
      } catch { return null }
    }
  }
  return `https://${match[1]!.toLowerCase()}`
}

async function readFirefoxStorage(profileDir: string, query: BrowserWebStorageQuery, signal?: AbortSignal): Promise<BrowserOriginStorageEntry[]> {
  const results: BrowserOriginStorageEntry[] = []
  const { DatabaseSync } = await import('node:sqlite')
  const defaultRoot = path.join(profileDir, 'storage', 'default')
  const dirs = await fs.readdir(defaultRoot).catch(() => [] as string[])
  const placeholders = query.keys.map(() => '?').join(', ')

  for (const dirName of dirs) {
    importAbort(signal)
    const origin = parseFirefoxOriginDir(dirName, query.hostSuffix)
    if (!origin) continue
    const dbFile = path.join(defaultRoot, dirName, 'ls', 'data.sqlite')
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try { stat = await fs.lstat(dbFile) } catch { continue }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SQLITE_BYTES) continue
    let db: InstanceType<typeof DatabaseSync> | undefined
    try {
      db = new DatabaseSync(dbFile, { readOnly: true })
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500')
      const rows = db.prepare(`SELECT key, conversion_type, compression_type, value FROM data WHERE key IN (${placeholders})`).all(...query.keys)
      const values: Record<string, string> = {}
      for (const row of rows) {
        const key = String(row.key ?? '')
        const rawBytes = row.value instanceof Uint8Array ? Buffer.from(row.value)
          : typeof row.value === 'string' ? Buffer.from(row.value, 'utf8') : null
        if (!rawBytes) continue
        const compression = Number(row.compression_type ?? 0)
        const uncompressed = compression === 0 ? rawBytes : compression === 1 ? snappyUncompress(rawBytes, MAX_VALUE_CHARS * 2) : null
        if (!uncompressed) continue
        const conversion = Number(row.conversion_type ?? 1)
        const text = conversion === 0
          ? (uncompressed.length % 2 === 0 ? uncompressed.toString('utf16le') : null)
          : uncompressed.toString('latin1')
        if (text !== null && text.length <= MAX_VALUE_CHARS) values[key] = text
      }
      if (Object.keys(values).length) results.push({ origin, source: 'local-storage', values })
    } catch { /* Optional storage files never fail cookie import. */ }
    finally { db?.close() }
  }

  importAbort(signal)
  const legacyFile = path.join(profileDir, 'webappsstore.sqlite')
  let legacyStat: Awaited<ReturnType<typeof fs.lstat>> | null = null
  try { legacyStat = await fs.lstat(legacyFile) } catch { legacyStat = null }
  if (legacyStat?.isFile() && !legacyStat.isSymbolicLink() && legacyStat.size <= MAX_SQLITE_BYTES) {
    let db: InstanceType<typeof DatabaseSync> | undefined
    try {
      db = new DatabaseSync(legacyFile, { readOnly: true })
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500')
      const rows = db.prepare(`SELECT originKey, key, value FROM webappsstore2 WHERE key IN (${placeholders}) LIMIT 256`).all(...query.keys)
      const grouped = new Map<string, Record<string, string>>()
      for (const row of rows) {
        const originKey = String(row.originKey ?? '')
        const parsed = /^([^:]+):https:443$/.exec(originKey)
        if (!parsed) continue
        const reversed = parsed[1]!.replace(/\.$/, '')
        const host = [...reversed].reverse().join('').toLowerCase()
        if (!hostMatches(host, query.hostSuffix)) continue
        const value = String(row.value ?? '')
        if (value.length > MAX_VALUE_CHARS) continue
        const origin = `https://${host}`
        let bucket = grouped.get(origin)
        if (!bucket) { bucket = {}; grouped.set(origin, bucket) }
        bucket[String(row.key ?? '')] = value
      }
      for (const [origin, values] of grouped) results.push({ origin, source: 'local-storage', values })
    } catch { /* Ignore unreadable legacy Firefox store. */ }
    finally { db?.close() }
  }
  return results
}

export async function readBrowserWebStorage(
  profile: Pick<DiscoveredBrowserProfile, 'browser' | 'directory'>,
  query: BrowserWebStorageQuery,
  signal?: AbortSignal,
): Promise<BrowserOriginStorageEntry[]> {
  importAbort(signal)
  if (!query.keys.length) return []
  try {
    if (profile.browser === 'firefox') return await readFirefoxStorage(profile.directory, query, signal)
    const local = await readChromiumLocalStorage(profile.directory, query, signal)
    importAbort(signal)
    const idb = await readChromiumIndexedDb(profile.directory, query, signal)
    importAbort(signal)
    return [...local, ...idb]
  } catch (error) {
    importAbort(signal)
    void error
    return []
  }
}

export function eraseBrowserWebStorage(entries: BrowserOriginStorageEntry[] | undefined): void {
  if (!entries) return
  for (const entry of entries) {
    for (const key of Object.keys(entry.values)) entry.values[key] = ''
  }
}
