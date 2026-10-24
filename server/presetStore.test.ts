import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
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
  it('encodes separators without colliding with literal underscores', () => {
    expect(fileNameFor('cs2/iem')).toBe('~6373322f69656d.json')
    expect(fileNameFor('cs2__iem')).not.toBe(fileNameFor('cs2/iem'))
    expect(idFromFileName(fileNameFor('valorant/vct/emea')!)).toBe('valorant/vct/emea')
  })

  it('accepts plain ids and the allowed punctuation', () => {
    expect(idFromFileName(fileNameFor('cs2')!)).toBe('cs2')
    expect(idFromFileName(fileNameFor('cs2.iem_2024-spring')!)).toBe('cs2.iem_2024-spring')
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
    expect(idFromFileName(fileNameFor(`a${'b'.repeat(64)}`)!)).toBe(`a${'b'.repeat(64)}`)
    expect(fileNameFor(`a${'b'.repeat(65)}`)).toBeNull()
  })

  it('round-trips through idFromFileName', () => {
    expect(idFromFileName(fileNameFor('cs2/iem')!)).toBe('cs2/iem')
    expect(idFromFileName('plain.json')).toBe('plain')
  })

  it('keeps IDs consistent with the lowercase profile schema and rejects ambiguous segments', () => {
    for (const id of ['CS2/iem', 'cs2/IEM', 'a//b', 'a/', 'a/.b', 'a/_b']) expect(fileNameFor(id)).toBeNull()
    for (const name of ['~zz.json', '~61.bak.json', '~41.json', '~00.json']) expect(idFromFileName(name)).toBe('')
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

  it('writes to an encoded file name inside a presets subdirectory', async () => {
    await store.save('cs2/iem', validProfile())
    expect(await readdir(join(dataDir, 'presets'))).toContain(fileNameFor('cs2/iem'))
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

  it('rejects an expected etag when the preset no longer exists', async () => {
    const outcome = await store.save('cs2/new', validProfile(), 'whatever')
    expect(outcome).toMatchObject({ ok: false, code: 'conflict', currentEtag: '' })
    expect(await store.get('cs2/new')).toBeNull()
  })

  it('keeps one backup generation on overwrite', async () => {
    await store.save('cs2/iem', validProfile({ name: 'First' }))
    await store.save('cs2/iem', validProfile({ name: 'Second' }))
    const backup = JSON.parse(
      await readFile(join(dataDir, 'presets', fileNameFor('cs2/iem')!.replace('.json', '.bak.json')), 'utf8'),
    ) as { name: string }
    expect(backup.name).toBe('First')

    await store.save('cs2/iem', validProfile({ name: 'Third' }))
    const rolled = JSON.parse(
      await readFile(join(dataDir, 'presets', fileNameFor('cs2/iem')!.replace('.json', '.bak.json')), 'utf8'),
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

  it('does not infer missing or mismatched legacy IDs from ambiguous file names', async () => {
    await mkdir(join(dataDir, 'presets'), { recursive: true })
    const profile = { ...validProfile(), id: '' }
    await writeFile(join(dataDir, 'presets', 'cs2__named.json'), JSON.stringify(profile), 'utf8')
    // A valid body in a different ID's filename must not appear as either preset.
    const other = { ...validProfile(), id: 'stored/id' }
    await writeFile(join(dataDir, 'presets', 'cs2__other.json'), JSON.stringify(other), 'utf8')
    const listed = await store.list()
    expect(listed).toEqual([])
    expect(await store.get('cs2/other')).toBeNull()
    expect(await store.get('stored/id')).toBeNull()
    expect(await store.remove('cs2/other')).toBe(false)
    expect(JSON.parse(await readFile(join(dataDir, 'presets', 'cs2__other.json'), 'utf8')).id).toBe('stored/id')
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
    expect(await readdir(join(dataDir, 'presets'))).toContain(fileNameFor('cs2/iem')!.replace('.json', '.bak.json'))

    expect(await store.remove('cs2/iem')).toBe(true)

    // Removing a preset also removes its own previous generation.
    expect(await readdir(join(dataDir, 'presets'))).toEqual([])
  })

  it('serializes different-length writes across store instances without mixing JSON', async () => {
    const other = new PresetStore(join(dataDir, '.'))
    const names = Array.from({ length: 8 }, (_, i) => `n${i}`.repeat(i * 400 + 1))
    const results = await Promise.all(names.map((name, i) => (i % 2 ? other : store).save('cs2/iem', validProfile({ name }))))
    expect(results.every(result => result.ok)).toBe(true)
    expect((await store.get('cs2/iem'))?.profile.name).toBe(names.at(-1))
    expect(JSON.parse(await readFile(join(dataDir, 'presets', fileNameFor('cs2/iem')!), 'utf8')).name).toBe(names.at(-1))
    expect((await readdir(join(dataDir, 'presets'))).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('allows only one writer with the same ETag across store instances', async () => {
    const initial = await store.save('cs2/iem', validProfile())
    if (!initial.ok) throw new Error('Fixture failed')
    const other = new PresetStore(dataDir)
    const [first, second] = await Promise.all([
      store.save('cs2/iem', validProfile({ name: 'First' }), initial.record.etag),
      other.save('cs2/iem', validProfile({ name: 'Second'.repeat(4000) }), initial.record.etag),
    ])
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('First write failed')
    expect(second).toEqual({ ok: false, code: 'conflict', currentEtag: first.record.etag })
    expect((await store.get('cs2/iem'))?.etag).toBe(first.record.etag)
  })

  it('orders deletion after a pending write and prevents stale recreation', async () => {
    const initial = await store.save('cs2/iem', validProfile())
    if (!initial.ok) throw new Error('Fixture failed')
    const other = new PresetStore(dataDir)
    const write = store.save('cs2/iem', validProfile({ name: 'In flight' }), initial.record.etag)
    const remove = other.remove('cs2/iem')
    const stale = store.save('cs2/iem', validProfile({ name: 'Stale' }), initial.record.etag)
    expect((await write).ok).toBe(true)
    expect(await remove).toBe(true)
    expect(await stale).toEqual({ ok: false, code: 'conflict', currentEtag: '' })
    expect(await other.get('cs2/iem')).toBeNull()
    expect(await readdir(join(dataDir, 'presets'))).toEqual([])
  })

  it('snapshots the submitted profile before waiting for earlier operations', async () => {
    const raw = validProfile({ name: 'Submitted' })
    const pending = store.save('cs2/iem', raw)
    raw.name = 'Changed after submission'
    await pending
    expect((await store.get('cs2/iem'))?.profile.name).toBe('Submitted')
  })

  it.each(['con', 'nul.txt', 'aux', 'prn', 'com1', 'lpt9'])('stores Windows reserved names as ordinary encoded IDs (%s)', async id => {
    expect((await store.save(id, validProfile())).ok).toBe(true)
    expect((await store.get(id))?.id).toBe(id)
    expect((await store.list()).map(record => record.id)).toContain(id)
    expect(await store.remove(id)).toBe(true)
  })

  it('keeps new slash, underscore and backup-looking IDs independent', async () => {
    for (const id of ['event/one', 'event__one', 'event', 'event.bak']) {
      expect((await store.save(id, validProfile({ name: id }))).ok).toBe(true)
    }
    await store.save('event', validProfile({ name: 'Updated event' }))
    expect((await store.get('event/one'))?.profile.name).toBe('event/one')
    expect((await store.get('event__one'))?.profile.name).toBe('event__one')
    expect((await store.get('event.bak'))?.profile.name).toBe('event.bak')
    expect(await store.list()).toHaveLength(4)
    await store.remove('event')
    await store.remove('event/one')
    expect((await store.get('event.bak'))?.id).toBe('event.bak')
    expect((await store.get('event__one'))?.id).toBe('event__one')
  })

  it('updates a verified legacy file in place without migrating it or reading its alias', async () => {
    const directory = join(dataDir, 'presets')
    await mkdir(directory)
    const legacy = join(directory, 'cs2__iem.json')
    await writeFile(legacy, JSON.stringify(validProfile({ id: 'cs2/iem', name: 'Legacy' })))
    const initial = await store.get('cs2/iem')
    expect(initial?.profile.name).toBe('Legacy')
    expect(await store.get('cs2__iem')).toBeNull()
    expect(await store.remove('cs2__iem')).toBe(false)
    expect((await store.save('cs2__iem', validProfile({ name: 'Underscore' }))).ok).toBe(true)
    expect((await store.save('cs2/iem', validProfile({ name: 'Updated legacy' }), initial!.etag)).ok).toBe(true)
    expect(JSON.parse(await readFile(legacy, 'utf8')).name).toBe('Updated legacy')
    expect((await readdir(directory)).includes(fileNameFor('cs2/iem')!)).toBe(false)
    expect((await store.get('cs2__iem'))?.profile.name).toBe('Underscore')
    expect(await store.list()).toHaveLength(2)
  })

  it('preserves a legitimate legacy .bak ID while saving and removing its base ID', async () => {
    const directory = join(dataDir, 'presets')
    await mkdir(directory)
    await writeFile(join(directory, 'event.json'), JSON.stringify(validProfile({ id: 'event', name: 'Base' })))
    const independent = JSON.stringify(validProfile({ id: 'event.bak', name: 'Independent' }))
    await writeFile(join(directory, 'event.bak.json'), independent)
    expect(await store.list()).toHaveLength(2)
    expect((await store.save('event', validProfile({ name: 'Updated' }))).ok).toBe(true)
    expect(await readFile(join(directory, 'event.bak.json'), 'utf8')).toBe(independent)
    expect(await store.remove('event')).toBe(true)
    expect((await store.get('event.bak'))?.profile.name).toBe('Independent')
  })

  it('prefers the encoded primary and removes matching legacy copies without resurrection', async () => {
    const directory = join(dataDir, 'presets')
    await store.save('cs2/iem', validProfile({ name: 'Encoded' }))
    await writeFile(join(directory, 'cs2__iem.json'), JSON.stringify(validProfile({ id: 'cs2/iem', name: 'Legacy' })))
    await writeFile(join(directory, 'cs2__iem.bak.json'), JSON.stringify(validProfile({ id: 'cs2/iem', name: 'Old backup' })))
    expect((await store.get('cs2/iem'))?.profile.name).toBe('Encoded')
    expect((await store.list()).map(record => record.profile.name)).toEqual(['Encoded'])
    expect(await store.remove('cs2/iem')).toBe(true)
    expect(await readdir(directory)).toEqual([])
    expect(await store.get('cs2/iem')).toBeNull()
  })

  it('refuses to overwrite an encoded path whose stored ID does not match', async () => {
    const directory = join(dataDir, 'presets')
    await mkdir(directory)
    const file = join(directory, fileNameFor('cs2/iem')!)
    const misplaced = JSON.stringify(validProfile({ id: 'other/id', name: 'Preserve me' }))
    await writeFile(file, misplaced)
    expect(await store.get('cs2/iem')).toBeNull()
    expect(await store.list()).toEqual([])
    expect(await store.remove('cs2/iem')).toBe(false)
    expect(await store.save('cs2/iem', validProfile())).toMatchObject({ ok: false, code: 'io-error' })
    expect(await readFile(file, 'utf8')).toBe(misplaced)
    await rm(file)
    expect((await store.save('cs2/iem', validProfile())).ok).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('shares ordering for differently cased Windows data-directory paths', async () => {
    const other = new PresetStore(dataDir.toUpperCase())
    const initial = await store.save('cs2/iem', validProfile())
    if (!initial.ok) throw new Error('Fixture failed')
    const results = await Promise.all([
      store.save('cs2/iem', validProfile({ name: 'First' }), initial.record.etag),
      other.save('cs2/iem', validProfile({ name: 'Second' }), initial.record.etag),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok && result.code === 'conflict')).toHaveLength(1)
  })

  it('shares ordering when another store reaches the same data directory through an alias', async () => {
    const actual = join(dataDir, 'actual'), alias = join(dataDir, 'alias')
    await mkdir(actual)
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const firstStore = new PresetStore(actual), aliasStore = new PresetStore(alias)
    const initial = await firstStore.save('cs2/iem', validProfile())
    if (!initial.ok) throw new Error('Fixture failed')
    const results = await Promise.all([
      firstStore.save('cs2/iem', validProfile({ name: 'First' }), initial.record.etag),
      aliasStore.save('cs2/iem', validProfile({ name: 'Second' }), initial.record.etag),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok && result.code === 'conflict')).toHaveLength(1)
    expect((await aliasStore.get('cs2/iem'))?.profile.name).toBe('First')
  })
})
