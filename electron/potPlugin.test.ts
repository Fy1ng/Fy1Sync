import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BGUTIL_PLUGIN_SHA256, prepareScriptOnlyPotPlugin, readScriptOnlyPluginZip } from './potPlugin'

vi.mock('node:crypto', async original => {
  const crypto = await original<typeof import('node:crypto')>()
  return { ...crypto, createHash: vi.fn(crypto.createHash) }
})
const actualCrypto = await vi.importActual<typeof import('node:crypto')>('node:crypto')
const roots: string[] = []
beforeEach(() => { vi.mocked(createHash).mockReset().mockImplementation(actualCrypto.createHash) })
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const BASE = 'yt_dlp_plugins/extractor/getpot_bgutil.py'
const SCRIPT = 'yt_dlp_plugins/extractor/getpot_bgutil_script.py'
const HTTP = 'yt_dlp_plugins/extractor/getpot_bgutil_http.py'
const contents = [{ name: BASE, data: Buffer.from('# base source\n') }, { name: SCRIPT, data: Buffer.from('# one-shot script\n') }]

function checksum(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(entries: { name: string; data: Buffer; method?: number; size?: number; mode?: number }[] = contents): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const method = entry.method ?? 8
    const body = method === 0 ? entry.data : deflateRawSync(entry.data)
    const crc = checksum(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.size ?? entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.size ?? entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const table = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(table.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, table, end])
}

async function expanded(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer-pot-test-'))
  roots.push(root)
  await mkdir(path.join(root, 'yt_dlp_plugins', 'extractor'), { recursive: true })
  for (const entry of [...contents, { name: HTTP, data: Buffer.from('# HTTP must never be copied\n') }]) await writeFile(path.join(root, entry.name), entry.data)
  return root
}

describe('bounded script-only ZIP extraction', () => {
  it('reads stored and deflated sources but never extracts the HTTP provider or other entries', () => {
    const files = readScriptOnlyPluginZip(zip([{ ...contents[0]!, method: 0 }, contents[1]!, { name: HTTP, data: Buffer.from('HTTP') }]))
    expect([...files.keys()]).toEqual([BASE, SCRIPT])
    for (const entry of contents) expect(files.get(entry.name)).toEqual(entry.data)
  })

  it.each(['../escape.py', '/absolute.py', 'C:/absolute.py', 'a\\escape.py', 'a/../escape.py'])('rejects path traversal entry %s', name => {
    expect(() => readScriptOnlyPluginZip(zip([...contents, { name, data: Buffer.from('bad') }]))).toThrow()
  })

  it('rejects missing, duplicate, symlink, encrypted and unsupported source entries', () => {
    expect(() => readScriptOnlyPluginZip(zip(contents.slice(0, 1)))).toThrow()
    expect(() => readScriptOnlyPluginZip(zip([...contents, contents[0]!]))).toThrow()
    expect(() => readScriptOnlyPluginZip(zip([{ ...contents[0]!, mode: 0o120777 }, contents[1]!]))).toThrow()
    expect(() => readScriptOnlyPluginZip(zip([{ ...contents[0]!, method: 99 }, contents[1]!]))).toThrow()
    const encrypted = zip()
    const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    encrypted.writeUInt16LE(1, central + 8)
    expect(() => readScriptOnlyPluginZip(encrypted)).toThrow()
  })

  it('rejects oversized archives, declared source sizes and decompression bombs', () => {
    expect(() => readScriptOnlyPluginZip(Buffer.alloc(16 * 1_048_576 + 1))).toThrow()
    expect(() => readScriptOnlyPluginZip(zip([{ ...contents[0]!, size: 1_048_577 }, contents[1]!]))).toThrow()
    expect(() => readScriptOnlyPluginZip(zip([{ name: BASE, data: Buffer.alloc(1_048_577), size: 1 }, contents[1]!]))).toThrow()
  })

  it('validates central bounds, local names, payload size and CRC before accepting bytes', () => {
    const centralBounds = zip()
    centralBounds.writeUInt32LE(0xffffffff, centralBounds.length - 6)
    expect(() => readScriptOnlyPluginZip(centralBounds)).toThrow()
    const localName = zip()
    localName[30] = 0x61
    expect(() => readScriptOnlyPluginZip(localName)).toThrow()
    expect(() => readScriptOnlyPluginZip(zip([{ ...contents[0]!, size: 1 }, contents[1]!]))).toThrow()
    const crc = zip()
    const central = crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    crc.writeUInt32LE(0, central + 16)
    expect(() => readScriptOnlyPluginZip(crc)).toThrow()
    expect(() => readScriptOnlyPluginZip(Buffer.from('not a ZIP'))).toThrow()
  })
})

describe('private script-only plugin preparation', () => {
  it.each([false, true])('copies only both source files from an expanded installation (namespace=%s)', async namespace => {
    const root = await expanded()
    const prepared = await prepareScriptOnlyPotPlugin(namespace ? path.join(root, 'yt_dlp_plugins') : root)
    roots.push(prepared.pluginDir)
    expect(prepared.pluginDir).not.toBe(root)
    const files = (await readdir(prepared.pluginDir, { recursive: true })).filter(name => name.endsWith('.py')).map(name => name.replaceAll(path.sep, '/'))
    expect(files.sort()).toEqual([`script/${BASE}`, `script/${SCRIPT}`].sort())
    expect(await readFile(path.join(prepared.pluginDir, 'script', BASE))).toEqual(contents[0]!.data)
    expect(await readFile(path.join(root, HTTP), 'utf8')).toContain('HTTP')
    await prepared.dispose()
    await prepared.dispose()
    await expect(stat(prepared.pluginDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checks the pinned SHA256 before parsing an installed ZIP', async () => {
    const root = await expanded()
    await writeFile(path.join(root, 'bgutil-ytdlp-pot-provider.zip'), zip())
    await expect(prepareScriptOnlyPotPlugin(root)).rejects.toThrow(/^PO token 脚本插件不可用$/)
    expect(createHash).toHaveBeenCalledExactlyOnceWith('sha256')
  })

  it('prepares only the approved sources from a checksum-verified archive', async () => {
    const root = await expanded()
    const archive = zip([...contents, { name: HTTP, data: Buffer.from('HTTP') }])
    await writeFile(path.join(root, 'bgutil-ytdlp-pot-provider.zip'), archive)
    const digest = { update: vi.fn().mockReturnThis(), digest: vi.fn(() => BGUTIL_PLUGIN_SHA256) }
    vi.mocked(createHash).mockReturnValue(digest as unknown as ReturnType<typeof createHash>)
    const prepared = await prepareScriptOnlyPotPlugin(root)
    roots.push(prepared.pluginDir)
    expect(digest.update).toHaveBeenCalledWith(archive)
    expect(digest.digest).toHaveBeenCalledWith('hex')
    const python = (await readdir(prepared.pluginDir, { recursive: true })).filter(name => name.endsWith('.py'))
    expect(python).toHaveLength(2)
    expect(python.some(name => name.includes('http'))).toBe(false)
    await prepared.dispose()
  })

  it('rejects expanded source directories that escape through a junction or symlink', async () => {
    const root = await expanded()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'syncer-pot-outside-'))
    roots.push(outside)
    for (const entry of contents) await writeFile(path.join(outside, path.basename(entry.name)), entry.data)
    const extractor = path.join(root, 'yt_dlp_plugins', 'extractor')
    await rm(extractor, { recursive: true })
    await symlink(outside, extractor, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareScriptOnlyPotPlugin(root)).rejects.toThrow(/^PO token 脚本插件不可用$/)
    expect(await readFile(path.join(outside, 'getpot_bgutil.py'))).toEqual(contents[0]!.data)
  })

  it('bounds expanded source files and never exposes installation paths in errors', async () => {
    const root = await expanded()
    await writeFile(path.join(root, SCRIPT), Buffer.alloc(1_048_577))
    await expect(prepareScriptOnlyPotPlugin(root)).rejects.toThrow(/^PO token 脚本插件不可用$/)
    await expect(prepareScriptOnlyPotPlugin('relative/private/path')).rejects.toThrow(/^PO token 脚本插件不可用$/)
  })
})
