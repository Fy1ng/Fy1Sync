/**
 * Server-side profile preset store.
 *
 * Profiles built in the Profile Editor live in the browser's IndexedDB; presets promoted
 * here are shared across browsers and survive a cleared profile. Writes are validated,
 * size-capped, conflict-checked with an ETag, backed up, and written atomically
 * (temp file + rename) so a crash mid-write cannot leave a truncated JSON file that
 * would break the editor on next load.
 */

import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  parseProfile,
  type ProfileIssue,
  type RecognitionProfile,
} from '../src/core/profileSchema'

/** A profile with several multi-sample templates is tens of KB; 2 MiB is generous. */
export const MAX_PRESET_BYTES = 2 * 1_048_576

export type PresetRecord = {
  id: string
  profile: RecognitionProfile
  updatedAt: number
  etag: string
}

export type SaveOutcome =
  | { ok: true; record: PresetRecord; created: boolean }
  | { ok: false; code: 'invalid'; issues: ProfileIssue[] }
  | { ok: false; code: 'too-large'; message: string }
  | { ok: false; code: 'conflict'; currentEtag: string }
  | { ok: false; code: 'io-error'; message: string }

/** Hex is case-stable on Windows; the prefix is outside the legacy ID alphabet. */
export function fileNameFor(id: string): string | null {
  if (id.length > 65 || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(id) || id.includes('..')) return null
  return `~${Buffer.from(id, 'utf8').toString('hex')}.json`
}

export function idFromFileName(fileName: string): string {
  if (fileName.startsWith('~')) {
    const match = /^~([a-f0-9]{2}(?:[a-f0-9]{2}){0,64})\.json$/i.exec(fileName)
    if (!match) return ''
    const id = Buffer.from(match[1]!, 'hex').toString('utf8')
    return fileNameFor(id)?.toLowerCase() === fileName.toLowerCase() ? id : ''
  }
  return fileName.replace(/\.json$/i, '').replace(/__/g, '/')
}

/** Existing files stay in place; their stored ID must also match before use. */
function legacyFileNameFor(id: string): string | null {
  if (!fileNameFor(id)) return null
  const fileName = `${id.replace(/\//g, '__')}.json`
  // These names address devices, not ordinary files, on Windows.
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName) ? null : fileName
}

/** Backups always use the encoded namespace, including for a legacy primary file. */
function backupNameFor(fileName: string): string {
  return fileName.replace(/\.json$/, '.bak.json')
}

const operations = new Map<string, Promise<void>>()

function directoryKey(directory: string): string {
  const suffix: string[] = []
  let parent = directory
  let physical = directory
  for (;;) {
    try { physical = join(realpathSync(parent), ...suffix); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) break
      suffix.unshift(basename(parent))
      parent = dirname(parent)
    }
  }
  return process.platform === 'win32' ? physical.toLowerCase() : physical
}

/** Share ordering across store instances; a failed operation cannot poison the queue. */
function ordered<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const key = directoryKey(directory)
  const pending = (operations.get(key) ?? Promise.resolve()).then(operation)
  const tail = pending.then(() => {}, () => {})
  operations.set(key, tail)
  void tail.then(() => { if (operations.get(key) === tail) operations.delete(key) })
  return pending
}

function sameFileName(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

type FileEntry = { exists: boolean; record: PresetRecord | null }
type OwnedEntry = { fileName: string; record: PresetRecord }

export function etagFor(profile: RecognitionProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 32)
}

export class PresetStore {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = resolve(dataDir, 'presets')
  }

  async list(): Promise<PresetRecord[]> {
    return ordered(this.dir, () => this.listEntries())
  }

  private async listEntries(): Promise<PresetRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return [] // No presets written yet.
    }

    const records = new Map<string, OwnedEntry>()
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue
      const { record } = await this.readFile(name)
      if (!record) continue
      const canonical = fileNameFor(record.id)!
      const legacy = legacyFileNameFor(record.id)
      // Old backups and misplaced files are not primary records. A legitimate
      // legacy ID ending in .bak remains visible when its own ID matches.
      if (!sameFileName(name, canonical) && (!legacy || !sameFileName(name, legacy))) continue
      if (!records.has(record.id) || sameFileName(name, canonical)) records.set(record.id, { fileName: name, record })
    }
    return [...records.values()].map(entry => entry.record).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<PresetRecord | null> {
    const fileName = fileNameFor(id)
    if (!fileName) return null
    return ordered(this.dir, async () => (await this.find(id))?.record ?? null)
  }

  async save(
    id: string,
    raw: unknown,
    expectedEtag?: string,
  ): Promise<SaveOutcome> {
    const fileName = fileNameFor(id)
    if (!fileName) {
      return {
        ok: false,
        code: 'invalid',
        issues: [
          {
            path: 'id',
            message: '预设 ID 只能包含小写字母、数字、点、下划线、短横线和斜杠',
            severity: 'error',
          },
        ],
      }
    }

    let serialized: string | undefined
    try { serialized = JSON.stringify(raw) } catch {
      return { ok: false, code: 'invalid', issues: [{ path: '', message: '预设无法序列化', severity: 'error' }] }
    }
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_PRESET_BYTES) {
      return { ok: false, code: 'too-large', message: `预设超过 ${MAX_PRESET_BYTES} 字节上限` }
    }

    // Snapshot caller-owned data before joining a queue that may await another write.
    const parsed = parseProfile(JSON.parse(serialized))
    if (!parsed.profile) {
      return { ok: false, code: 'invalid', issues: parsed.issues }
    }

    const validated = parsed.profile
    return ordered<SaveOutcome>(this.dir, async () => {
      try {
        const canonical = await this.readFile(fileName)
        if (canonical.exists && canonical.record?.id !== id) throw new Error('预设文件归属无法确认')
        const existing = await this.find(id)
        // A deleted record is also a stale edit, not an invitation to recreate it.
        if (expectedEtag !== undefined && existing?.record.etag !== expectedEtag) {
          return { ok: false, code: 'conflict', currentEtag: existing?.record.etag ?? '' }
        }
        const profile: RecognitionProfile = { ...validated, id, updatedAt: Date.now() }
        const record: PresetRecord = { id, profile, updatedAt: profile.updatedAt, etag: etagFor(profile) }
        await mkdir(this.dir, { recursive: true })
        if (existing) {
          const backupName = backupNameFor(fileName)
          const backup = await this.readFile(backupName)
          if (backup.exists && backup.record?.id !== id) throw new Error('预设备份归属无法确认')
          await this.atomicWrite(backupName, existing.record.profile)
        }
        await this.atomicWrite(existing?.fileName ?? fileName, profile)
        return { ok: true, record, created: existing === null }
      } catch {
        return { ok: false, code: 'io-error', message: '写入预设失败, 请检查文件后重试' }
      }
    })
  }

  async remove(id: string): Promise<boolean> {
    const fileName = fileNameFor(id)
    if (!fileName) return false
    return ordered(this.dir, async () => {
      const legacy = legacyFileNameFor(id)
      const candidates = [fileName, ...(legacy ? [legacy] : [])]
      let removed = false
      try {
        for (const name of candidates) {
          if ((await this.readFile(name)).record?.id !== id) continue
          await unlink(join(this.dir, name))
          removed = true
        }
        if (!removed) return false
        for (const name of candidates.map(backupNameFor)) {
          // An old backup path may instead hold another legitimate .bak ID.
          if ((await this.readFile(name)).record?.id === id) await unlink(join(this.dir, name))
        }
        return true
      } catch { return false }
    })
  }

  private async find(id: string): Promise<OwnedEntry | null> {
    const canonical = fileNameFor(id)!
    const legacy = legacyFileNameFor(id)
    for (const fileName of [canonical, ...(legacy ? [legacy] : [])]) {
      const { record } = await this.readFile(fileName)
      if (record?.id === id) return { fileName, record }
    }
    return null
  }

  private async atomicWrite(fileName: string, profile: RecognitionProfile): Promise<void> {
    const target = join(this.dir, fileName)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(profile, null, 2), 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, target)
    } finally { await unlink(temporary).catch(() => {}) }
  }

  private async readFile(fileName: string): Promise<FileEntry> {
    try {
      const text = await readFile(join(this.dir, fileName), 'utf8')
      const parsed = parseProfile(JSON.parse(text))
      if (!parsed.profile || !fileNameFor(parsed.profile.id)) return { exists: true, record: null }
      return { exists: true, record: {
        id: parsed.profile.id,
        profile: parsed.profile,
        updatedAt: parsed.profile.updatedAt ?? 0,
        etag: etagFor(parsed.profile),
      } }
    } catch (error) {
      return { exists: (error as NodeJS.ErrnoException).code !== 'ENOENT', record: null }
    }
  }
}
