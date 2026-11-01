import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnlineUpdateService, readVerifiedUpdateArchive, type OnlineUpdateServiceOptions } from './onlineUpdateService'
import type { FrontendBundle, FrontendSnapshot, FrontendUpdateEntry, FrontendUpdatePort, OnlineUpdateCatalog, OnlineUpdateSource, SignedUpdateCatalog } from './onlineUpdateContracts'

const roots: string[] = [], services: OnlineUpdateService[] = []
afterEach(async () => {
  services.forEach(service => service.dispose())
  await Promise.all(services.splice(0).map(service => service.cancel()))
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('fy1sync-online-tests-')) throw new Error('Unsafe test cleanup')
    await rm(root, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

function artifact(revision = 2) {
  const bundle: FrontendBundle = { kind: 'fy1sync-frontend-bundle', schemaVersion: 1, revision, version: `0.2.0+ui.${revision}`, bridgeVersion: 1, files: [
    { path: 'index.html', content: Buffer.from('<html><script src="/assets/app.js"></script></html>').toString('base64') },
    { path: 'assets/app.js', content: Buffer.from(`console.log(${revision})`).toString('base64') },
  ] }
  const bytes = Buffer.from(JSON.stringify(bundle)), sha256 = createHash('sha256').update(bytes).digest('hex')
  const entry: FrontendUpdateEntry = { revision, version: bundle.version, bridgeVersion: 1, minAppVersion: '0.2.0', maxAppVersion: '0.2.0',
    bytes: bytes.length, sha256, path: `frontends/${sha256}.json`, notes: `界面更新 ${revision}` }
  return { bundle, bytes, entry }
}

async function fixture(overrides: Partial<OnlineUpdateServiceOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fy1sync-online-tests-'))
  roots.push(root)
  const keys = generateKeyPairSync('ed25519')
  const source: OnlineUpdateSource = { publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), mirrors: [
    { id: 'github', manifestUrl: 'https://updates.example.org/updates/manifest.json' }, { id: 'gitcode', manifestUrl: 'https://mirror.example.org/updates/manifest.json' },
  ] }
  const frontend = artifact()
  const installer = Buffer.alloc(300_000, 0x41)
  installer.write('MZ')
  const installerHash = createHash('sha256').update(installer).digest('hex')
  const catalog: OnlineUpdateCatalog = { kind: 'fy1sync-update-catalog', schemaVersion: 1, revision: 1, frontend: frontend.entry, application: {
    platform: 'win32', arch: 'x64', version: '0.3.0', sha256: installerHash, bytes: installer.length, notes: '完整应用更新', downloads: {
      github: { url: 'https://downloads.example.org/github/setup.exe', redirectOrigins: [] },
      gitcode: { url: 'https://downloads.example.org/gitcode/setup.exe', redirectOrigins: [] },
    },
  } }
  const snapshot: FrontendSnapshot = { currentRevision: 1, currentVersion: '0.2.0', phase: 'bundled', staged: null, canRollback: false, blockedRevision: 0, message: '' }
  const stage = vi.fn(async (entry: FrontendUpdateEntry, _envelope: SignedUpdateCatalog, _bytes: Uint8Array) => { snapshot.staged = structuredClone(entry) })
  const discardStaged = vi.fn(async () => { snapshot.staged = null })
  const port: FrontendUpdatePort = { snapshot: () => structuredClone(snapshot), stage, discardStaged }
  const replies = new Map<string, () => Response | Promise<Response>>()
  const signCatalog = (value: OnlineUpdateCatalog): SignedUpdateCatalog => {
    const payload = Buffer.from(JSON.stringify(value))
    return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
  }
  const serve = (value: OnlineUpdateCatalog) => {
    const signed = signCatalog(value)
    for (const mirror of source.mirrors) replies.set(mirror.manifestUrl, () => Response.json(signed))
    return signed
  }
  const serveArtifact = (value: ReturnType<typeof artifact>) => {
    for (const mirror of source.mirrors) replies.set(new URL(value.entry.path, mirror.manifestUrl).href, () => new Response(new Uint8Array(value.bytes)))
  }
  serve(catalog)
  serveArtifact(frontend)
  for (const download of Object.values(catalog.application!.downloads)) replies.set(download.url, () => new Response(new Uint8Array(installer)))
  const request = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const response = replies.get(String(input))
    if (!response) throw new Error('Internal fixture request with token=do-not-expose')
    return response()
  })
  const options: OnlineUpdateServiceOptions = { userDataDir: root, source, currentAppVersion: '0.2.0', bridgeVersion: 1, frontend: port,
    installSupported: true, request, resolve: async () => ['93.184.216.34'], now: () => 1_793_000_000_000, ...overrides }
  const service = new OnlineUpdateService(options)
  services.push(service)
  const restart = () => {
    service.dispose()
    const next = new OnlineUpdateService(options)
    services.push(next)
    return next
  }
  return { root, source, catalog, frontend, installer, snapshot, stage, discardStaged, replies, request, service, options, serve, serveArtifact, signCatalog, restart }
}

describe('signed online update service', () => {
  it('does not contact the network until a manual check and never downloads as part of checking', async () => {
    const f = await fixture()
    expect(f.request).not.toHaveBeenCalled()
    expect(f.service.state()).toMatchObject({ phase: 'idle', source: 'github', currentFrontendRevision: 1 })
    const events = vi.fn()
    f.service.subscribe(events)
    const checked = await f.service.check()
    expect(checked).toMatchObject({ phase: 'idle', frontend: { phase: 'available', revision: 2 }, application: { phase: 'available', version: '0.3.0' } })
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.stage).not.toHaveBeenCalled()
    expect(events.mock.lastCall?.[0]).toEqual(checked)
    expect(readVerifiedUpdateArchive(f.root, f.source)?.latest.catalog).toEqual(f.catalog)
  })

  it('stages a valid frontend, publishes the final ready state, and keeps it available after a network failure', async () => {
    const f = await fixture()
    await f.service.check()
    const events = vi.fn()
    f.service.subscribe(events)
    const ready = await f.service.download('frontend')
    expect(ready.frontend).toMatchObject({ phase: 'ready', revision: 2 })
    expect(f.stage).toHaveBeenCalledWith(f.frontend.entry, f.signCatalog(f.catalog), expect.any(Uint8Array))
    expect(events.mock.lastCall?.[0]).toEqual(ready)
    f.replies.clear()
    expect(await f.service.check()).toMatchObject({ phase: 'error', frontend: { phase: 'ready' } })
    expect(f.discardStaged).not.toHaveBeenCalled()
    expect(JSON.stringify(f.service.state())).not.toContain('do-not-expose')
  })

  it('validates frontend contents before handing them to the staging port', async () => {
    const f = await fixture()
    await f.service.check()
    const url = new URL(f.frontend.entry.path, f.source.mirrors[0]!.manifestUrl).href
    f.replies.set(url, () => new Response(new Uint8Array(Buffer.alloc(f.frontend.bytes.length, 0x41))))
    expect((await f.service.download('frontend')).phase).toBe('error')
    expect(f.stage).not.toHaveBeenCalled()
    const broken = { ...f.frontend.bundle, files: [...f.frontend.bundle.files, { path: '../main.cjs', content: 'YQ==' }] }
    const bytes = Buffer.from(JSON.stringify(broken)), hash = createHash('sha256').update(bytes).digest('hex')
    const entry = { ...f.frontend.entry, revision: 3, sha256: hash, bytes: bytes.length, path: `frontends/${hash}.json` }
    f.serve({ ...f.catalog, revision: 2, frontend: entry })
    await f.service.check()
    f.replies.set(new URL(entry.path, f.source.mirrors[0]!.manifestUrl).href, () => new Response(new Uint8Array(bytes)))
    expect((await f.service.download('frontend')).phase).toBe('error')
    expect(f.stage).not.toHaveBeenCalled()
  })

  it('deduplicates requests and refuses a concurrent different download', async () => {
    const f = await fixture()
    const first = f.service.check(), second = f.service.check()
    expect(first).toBe(second)
    await first
    let release: ((value: Response) => void) | undefined
    f.replies.set(new URL(f.frontend.entry.path, f.source.mirrors[0]!.manifestUrl).href, () => new Promise<Response>(resolve => { release = resolve }))
    const download = f.service.download('frontend')
    expect(f.service.download('application')).toBe(download)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(() => f.service.setSource('gitcode')).toThrow()
    release!(new Response(new Uint8Array(f.frontend.bytes)))
    expect((await download).frontend.phase).toBe('ready')
    expect(f.request).toHaveBeenCalledTimes(2)
  })

  it('cancels an uncooperative download promptly without replacing an older staged artifact', async () => {
    const f = await fixture()
    await f.service.check()
    f.replies.set(new URL(f.frontend.entry.path, f.source.mirrors[0]!.manifestUrl).href, async () => new Promise<Response>(() => {}))
    const download = f.service.download('frontend')
    await vi.waitFor(() => expect(f.service.state().frontend.phase).toBe('downloading'))
    const cancelled = await f.service.cancel()
    expect(cancelled.phase).toBe('idle')
    expect(cancelled.message).toContain('已取消')
    expect(await download).toEqual(cancelled)
    expect(f.stage).not.toHaveBeenCalled()
    expect(f.snapshot.staged).toBeNull()
  })

  it('does not claim cancellation after an atomic staging commit has started', async () => {
    const f = await fixture()
    await f.service.check()
    let release: (() => void) | undefined
    f.stage.mockImplementationOnce(async entry => { await new Promise<void>(resolve => { release = resolve }); f.snapshot.staged = entry })
    const pending = f.service.download('frontend')
    await vi.waitFor(() => expect(release).toBeDefined())
    const cancellation = f.service.cancel()
    release!()
    expect((await pending).frontend.phase).toBe('ready')
    expect((await cancellation).message).not.toContain('已取消')
  })

  it('selects only embedded sources, makes selection itself offline, and persists it', async () => {
    const f = await fixture()
    await f.service.check()
    const calls = f.request.mock.calls.length
    expect(f.service.setSource('gitcode').source).toBe('gitcode')
    expect(f.request).toHaveBeenCalledTimes(calls)
    expect(() => f.service.setSource('https://evil.example.org' as 'github')).toThrow()
    const restored = f.restart()
    expect(restored.state().source).toBe('gitcode')
    await restored.check()
    expect(String(f.request.mock.lastCall?.[0])).toBe(f.source.mirrors[1]!.manifestUrl)
    f.replies.delete(f.source.mirrors[1]!.manifestUrl)
    const before = f.request.mock.calls.length
    expect((await restored.check()).phase).toBe('error')
    expect(f.request).toHaveBeenCalledTimes(before + 1)
    expect(restored.state().source).toBe('gitcode')
  })

  it('rejects catalog downgrade and same-revision equivocation across mirrors and restarts', async () => {
    const f = await fixture()
    f.serve({ ...f.catalog, revision: 4 })
    await f.service.check()
    f.service.setSource('gitcode')
    f.serve({ ...f.catalog, revision: 3 })
    expect((await f.service.check()).phase).toBe('error')
    const restored = f.restart()
    f.serve({ ...f.catalog, revision: 4, frontend: null })
    expect((await restored.check()).phase).toBe('error')
    expect(readVerifiedUpdateArchive(f.root, f.source)?.latest.catalog.revision).toBe(4)
    f.serve({ ...f.catalog, revision: 5 })
    expect((await restored.check()).phase).toBe('idle')
  })

  it('retains channel high-water marks even after a signed withdrawal', async () => {
    const f = await fixture()
    await f.service.check()
    f.serve({ ...f.catalog, revision: 2, frontend: null, application: null })
    await f.service.check()
    const cached = readVerifiedUpdateArchive(f.root, f.source)!
    expect(cached.frontendHigh?.catalog.frontend?.revision).toBe(2)
    expect(cached.applicationHigh?.catalog.application?.version).toBe('0.3.0')
    for (const changes of [
      { frontend: { ...f.frontend.entry, revision: 1 } }, { frontend: { ...f.frontend.entry, notes: 'changed without bump' } },
      { application: { ...f.catalog.application!, version: '0.2.5' } }, { application: { ...f.catalog.application!, notes: 'changed without bump' } },
    ]) {
      f.serve({ ...f.catalog, revision: 3, ...changes })
      expect((await f.service.check()).phase).toBe('error')
    }
  })

  it('withdraws a staged frontend only after the new catalog is persisted and verified', async () => {
    const f = await fixture()
    await f.service.check()
    await f.service.download('frontend')
    f.discardStaged.mockImplementationOnce(async () => {
      expect(readVerifiedUpdateArchive(f.root, f.source)?.latest.catalog.frontend).toBeNull()
      f.snapshot.staged = null
    })
    f.serve({ ...f.catalog, revision: 2, frontend: null })
    expect((await f.service.check()).frontend.phase).toBe('current')
    expect(f.discardStaged).toHaveBeenCalledOnce()
  })

  it('retains crash-safe withdrawal evidence if the frontend port cannot discard pending state', async () => {
    const f = await fixture()
    await f.service.check()
    await f.service.download('frontend')
    f.discardStaged.mockRejectedValueOnce(new Error('disk failure'))
    f.serve({ ...f.catalog, revision: 2, frontend: null })
    expect((await f.service.check()).phase).toBe('error')
    expect(readVerifiedUpdateArchive(f.root, f.source)?.latest.catalog.frontend).toBeNull()
    const count = f.request.mock.calls.length
    await f.service.check()
    expect(f.request).toHaveBeenCalledTimes(count)
  })

  it.each([
    { bridgeVersion: 2 }, { minAppVersion: '0.3.0', maxAppVersion: '0.3.0' }, { minAppVersion: '0.1.0', maxAppVersion: '0.1.9' },
  ])('does not download an incompatible frontend %j', async change => {
    const f = await fixture()
    f.serve({ ...f.catalog, frontend: { ...f.frontend.entry, ...change } })
    expect((await f.service.check()).frontend.phase).toBe('incompatible')
    await f.service.download('frontend')
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.stage).not.toHaveBeenCalled()
  })

  it('does not offer quarantined frontend revisions again but allows a higher revision', async () => {
    const f = await fixture()
    f.snapshot.phase = 'rolled-back'
    f.snapshot.blockedRevision = 2
    expect((await f.service.check()).frontend.phase).toBe('rolled-back')
    await f.service.download('frontend')
    expect(f.stage).not.toHaveBeenCalled()
    const next = artifact(3)
    f.serveArtifact(next)
    f.serve({ ...f.catalog, revision: 2, frontend: next.entry })
    expect((await f.service.check()).frontend.phase).toBe('available')
    expect((await f.service.download('frontend')).frontend.phase).toBe('ready')
  })

  it('streams, verifies and persists an installer, then revalidates it offline before execution', async () => {
    const f = await fixture()
    await f.service.check()
    expect((await f.service.download('application')).application.phase).toBe('ready')
    const file = await f.service.installerPath()
    expect(await readFile(file)).toEqual(f.installer)
    expect((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([])
    f.request.mockClear()
    f.replies.clear()
    const restored = f.restart()
    expect(await restored.installerPath()).toBe(file)
    expect(restored.state().application.phase).toBe('ready')
    expect(f.request).not.toHaveBeenCalled()
    await writeFile(file, Buffer.alloc(f.installer.length, 0x42))
    await expect(restored.installerPath()).rejects.toThrow()
    expect(restored.state()).toMatchObject({ phase: 'error', application: { phase: 'available' } })
  })

  it('retains an already verified installer when a later metadata check fails', async () => {
    const f = await fixture()
    await f.service.check()
    await f.service.download('application')
    f.replies.clear()
    expect(await f.service.check()).toMatchObject({ phase: 'error', application: { phase: 'ready' } })
    expect(await f.service.installerPath()).toContain(f.catalog.application!.sha256)
  })

  it('does not execute withdrawn installers, including after restart', async () => {
    const f = await fixture()
    await f.service.check()
    await f.service.download('application')
    f.serve({ ...f.catalog, revision: 2, application: null })
    expect((await f.service.check()).application.phase).toBe('unavailable')
    await expect(f.service.installerPath()).rejects.toThrow()
    await expect(f.restart().installerPath()).rejects.toThrow()
  })

  it.each(['partial', 'hash', 'cancel'])('cleans only its private temporary installer after %s failure', async mode => {
    const f = await fixture()
    await f.service.check()
    const download = f.catalog.application!.downloads.github!.url
    if (mode === 'hash') f.replies.set(download, () => new Response(new Uint8Array(Buffer.alloc(f.installer.length, 0x42))))
    else f.replies.set(download, () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(f.installer.subarray(0, 1024)))
      if (mode === 'partial') controller.close()
    } })))
    const pending = f.service.download('application')
    if (mode === 'cancel') {
      await vi.waitFor(() => expect(f.service.state().application.downloadedBytes).toBe(1024))
      await f.service.cancel()
    }
    const result = await pending
    expect(result.phase).toBe(mode === 'cancel' ? 'idle' : 'error')
    expect(result.application.phase).toBe('available')
    expect(await readdir(path.join(f.root, 'online-updates', 'installers'))).toEqual([])
    await expect(f.service.installerPath()).rejects.toThrow()
  })

  it('does not download or execute installers in an unsupported runtime', async () => {
    const f = await fixture({ installSupported: false })
    expect((await f.service.check()).application.phase).toBe('incompatible')
    await f.service.download('application')
    expect(f.request).toHaveBeenCalledTimes(1)
    await expect(f.service.installerPath()).rejects.toThrow()
  })

  it('does not download a missing-source installer from the other mirror', async () => {
    const f = await fixture()
    f.serve({ ...f.catalog, application: { ...f.catalog.application!, downloads: { github: f.catalog.application!.downloads.github } } })
    f.service.setSource('gitcode')
    expect((await f.service.check()).application.phase).toBe('incompatible')
    await f.service.download('application')
    expect(f.request).toHaveBeenCalledTimes(1)
  })

  it('refuses an installer directory junction without touching its external target', async () => {
    const f = await fixture()
    await f.service.check()
    const outside = await mkdtemp(path.join(tmpdir(), 'fy1sync-online-tests-outside-'))
    roots.push(outside)
    await writeFile(path.join(outside, 'sentinel'), 'keep')
    await symlink(outside, path.join(f.root, 'online-updates', 'installers'), 'junction')
    expect((await f.service.download('application')).phase).toBe('error')
    expect(await readdir(outside)).toEqual(['sentinel'])
    expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('keep')
  })

  it('fails closed on damaged persisted anti-downgrade evidence without erasing it', async () => {
    const f = await fixture()
    await f.service.check()
    const file = path.join(f.root, 'online-updates', 'catalog.json')
    await writeFile(file, '{bad-json')
    const restored = f.restart()
    const before = f.request.mock.calls.length
    expect((await restored.check()).phase).toBe('error')
    expect(f.request).toHaveBeenCalledTimes(before)
    expect(await readFile(file, 'utf8')).toBe('{bad-json')
  })

  it('rejects locally mixed signed proofs that equivocate at the same catalog revision', async () => {
    const f = await fixture()
    await f.service.check()
    f.serve({ ...f.catalog, revision: 2, frontend: null, application: null })
    await f.service.check()
    const file = path.join(f.root, 'online-updates', 'catalog.json')
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    record.frontendHigh = f.signCatalog({ ...f.catalog, revision: 2 })
    await writeFile(file, JSON.stringify(record))
    expect(() => readVerifiedUpdateArchive(f.root, f.source)).toThrow()
    expect(f.restart().state().phase).toBe('error')
  })

  it('has no writes or requests for an unconfigured source and stops future operations after disposal', async () => {
    const f = await fixture({ source: null })
    expect((await f.service.check()).phase).toBe('unconfigured')
    expect((await f.service.download('frontend')).phase).toBe('unconfigured')
    expect(f.request).not.toHaveBeenCalled()
    expect(await readdir(f.root)).toEqual([])
    f.service.dispose()
    await f.service.check()
    expect(f.request).not.toHaveBeenCalled()
  })
})
