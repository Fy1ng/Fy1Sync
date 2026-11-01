import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateStylePackKeys, prepareStylePackRelease, runStylePackRelease, type ReleaseValidators, type StylePackReleaseOptions } from '../scripts/stylepack-release.mjs'
import { createEmptyHudStylePack, parseHudStylePack } from '../src/core/hudStylePack'
import { parseStylePackSource, verifyStylePackCatalog } from '../electron/stylePackSync'

const validators: ReleaseValidators = { parseHudStylePack, parseStylePackSource, verifyStylePackCatalog }

describe('offline style pack releases', () => {
  let directory: string
  let options: StylePackReleaseOptions
  let keys: Awaited<ReturnType<typeof generateStylePackKeys>>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fy1sync-stylepack-release-'))
    keys = await generateStylePackKeys(join(directory, 'private'))
    const inputDirectory = join(directory, 'input')
    await mkdir(inputDirectory)
    await writeFile(join(inputDirectory, 'iem.json'), JSON.stringify(createEmptyHudStylePack('cs2/iem', 'IEM')))
    options = {
      inputDirectory, destination: join(directory, 'public'), privateKeyPath: keys.privatePath,
      manifestUrl: 'https://assets.example.com/styles/manifest.json', revision: 1, minAppVersion: '0.2.0', validators,
    }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it('produces a catalog accepted by the client, with exact public content hashes and no private material', async () => {
    const output = await prepareStylePackRelease(options)
    const envelope = JSON.parse(await readFile(output.manifestPath, 'utf8'))
    const catalog = verifyStylePackCatalog(envelope, output.source)
    expect(catalog).toEqual(output.catalog)
    expect(catalog.packs).toHaveLength(1)
    const entry = catalog.packs[0]!
    const bytes = await readFile(join(options.destination, entry.path))
    expect(entry.bytes).toBe(bytes.length)
    expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(parseHudStylePack(JSON.parse(bytes.toString('utf8'))).pack?.id).toBe('cs2/iem')
    expect(await readdir(options.destination)).toEqual(['manifest.json', 'packs'])
    const privatePem = await readFile(keys.privatePath, 'utf8')
    expect(JSON.stringify(envelope)).not.toContain(privatePem)
    expect(bytes.toString('utf8')).not.toContain('PRIVATE KEY')
    expect(output.source.publicKey).toBe(keys.publicKey)
  })

  it('refuses key replacement and never prints private key contents', async () => {
    const original = await readFile(keys.privatePath)
    await expect(generateStylePackKeys(join(directory, 'private'))).rejects.toThrow('不会覆盖')
    expect(await readFile(keys.privatePath)).toEqual(original)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await runStylePackRelease(['keygen', '--out', join(directory, 'new-private')])
    expect(stdout.mock.calls.flat().join(' ')).not.toContain('PRIVATE KEY')
  })

  it('keeps unchanged pack bytes stable despite source JSON whitespace and property ordering', async () => {
    const first = await prepareStylePackRelease(options)
    const raw = JSON.parse(await readFile(join(options.inputDirectory, 'iem.json'), 'utf8'))
    const reordered = Object.fromEntries(Object.entries(raw).reverse())
    await writeFile(join(options.inputDirectory, 'iem.json'), `${JSON.stringify(reordered, null, 4)}\n`)
    const second = await prepareStylePackRelease({ ...options, revision: 2 })
    expect(second.catalog.packs).toEqual(first.catalog.packs)
    expect(await readdir(join(options.destination, 'packs'))).toHaveLength(1)
  })

  it('rejects changed content under an existing pack revision and preserves the active manifest', async () => {
    const first = await prepareStylePackRelease(options)
    const originalManifest = await readFile(first.manifestPath)
    await writeFile(join(options.inputDirectory, 'iem.json'), JSON.stringify({ ...createEmptyHudStylePack('cs2/iem', 'IEM 2027') }))
    await expect(prepareStylePackRelease({ ...options, revision: 2 })).rejects.toThrow('递增')
    expect(await readFile(first.manifestPath)).toEqual(originalManifest)
    await writeFile(join(options.inputDirectory, 'iem.json'), JSON.stringify({ ...createEmptyHudStylePack('cs2/iem', 'IEM 2027'), revision: 2 }))
    expect((await prepareStylePackRelease({ ...options, revision: 2 })).catalog.packs[0]?.revision).toBe(2)
  })

  it('rejects equal and decreasing catalog revisions, including a previous release in another directory', async () => {
    const first = await prepareStylePackRelease(options)
    await expect(prepareStylePackRelease(options)).rejects.toThrow('必须大于')
    await expect(prepareStylePackRelease({ ...options, destination: join(directory, 'other-public'), previousManifest: first.manifestPath })).rejects.toThrow('必须大于')
    const second = await prepareStylePackRelease({ ...options, revision: 2, destination: join(directory, 'other-public'), previousManifest: first.manifestPath })
    expect(second.catalog.packs).toEqual(first.catalog.packs)
  })

  it('rejects an old catalog signed by a different publisher', async () => {
    const first = await prepareStylePackRelease(options)
    const another = await generateStylePackKeys(join(directory, 'another-private'))
    await expect(prepareStylePackRelease({ ...options, revision: 2, privateKeyPath: another.privatePath, previousManifest: first.manifestPath, destination: join(directory, 'other-public') })).rejects.toThrow()
  })

  it('cannot replace a newer destination catalog by supplying an older --previous file', async () => {
    const first = await prepareStylePackRelease(options)
    const older = join(directory, 'old-manifest.json')
    await writeFile(older, await readFile(first.manifestPath))
    const newer = await prepareStylePackRelease({ ...options, revision: 3 })
    const newestBytes = await readFile(newer.manifestPath)
    await expect(prepareStylePackRelease({ ...options, revision: 2, previousManifest: older })).rejects.toThrow('必须大于')
    expect(await readFile(newer.manifestPath)).toEqual(newestBytes)
  })

  it('rejects malformed HUD data and duplicate IDs before creating public files', async () => {
    await writeFile(join(options.inputDirectory, 'iem.json'), JSON.stringify({ ...createEmptyHudStylePack('cs2/iem', 'IEM'), unknown: true }))
    await expect(prepareStylePackRelease(options)).rejects.toThrow('生产格式校验')
    await expect(readdir(options.destination)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(options.inputDirectory, 'iem.json'), JSON.stringify(createEmptyHudStylePack('cs2/iem', 'IEM')))
    await writeFile(join(options.inputDirectory, 'duplicate.json'), JSON.stringify(createEmptyHudStylePack('cs2/iem', 'IEM')))
    await expect(prepareStylePackRelease(options)).rejects.toThrow('重复')
  })

  it('requires explicit permission to publish an empty catalog', async () => {
    await rm(join(options.inputDirectory, 'iem.json'))
    await expect(prepareStylePackRelease(options)).rejects.toThrow('--allow-empty')
    expect((await prepareStylePackRelease({ ...options, allowEmpty: true })).catalog.packs).toEqual([])
  })

  it('does not publish a directory containing a private key or unknown files', async () => {
    await expect(prepareStylePackRelease({ ...options, destination: join(directory, 'private') })).rejects.toThrow('隔离')
    await mkdir(options.destination)
    await writeFile(join(options.destination, 'notes.txt'), 'unrelated private text')
    await expect(prepareStylePackRelease(options)).rejects.toThrow('非样式包文件')
    expect(await readFile(join(options.destination, 'notes.txt'), 'utf8')).toBe('unrelated private text')
  })

  it('refuses directory junctions instead of writing outside the selected output', async () => {
    const real = join(directory, 'outside')
    await mkdir(real)
    await symlink(real, options.destination, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareStylePackRelease(options)).rejects.toThrow('符号链接')
    expect(await readdir(real)).toEqual([])
  })

  it('does not overwrite a damaged content-addressed file or commit a new manifest', async () => {
    const first = await prepareStylePackRelease(options)
    const manifest = await readFile(first.manifestPath)
    await writeFile(join(options.destination, first.catalog.packs[0]!.path), 'broken')
    await expect(prepareStylePackRelease({ ...options, revision: 2 })).rejects.toThrow('已损坏')
    expect(await readFile(first.manifestPath)).toEqual(manifest)
  })

  it('validates compatibility metadata with the production catalog validator', async () => {
    await expect(prepareStylePackRelease({ ...options, minAppVersion: 'not-a-version' })).rejects.toThrow()
    await expect(readdir(options.destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves an unchanged pack minimum by default and requires a revision for compatibility metadata changes', async () => {
    const first = await prepareStylePackRelease({ ...options, minAppVersion: '0.1.0' })
    const second = await prepareStylePackRelease({ ...options, revision: 2, minAppVersion: undefined })
    expect(second.catalog.packs).toEqual(first.catalog.packs)
    await expect(prepareStylePackRelease({ ...options, revision: 3, minAppVersion: '0.3.0' })).rejects.toThrow('递增')
  })
})
