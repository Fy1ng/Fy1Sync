import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

export interface LevelDbEntry {
  key: Buffer
  value: Buffer
}

const TABLE_MAGIC = 0x57fb808b247547dbn
const LOG_BLOCK_SIZE = 32 * 1024
const LOG_HEADER_SIZE = 7
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_BLOCK_BYTES = 8 * 1024 * 1024

function varint32(buf: Uint8Array, offset: number): { value: number; next: number } | null {
  let result = 0
  for (let shift = 0; shift <= 28 && offset < buf.length; shift += 7) {
    const byte = buf[offset++]!
    if (shift === 28 && byte > 0x0f) return null
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result >>> 0, next: offset }
  }
  return null
}

function varint64(buf: Uint8Array, offset: number): { value: bigint; next: number } | null {
  let result = 0n
  for (let shift = 0n; shift <= 63n && offset < buf.length; shift += 7n) {
    const byte = buf[offset++]!
    if (shift === 63n && byte > 0x01) return null
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, next: offset }
  }
  return null
}

/** Pure-JS Snappy block decompressor for LevelDB data blocks and Firefox LSNG blobs. */
export function snappyUncompress(input: Uint8Array, maxOutputBytes = MAX_BLOCK_BYTES): Buffer {
  const header = varint32(input, 0)
  if (!header || header.value > maxOutputBytes) throw new Error('Invalid Snappy header')
  const targetLength = header.value
  const out = Buffer.allocUnsafe(targetLength)
  let pos = header.next
  let outPos = 0

  while (pos < input.length) {
    const tag = input[pos++]!
    const kind = tag & 0x03
    if (kind === 0) {
      const code = tag >>> 2
      let length = code + 1
      if (code >= 60) {
        const extraBytes = code - 59
        if (pos + extraBytes > input.length) throw new Error('Truncated Snappy literal length')
        length = 0
        for (let i = 0; i < extraBytes; i++) length |= input[pos + i]! << (i * 8)
        length = (length >>> 0) + 1
        pos += extraBytes
      }
      if (pos + length > input.length || outPos + length > targetLength) throw new Error('Invalid Snappy literal')
      out.set(input.subarray(pos, pos + length), outPos)
      pos += length
      outPos += length
    } else {
      let length = 0
      let copyOffset = 0
      if (kind === 1) {
        if (pos >= input.length) throw new Error('Truncated Snappy copy-1')
        length = ((tag >>> 2) & 0x07) + 4
        copyOffset = ((tag & 0xe0) << 3) | input[pos++]!
      } else if (kind === 2) {
        if (pos + 2 > input.length) throw new Error('Truncated Snappy copy-2')
        length = (tag >>> 2) + 1
        copyOffset = input[pos]! | (input[pos + 1]! << 8)
        pos += 2
      } else {
        if (pos + 4 > input.length) throw new Error('Truncated Snappy copy-4')
        length = (tag >>> 2) + 1
        copyOffset = (input[pos]! | (input[pos + 1]! << 8) | (input[pos + 2]! << 16) | (input[pos + 3]! << 24)) >>> 0
        pos += 4
      }
      if (copyOffset === 0 || copyOffset > outPos || outPos + length > targetLength) throw new Error('Invalid Snappy copy')
      let srcPos = outPos - copyOffset
      for (let i = 0; i < length; i++) out[outPos++] = out[srcPos++]!
    }
  }
  if (outPos !== targetLength) throw new Error('Snappy output length mismatch')
  return out
}

function readLogRecords(buf: Buffer): Buffer[] {
  const records: Buffer[] = []
  let fragments: Buffer[] = []
  for (let blockStart = 0; blockStart < buf.length; blockStart += LOG_BLOCK_SIZE) {
    const blockEnd = Math.min(blockStart + LOG_BLOCK_SIZE, buf.length)
    let pos = blockStart
    while (pos + LOG_HEADER_SIZE <= blockEnd) {
      const crc = buf.readUInt32LE(pos)
      const length = buf.readUInt16LE(pos + 4)
      const type = buf[pos + 6]!
      if (crc === 0 && length === 0 && type === 0) break
      pos += LOG_HEADER_SIZE
      if (pos + length > blockEnd) { fragments = []; break }
      const slice = buf.subarray(pos, pos + length)
      pos += length
      if (type === 1) {
        fragments = []
        records.push(slice)
      } else if (type === 2) {
        fragments = [slice]
      } else if (type === 3 && fragments.length) {
        fragments.push(slice)
      } else if (type === 4 && fragments.length) {
        fragments.push(slice)
        records.push(Buffer.concat(fragments))
        fragments = []
      } else {
        fragments = []
      }
    }
  }
  return records
}

interface RawMutation {
  key: Buffer
  value: Buffer
  deleted: boolean
  sequence: bigint
  rank: number
}

function parseWriteBatches(buf: Buffer, rank: number): RawMutation[] {
  const mutations: RawMutation[] = []
  for (const record of readLogRecords(buf)) {
    if (record.length < 12) continue
    const baseSeq = record.readBigUInt64LE(0)
    const count = record.readUInt32LE(8)
    let pos = 12
    for (let index = 0; index < count && pos < record.length; index++) {
      const kind = record[pos++]!
      const keyLen = varint32(record, pos)
      if (!keyLen || keyLen.next + keyLen.value > record.length) break
      const key = Buffer.from(record.subarray(keyLen.next, keyLen.next + keyLen.value))
      pos = keyLen.next + keyLen.value
      if (kind === 1) {
        const valLen = varint32(record, pos)
        if (!valLen || valLen.next + valLen.value > record.length) break
        const value = Buffer.from(record.subarray(valLen.next, valLen.next + valLen.value))
        pos = valLen.next + valLen.value
        mutations.push({ key, value, deleted: false, sequence: baseSeq + BigInt(index), rank })
      } else if (kind === 0) {
        mutations.push({ key, value: Buffer.alloc(0), deleted: true, sequence: baseSeq + BigInt(index), rank })
      } else break
    }
  }
  return mutations
}

function readBlock(file: Buffer, offset: number, size: number): Buffer | null {
  if (offset < 0 || size < 0 || size > MAX_BLOCK_BYTES || offset + size + 5 > file.length) return null
  const raw = file.subarray(offset, offset + size)
  const compression = file[offset + size]!
  try {
    if (compression === 0) return raw
    if (compression === 1) return snappyUncompress(raw)
    if (compression === 2 && typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(raw, { maxOutputLength: MAX_BLOCK_BYTES })
    }
    return null
  } catch { return null }
}

function iterateBlockEntries(block: Buffer): Array<{ key: Buffer; value: Buffer }> {
  if (block.length < 4) return []
  const restarts = block.readUInt32LE(block.length - 4)
  if (restarts === 0 || restarts > (block.length - 4) >>> 2) return []
  const limit = block.length - (restarts + 1) * 4
  if (limit < 0) return []
  const entries: Array<{ key: Buffer; value: Buffer }> = []
  let previous: Buffer = Buffer.alloc(0)
  let pos = 0
  while (pos < limit) {
    const shared = varint32(block, pos)
    if (!shared) break
    const unshared = varint32(block, shared.next)
    if (!unshared) break
    const valueLen = varint32(block, unshared.next)
    if (!valueLen) break
    pos = valueLen.next
    if (shared.value > previous.length || pos + unshared.value + valueLen.value > limit) break
    const key = Buffer.allocUnsafe(shared.value + unshared.value)
    if (shared.value > 0) previous.copy(key, 0, 0, shared.value)
    block.copy(key, shared.value, pos, pos + unshared.value)
    pos += unshared.value
    const value = Buffer.from(block.subarray(pos, pos + valueLen.value))
    pos += valueLen.value
    previous = key
    entries.push({ key, value })
  }
  return entries
}

function parseTable(file: Buffer, rank: number): RawMutation[] {
  if (file.length < 48 || file.readBigUInt64LE(file.length - 8) !== TABLE_MAGIC) return []
  const footer = file.subarray(file.length - 48, file.length - 8)
  const metaOffset = varint64(footer, 0)
  if (!metaOffset) return []
  const metaSize = varint64(footer, metaOffset.next)
  if (!metaSize) return []
  const indexOffset = varint64(footer, metaSize.next)
  if (!indexOffset) return []
  const indexSize = varint64(footer, indexOffset.next)
  if (!indexSize || indexOffset.value > BigInt(Number.MAX_SAFE_INTEGER) || indexSize.value > BigInt(MAX_BLOCK_BYTES)) return []

  const indexBlock = readBlock(file, Number(indexOffset.value), Number(indexSize.value))
  if (!indexBlock) return []
  const mutations: RawMutation[] = []
  for (const indexEntry of iterateBlockEntries(indexBlock)) {
    const dataOffset = varint64(indexEntry.value, 0)
    if (!dataOffset) continue
    const dataSize = varint64(indexEntry.value, dataOffset.next)
    if (!dataSize || dataOffset.value > BigInt(Number.MAX_SAFE_INTEGER) || dataSize.value > BigInt(MAX_BLOCK_BYTES)) continue
    const dataBlock = readBlock(file, Number(dataOffset.value), Number(dataSize.value))
    if (!dataBlock) continue
    for (const item of iterateBlockEntries(dataBlock)) {
      if (item.key.length < 8) continue
      const userKey = Buffer.from(item.key.subarray(0, item.key.length - 8))
      const tag = item.key.readBigUInt64LE(item.key.length - 8)
      const kind = Number(tag & 0xffn)
      const sequence = tag >> 8n
      if (kind === 1) mutations.push({ key: userKey, value: item.value, deleted: false, sequence, rank })
      else if (kind === 0) mutations.push({ key: userKey, value: Buffer.alloc(0), deleted: true, sequence, rank })
    }
  }
  return mutations
}

interface ManifestState {
  levels: Map<number, Set<bigint>>
  logNumber: bigint
  prevLogNumber: bigint
}

function parseManifest(buf: Buffer): ManifestState | null {
  const levels = new Map<number, Set<bigint>>()
  let logNumber = 0n
  let prevLogNumber = 0n
  for (const record of readLogRecords(buf)) {
    let pos = 0
    while (pos < record.length) {
      const tag = varint32(record, pos)
      if (!tag) return null
      pos = tag.next
      if (tag.value === 1) {
        const len = varint32(record, pos)
        if (!len || len.next + len.value > record.length) return null
        pos = len.next + len.value
      } else if (tag.value === 2) {
        const num = varint64(record, pos)
        if (!num) return null
        logNumber = num.value; pos = num.next
      } else if (tag.value === 3 || tag.value === 4) {
        const num = varint64(record, pos)
        if (!num) return null
        pos = num.next
      } else if (tag.value === 9) {
        const num = varint64(record, pos)
        if (!num) return null
        prevLogNumber = num.value; pos = num.next
      } else if (tag.value === 5) {
        const level = varint32(record, pos)
        if (!level) return null
        const slice = varint32(record, level.next)
        if (!slice || slice.next + slice.value > record.length) return null
        pos = slice.next + slice.value
      } else if (tag.value === 6) {
        const level = varint32(record, pos)
        if (!level) return null
        const fileNum = varint64(record, level.next)
        if (!fileNum) return null
        levels.get(level.value)?.delete(fileNum.value)
        pos = fileNum.next
      } else if (tag.value === 7) {
        const level = varint32(record, pos)
        if (!level) return null
        const fileNum = varint64(record, level.next)
        if (!fileNum) return null
        const fileSize = varint64(record, fileNum.next)
        if (!fileSize) return null
        const smallest = varint32(record, fileSize.next)
        if (!smallest || smallest.next + smallest.value > record.length) return null
        const largest = varint32(record, smallest.next + smallest.value)
        if (!largest || largest.next + largest.value > record.length) return null
        let set = levels.get(level.value)
        if (!set) { set = new Set(); levels.set(level.value, set) }
        set.add(fileNum.value)
        pos = largest.next + largest.value
      } else return null
    }
  }
  return { levels, logNumber, prevLogNumber }
}

async function readSafeFile(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null
    return await fs.readFile(file)
  } catch { return null }
}

/** Read live key-value pairs from a read-only LevelDB directory without modifying or locking it. */
export async function readLevelDbEntries(directory: string, signal?: AbortSignal): Promise<LevelDbEntry[]> {
  signal?.throwIfAborted()
  let dirStat: Awaited<ReturnType<typeof fs.lstat>>
  try { dirStat = await fs.lstat(directory) } catch { return [] }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return []

  const names = await fs.readdir(directory).catch(() => [] as string[])
  if (!names.length || names.length > 2048) return []

  let manifest: ManifestState | null = null
  const currentRaw = names.includes('CURRENT') ? await readSafeFile(path.join(directory, 'CURRENT')) : null
  const manifestName = currentRaw?.toString('utf8').trim()
  if (manifestName && /^MANIFEST-\d+$/.test(manifestName) && names.includes(manifestName)) {
    const manifestBuf = await readSafeFile(path.join(directory, manifestName))
    if (manifestBuf) manifest = parseManifest(manifestBuf)
  }

  const tables = new Map<bigint, string>()
  const logs = new Map<bigint, string>()
  for (const name of names) {
    const match = /^(\d+)\.(ldb|sst|log)$/.exec(name)
    if (!match) continue
    const num = BigInt(match[1]!)
    if (match[2] === 'log') logs.set(num, name)
    else tables.set(num, name)
  }

  const orderedSources: Array<{ kind: 'table' | 'log'; name: string; rank: number }> = []
  let rank = 1
  if (manifest) {
    // Deeper levels are older (and bottommost compaction may zero sequence numbers); L0/WAL are newer.
    const sortedLevels = [...manifest.levels.keys()].sort((a, b) => b - a)
    for (const level of sortedLevels) {
      const nums = [...(manifest.levels.get(level) ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      for (const num of nums) {
        const name = tables.get(num)
        if (name) orderedSources.push({ kind: 'table', name, rank: level === 0 ? rank++ : -level })
      }
    }
    const logNums = [...logs.keys()]
      .filter(num => num >= manifest.logNumber || (manifest.prevLogNumber > 0n && num === manifest.prevLogNumber))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const num of logNums) orderedSources.push({ kind: 'log', name: logs.get(num)!, rank: 1_000_000 + rank++ })
  } else {
    for (const num of [...tables.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      orderedSources.push({ kind: 'table', name: tables.get(num)!, rank: rank++ })
    }
    for (const num of [...logs.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      orderedSources.push({ kind: 'log', name: logs.get(num)!, rank: 1_000_000 + rank++ })
    }
  }

  let totalBytes = 0
  const state = new Map<string, { key: Buffer; value: Buffer; deleted: boolean; sequence: bigint; rank: number }>()
  for (const source of orderedSources) {
    signal?.throwIfAborted()
    const buf = await readSafeFile(path.join(directory, source.name))
    if (!buf) continue
    totalBytes += buf.length
    if (totalBytes > MAX_TOTAL_BYTES) break
    const mutations = source.kind === 'log' ? parseWriteBatches(buf, source.rank) : parseTable(buf, source.rank)
    for (const mutation of mutations) {
      const mapKey = mutation.key.toString('latin1')
      const existing = state.get(mapKey)
      if (!existing
        || mutation.sequence > existing.sequence
        || (mutation.sequence === 0n && mutation.rank > existing.rank)
        || (existing.sequence === 0n && mutation.rank > existing.rank)
        || (mutation.sequence === existing.sequence && mutation.rank >= existing.rank)) {
        state.set(mapKey, mutation)
      }
    }
  }

  const live: LevelDbEntry[] = []
  for (const entry of state.values()) {
    if (!entry.deleted) live.push({ key: entry.key, value: entry.value })
  }
  return live
}
