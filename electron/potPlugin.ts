import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const BGUTIL_PLUGIN_SHA256 = 'a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef'
const ARCHIVE_NAME = 'bgutil-ytdlp-pot-provider.zip'
const MAX_ARCHIVE_BYTES = 16 * 1_048_576
const MAX_SOURCE_BYTES = 1_048_576
const SOURCE_NAMES = ['getpot_bgutil.py', 'getpot_bgutil_script.py'] as const
const ENTRY_NAMES = SOURCE_NAMES.map(name => `yt_dlp_plugins/extractor/${name}`)

export interface PrivatePotPlugin { pluginDir: string; dispose: () => Promise<void> }

function invalid(): never { throw new Error('Invalid PO token script plugin') }

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc >>> 0
})
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

/** Read only the two exact source entries; never derive output paths from ZIP names. */
export function readScriptOnlyPluginZip(archive: Buffer): ReadonlyMap<string, Buffer> {
  if (archive.length < 22 || archive.length > MAX_ARCHIVE_BYTES) invalid()
  let end = -1
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 65_535); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) {
      end = offset; break
    }
  }
  if (end < 0 || archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0) invalid()
  const entries = archive.readUInt16LE(end + 10)
  const centralSize = archive.readUInt32LE(end + 12)
  const centralStart = archive.readUInt32LE(end + 16)
  if (!entries || entries > 1024 || entries !== archive.readUInt16LE(end + 8) || centralStart + centralSize !== end) invalid()
  const names = new Set<string>()
  const files = new Map<string, Buffer>()
  let cursor = centralStart
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) invalid()
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const expectedCrc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > end || !nameLength || archive.readUInt16LE(cursor + 34) !== 0 || (flags & 1)) invalid()
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = rawName.toString('utf8')
    if (!Buffer.from(name).equals(rawName) || name.includes('\\') || name.includes('\0') || name.startsWith('/')
      || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) invalid()
    names.add(name)
    if (ENTRY_NAMES.includes(name)) {
      if (!uncompressedSize || uncompressedSize > MAX_SOURCE_BYTES || compressedSize > MAX_ARCHIVE_BYTES
        || ((archive.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000 || ![0, 8].includes(method)) invalid()
      if (localOffset + 30 > centralStart || archive.readUInt32LE(localOffset) !== 0x04034b50
        || archive.readUInt16LE(localOffset + 6) !== flags || archive.readUInt16LE(localOffset + 8) !== method) invalid()
      const localNameLength = archive.readUInt16LE(localOffset + 26)
      const bodyStart = localOffset + 30 + localNameLength + archive.readUInt16LE(localOffset + 28)
      if (bodyStart + compressedSize > centralStart
        || !archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(rawName)) invalid()
      const compressed = archive.subarray(bodyStart, bodyStart + compressedSize)
      const content = method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_SOURCE_BYTES }) : Buffer.from(compressed)
      if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) invalid()
      files.set(name, content)
    }
    cursor = next
  }
  if (cursor !== end || files.size !== ENTRY_NAMES.length) invalid()
  return files
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Resolve before opening so expanded installations cannot read through escaping symlinks. */
async function boundedFile(root: string, relative: string, limit: number): Promise<Buffer> {
  const resolved = await realpath(path.join(root, relative))
  if (!within(root, resolved)) invalid()
  const file = await open(resolved, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > limit) invalid()
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (!length || length > limit) invalid()
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

/** Build a private namespace containing no HTTP provider, without modifying the installation. */
export async function prepareScriptOnlyPotPlugin(pluginDir: string): Promise<PrivatePotPlugin> {
  let temporary: string | undefined
  let tempBase: string | undefined
  const cleanup = async () => {
    if (temporary && tempBase && path.dirname(temporary) === tempBase && path.basename(temporary).startsWith('stream-syncer-pot-')) {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  try {
    if (!path.isAbsolute(pluginDir)) invalid()
    const sourceRoot = await realpath(pluginDir)
    if (!(await stat(sourceRoot)).isDirectory()) invalid()
    let files: ReadonlyMap<string, Buffer>
    let archivePresent = false
    try { await stat(path.join(sourceRoot, ARCHIVE_NAME)); archivePresent = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (archivePresent) {
      const archive = await boundedFile(sourceRoot, ARCHIVE_NAME, MAX_ARCHIVE_BYTES)
      if (createHash('sha256').update(archive).digest('hex') !== BGUTIL_PLUGIN_SHA256) invalid()
      files = readScriptOnlyPluginZip(archive)
    } else {
      const namespace = path.basename(sourceRoot) === 'yt_dlp_plugins' ? '' : 'yt_dlp_plugins'
      files = new Map(await Promise.all(ENTRY_NAMES.map(async (entry, index) => [entry,
        await boundedFile(sourceRoot, path.join(namespace, 'extractor', SOURCE_NAMES[index]!), MAX_SOURCE_BYTES),
      ] as const)))
    }
    tempBase = await realpath(os.tmpdir())
    temporary = await mkdtemp(path.join(tempBase, 'stream-syncer-pot-'))
    const destination = path.join(temporary, 'script', 'yt_dlp_plugins', 'extractor')
    await mkdir(destination, { recursive: true, mode: 0o700 })
    for (const name of SOURCE_NAMES) await writeFile(path.join(destination, name), files.get(`yt_dlp_plugins/extractor/${name}`)!, { mode: 0o600, flag: 'wx' })
    return { pluginDir: temporary, dispose: cleanup }
  } catch {
    await cleanup()
    throw new Error('PO token 脚本插件不可用')
  }
}
