import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { crc32, createInflateRaw } from 'node:zlib'

const require = createRequire(import.meta.url)
// Resolve through the existing packaging dependency, including a non-hoisted install.
const packagingRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const unzipper = packagingRequire('unzipper')

const defaults = Object.freeze({
  maxEntries: 20_000, maxArchiveBytes: 2 * 1024 ** 3, maxFileBytes: 1024 ** 3,
  maxTotalBytes: 4 * 1024 ** 3, maxCentralDirectoryBytes: 16 * 1024 ** 2,
})

function limitsFor(options) {
  const limits = { ...defaults, ...options?.limits }
  if (Object.keys(limits).some(key => !Object.hasOwn(defaults, key) || !Number.isSafeInteger(limits[key]) || limits[key] <= 0)) throw new Error('Invalid archive verification limit')
  return limits
}

function memberPath(name, forbiddenPath) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 1024 || /[\\\x00-\x1f\x7f<>:"|?*]/.test(name)) throw new Error('Unsafe archive member path')
  const directory = name.endsWith('/')
  const relative = directory ? name.slice(0, -1) : name
  const parts = relative.split('/')
  if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe archive member path')
  if (forbiddenPath?.(relative)) throw new Error('Forbidden archive member path: ' + relative)
  return { relative, directory, key: relative.normalize('NFC').toLowerCase() }
}

async function digest(input, limit, inflate = false) {
  const hash = createHash('sha256')
  let size = 0, checksum = 0
  const output = new Writable({ write(chunk, _encoding, callback) {
    size += chunk.length
    if (size > limit) { callback(new Error('Archive member exceeds its verified size')); return }
    hash.update(chunk)
    checksum = crc32(chunk, checksum)
    callback()
  } })
  try {
    await pipeline(input, ...(inflate ? [createInflateRaw()] : []), output)
    return { size, sha256: hash.digest('hex'), crc32: checksum }
  } finally { input.destroy() }
}

/** Read every regular release file once; nothing is extracted or written here. */
export async function fingerprintRelease(directory, options = {}) {
  const limits = limitsFor(options)
  const root = path.resolve(directory), rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Release root must be a regular directory')
  const files = new Map(), directories = new Set(), keys = new Set()
  let bytes = 0
  async function walk(folder, prefix = '') {
    for await (const entry of await opendir(folder)) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Non-regular entry in release')
      const relative = prefix + entry.name
      const checked = memberPath(relative + (entry.isDirectory() ? '/' : ''), options.forbiddenPath)
      if (keys.has(checked.key) || keys.size >= limits.maxEntries) throw new Error('Duplicate release path or entry limit exceeded')
      keys.add(checked.key)
      if (entry.isDirectory()) {
        directories.add(relative)
        await walk(path.join(folder, entry.name), relative + '/')
      } else {
        const file = path.join(folder, entry.name), info = await lstat(file)
        if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFileBytes || bytes + info.size > limits.maxTotalBytes) throw new Error('Release file size limit exceeded')
        const actual = await digest(createReadStream(file, { highWaterMark: 64 * 1024 }), info.size)
        if (actual.size !== info.size) throw new Error('Release file changed during verification')
        files.set(relative, actual)
        bytes += actual.size
      }
    }
  }
  await walk(root)
  return { files, directories, bytes }
}

async function readAt(handle, offset, length) {
  const bytes = Buffer.alloc(length)
  let count = 0
  while (count < length) {
    const { bytesRead } = await handle.read(bytes, count, length - count, offset + count)
    if (!bytesRead) throw new Error('Truncated ZIP structure')
    count += bytesRead
  }
  return bytes
}

/** Bound the central directory before asking a ZIP library to allocate its entry list. */
async function preflight(handle, size, limits) {
  if (size < 22 || size > limits.maxArchiveBytes) throw new Error('ZIP archive size limit exceeded')
  const tail = await readAt(handle, Math.max(0, size - 65_557), Math.min(size, 65_557))
  let end = -1
  for (let cursor = tail.length - 22; cursor >= 0; cursor--) {
    if (tail.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + tail.readUInt16LE(cursor + 20) === tail.length) { end = cursor; break }
  }
  if (end < 0) throw new Error('ZIP end record is missing')
  const endOffset = size - tail.length + end
  const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16)
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count
    || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('Multi-disk and ZIP64 releases are unsupported')
  if (count > limits.maxEntries || directorySize > limits.maxCentralDirectoryBytes || directoryOffset + directorySize !== endOffset) throw new Error('ZIP central directory exceeds its bounds')
  const central = await readAt(handle, directoryOffset, directorySize)
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory')
    const nameLength = central.readUInt16LE(cursor + 28), extraLength = central.readUInt16LE(cursor + 30), commentLength = central.readUInt16LE(cursor + 32)
    if (!nameLength || nameLength > 1024 || central.readUInt32LE(cursor + 20) === 0xffffffff
      || central.readUInt32LE(cursor + 24) === 0xffffffff || central.readUInt32LE(cursor + 42) === 0xffffffff) throw new Error('Unsupported ZIP member metadata')
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > central.length) throw new Error('Truncated ZIP central directory')
    checkExtra(central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength), central.subarray(cursor + 46, cursor + 46 + nameLength))
    cursor = next
  }
  if (cursor !== central.length) throw new Error('Unexpected data in ZIP central directory')
  return { count, directoryOffset, directorySize, endOffset }
}

function checkExtra(extra, rawName) {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) throw new Error('Truncated ZIP extra field')
    const kind = extra.readUInt16LE(cursor), length = extra.readUInt16LE(cursor + 2)
    const next = cursor + 4 + length
    if (next > extra.length || kind === 0x0001 || kind === 0x756e || kind === 0x000d) throw new Error('Unsupported ZIP extra field')
    if (kind === 0x7075) {
      const field = extra.subarray(cursor + 4, next)
      if (field.length < 5 || field[0] !== 1 || field.readUInt32LE(1) !== crc32(rawName) || !field.subarray(5).equals(rawName)) throw new Error('Conflicting ZIP Unicode path')
    }
    cursor = next
  }
}

async function localRecord(handle, entry, directoryOffset) {
  const offset = entry.offsetToLocalFileHeader
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 30 > directoryOffset) throw new Error('ZIP local header exceeds its bounds')
  const header = await readAt(handle, offset, 30)
  const nameLength = header.readUInt16LE(26), extraLength = header.readUInt16LE(28)
  const start = offset + 30 + nameLength + extraLength
  if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags
    || header.readUInt16LE(8) !== entry.compressionMethod || start + entry.compressedSize > directoryOffset) throw new Error('ZIP local and central headers disagree')
  const metadata = await readAt(handle, offset + 30, nameLength + extraLength)
  if (!metadata.subarray(0, nameLength).equals(entry.pathBuffer)) throw new Error('ZIP local and central paths disagree')
  checkExtra(metadata.subarray(nameLength), entry.pathBuffer)
  const localValues = [header.readUInt32LE(14), header.readUInt32LE(18), header.readUInt32LE(22)]
  const expected = [entry.crc32, entry.compressedSize, entry.uncompressedSize]
  const descriptor = (entry.flags & 8) !== 0
  if (localValues.some((value, index) => value !== expected[index] && (!descriptor || value !== 0))) throw new Error('ZIP local member sizes disagree')
  let end = start + entry.compressedSize
  if (descriptor) {
    if (end + 12 > directoryOffset) throw new Error('ZIP data descriptor exceeds its bounds')
    const bytes = await readAt(handle, end, Math.min(16, directoryOffset - end))
    const skip = bytes.readUInt32LE(0) === 0x08074b50 ? 4 : 0
    if (bytes.length < skip + 12 || expected.some((value, index) => bytes.readUInt32LE(skip + index * 4) !== value)) throw new Error('ZIP data descriptor disagrees')
    end += skip + 12
  }
  return { offset, start, end }
}

/** Verify the complete ZIP against the already-hashed unpacked tree, without extraction. */
export async function verifyPackageArchive(archive, expected, options = {}) {
  const limits = limitsFor(options)
  const info = await lstat(archive)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('ZIP archive must be a regular file')
  const handle = await open(archive, 'r'), streams = new Set()
  let rejectRead
  const failedRead = new Promise((_resolve, reject) => { rejectRead = reject })
  const source = {
    size: async () => info.size,
    stream(offset, length = info.size - offset) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset + length > info.size) throw new Error('ZIP read exceeds its bounds')
      // A range owns its iterator, not the shared descriptor. Destroying a standard
      // fs.ReadStream can close even an externally supplied descriptor on failure.
      const stream = Readable.from((async function* () {
        let position = offset, remaining = length
        while (remaining > 0) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
          if (!bytesRead) throw new Error('Truncated ZIP data')
          position += bytesRead
          remaining -= bytesRead
          yield chunk.subarray(0, bytesRead)
        }
      })(), { objectMode: false })
      streams.add(stream)
      stream.on('error', error => rejectRead(error))
      stream.once('close', () => streams.delete(stream))
      return stream
    },
  }
  try {
    const layout = await preflight(handle, info.size, limits)
    const directory = await Promise.race([unzipper.Open.custom(source, { tailSize: info.size - layout.endOffset }), failedRead])
    if (directory.files.length !== layout.count) throw new Error('ZIP member count disagrees')
    const members = [], keys = new Set(), seenFiles = new Set()
    let bytes = 0, directories = 0
    for (const entry of directory.files) {
      const checked = memberPath(entry.path, options.forbiddenPath)
      if (!Buffer.from(entry.path, 'utf8').equals(entry.pathBuffer) || (!(entry.flags & 0x800) && entry.pathBuffer.some(byte => byte > 0x7f))) throw new Error('Ambiguous ZIP filename encoding')
      if (keys.has(checked.key)) throw new Error('Duplicate ZIP member path')
      keys.add(checked.key)
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000
      if (entry.signature !== 0x02014b50 || entry.diskNumber !== 0 || (entry.flags & ~0x080e) || ![0, 8].includes(entry.compressionMethod)
        || (mode && mode !== (checked.directory ? 0x4000 : 0x8000)) || (entry.externalFileAttributes & 0x400)
        || (!checked.directory && (entry.externalFileAttributes & 0x10))) throw new Error('Unsupported or non-regular ZIP member')
      if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize) || entry.compressedSize < 0 || entry.uncompressedSize < 0
        || entry.uncompressedSize > limits.maxFileBytes || bytes + entry.uncompressedSize > limits.maxTotalBytes) throw new Error('ZIP member size limit exceeded')
      const record = await localRecord(handle, entry, layout.directoryOffset)
      if (checked.directory) {
        if (entry.uncompressedSize || entry.compressedSize || entry.crc32 || !expected.directories.has(checked.relative)) throw new Error('Unexpected ZIP directory')
        directories++
      } else {
        const target = expected.files.get(checked.relative)
        if (!target || target.size !== entry.uncompressedSize) throw new Error('ZIP file set or size differs from unpacked release: ' + checked.relative)
        seenFiles.add(checked.relative)
        bytes += entry.uncompressedSize
      }
      members.push({ ...record, entry, checked })
    }
    if (seenFiles.size !== expected.files.size || bytes !== expected.bytes) throw new Error('ZIP file set differs from unpacked release')
    // Reject orphan local records, overlapping payloads and hidden prefixes that a
    // streaming extractor could interpret differently from the central directory.
    members.sort((left, right) => left.offset - right.offset)
    let end = 0
    for (const member of members) {
      if (member.offset !== end) throw new Error('ZIP local records overlap or contain unlisted data')
      end = member.end
    }
    if (end !== layout.directoryOffset) throw new Error('ZIP contains unlisted local data')
    for (const { entry, checked, start } of members) {
      if (checked.directory) continue
      const actual = entry.compressedSize
        ? await digest(source.stream(start, entry.compressedSize), entry.uncompressedSize, entry.compressionMethod === 8)
        : { size: 0, sha256: createHash('sha256').digest('hex'), crc32: 0 }
      const target = expected.files.get(checked.relative)
      if (actual.size !== target.size || actual.sha256 !== target.sha256 || actual.crc32 !== entry.crc32) throw new Error('ZIP file content differs from unpacked release: ' + checked.relative)
    }
    return { files: seenFiles.size, directories, bytes }
  } finally {
    await Promise.allSettled([...streams].map(async stream => {
      const closed = finished(stream, { cleanup: true })
      stream.destroy()
      await closed
    }))
    await handle.close()
  }
}
