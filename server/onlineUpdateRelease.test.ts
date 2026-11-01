import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateOnlineUpdateKeys, prepareOnlineUpdateRelease, runOnlineUpdateRelease, type OnlineUpdateReleaseOptions, type OnlineUpdateReleaseValidators } from '../scripts/online-update-release.mjs'
import { compareAppVersions } from '../electron/appUpdateService'
import { parseOnlineUpdateSource, verifyOnlineUpdateCatalog, validateFrontendBundle } from '../electron/onlineUpdateManifest'
import type { ApplicationUpdateEntry } from '../electron/onlineUpdateContracts'
import appPackage from '../package.json'

const validators: OnlineUpdateReleaseValidators = { parseOnlineUpdateSource, verifyOnlineUpdateCatalog, validateFrontendBundle, compareAppVersions }
const html = '<!doctype html><html><head><script type="module" src="/assets/index-abcd1234.js"></script><link rel="stylesheet" href="/assets/index-abcd1234.css"></head><body><div id="root"></div></body></html>'
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('offline signed application update publisher', () => {
  let directory: string
  let options: OnlineUpdateReleaseOptions
  let keys: Awaited<ReturnType<typeof generateOnlineUpdateKeys>>

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'fy1sync-update-publisher-'))
    keys = await generateOnlineUpdateKeys(path.join(directory, 'private'))
    const clientDirectory = path.join(directory, 'client')
    await mkdir(path.join(clientDirectory, 'assets'), { recursive: true })
    await writeFile(path.join(clientDirectory, 'index.html'), html)
    await writeFile(path.join(clientDirectory, 'assets/index-abcd1234.js'), 'document.getElementById("root").textContent = "Synthetic update";')
    await writeFile(path.join(clientDirectory, 'assets/index-abcd1234.css'), 'body{color:#fff}')
    await mkdir(path.join(directory, 'config'))
    const sourcePath = path.join(directory, 'config/source.json')
    await writeFile(sourcePath, JSON.stringify({ publicKey: keys.publicKey, mirrors: [
      { id: 'github', manifestUrl: 'https://raw.githubusercontent.com/example/fy1sync/app-updates/manifest.json' },
      { id: 'gitcode', manifestUrl: 'https://raw.gitcode.com/example/fy1sync/raw/app-updates/manifest.json' },
    ] }))
    options = { destination: path.join(directory, 'public'), privateKeyPath: keys.privatePath, sourcePath,
      clientDirectory, revision: 2, catalogRevision: 1, validators }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('fy1sync-update-publisher-')) throw new Error('Invalid test cleanup path')
    await rm(directory, { recursive: true, force: true })
  })

  const applicationOptions = async (version = '0.3.0'): Promise<Partial<OnlineUpdateReleaseOptions>> => {
    const installerPath = path.join(directory, 'setup.exe')
    const bytes = Buffer.alloc(2_100_001, 0x42)
    bytes.write('MZ', 0)
    bytes.writeUInt32LE(128, 60)
    bytes.write('PE\0\0', 128)
    await writeFile(installerPath, bytes)
    const applicationDescriptorPath = path.join(directory, 'application.json')
    const descriptor: Omit<ApplicationUpdateEntry, 'sha256' | 'bytes'> = { version, platform: 'win32', arch: 'x64', notes: '合成离线安装包, 不执行.', downloads: {
      github: { url: `https://github.com/example/fy1sync/releases/download/v${version}/setup.exe`, redirectOrigins: ['https://release-assets.githubusercontent.com'] },
      gitcode: { url: `https://downloads.example.com/fy1sync/${version}/setup.exe`, redirectOrigins: [] },
    } }
    await writeFile(applicationDescriptorPath, JSON.stringify(descriptor))
    return { applicationDescriptorPath, installerPath }
  }

  it('produces exact signed public bytes accepted by the installed client, with no fixtures, maps or private files', async () => {
    await writeFile(path.join(options.clientDirectory!, 'assets/index-abcd1234.js.map'), 'SYNTHETIC_PRIVATE_SOURCE_MAP')
    await writeFile(path.join(options.clientDirectory!, '.env'), 'SYNTHETIC_PRIVATE_ENV')
    await mkdir(path.join(options.clientDirectory!, 'test-sources'))
    await writeFile(path.join(options.clientDirectory!, 'test-sources/private.json'), 'SYNTHETIC_PRIVATE_FIXTURE')
    const result = await prepareOnlineUpdateRelease(options)
    const envelope = JSON.parse(await readFile(result.manifestPath, 'utf8'))
    expect(verifyOnlineUpdateCatalog(envelope, result.source)).toEqual(result.catalog)
    const entry = result.catalog.frontend!
    const bytes = await readFile(path.join(options.destination, entry.path))
    expect(entry).toMatchObject({ revision: 2, bridgeVersion: 1, bytes: bytes.length, sha256: sha(bytes), minAppVersion: appPackage.version, maxAppVersion: appPackage.version })
    const bundle = validateFrontendBundle(JSON.parse(bytes.toString('utf8')), entry)
    expect(bundle.files.map(file => file.path)).toEqual(['index.html', 'assets/index-abcd1234.css', 'assets/index-abcd1234.js'])
    expect(result.catalog.application).toBeNull()
    expect(await readdir(options.destination)).toEqual(['frontends', 'history', 'manifest.json'])
    const historyNames = await readdir(path.join(options.destination, 'history'))
    expect(historyNames).toEqual([`1-${sha(Buffer.from(envelope.payload, 'base64'))}.json`])
    expect(JSON.parse(await readFile(path.join(options.destination, 'history', historyNames[0]!), 'utf8'))).toEqual(envelope)
    const allText = bundle.files.map(file => Buffer.from(file.content, 'base64').toString('utf8')).join('\n')
    expect(allText).not.toMatch(/SYNTHETIC_PRIVATE|PRIVATE KEY/)
    expect(JSON.stringify(envelope)).not.toContain((await readFile(keys.privatePath, 'utf8')).trim())
  })

  it('generates deterministic frontend content and signatures for the same inputs', async () => {
    const first = await prepareOnlineUpdateRelease(options)
    const second = await prepareOnlineUpdateRelease({ ...options, destination: path.join(directory, 'second-public') })
    expect(second.catalog).toEqual(first.catalog)
    expect(await readFile(second.manifestPath)).toEqual(await readFile(first.manifestPath))
  })

  it('does not replace existing keys or print their material', async () => {
    const original = await readFile(keys.privatePath)
    await expect(generateOnlineUpdateKeys(path.dirname(keys.privatePath))).rejects.toThrow('不会覆盖')
    expect(await readFile(keys.privatePath)).toEqual(original)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await runOnlineUpdateRelease(['keygen', '--out', path.join(directory, 'new-private')])
    const printed = stdout.mock.calls.flat().join(' ')
    expect(printed).not.toMatch(/PRIVATE KEY|MC4CAQ/)
    expect(printed).toContain('不会输出')
  })

  it('refuses a private key that does not match the built-in source configuration', async () => {
    const another = await generateOnlineUpdateKeys(path.join(directory, 'another-private'))
    await expect(prepareOnlineUpdateRelease({ ...options, privateKeyPath: another.privatePath })).rejects.toThrow('公钥不匹配')
    await expect(readdir(options.destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsafe directory relationships and preserves unrelated output', async () => {
    for (const destination of [directory, path.join(directory, 'private/release'), path.join(directory, 'config/release'), path.join(options.clientDirectory!, 'release')]) {
      await expect(prepareOnlineUpdateRelease({ ...options, destination })).rejects.toThrow('隔离')
    }
    await mkdir(options.destination)
    await writeFile(path.join(options.destination, 'private-note.txt'), 'UNRELATED_LOCAL_DATA')
    await expect(prepareOnlineUpdateRelease(options)).rejects.toThrow('非更新发布文件')
    expect(await readFile(path.join(options.destination, 'private-note.txt'), 'utf8')).toBe('UNRELATED_LOCAL_DATA')
  })

  it('refuses directory junctions for input, output and keys', async () => {
    const outside = path.join(directory, 'outside')
    await mkdir(outside)
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(outside, options.destination, type)
    await expect(prepareOnlineUpdateRelease(options)).rejects.toThrow('符号链接')
    expect(await readdir(outside)).toEqual([])
    const keyLink = path.join(directory, 'linked-key-dir')
    await symlink(path.dirname(keys.privatePath), keyLink, type)
    await expect(generateOnlineUpdateKeys(keyLink)).rejects.toThrow('符号链接')
    const clientLink = path.join(directory, 'client-link')
    await symlink(options.clientDirectory!, clientLink, type)
    await expect(prepareOnlineUpdateRelease({ ...options, destination: path.join(directory, 'second-public'), clientDirectory: clientLink })).rejects.toThrow('符号链接')
  })

  it.each([
    ['missing-script', html.replace('index-abcd1234.js', 'missing-deadbeef.js')],
    ['remote-script', html.replace('/assets/index-abcd1234.js', 'https://cdn.example.com/code.js')],
    ['inline-script', html.replace('</head>', '<script>alert(1)</script></head>')],
    ['no-root', html.replace('id="root"', 'id="not-root"')],
    ['base-element', html.replace('</head>', '<base href="https://other.example.com"></head>')],
  ])('refuses incomplete or non-local frontend entry %s', async (_name, document) => {
    await writeFile(path.join(options.clientDirectory!, 'index.html'), document)
    await expect(prepareOnlineUpdateRelease(options)).rejects.toThrow()
    await expect(readdir(options.destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checks referenced CSS and lazy JS assets before signing', async () => {
    const css = path.join(options.clientDirectory!, 'assets/index-abcd1234.css')
    await writeFile(css, 'body{background:url(./missing-abcd1234.png)}')
    await expect(prepareOnlineUpdateRelease(options)).rejects.toThrow('未收录')
    await writeFile(css, 'body{color:#fff}')
    await writeFile(path.join(options.clientDirectory!, 'assets/index-abcd1234.js'), 'import("./missing-abcd1234.js")')
    await expect(prepareOnlineUpdateRelease(options)).rejects.toThrow('未收录')
  })

  it('refuses unsafe asset names and accidental private key inclusion', async () => {
    const extra = path.join(options.clientDirectory!, 'assets/.env')
    await writeFile(extra, 'SYNTHETIC_ENV_VALUE')
    await expect(prepareOnlineUpdateRelease(options)).rejects.toThrow('文件名')
    await rm(extra)
    await writeFile(path.join(options.clientDirectory!, 'assets/index-abcd1234.js'), 'const value="-----BEGIN PRIVATE KEY-----";')
    await expect(prepareOnlineUpdateRelease(options)).rejects.toThrow('疑似包含私钥')
  })

  it('requires frontend revision to exceed the baseline and every supplied previous revision', async () => {
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 1 })).rejects.toThrow('必须大于')
    const first = await prepareOnlineUpdateRelease(options)
    const initialBytes = await readFile(first.manifestPath)
    await expect(prepareOnlineUpdateRelease({ ...options, catalogRevision: 2 })).rejects.toThrow('必须大于')
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 3 })).rejects.toThrow('必须大于')
    expect(await readFile(first.manifestPath)).toEqual(initialBytes)
    const previous = path.join(directory, 'older-manifest.json')
    await writeFile(previous, initialBytes)
    const next = await prepareOnlineUpdateRelease({ ...options, revision: 3, catalogRevision: 3 })
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 4, catalogRevision: 2, previousManifest: previous })).rejects.toThrow('必须大于')
    expect(await readFile(next.manifestPath)).not.toEqual(initialBytes)
  })

  it('validates client version ranges with the production parser before writing public files', async () => {
    await expect(prepareOnlineUpdateRelease({ ...options, minAppVersion: 'invalid' })).rejects.toThrow()
    await expect(prepareOnlineUpdateRelease({ ...options, minAppVersion: '0.3.0', maxAppVersion: '0.2.0' })).rejects.toThrow()
    await expect(readdir(options.destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the frontend when publishing an installer, and hashes/copies the entire installer exactly', async () => {
    const first = await prepareOnlineUpdateRelease(options)
    const app = await applicationOptions()
    const result = await prepareOnlineUpdateRelease({ ...options, ...app, clientDirectory: undefined, revision: undefined, catalogRevision: 2 })
    expect(result.catalog.frontend).toEqual(first.catalog.frontend)
    const entry = result.catalog.application!
    const sourceBytes = await readFile(app.installerPath!)
    expect(entry).toMatchObject({ version: '0.3.0', bytes: sourceBytes.length, sha256: sha(sourceBytes), platform: 'win32', arch: 'x64' })
    expect(await readFile(path.join(options.destination, 'installers', `${entry.sha256}.exe`))).toEqual(sourceBytes)
    expect(verifyOnlineUpdateCatalog(JSON.parse(await readFile(result.manifestPath, 'utf8')), result.source)).toEqual(result.catalog)
  }, 15_000)

  it('copies retained frontend assets when preparing a new output directory from a previous release', async () => {
    const first = await prepareOnlineUpdateRelease(options)
    const second = await prepareOnlineUpdateRelease({ ...options, ...await applicationOptions(), clientDirectory: undefined, revision: undefined,
      catalogRevision: 2, destination: path.join(directory, 'second-public'), previousManifest: first.manifestPath })
    expect(second.catalog.frontend).toEqual(first.catalog.frontend)
    expect(await readFile(path.join(second.destination, second.catalog.frontend!.path))).toEqual(await readFile(path.join(first.destination, first.catalog.frontend!.path)))
  })

  it('rejects installer downgrades and metadata changes under the same application version', async () => {
    const app = await applicationOptions()
    const first = await prepareOnlineUpdateRelease({ ...options, ...app })
    const original = await readFile(first.manifestPath)
    const descriptor = JSON.parse(await readFile(app.applicationDescriptorPath!, 'utf8'))
    for (const edit of [{ notes: 'changed' }, { version: '0.2.9' }]) {
      await writeFile(app.applicationDescriptorPath!, JSON.stringify({ ...descriptor, ...edit }))
      await expect(prepareOnlineUpdateRelease({ ...options, ...app, clientDirectory: undefined, revision: undefined, catalogRevision: 2 })).rejects.toThrow('提高应用版本')
      expect(await readFile(first.manifestPath)).toEqual(original)
    }
  })

  it('rejects non-PE installers and untrusted or malformed descriptors', async () => {
    const app = await applicationOptions()
    const originalInstaller = await readFile(app.installerPath!)
    await writeFile(app.installerPath!, 'not an installer')
    await expect(prepareOnlineUpdateRelease({ ...options, ...app })).rejects.toThrow('安装包')
    await writeFile(app.installerPath!, originalInstaller)
    const descriptor = JSON.parse(await readFile(app.applicationDescriptorPath!, 'utf8'))
    await writeFile(app.applicationDescriptorPath!, JSON.stringify({ ...descriptor, sha256: '0'.repeat(64) }))
    await expect(prepareOnlineUpdateRelease({ ...options, ...app })).rejects.toThrow('哈希和大小')
    await writeFile(app.applicationDescriptorPath!, JSON.stringify({ ...descriptor, downloads: { github: { url: 'file:///private/setup.exe', redirectOrigins: [] } } }))
    await expect(prepareOnlineUpdateRelease({ ...options, ...app })).rejects.toThrow()
    await expect(readdir(options.destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires explicit withdrawal and does not silently drop the other channel', async () => {
    await expect(prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined })).rejects.toThrow('显式撤回')
    const first = await prepareOnlineUpdateRelease({ ...options, ...await applicationOptions() })
    const second = await prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 2, dropApplication: true })
    expect(second.catalog.frontend).toEqual(first.catalog.frontend)
    expect(second.catalog.application).toBeNull()
    const third = await prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 3, dropFrontend: true })
    expect(third.catalog.frontend).toBeNull()
    expect(third.catalog.application).toBeNull()
    expect(await readFile(path.join(options.destination, first.catalog.frontend!.path))).toBeDefined()
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 3, catalogRevision: 4, dropFrontend: true })).rejects.toThrow('不能同时')
  })

  it('preserves the last signed manifest if an existing content-addressed asset is damaged', async () => {
    const first = await prepareOnlineUpdateRelease(options)
    const original = await readFile(first.manifestPath)
    await writeFile(path.join(options.destination, first.catalog.frontend!.path), 'damaged')
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 3, catalogRevision: 2 })).rejects.toThrow('已损坏')
    expect(await readFile(first.manifestPath)).toEqual(original)
  })

  it('retains the frontend high-water mark across withdrawal and rejects same or lower revisions', async () => {
    await prepareOnlineUpdateRelease({ ...options, revision: 5 })
    const withdrawn = await prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 2, dropFrontend: true })
    const before = await readFile(withdrawn.manifestPath)
    for (const revision of [5, 4, 2]) {
      await expect(prepareOnlineUpdateRelease({ ...options, revision, catalogRevision: 3 })).rejects.toThrow('必须大于')
      expect(await readFile(withdrawn.manifestPath)).toEqual(before)
    }
    const next = await prepareOnlineUpdateRelease({ ...options, revision: 6, catalogRevision: 3 })
    expect(next.catalog.frontend?.revision).toBe(6)
    expect(await readdir(path.join(next.destination, 'history'))).toHaveLength(3)
  })

  it('retains the application high-water mark across withdrawal even when the old installer is identical', async () => {
    const app = await applicationOptions('0.3.0')
    await prepareOnlineUpdateRelease({ ...options, ...app })
    const withdrawn = await prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 2, dropApplication: true })
    for (const version of ['0.3.0', '0.2.9']) {
      await expect(prepareOnlineUpdateRelease({ ...options, ...await applicationOptions(version), clientDirectory: undefined, revision: undefined, catalogRevision: 3 })).rejects.toThrow('提高应用版本')
    }
    const next = await prepareOnlineUpdateRelease({ ...options, ...await applicationOptions('0.4.0'), clientDirectory: undefined, revision: undefined, catalogRevision: 3 })
    expect(next.catalog.application?.version).toBe('0.4.0')
    expect(next.catalog.frontend).toEqual(withdrawn.catalog.frontend)
  }, 15_000)

  it('keeps withdrawn channels absent instead of resurrecting the highest non-null history entry', async () => {
    await prepareOnlineUpdateRelease({ ...options, ...await applicationOptions() })
    await prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 2, dropApplication: true, dropFrontend: true })
    const next = await prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 3 })
    expect(next.catalog.frontend).toBeNull()
    expect(next.catalog.application).toBeNull()
    expect(await readdir(path.join(next.destination, 'history'))).toHaveLength(3)
  })

  it('inherits authenticated history into a new output directory even when the previous manifest withdrew the channel', async () => {
    await prepareOnlineUpdateRelease({ ...options, revision: 5 })
    const withdrawn = await prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 2, dropFrontend: true })
    const nextDirectory = path.join(directory, 'next-public')
    await expect(prepareOnlineUpdateRelease({ ...options, destination: nextDirectory, previousManifest: withdrawn.manifestPath, catalogRevision: 3, revision: 5 })).rejects.toThrow('必须大于')
    await expect(readdir(nextDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    const next = await prepareOnlineUpdateRelease({ ...options, destination: nextDirectory, previousManifest: withdrawn.manifestPath, catalogRevision: 3, revision: 6 })
    const oldHistory = path.join(withdrawn.destination, 'history'), newHistory = path.join(next.destination, 'history')
    expect(await readdir(newHistory)).toHaveLength(3)
    for (const name of await readdir(oldHistory)) expect(await readFile(path.join(newHistory, name))).toEqual(await readFile(path.join(oldHistory, name)))
  })

  it('imports a baseline latest manifest that has no history directory without discarding that signed revision', async () => {
    const first = await prepareOnlineUpdateRelease(options)
    const history = path.join(first.destination, 'history')
    for (const name of await readdir(history)) await rm(path.join(history, name))
    await rmdir(history)
    const second = await prepareOnlineUpdateRelease({ ...options, revision: 3, catalogRevision: 2 })
    expect(await readdir(path.join(second.destination, 'history'))).toHaveLength(2)
  })

  it('rejects tampered history signatures, mismatched names and unsigned high-water records before changing the latest manifest', async () => {
    const first = await prepareOnlineUpdateRelease(options)
    const latest = await readFile(first.manifestPath)
    const history = path.join(first.destination, 'history'), name = (await readdir(history))[0]!
    const original = await readFile(path.join(history, name))
    const envelope = JSON.parse(original.toString('utf8'))
    await writeFile(path.join(history, name), JSON.stringify({ ...envelope, signature: Buffer.alloc(64).toString('base64') }))
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 3, catalogRevision: 2 })).rejects.toThrow()
    await writeFile(path.join(history, name), original)
    const badName = `1-${'0'.repeat(64)}.json`
    await rename(path.join(history, name), path.join(history, badName))
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 3, catalogRevision: 2 })).rejects.toThrow('文件名与签名')
    await rename(path.join(history, badName), path.join(history, name))
    const unsigned = path.join(history, `99-${'0'.repeat(64)}.json`)
    await writeFile(unsigned, JSON.stringify({ maxRevision: 99, application: '9.0.0' }))
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 3, catalogRevision: 2 })).rejects.toThrow()
    expect(await readFile(first.manifestPath)).toEqual(latest)
  })

  it('bounds the historical record count before parsing or writing new artifacts', async () => {
    const history = path.join(options.destination, 'history')
    await mkdir(history, { recursive: true })
    await Promise.all(Array.from({ length: 1025 }, (_, index) => writeFile(path.join(history, `${index + 1}-${'0'.repeat(64)}.json`), '{}')))
    await expect(prepareOnlineUpdateRelease(options)).rejects.toThrow('1024')
    await expect(readFile(path.join(options.destination, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reserves signed versions when artifact preparation fails and never revives that unpublished channel implicitly', async () => {
    const first = await prepareOnlineUpdateRelease(options)
    const latest = await readFile(first.manifestPath)
    const app = await applicationOptions()
    let changed = false
    const interrupted: OnlineUpdateReleaseValidators = { ...validators, verifyOnlineUpdateCatalog(raw, source) {
      const catalog = verifyOnlineUpdateCatalog(raw, source)
      if (!changed && catalog.revision === 2) { changed = true; appendFileSync(app.installerPath!, 'changed-after-signing') }
      return catalog
    } }
    await expect(prepareOnlineUpdateRelease({ ...options, ...app, revision: 3, catalogRevision: 2, validators: interrupted })).rejects.toThrow('签名准备期间发生变化')
    expect(await readFile(first.manifestPath)).toEqual(latest)
    expect(await readdir(path.join(options.destination, 'history'))).toHaveLength(2)
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 4, catalogRevision: 2 })).rejects.toThrow('必须大于')
    await expect(prepareOnlineUpdateRelease({ ...options, revision: 3, catalogRevision: 3 })).rejects.toThrow('必须大于')
    await expect(prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 3 })).rejects.toThrow('历史前端更新存在回退')
    const withdrawn = await prepareOnlineUpdateRelease({ ...options, clientDirectory: undefined, revision: undefined, catalogRevision: 3, dropFrontend: true })
    expect(withdrawn.catalog.frontend).toBeNull()
    expect(withdrawn.catalog.application).toBeNull()
    const fixed = await prepareOnlineUpdateRelease({ ...options, ...await applicationOptions('0.4.0'), revision: 4, catalogRevision: 4 })
    expect(fixed.catalog.frontend?.revision).toBe(4)
    expect(fixed.catalog.application?.version).toBe('0.4.0')
  }, 15_000)

  it('rejects unknown or repeated CLI flags without making output', async () => {
    for (const args of [['prepare', '--out', directory, '--out', directory], ['prepare', '--unknown', 'value'], ['keygen', '--out', directory, '--force', 'true']]) {
      await expect(runOnlineUpdateRelease(args)).rejects.toThrow()
    }
    await expect(readdir(options.destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
