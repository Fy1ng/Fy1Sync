import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { FrontendUpdates } from './frontendUpdates'
import type { FrontendBundle, FrontendUpdateEntry, OnlineUpdateCatalog, OnlineUpdateSource } from './onlineUpdateContracts'

const roots: string[] = []
const keys = generateKeyPairSync('ed25519')
const source: OnlineUpdateSource = { mirrors: [{ id: 'github', manifestUrl: 'https://updates.example.org/manifest.json' }],
  publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('fy1sync-frontend-')) throw new Error('Unsafe cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy1sync-frontend-'))
  roots.push(root)
  const bundledClientDir = path.join(root, 'bundled')
  fs.mkdirSync(bundledClientDir)
  fs.writeFileSync(path.join(bundledClientDir, 'index.html'), 'BUNDLED')
  const options = { userDataDir: root, bundledClientDir, source, currentAppVersion: '0.2.0', bridgeVersion: 1, bundledRevision: 1 }
  return { root, bundledClientDir, options, open: () => new FrontendUpdates(options) }
}
function release(revision = 2, changes: Partial<FrontendUpdateEntry> = {}) {
  const bundle: FrontendBundle = { kind: 'fy1sync-frontend-bundle', schemaVersion: 1, revision,
    version: '0.2.0', bridgeVersion: 1, files: [
      { path: 'index.html', content: Buffer.from(`<div id="root">UI ${revision}</div><script src="/assets/main.js"></script>`).toString('base64') },
      { path: 'assets/main.js', content: Buffer.from(`document.title = 'UI ${revision}'`).toString('base64') },
    ] }
  const bytes = Buffer.from(JSON.stringify(bundle))
  const hash = createHash('sha256').update(bytes).digest('hex')
  const entry: FrontendUpdateEntry = { revision, version: '0.2.0', bridgeVersion: 1, minAppVersion: '0.2.0', maxAppVersion: '0.2.0',
    sha256: hash, bytes: bytes.length, path: `frontends/${hash}.json`, notes: 'Offline update fixture', ...changes }
  const catalog: OnlineUpdateCatalog = { kind: 'fy1sync-update-catalog', schemaVersion: 1, revision, frontend: entry, application: null }
  const payload = Buffer.from(JSON.stringify(catalog))
  return { entry, bytes, envelope: { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') } }
}
async function stage(store: FrontendUpdates, candidate = release()) { await store.stage(candidate.entry, candidate.envelope, candidate.bytes); return candidate }

describe('authenticated frontend activation', () => {
  it('stages without changing the current renderer or any user data, and activates offline at the next boot', async () => {
    const f = fixture(), initial = f.open()
    fs.writeFileSync(path.join(f.root, 'user-draft.json'), '{"revision":7187}')
    expect(initial.beginBoot()).toBe(f.bundledClientDir)
    const candidate = await stage(initial)
    expect(initial.clientDir()).toBe(f.bundledClientDir)
    expect(initial.snapshot()).toMatchObject({ currentRevision: 1, phase: 'bundled', staged: { revision: 2 } })
    const restarted = f.open()
    expect(restarted.beginBoot()).toContain(candidate.entry.sha256)
    expect(restarted.snapshot()).toMatchObject({ currentRevision: 2, phase: 'trial', staged: null })
    expect(restarted.confirmHealthy(999)).toBe(false)
    expect(restarted.confirmHealthy(1)).toBe(true)
    const third = f.open()
    expect(third.beginBoot()).toContain(candidate.entry.sha256)
    expect(third.snapshot()).toMatchObject({ phase: 'current', currentRevision: 2 })
    expect(fs.readFileSync(path.join(f.root, 'user-draft.json'), 'utf8')).toBe('{"revision":7187}')
    expect(fs.readFileSync(path.join(f.bundledClientDir, 'index.html'), 'utf8')).toBe('BUNDLED')
  })

  it('rolls back an interrupted first startup and never retries the same failed revision', async () => {
    const f = fixture(), initial = f.open()
    initial.beginBoot()
    const bad = await stage(initial)
    const trial = f.open()
    trial.beginBoot()
    const recovery = f.open()
    expect(recovery.beginBoot()).toBe(f.bundledClientDir)
    expect(recovery.snapshot()).toMatchObject({ phase: 'rolled-back', blockedRevision: 2, currentRevision: 1 })
    await expect(stage(recovery, bad)).rejects.toThrow()
    await stage(recovery, release(3))
    const retry = f.open()
    retry.beginBoot()
    expect(retry.snapshot()).toMatchObject({ phase: 'trial', currentRevision: 3 })
  })

  it('uses the previous known-good version for a watchdog failure and a manual rollback', async () => {
    const f = fixture(), original = f.open()
    original.beginBoot()
    const second = await stage(original)
    const active = f.open()
    active.beginBoot(); active.confirmHealthy(1)
    await stage(active, release(3))
    const third = f.open()
    third.beginBoot()
    expect(third.failBoot()).toBe(true)
    expect(third.clientDir()).toContain(second.entry.sha256)
    expect(third.snapshot()).toMatchObject({ currentRevision: 2, blockedRevision: 3, phase: 'rolled-back' })
    expect(third.failBoot()).toBe(false)
    await stage(third, release(4))
    const fourth = f.open()
    fourth.beginBoot(); fourth.confirmHealthy(1)
    fourth.rollbackForRestart()
    const rolledBack = f.open()
    expect(rolledBack.beginBoot()).toContain(second.entry.sha256)
    expect(rolledBack.snapshot()).toMatchObject({ currentRevision: 2, blockedRevision: 4 })
  })

  it.each(['asset', 'extra-file', 'bundle', 'proof'])('refuses a tampered %s even after a prior healthy start', async kind => {
    const f = fixture(), original = f.open()
    original.beginBoot()
    const candidate = await stage(original)
    const active = f.open()
    const client = active.beginBoot()
    active.confirmHealthy(1)
    const directory = path.join(f.root, 'online-updates/frontend/releases', candidate.entry.sha256)
    if (kind === 'asset') fs.writeFileSync(path.join(client, 'assets/main.js'), 'MALICIOUS')
    if (kind === 'extra-file') fs.writeFileSync(path.join(client, 'assets/extra.js'), 'UNLISTED')
    if (kind === 'bundle') fs.writeFileSync(path.join(directory, 'bundle.json'), '{}')
    if (kind === 'proof') fs.writeFileSync(path.join(directory, 'proof.json'), '{}')
    const restart = f.open()
    expect(restart.beginBoot()).toBe(f.bundledClientDir)
    expect(restart.snapshot().phase).toBe('rolled-back')
  })

  it.each([{ currentAppVersion: '0.3.0' }, { bridgeVersion: 2 }, { bundledRevision: 3 }])('ignores incompatible cached frontend on a full application upgrade %j', async change => {
    const f = fixture(), original = f.open()
    original.beginBoot()
    await stage(original)
    const next = new FrontendUpdates({ ...f.options, ...change })
    expect(next.beginBoot()).toBe(f.bundledClientDir)
    expect(next.snapshot().staged).toBeNull()
  })

  it('requires a valid signature and matching bytes before it can change the selected version', async () => {
    const f = fixture(), store = f.open()
    store.beginBoot()
    const valid = await stage(store)
    const third = release(3)
    await expect(store.stage(third.entry, { ...third.envelope, signature: Buffer.alloc(64).toString('base64') }, third.bytes)).rejects.toThrow()
    await expect(store.stage(third.entry, third.envelope, Buffer.from('truncated'))).rejects.toThrow()
    expect(store.snapshot().staged?.sha256).toBe(valid.entry.sha256)
    expect(store.clientDir()).toBe(f.bundledClientDir)
  })

  it('discards a withdrawn pending release without disturbing active files', async () => {
    const f = fixture(), store = f.open()
    store.beginBoot()
    await stage(store)
    await store.discardStaged()
    expect(store.snapshot().staged).toBeNull()
    const next = f.open()
    expect(next.beginBoot()).toBe(f.bundledClientDir)
  })

  it.each(['withdrawn', 'damaged-archive'])('does not activate pending code after a %s record survived an interrupted check', async mode => {
    const f = fixture(), store = f.open()
    store.beginBoot()
    const pending = await stage(store)
    const payload = Buffer.from(JSON.stringify({ kind: 'fy1sync-update-catalog', schemaVersion: 1, revision: 3, frontend: null, application: null }))
    const latest = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
    const archive = { schemaVersion: 1, latest, frontendHigh: pending.envelope, applicationHigh: null, checkedAt: 1 }
    fs.writeFileSync(path.join(f.root, 'online-updates/catalog.json'), mode === 'withdrawn' ? JSON.stringify(archive) : 'broken')
    const next = f.open()
    expect(next.beginBoot()).toBe(f.bundledClientDir)
    expect(next.snapshot()).toMatchObject({ phase: 'rolled-back', staged: null, blockedRevision: 2 })
  })

  it('does not follow a junction outside the cache', async () => {
    const f = fixture(), store = f.open()
    store.beginBoot()
    const candidate = await stage(store)
    const root = path.join(f.root, 'online-updates/frontend/releases', candidate.entry.sha256, 'client')
    const assets = path.join(root, 'assets'), outside = path.join(f.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'main.js'), "document.title = 'UI 2'")
    if (path.dirname(assets) !== root || !root.startsWith(f.root + path.sep)) throw new Error('Unsafe fixture move')
    fs.renameSync(assets, path.join(root, 'assets-original'))
    fs.symlinkSync(outside, assets, process.platform === 'win32' ? 'junction' : 'dir')
    const next = f.open()
    expect(next.beginBoot()).toBe(f.bundledClientDir)
    expect(fs.readFileSync(path.join(outside, 'main.js'), 'utf8')).toBe("document.title = 'UI 2'")
  })

  it('falls back safely when selection metadata is malformed and does not overwrite it at boot', () => {
    const f = fixture()
    const directory = path.join(f.root, 'online-updates/frontend')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'selection.json'), 'broken')
    const next = f.open()
    expect(next.beginBoot()).toBe(f.bundledClientDir)
    expect(fs.readFileSync(path.join(directory, 'selection.json'), 'utf8')).toBe('broken')
    expect(next.snapshot().phase).toBe('rolled-back')
  })

  it('cannot use cached executable code after its trust configuration is removed', async () => {
    const f = fixture(), initial = f.open()
    initial.beginBoot()
    await stage(initial)
    const noTrust = new FrontendUpdates({ ...f.options, source: null })
    expect(noTrust.beginBoot()).toBe(f.bundledClientDir)
    await expect(stage(noTrust)).rejects.toThrow()
  })

  it('does not publish a partially written candidate when the application closes during staging', async () => {
    const f = fixture(), store = f.open()
    store.beginBoot()
    const pending = stage(store)
    store.dispose()
    await expect(pending).rejects.toThrow()
    const next = f.open()
    expect(next.beginBoot()).toBe(f.bundledClientDir)
    expect(next.snapshot().staged).toBeNull()
    expect(fs.readdirSync(path.join(f.root, 'online-updates/frontend/releases'))).toEqual([])
  })
})
