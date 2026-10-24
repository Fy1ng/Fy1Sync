import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fingerprintRelease, verifyPackageArchive, type PackageSnapshot } from '../scripts/package-archive.mjs'

interface Member {
  name: string
  content?: string | Buffer
  localName?: string
  method?: number
  flags?: number
  mode?: number
  size?: number
  checksum?: number
  descriptor?: 'signed' | 'unsigned'
  extra?: Buffer
  listed?: boolean
}

/** A tiny fixture writer deliberately permits malformed inputs to exercise rejection. */
function zip(members: Member[], comment = ''): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const member of members) {
    const directory = member.name.endsWith('/')
    const name = Buffer.from(member.name), localName = Buffer.from(member.localName ?? member.name), extra = member.extra ?? Buffer.alloc(0)
    const content = Buffer.from(member.content ?? ''), method = member.method ?? (directory ? 0 : 8)
    const compressed = method === 8 ? deflateRawSync(content) : content
    const flags = member.flags ?? (0x800 | (member.descriptor ? 8 : 0)), checksum = member.checksum ?? crc32(content), size = member.size ?? content.length
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(33, 12)
    if (!member.descriptor) {
      header.writeUInt32LE(checksum, 14)
      header.writeUInt32LE(compressed.length, 18)
      header.writeUInt32LE(size, 22)
    }
    header.writeUInt16LE(localName.length, 26)
    header.writeUInt16LE(extra.length, 28)
    const descriptor = member.descriptor ? Buffer.alloc(member.descriptor === 'signed' ? 16 : 12) : Buffer.alloc(0)
    if (member.descriptor) {
      const skip = member.descriptor === 'signed' ? 4 : 0
      if (skip) descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(checksum, skip)
      descriptor.writeUInt32LE(compressed.length, skip + 4)
      descriptor.writeUInt32LE(size, skip + 8)
    }
    local.push(header, localName, extra, compressed, descriptor)
    if (member.listed !== false) {
      const entry = Buffer.alloc(46)
      entry.writeUInt32LE(0x02014b50, 0)
      entry.writeUInt16LE(0x0314, 4)
      entry.writeUInt16LE(20, 6)
      entry.writeUInt16LE(flags, 8)
      entry.writeUInt16LE(method, 10)
      entry.writeUInt16LE(33, 14)
      entry.writeUInt32LE(checksum, 16)
      entry.writeUInt32LE(compressed.length, 20)
      entry.writeUInt32LE(size, 24)
      entry.writeUInt16LE(name.length, 28)
      entry.writeUInt16LE(extra.length, 30)
      entry.writeUInt32LE(((member.mode ?? (directory ? 0o40755 : 0o100644)) << 16) >>> 0, 38)
      entry.writeUInt32LE(offset, 42)
      central.push(Buffer.concat([entry, name, extra]))
    }
    offset += header.length + localName.length + extra.length + compressed.length + descriptor.length
  }
  const directory = Buffer.concat(central), commentBytes = Buffer.from(comment), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(commentBytes.length, 20)
  return Buffer.concat([...local, directory, end, commentBytes])
}

const fixturesRoot = path.resolve('.runtime-cache/source-audit-20261024/zip-fixtures')
let root: string, release: string, archive: string
beforeEach(async () => {
  await mkdir(fixturesRoot, { recursive: true })
  root = await mkdtemp(path.join(fixturesRoot, 'case-'))
  release = path.join(root, 'release')
  archive = path.join(root, 'package.zip')
  await mkdir(release)
})
afterEach(async () => {
  if (path.dirname(root) !== fixturesRoot || !path.basename(root).startsWith('case-')) throw new Error('Invalid fixture cleanup path')
  await rm(root, { recursive: true, force: true })
})

async function snapshot(files: Record<string, string | Buffer>): Promise<PackageSnapshot> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(release, name)), { recursive: true })
    await writeFile(path.join(release, name), content)
  }
  return fingerprintRelease(release)
}

async function verify(members: Member[], expected: PackageSnapshot) {
  await writeFile(archive, zip(members))
  return verifyPackageArchive(archive, expected)
}

describe('release ZIP content verification', () => {
  it('matches stored, deflated, empty and UTF-8 files, including the physical network runtime', async () => {
    const files = { 'Stream Syncer.exe': 'synthetic executable', 'assets/弹幕.txt': 'fixture', 'empty.txt': '',
      'resources/app.asar.unpacked/electron/network-runtime.cjs': 'synthetic worker runtime' }
    const expected = await snapshot(files)
    await writeFile(archive, zip([
      { name: 'assets/' },
      ...Object.entries(files).map(([name, content], i) => ({ name, content, method: i % 2 ? 8 : 0 })),
    ], 'local test archive'))
    expect(await verifyPackageArchive(archive, expected)).toEqual({ files: 4, directories: 1, bytes: expected.bytes })
    expect(await readFile(path.join(release, 'Stream Syncer.exe'), 'utf8')).toBe('synthetic executable')
  })

  it.each(['signed', 'unsigned'] as const)('supports a consistent %s data descriptor', async descriptor => {
    const expected = await snapshot({ 'a.txt': 'matching content' })
    expect(await verify([{ name: 'a.txt', content: 'matching content', descriptor }], expected)).toMatchObject({ files: 1 })
  })

  it('rejects an old ZIP with the same file paths and sizes but different content', async () => {
    const expected = await snapshot({ 'main.cjs': 'new build' })
    await expect(verify([{ name: 'main.cjs', content: 'old build' }], expected)).rejects.toThrow('content differs')
  })

  it('includes unpacked runtime bytes in the content comparison', async () => {
    const name = 'resources/app.asar.unpacked/electron/network-runtime.cjs'
    const expected = await snapshot({ [name]: 'new runtime' })
    await expect(verify([{ name, content: 'old runtime' }], expected)).rejects.toThrow('content differs')
  })

  it('rejects a changed file size before accepting its contents', async () => {
    const expected = await snapshot({ 'a.txt': 'current' })
    await expect(verify([{ name: 'a.txt', content: 'short' }], expected)).rejects.toThrow('size differs')
  })

  it('rejects missing or additional ZIP files', async () => {
    const expected = await snapshot({ 'a.txt': 'a', 'b.txt': 'b' })
    await expect(verify([{ name: 'a.txt', content: 'a' }], expected)).rejects.toThrow('file set differs')
    await expect(verify([{ name: 'a.txt', content: 'a' }, { name: 'b.txt', content: 'b' }, { name: 'extra.txt', content: 'x' }], expected)).rejects.toThrow('file set or size differs')
  })

  it.each(['a.txt', 'A.TXT'])('rejects duplicate and Windows-case-equivalent ZIP members (%s)', async repeated => {
    const expected = await snapshot({ 'a.txt': 'a' })
    await expect(verify([{ name: 'a.txt', content: 'a' }, { name: repeated, content: 'a' }], expected)).rejects.toThrow('Duplicate ZIP')
  })

  it('rejects conflicting directory/file entries and unexpected empty directories', async () => {
    const expected = await snapshot({ 'folder/a.txt': 'a' })
    await expect(verify([{ name: 'folder/' }, { name: 'folder', content: '' }, { name: 'folder/a.txt', content: 'a' }], expected)).rejects.toThrow('Duplicate ZIP')
    await expect(verify([{ name: 'extra/' }, { name: 'folder/a.txt', content: 'a' }], expected)).rejects.toThrow('Unexpected ZIP directory')
  })

  it.each(['../escape', 'a/../escape', '/absolute', 'C:/absolute', 'a\\b', './a', 'a//b', 'a/./b', 'a:stream', 'nul.txt', 'COM1', 'folder./a', 'trailing ', 'bad\0name'])('rejects unsafe or ambiguous archive path %j', async name => {
    const expected = await snapshot({ 'a.txt': 'a' })
    await expect(verify([{ name, content: 'a' }], expected)).rejects.toThrow('Unsafe archive member path')
  })

  it('rejects symlink metadata even if its path matches a regular release file', async () => {
    const expected = await snapshot({ 'a.txt': 'a' })
    await expect(verify([{ name: 'a.txt', content: 'a', mode: 0o120777 }], expected)).rejects.toThrow('non-regular ZIP member')
  })

  it('rejects mismatched local paths and orphan records hidden from the central directory', async () => {
    const expected = await snapshot({ 'a.txt': 'a' })
    await expect(verify([{ name: 'a.txt', localName: '../hidden', content: 'a' }], expected)).rejects.toThrow('paths disagree')
    await expect(verify([{ name: 'a.txt', content: 'a' }, { name: '../hidden', content: 'x', listed: false }], expected)).rejects.toThrow('unlisted local data')
  })

  it('rejects encrypted, unsupported-compression and ambiguously encoded members', async () => {
    const expected = await snapshot({ 'a.txt': 'a', '弹幕.txt': 'b' })
    await expect(verify([{ name: 'a.txt', content: 'a', flags: 0x801 }], expected)).rejects.toThrow('Unsupported')
    await expect(verify([{ name: 'a.txt', content: 'a', method: 12 }], expected)).rejects.toThrow('Unsupported')
    await expect(verify([{ name: '弹幕.txt', content: 'b', flags: 0 }], expected)).rejects.toThrow('filename encoding')
  })

  it('rejects a Unicode path override that disagrees with the stored name', async () => {
    const expected = await snapshot({ 'a.txt': 'a' })
    const replacement = Buffer.from('../other'), extra = Buffer.alloc(9 + replacement.length)
    extra.writeUInt16LE(0x7075, 0)
    extra.writeUInt16LE(5 + replacement.length, 2)
    extra[4] = 1
    extra.writeUInt32LE(crc32(Buffer.from('a.txt')), 5)
    replacement.copy(extra, 9)
    await expect(verify([{ name: 'a.txt', content: 'a', extra }], expected)).rejects.toThrow('Conflicting ZIP Unicode path')
  })

  it('stops a decompressor that produces more bytes than the matching header declares', async () => {
    const expected = await snapshot({ 'a.txt': 'aaa' })
    await expect(verify([{ name: 'a.txt', content: Buffer.alloc(64 * 1024, 0x61), size: 3 }], expected)).rejects.toThrow('exceeds its verified size')
  })

  it('rejects a wrong CRC even when decompressed bytes match the release hash', async () => {
    const expected = await snapshot({ 'a.txt': 'a' })
    await expect(verify([{ name: 'a.txt', content: 'a', checksum: 1 }], expected)).rejects.toThrow('content differs')
  })

  it('enforces archive, central-directory, entry-count, file and total byte limits', async () => {
    const expected = await snapshot({ 'a.txt': 'aaa', 'b.txt': 'bbb' })
    await writeFile(archive, zip([{ name: 'a.txt', content: 'aaa' }, { name: 'b.txt', content: 'bbb' }]))
    for (const limits of [{ maxArchiveBytes: 22 }, { maxCentralDirectoryBytes: 1 }, { maxEntries: 1 }, { maxFileBytes: 2 }, { maxTotalBytes: 5 }]) {
      await expect(verifyPackageArchive(archive, expected, { limits })).rejects.toThrow(/limit|bounds/)
    }
    await expect(fingerprintRelease(release, { limits: { maxFileBytes: 2 } })).rejects.toThrow('limit')
  })

  it('rejects truncated central directories and unsupported ZIP64 end records', async () => {
    const expected = await snapshot({ 'a.txt': 'a' })
    const valid = zip([{ name: 'a.txt', content: 'a' }])
    await writeFile(archive, valid.subarray(0, valid.length - 3))
    await expect(verifyPackageArchive(archive, expected)).rejects.toThrow('end record')
    const zip64 = Buffer.from(valid)
    zip64.writeUInt16LE(0xffff, zip64.length - 12)
    zip64.writeUInt16LE(0xffff, zip64.length - 14)
    await writeFile(archive, zip64)
    await expect(verifyPackageArchive(archive, expected)).rejects.toThrow('ZIP64')
  })

  it('applies the release forbidden-path policy and refuses source-directory links', async () => {
    const expected = await snapshot({ 'a.txt': 'a' })
    await writeFile(archive, zip([{ name: 'a.txt', content: 'a' }]))
    await expect(verifyPackageArchive(archive, expected, { forbiddenPath: name => name === 'a.txt' })).rejects.toThrow('Forbidden archive')
    const target = path.join(root, 'target')
    await mkdir(target)
    await symlink(target, path.join(release, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fingerprintRelease(release)).rejects.toThrow('Non-regular entry')
  })
})
