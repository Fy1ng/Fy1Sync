/**
 * Server-side profile preset store.
 *
 * Profiles built in the Profile Editor live in the browser's IndexedDB; presets promoted
 * here are shared across browsers and survive a cleared profile. Writes are validated,
 * size-capped, conflict-checked with an ETag, backed up, and written atomically
 * (temp file + rename) so a crash mid-write cannot leave a truncated JSON file that
 * would break the editor on next load.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

/**
 * Profile ids look like `cs2/iem`, so they become nested paths on disk. The separator is
 * flattened rather than honoured: a raw id in a path is a traversal vector
 * (`../../etc/passwd`), and the id is untrusted input from the editor.
 */
export function fileNameFor(id: string): string | null {
  if (!/^[a-z0-9][a-z0-9._/-]{0,64}$/i.test(id)) return null
  if (id.includes('..')) return null
  return `${id.replace(/\//g, '__')}.json`
}

export function idFromFileName(fileName: string): string {
  return fileName.replace(/\.json$/i, '').replace(/__/g, '/')
}

/** The single generation kept back from an overwrite. `list` skips these. */
function backupNameFor(fileName: string): string {
  return fileName.replace(/\.json$/, '.bak.json')
}

export function etagFor(profile: RecognitionProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 32)
}

export class PresetStore {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = resolve(dataDir, 'presets')
  }

  async list(): Promise<PresetRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return [] // No presets written yet.
    }

    const records: PresetRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.bak.json')) continue
      const record = await this.readFile(name)
      // A corrupt file is skipped, not fatal: one bad preset must not hide the rest.
      if (record) records.push(record)
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<PresetRecord | null> {
    const fileName = fileNameFor(id)
    if (!fileName) return null
    return this.readFile(fileName)
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
            message: '预设 ID 只能包含字母、数字、点、下划线、短横线和斜杠',
            severity: 'error',
          },
        ],
      }
    }

    const serialized = JSON.stringify(raw)
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_PRESET_BYTES) {
      return { ok: false, code: 'too-large', message: `预设超过 ${MAX_PRESET_BYTES} 字节上限` }
    }

    const parsed = parseProfile(raw)
    if (!parsed.profile) {
      return { ok: false, code: 'invalid', issues: parsed.issues }
    }

    const existing = await this.readFile(fileName)
    if (expectedEtag !== undefined && existing && existing.etag !== expectedEtag) {
      return { ok: false, code: 'conflict', currentEtag: existing.etag }
    }

    const profile: RecognitionProfile = { ...parsed.profile, id, updatedAt: Date.now() }
    const record: PresetRecord = {
      id,
      profile,
      updatedAt: profile.updatedAt,
      etag: etagFor(profile),
    }

    try {
      await mkdir(this.dir, { recursive: true })
      const target = join(this.dir, fileName)
      if (existing) {
        // Keep exactly one generation back; enough to undo a bad overwrite by hand.
        await writeFile(
          join(this.dir, backupNameFor(fileName)),
          JSON.stringify(existing.profile, null, 2),
          'utf8',
        )
      }
      const temp = `${target}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(profile, null, 2), 'utf8')
      await rename(temp, target)
    } catch (error) {
      return {
        ok: false,
        code: 'io-error',
        message: `写入预设失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    return { ok: true, record, created: existing === null }
  }

  async remove(id: string): Promise<boolean> {
    const fileName = fileNameFor(id)
    if (!fileName) return false
    try {
      await unlink(join(this.dir, fileName))
    } catch {
      return false
    }
    // The backup goes with it. `list` hides `.bak.json`, so one left behind is invisible
    // from the editor while still holding a deleted preset's contents — and if the same id
    // is created again it reads as that preset's previous generation, which it is not.
    // Missing is the normal case (nothing was ever overwritten), hence the swallowed error.
    await unlink(join(this.dir, backupNameFor(fileName))).catch(() => undefined)
    return true
  }

  private async readFile(fileName: string): Promise<PresetRecord | null> {
    try {
      const text = await readFile(join(this.dir, fileName), 'utf8')
      const parsed = parseProfile(JSON.parse(text))
      if (!parsed.profile) return null
      return {
        id: parsed.profile.id || idFromFileName(fileName),
        profile: parsed.profile,
        updatedAt: parsed.profile.updatedAt ?? 0,
        etag: etagFor(parsed.profile),
      }
    } catch {
      return null
    }
  }
}
