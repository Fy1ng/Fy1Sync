import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  etagFor,
  fileNameFor,
  idFromFileName,
  MAX_PRESET_BYTES,
  PresetStore,
} from './presetStore'
import { packBitmap } from '../src/core/bitmapCodec'
import { createEmptyProfile, PROFILE_SCHEMA_VERSION, TEMPLATE_PIXELS } from '../src/core/profileSchema'

/**
 * A bit-packed sample of exactly the size the schema demands. The store only cares that
 * validation passes, so the pattern itself is arbitrary — but the length is not, and a
 * short string is rejected before anything reaches disk.
 */
function sampleData(seed = 0): string {
  const mask = new Uint8Array(TEMPLATE_PIXELS)
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = (index + seed) % 3 === 0 ? 255 : 0
  }
  return packBitmap(mask)
}

describe('fileNameFor', () => {
  it('flattens the id separator instead of honouring it as a path', () => {
    // A nested path would let an id escape the presets directory; flattening keeps it flat.
    expect(fileNameFor('cs2/iem')).toBe('cs2__iem.json')
    expect(fileNameFor('valorant/vct/emea')).toBe('valorant__vct__emea.json')
  })

  it('accepts plain ids and the allowed punctuation', () => {
    expect(fileNameFor('cs2')).toBe('cs2.json')
    expect(fileNameFor('cs2.iem_2024-spring')).toBe('cs2.iem_2024-spring.json')
  })

  it('rejects traversal attempts', () => {
    for (const id of ['../etc/passwd', 'cs2/../../secret', '..', 'a/..', './x']) {
      expect(fileNameFor(id)).toBeNull()
    }
  })

  it('rejects absolute paths, backslashes and control characters', () => {
    for (const id of ['/etc/passwd', 'C:\\windows', 'a\\b', 'a\0b', 'a b', 'a:b', '']) {
      expect(fileNameFor(id)).toBeNull()
    }
  })

  it('rejects an id that does not start alphanumerically', () => {
    expect(fileNameFor('-leading')).toBeNull()
    expect(fileNameFor('_leading')).toBeNull()
    expect(fileNameFor('.hidden')).toBeNull()
  })

  it('accepts an id at the length limit and rejects the one past it', () => {
    // The pattern is one leading character plus up to 64 more, so 65 total is the boundary.
    expect(fileNameFor(`a${'b'.repeat(64)}`)).toBe(`a${'b'.repeat(64)}.json`)
    expect(fileNameFor(`a${'b'.repeat(65)}`)).toBeNull()
  })

  it('round-trips through idFromFileName', () => {
    expect(idFromFileName(fileNameFor('cs2/iem')!)).toBe('cs2/iem')
    expect(idFromFileName('plain.json')).toBe('plain')
  })
})

describe('etagFor', () => {
  it('is stable for equal content and differs when content changes', () => {
    const profile = createEmptyProfile('cs2/iem', 'IEM')
    expect(etagFor(profile)).toBe(etagFor({ ...profile }))
    expect(etagFor({ ...profile, matchThreshold: 0.9 })).not.toBe(etagFor(profile))
  })

  it('is a 32-character hex digest', () => {
    expect(etagFor(createEmptyProfile())).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('PresetStore', () => {
  let dataDir: string
  let store: PresetStore

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'stream-sync-presets-'))
    store = new PresetStore(dataDir)
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  const validProfile = (overrides: Record<string, unknown> = {}) => ({
    ...createEmptyProfile('cs2/iem', 'IEM Countdown'),
    templates: {
      '0': [{ id: 's0', data: sampleData(0), createdAt: 1, origin: 'editor' }],
    },
    ...overrides,
  })

  it('returns an empty list before anything is written', async () => {
    expect(await store.list()).toEqual([])
  })

  it('saves and reads a profile back', async () => {
    const outcome = await store.save('cs2/iem', validProfile())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.created).toBe(true)
    expect(outcome.record.id).toBe('cs2/iem')

    const loaded = await store.get('cs2/iem')
    expect(loaded?.profile.name).toBe('IEM Countdown')
    expect(loaded?.etag).toBe(outcome.record.etag)
  })

  it('writes to a flattened file name inside a presets subdirectory', async () => {
    await store.save('cs2/iem', validProfile())
    expect(await readdir(join(dataDir, 'presets'))).toContain('cs2__iem.json')
  })

  it('forces the stored id to match the requested one', async () => {
    // The body is untrusted; an id mismatch would make the file unreachable by its name.
    const outcome = await store.save('cs2/iem', validProfile({ id: 'somewhere/else' }))
    expect(outcome.ok).toBe(true)
    expect((await store.get('cs2/iem'))?.profile.id).toBe('cs2/iem')
  })

  it('stamps updatedAt on save', async () => {
    const before = Date.now()
    const outcome = await store.save('cs2/iem', validProfile({ updatedAt: 0 }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('rejects an id that cannot be a file name', async () => {
    const outcome = await store.save('../escape', validProfile())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('invalid')
    if (outcome.code !== 'invalid') return
    expect(outcome.issues[0]?.path).toBe('id')
    // Nothing may reach the disk for a rejected id.
    await expect(readdir(join(dataDir, 'presets'))).rejects.toThrow()
  })

  it('rejects an invalid profile with schema issues', async () => {
    const outcome = await store.save('cs2/iem', { schemaVersion: 2, id: 'cs2/iem' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('invalid')
    if (outcome.code !== 'invalid') return
    expect(outcome.issues.length).toBeGreaterThan(0)
  })

  it('rejects a future schema version rather than guessing', async () => {
    const outcome = await store.save('cs2/iem', {
      ...validProfile(),
      schemaVersion: PROFILE_SCHEMA_VERSION + 1,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok || outcome.code !== 'invalid') return
    expect(outcome.issues[0]?.path).toBe('schemaVersion')
  })

  it('migrates a v1 payload on the way in', async () => {
    const outcome = await store.save('cs2/iem', {
      schemaVersion: 1,
      id: 'cs2/iem',
      name: 'Legacy',
      roi: { x: 0.4, y: 0.02, w: 0.2, h: 0.08 },
      clockFormat: 'm:ss',
      detectWindowSeconds: 3,
      sampleFps: 30,
      matchThreshold: 0.82,
      templates: { '0': { data: sampleData(1) } },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION)
    expect(outcome.record.profile.templates['0']).toHaveLength(1)
  })

  it('rejects a payload over the size cap', async () => {
    const huge = validProfile({
      notes: 'x'.repeat(MAX_PRESET_BYTES + 1),
    })
    const outcome = await store.save('cs2/iem', huge)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('too-large')
  })

  it('rejects a payload that cannot be serialised', async () => {
    const outcome = await store.save('cs2/iem', () => {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('too-large')
  })

  it('reports created: false on an overwrite', async () => {
    await store.save('cs2/iem', validProfile())
    const second = await store.save('cs2/iem', validProfile({ name: 'Renamed' }))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.created).toBe(false)
    expect((await store.get('cs2/iem'))?.profile.name).toBe('Renamed')
  })

  it('accepts a write whose expected etag matches', async () => {
    const first = await store.save('cs2/iem', validProfile())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await store.save('cs2/iem', validProfile({ name: 'V2' }), first.record.etag)
    expect(second.ok).toBe(true)
  })

  it('rejects a stale write and reports the current etag', async () => {
    const first = await store.save('cs2/iem', validProfile())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await store.save('cs2/iem', validProfile({ name: 'Someone else' }))

    const stale = await store.save('cs2/iem', validProfile({ name: 'Mine' }), first.record.etag)
    expect(stale.ok).toBe(false)
    if (stale.ok || stale.code !== 'conflict') return
    expect(stale.currentEtag).not.toBe(first.record.etag)
    // The loser's content must not have landed.
    expect((await store.get('cs2/iem'))?.profile.name).toBe('Someone else')
  })

  it('ignores an expected etag when the preset does not exist yet', async () => {
    const outcome = await store.save('cs2/new', validProfile(), 'whatever')
    expect(outcome.ok).toBe(true)
  })

  it('keeps one backup generation on overwrite', async () => {
    await store.save('cs2/iem', validProfile({ name: 'First' }))
    await store.save('cs2/iem', validProfile({ name: 'Second' }))
    const backup = JSON.parse(
      await readFile(join(dataDir, 'presets', 'cs2__iem.bak.json'), 'utf8'),
    ) as { name: string }
    expect(backup.name).toBe('First')

    await store.save('cs2/iem', validProfile({ name: 'Third' }))
    const rolled = JSON.parse(
      await readFile(join(dataDir, 'presets', 'cs2__iem.bak.json'), 'utf8'),
    ) as { name: string }
    expect(rolled.name).toBe('Second')
  })

  it('leaves no temp file behind after a write', async () => {
    await store.save('cs2/iem', validProfile())
    const names = await readdir(join(dataDir, 'presets'))
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('reports io-error when the presets path cannot be created', async () => {
    // A file where the directory should be makes mkdir fail; the caller gets a clean error.
    const blocked = join(dataDir, 'blocked')
    await writeFile(join(dataDir, 'blocked'), 'not a directory', 'utf8')
    const outcome = await new PresetStore(blocked).save('cs2/iem', validProfile())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('io-error')
  })

  it('returns null for a missing or invalid id', async () => {
    expect(await store.get('cs2/iem')).toBeNull()
    expect(await store.get('../escape')).toBeNull()
  })

  it('lists presets newest first', async () => {
    await store.save('cs2/a', validProfile({ name: 'A', updatedAt: 1 }))
    await store.save('cs2/b', validProfile({ name: 'B', updatedAt: 2 }))
    const listed = await store.list()
    expect(listed).toHaveLength(2)
    expect(listed[0]!.updatedAt).toBeGreaterThanOrEqual(listed[1]!.updatedAt)
  })

  it('skips backups and non-JSON files when listing', async () => {
    await store.save('cs2/iem', validProfile())
    await store.save('cs2/iem', validProfile({ name: 'again' }))
    await writeFile(join(dataDir, 'presets', 'notes.txt'), 'ignore me', 'utf8')
    const listed = await store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe('cs2/iem')
  })

  it('skips a corrupt file instead of failing the whole listing', async () => {
    await store.save('cs2/good', validProfile())
    await writeFile(join(dataDir, 'presets', 'cs2__broken.json'), '{ not json', 'utf8')
    await writeFile(join(dataDir, 'presets', 'cs2__empty.json'), '{}', 'utf8')
    const listed = await store.list()
    expect(listed.map((record) => record.id)).toEqual(['cs2/good'])
  })

  it('recovers the id from the file name when the stored profile omits it', async () => {
    await mkdir(join(dataDir, 'presets'), { recursive: true })
    const profile = { ...validProfile(), id: '' }
    await writeFile(join(dataDir, 'presets', 'cs2__named.json'), JSON.stringify(profile), 'utf8')
    // An empty id fails validation, so nothing is listed; a mismatched one is kept as stored.
    const other = { ...validProfile(), id: 'stored/id' }
    await writeFile(join(dataDir, 'presets', 'cs2__other.json'), JSON.stringify(other), 'utf8')
    const listed = await store.list()
    expect(listed.map((record) => record.id)).toContain('stored/id')
  })

  it('removes a preset and reports whether anything was deleted', async () => {
    await store.save('cs2/iem', validProfile())
    expect(await store.remove('cs2/iem')).toBe(true)
    expect(await store.get('cs2/iem')).toBeNull()
    expect(await store.remove('cs2/iem')).toBe(false)
    expect(await store.remove('../escape')).toBe(false)
  })

  it('takes the backup generation with it', async () => {
    await store.save('cs2/iem', validProfile({ name: 'First' }))
    await store.save('cs2/iem', validProfile({ name: 'Second' }))
    expect(await readdir(join(dataDir, 'presets'))).toContain('cs2__iem.bak.json')

    expect(await store.remove('cs2/iem')).toBe(true)

    // `list` hides `.bak.json`, so a surviving backup is a deleted preset's contents kept
    // where nobody can see them — and it would resurface as the "previous generation" of
    // the next preset to take that id.
    expect(await readdir(join(dataDir, 'presets'))).toEqual([])
  })

  it('survives concurrent writes to the same id', async () => {
    // Last writer wins, but the file must always be complete JSON.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.save('cs2/iem', validProfile({ name: `n${i}` }))),
    )
    const loaded = await store.get('cs2/iem')
    expect(loaded).not.toBeNull()
    expect(loaded!.profile.name).toMatch(/^n\d$/)
  })
})
