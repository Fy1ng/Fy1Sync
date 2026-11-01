import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyHudStylePack } from '../src/core/hudStylePack'
import { MAX_PRESET_BYTES } from '../server/presetStore'
import { parseStylePackSource, StylePackSyncService, verifyStylePackCatalog } from './stylePackSync'
import type { SignedStylePackCatalog, StylePackCatalog, StylePackCatalogEntry, StylePackSource, StylePackSyncEvent } from './stylePackSyncContracts'

const keys = generateKeyPairSync('ed25519')
const source: StylePackSource = { manifestUrl: 'https://styles.example.org/stable/catalog.json', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const directories: string[] = [], services: StylePackSyncService[] = []
afterEach(async () => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

function signed(catalog: unknown, encoding?: Buffer): SignedStylePackCatalog {
  const bytes = encoding ?? Buffer.from(JSON.stringify(catalog))
  return { payload: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') }
}
function pack(id = 'cs2/iem', revision = 1, minAppVersion = '0.1.0') {
  const profile = { ...createEmptyHudStylePack(id, `${id} revision ${revision}`), revision }
  const bytes = Buffer.from(JSON.stringify(profile))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const entry: StylePackCatalogEntry = { id, revision, sha256, bytes: bytes.length, path: `packs/${sha256}.json`, minAppVersion }
  return { profile, bytes, entry }
}
function catalog(revision: number, ...entries: StylePackCatalogEntry[]): StylePackCatalog { return { kind: 'fy1sync-stylepack-catalog', schemaVersion: 1, revision, packs: entries } }
async function setup(options: { dataDir?: string; source?: StylePackSource | null; currentVersion?: string } = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'fy1sync-stylepack-'))
  if (!options.dataDir) directories.push(dataDir)
  const assets = new Map<string, Buffer | Response | Error>()
  const request = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const value = assets.get(String(input))
    if (value instanceof Error) throw value
    if (value instanceof Response) return value
    if (!value) throw new Error('Offline fixture')
    return new Response(new Uint8Array(value), { headers: { 'Content-Type': 'application/json' } })
  })
  const service = new StylePackSyncService({ dataDir, source: options.source === undefined ? source : options.source, currentVersion: options.currentVersion ?? '0.2.0', request, resolve: async () => ['8.8.8.8'], now: () => 1793000000000 })
  services.push(service)
  const publish = (value: StylePackCatalog, packs: ReturnType<typeof pack>[] = []) => {
    assets.set(source.manifestUrl, Buffer.from(JSON.stringify(signed(value))))
    for (const item of packs) assets.set(new URL(item.entry.path, source.manifestUrl).href, item.bytes)
  }
  return { dataDir, service, assets, request, publish }
}

describe('signed style catalog validation', () => {
  it('authenticates exact UTF-8 payload bytes rather than reserializing JSON', () => {
    const value = catalog(1, pack().entry)
    expect(verifyStylePackCatalog(signed(value, Buffer.from(JSON.stringify(value, null, 2))), source)).toEqual(value)
    const envelope = signed(value)
    expect(() => verifyStylePackCatalog({ ...envelope, payload: Buffer.from(JSON.stringify(catalog(2))).toString('base64') }, source)).toThrow()
    const other = generateKeyPairSync('ed25519')
    expect(() => verifyStylePackCatalog(envelope, { ...source, publicKey: other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })).toThrow()
  })
  it('rejects unsigned, malformed, duplicate, oversized and extended catalogs', () => {
    const entry = pack().entry
    const values = [
      { ...catalog(1), unexpected: true }, catalog(0), catalog(Number.MAX_SAFE_INTEGER + 1),
      catalog(1, entry, entry), catalog(1, { ...entry, path: '../outside.json' }),
      catalog(1, { ...entry, sha256: entry.sha256.toUpperCase() }),
      catalog(1, { ...entry, bytes: MAX_PRESET_BYTES + 1 }),
      catalog(1, { ...entry, minAppVersion: '1.0.0-01' }), catalog(1, { ...entry, minAppVersion: 'v1.0.0' }),
      catalog(1, { ...entry, id: '../escape' }), catalog(1, { ...entry, code: 'alert(1)' } as StylePackCatalogEntry),
      catalog(1, ...Array.from({ length: 129 }, (_, i) => ({ ...entry, id: `pack${i}` }))),
    ]
    for (const value of values) expect(() => verifyStylePackCatalog(signed(value), source)).toThrow()
    expect(() => verifyStylePackCatalog({ ...signed(catalog(1)), url: 'https://evil.example/' }, source)).toThrow()
    expect(() => verifyStylePackCatalog({ payload: 'x'.repeat(262145), signature: 'AA==' }, source)).toThrow()
    expect(() => verifyStylePackCatalog(signed(null, Buffer.from([0xff])), source)).toThrow()
  })
  it('requires one HTTPS origin and an actual Ed25519 public key in local source configuration', () => {
    expect(parseStylePackSource(undefined)).toBeNull()
    expect(parseStylePackSource(source)).toEqual(source)
    for (const raw of [{ ...source, manifestUrl: 'http://styles.example.org/catalog.json' }, { ...source, manifestUrl: 'https://user:secret@styles.example.org/catalog.json' }, { ...source, manifestUrl: 'https://styles.example.org:8443/catalog.json' }, { ...source, publicKey: 'secret' }, { ...source, cookie: 'secret' }]) expect(() => parseStylePackSource(raw)).toThrow()
  })
})

describe('silent incremental style synchronization', () => {
  it('downloads changed hashes only, emits once per installed change and survives an offline restart', async () => {
    const f = await setup(), first = pack(), other = pack('cs2/pgl')
    const events: StylePackSyncEvent[] = []
    f.service.subscribe(event => events.push(event))
    f.publish(catalog(1, first.entry), [first])
    expect(await f.service.sync()).toMatchObject({ phase: 'updated', installed: 1, downloaded: 1 })
    expect(await f.service.get(first.entry.id)).toMatchObject({ profile: first.profile })
    expect(await f.service.sync()).toMatchObject({ phase: 'current', downloaded: 0 })
    f.publish(catalog(2, first.entry, other.entry), [other])
    expect(await f.service.sync()).toMatchObject({ phase: 'updated', installed: 2, downloaded: 1 })
    expect(events.filter(event => event.topic === 'stylepacks-changed')).toHaveLength(2)
    expect(f.request.mock.calls.map(call => String(call[0])).filter(url => url.endsWith(first.entry.path))).toHaveLength(1)
    for (const call of f.request.mock.calls) {
      expect(call[1]).toMatchObject({ credentials: 'omit', redirect: 'manual', cache: 'no-store' })
      expect(call[1]?.headers).not.toHaveProperty('Cookie')
    }
    const restarted = await setup({ dataDir: f.dataDir })
    expect((await restarted.service.list()).map(record => record.id)).toEqual([first.entry.id, other.entry.id])
    expect(await restarted.service.sync()).toMatchObject({ phase: 'error', installed: 2 })
    expect(await restarted.service.get(first.entry.id)).toMatchObject({ profile: first.profile })
    expect(JSON.stringify(restarted.service.state())).not.toMatch(/https:|stylepack-|publicKey/)
    const exposed = await restarted.service.get(first.entry.id)
    exposed!.profile.name = 'mutated caller'
    expect((await restarted.service.get(first.entry.id))!.profile.name).toBe(first.profile.name)
  })
  it('keeps the complete previous snapshot when a later package fails validation', async () => {
    const f = await setup(), original = pack(), update = pack('cs2/iem', 2), bad = pack('cs2/pgl')
    f.publish(catalog(1, original.entry), [original]); await f.service.sync()
    const previous = await readFile(join(f.dataDir, 'stylepacks', 'active.json'))
    f.publish(catalog(2, update.entry, bad.entry), [update, bad])
    f.assets.set(new URL(bad.entry.path, source.manifestUrl).href, Buffer.from('corrupt'))
    expect(await f.service.sync()).toMatchObject({ phase: 'error', installed: 1 })
    expect(await f.service.get(original.entry.id)).toMatchObject({ profile: original.profile })
    expect(await f.service.get(bad.entry.id)).toBeNull()
    expect(await readFile(join(f.dataDir, 'stylepacks', 'active.json'))).toEqual(previous)
  })
  it('rejects catalog and package rollback, including after restart or a temporary removal', async () => {
    const f = await setup(), newer = pack('cs2/iem', 3), older = pack('cs2/iem', 2)
    f.publish(catalog(3, newer.entry), [newer]); await f.service.sync()
    for (const value of [catalog(2, older.entry), catalog(3), catalog(4, older.entry)]) {
      f.publish(value, [older]); expect((await f.service.sync()).phase).toBe('error')
    }
    f.publish(catalog(4)); expect((await f.service.sync()).installed).toBe(0)
    const restarted = await setup({ dataDir: f.dataDir })
    restarted.publish(catalog(5, older.entry), [older])
    expect((await restarted.service.sync()).phase).toBe('error')
    expect(await restarted.service.list()).toEqual([])
  })
  it('rejects changed content at the same package revision even in a new catalog', async () => {
    const f = await setup(), first = pack()
    f.publish(catalog(1, first.entry), [first]); await f.service.sync()
    f.publish(catalog(2, { ...first.entry, sha256: 'a'.repeat(64), path: `packs/${'a'.repeat(64)}.json` }))
    expect((await f.service.sync()).phase).toBe('error')
    expect((await f.service.get(first.entry.id))!.profile).toEqual(first.profile)
  })
  it('skips incompatible new packages and retains a signed older compatible version', async () => {
    const f = await setup(), first = pack(), incompatible = pack('cs2/iem', 2, '0.3.0'), newPack = pack('cs2/pgl', 1, '0.3.0')
    f.publish(catalog(1, first.entry), [first]); await f.service.sync()
    f.publish(catalog(2, incompatible.entry, newPack.entry), [incompatible, newPack])
    expect(await f.service.sync()).toMatchObject({ phase: 'current', incompatible: 2, installed: 1, downloaded: 0 })
    expect((await f.service.get(first.entry.id))!.profile).toEqual(first.profile)
    const restarted = await setup({ dataDir: f.dataDir })
    expect((await restarted.service.get(first.entry.id))!.profile).toEqual(first.profile)
    expect(await restarted.service.get(newPack.entry.id)).toBeNull()
    restarted.publish(catalog(3, pack('cs2/iem', 1).entry))
    expect((await restarted.service.sync()).phase).toBe('error')
  })
  it('repairs damaged cached bytes without accepting a rollback after restart', async () => {
    const f = await setup(), first = pack('cs2/iem', 2)
    f.publish(catalog(2, first.entry), [first]); await f.service.sync()
    await writeFile(join(f.dataDir, 'stylepacks', first.entry.path), 'damaged')
    const restarted = await setup({ dataDir: f.dataDir })
    expect(await restarted.service.list()).toEqual([])
    restarted.publish(catalog(1, pack().entry), [pack()])
    expect((await restarted.service.sync()).phase).toBe('error')
    restarted.publish(catalog(2, first.entry), [first])
    expect(await restarted.service.sync()).toMatchObject({ phase: 'updated', installed: 1, downloaded: 1 })
    expect((await restarted.service.get(first.entry.id))!.profile).toEqual(first.profile)
  })
  it('keeps the installed compatible snapshot offline after the client version increases', async () => {
    const f = await setup(), first = pack(), future = pack('cs2/iem', 2, '0.3.0')
    f.publish(catalog(1, first.entry), [first]); await f.service.sync()
    f.publish(catalog(2, future.entry), [future]); await f.service.sync()
    f.service.dispose()
    const upgraded = await setup({ dataDir: f.dataDir, currentVersion: '0.3.0' })
    expect((await upgraded.service.get(first.entry.id))?.profile).toEqual(first.profile)
    expect((await upgraded.service.sync()).phase).toBe('error')
    expect((await upgraded.service.get(first.entry.id))?.profile).toEqual(first.profile)
    upgraded.publish(catalog(2, future.entry), [future])
    expect(await upgraded.service.sync()).toMatchObject({ phase: 'updated', installed: 1, downloaded: 1 })
    expect((await upgraded.service.get(future.entry.id))?.profile).toEqual(future.profile)
  })
  it('removes obsolete blobs only after a complete successful snapshot commit', async () => {
    const f = await setup(), first = pack(), next = pack('cs2/iem', 2), broken = pack('cs2/pgl')
    f.publish(catalog(1, first.entry), [first]); await f.service.sync()
    f.publish(catalog(2, next.entry, broken.entry), [next])
    expect((await f.service.sync()).phase).toBe('error')
    expect(await readFile(join(f.dataDir, 'stylepacks', first.entry.path))).toEqual(first.bytes)
    f.publish(catalog(2, next.entry, broken.entry), [broken])
    expect((await f.service.sync()).phase).toBe('updated')
    expect(await readFile(join(f.dataDir, 'stylepacks', first.entry.path)).catch(() => null)).toBeNull()
    expect((await setup({ dataDir: f.dataDir })).service.state().installed).toBe(2)
  })
  it.each(['bytes', 'id', 'revision', 'schema'])('rejects a package whose %s disagrees with its signed entry', async mismatch => {
    const f = await setup(), first = pack()
    let bytes = first.bytes
    let entry = first.entry
    if (mismatch === 'bytes') entry = { ...entry, bytes: bytes.length + 1 }
    else {
      const value = { ...first.profile, ...(mismatch === 'id' ? { id: 'cs2/other' } : mismatch === 'revision' ? { revision: 2 } : { schemaVersion: 999 }) }
      bytes = Buffer.from(JSON.stringify(value))
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      entry = { ...entry, sha256, path: `packs/${sha256}.json`, bytes: bytes.length }
    }
    f.publish(catalog(1, entry))
    f.assets.set(new URL(entry.path, source.manifestUrl).href, bytes)
    expect((await f.service.sync()).phase).toBe('error')
    expect(await f.service.list()).toEqual([])
  })
  it('rejects redirects and streamed metadata beyond the configured bound', async () => {
    const f = await setup()
    f.assets.set(source.manifestUrl, new Response('', { status: 302, headers: { Location: 'https://evil.example/catalog.json' } }))
    expect((await f.service.sync()).phase).toBe('error')
    expect(f.request).toHaveBeenCalledTimes(1)
    f.assets.set(source.manifestUrl, Buffer.from('x'.repeat(262145)))
    expect((await f.service.sync()).phase).toBe('error')
  })
  it('bounds an uncooperative transport and streamed body by the request deadline', async () => {
    vi.useFakeTimers()
    const f = await setup()
    f.request.mockImplementationOnce(() => new Promise<Response>(() => {}))
    const request = f.service.sync()
    await vi.advanceTimersByTimeAsync(20_001)
    expect((await request).phase).toBe('error')
    f.request.mockImplementationOnce(async () => new Response(new ReadableStream({ start() {} })))
    const body = f.service.sync()
    await vi.advanceTimersByTimeAsync(20_001)
    expect((await body).phase).toBe('error')
  })
  it('revalidates cached signing evidence before exposing any downloaded packages', async () => {
    const f = await setup(), first = pack()
    f.publish(catalog(1, first.entry), [first]); await f.service.sync()
    const active = join(f.dataDir, 'stylepacks', 'active.json')
    const archive = JSON.parse(await readFile(active, 'utf8'))
    archive.catalogs[0].signature = Buffer.alloc(64).toString('base64')
    await writeFile(active, JSON.stringify(archive))
    const restarted = await setup({ dataDir: f.dataDir })
    expect(await restarted.service.list()).toEqual([])
    restarted.publish(catalog(1, first.entry), [first])
    expect(await restarted.service.sync()).toMatchObject({ phase: 'updated', installed: 1, downloaded: 0 })
  })
  it('never follows a junction out of its own cloud cache or changes local presets', async () => {
    const f = await setup(), outside = await mkdtemp(join(tmpdir(), 'fy1sync-outside-')), first = pack()
    directories.push(outside)
    await mkdir(join(f.dataDir, 'presets')); await writeFile(join(f.dataDir, 'presets', 'user.json'), 'private-user-data')
    await symlink(outside, join(f.dataDir, 'stylepacks'), process.platform === 'win32' ? 'junction' : 'dir')
    f.publish(catalog(1, first.entry), [first])
    expect((await f.service.sync()).phase).toBe('error')
    expect(await readFile(join(f.dataDir, 'presets', 'user.json'), 'utf8')).toBe('private-user-data')
    expect(await readFile(join(outside, 'active.json')).catch(() => null)).toBeNull()
  })
  it('deduplicates manual requests and aborts an uncooperative request without committing', async () => {
    const f = await setup(), first = pack()
    f.publish(catalog(1, first.entry), [first])
    let finish!: (response: Response) => void
    f.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = f.service.sync()
    expect(f.service.sync()).toBe(pending)
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    f.service.dispose()
    await pending
    finish(Response.json(signed(catalog(1, first.entry))))
    await Promise.resolve()
    expect(await f.service.list()).toEqual([])
    expect(await readFile(join(f.dataDir, 'stylepacks', 'active.json')).catch(() => null)).toBeNull()
  })
  it('delays startup, retries failures with backoff and stops timers on disposal', async () => {
    vi.useFakeTimers()
    const f = await setup()
    f.service.start(); f.service.start()
    await vi.advanceTimersByTimeAsync(9999); expect(f.request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(f.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1); expect(f.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(f.request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); expect(f.request).toHaveBeenCalledTimes(3)
    f.service.dispose()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); expect(f.request).toHaveBeenCalledTimes(3)
  })
  it('checks again six hours after successful automatic synchronization', async () => {
    vi.useFakeTimers()
    const f = await setup(), first = pack()
    f.publish(catalog(1, first.entry), [first])
    f.service.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.service.state()).toMatchObject({ phase: 'updated', installed: 1 })
    expect(f.request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 1)
    expect(f.request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.request).toHaveBeenCalledTimes(3)
    expect(f.service.state()).toMatchObject({ phase: 'current', downloaded: 0 })
  })
  it('does not access the network without a configured trusted source', async () => {
    const f = await setup({ source: null })
    f.service.start()
    expect((await f.service.sync()).phase).toBe('unconfigured')
    expect(f.request).not.toHaveBeenCalled()
  })
})
