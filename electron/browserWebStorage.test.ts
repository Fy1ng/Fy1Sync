import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readLevelDbEntries, snappyUncompress } from './leveldbReader'
import { eraseBrowserWebStorage, readBrowserWebStorage } from './browserWebStorage'
import { DOUYIN_SIGNING_IDB, DOUYIN_SIGNING_STORAGE_KEYS, matchDouyinSigningStorage } from './douyinSigningCapture'
import { douyinBrowserCookieFingerprint, douyinBrowserSigningServerProofs, type BrowserCookie } from './cookies'
import { syntheticDouyinSdkStorage, syntheticDouyinSigningMaterial } from '../server/douyin/fixtures/signingFixture'
import { DOUYIN_USER_AGENT } from '../server/platforms/douyinDanmaku'

const roots: string[] = []
afterEach(async () => {
  for (const dir of roots.splice(0)) {
    if (path.dirname(dir) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture')
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function encodeVarint(value: number | bigint): Buffer {
  let v = BigInt(value)
  const out: number[] = []
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return Buffer.from(out)
}

function snappyCompressLiteralAndCopy(prefix: Buffer, repeatCount: number): Buffer {
  const totalLen = prefix.length * (1 + repeatCount)
  const chunks: Buffer[] = [encodeVarint(totalLen)]
  if (prefix.length <= 60) {
    chunks.push(Buffer.from([((prefix.length - 1) << 2) | 0]))
  } else if (prefix.length <= 256) {
    chunks.push(Buffer.from([(60 << 2) | 0, prefix.length - 1]))
  } else {
    const lenMinus1 = prefix.length - 1
    chunks.push(Buffer.from([(61 << 2) | 0, lenMinus1 & 0xff, (lenMinus1 >>> 8) & 0xff]))
  }
  chunks.push(prefix)
  let remaining = prefix.length * repeatCount
  const offset = prefix.length
  while (remaining > 0) {
    const step = Math.min(remaining, 64)
    chunks.push(Buffer.from([((step - 1) << 2) | 2, offset & 0xff, (offset >>> 8) & 0xff]))
    remaining -= step
  }
  return Buffer.concat(chunks)
}

function buildLogRecord(payload: Buffer, type = 1): Buffer {
  const header = Buffer.alloc(7)
  header.writeUInt32LE(0x12345678, 0)
  header.writeUInt16LE(payload.length, 4)
  header[6] = type
  return Buffer.concat([header, payload])
}

function buildWriteBatch(sequence: bigint, ops: Array<{ deleted?: boolean; key: Buffer; value?: Buffer }>): Buffer {
  const header = Buffer.alloc(12)
  header.writeBigUInt64LE(sequence, 0)
  header.writeUInt32LE(ops.length, 8)
  const parts: Buffer[] = [header]
  for (const op of ops) {
    if (op.deleted) {
      parts.push(Buffer.from([0]), encodeVarint(op.key.length), op.key)
    } else {
      const val = op.value ?? Buffer.alloc(0)
      parts.push(Buffer.from([1]), encodeVarint(op.key.length), op.key, encodeVarint(val.length), val)
    }
  }
  return Buffer.concat(parts)
}

function buildBlock(entries: Array<{ key: Buffer; value: Buffer }>): Buffer {
  const parts: Buffer[] = []
  let prev: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  for (const entry of entries) {
    let shared = 0
    while (shared < prev.length && shared < entry.key.length && prev[shared] === entry.key[shared]) shared++
    const unshared = entry.key.length - shared
    parts.push(
      encodeVarint(shared),
      encodeVarint(unshared),
      encodeVarint(entry.value.length),
      entry.key.subarray(shared),
      entry.value,
    )
    prev = entry.key
  }
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(0, 0)
  trailer.writeUInt32LE(1, 4)
  parts.push(trailer)
  return Buffer.concat(parts)
}

function buildSstFile(items: Array<{ key: Buffer; value: Buffer; sequence: bigint; deleted?: boolean }>, snappy = false): Buffer {
  const rawData = buildBlock(items.map(item => {
    const tag = Buffer.alloc(8)
    tag.writeBigUInt64LE((item.sequence << 8n) | (item.deleted ? 0n : 1n), 0)
    return { key: Buffer.concat([item.key, tag]), value: item.value }
  }))
  const dataPayload = snappy ? snappyCompressLiteralAndCopy(rawData, 0) : rawData
  const dataSection = Buffer.concat([dataPayload, Buffer.from([snappy ? 1 : 0, 0, 0, 0, 0])])

  const metaPayload = buildBlock([{ key: Buffer.from('meta'), value: Buffer.alloc(0) }])
  const metaOffset = dataSection.length
  const metaSection = Buffer.concat([metaPayload, Buffer.from([0, 0, 0, 0, 0])])

  const dataHandle = Buffer.concat([encodeVarint(0), encodeVarint(dataPayload.length)])
  const indexPayload = buildBlock([{ key: Buffer.from([0xff]), value: dataHandle }])
  const indexOffset = metaOffset + metaSection.length
  const indexSection = Buffer.concat([indexPayload, Buffer.from([0, 0, 0, 0, 0])])

  const footer = Buffer.alloc(48)
  const handles = Buffer.concat([
    encodeVarint(metaOffset), encodeVarint(metaPayload.length),
    encodeVarint(indexOffset), encodeVarint(indexPayload.length),
  ])
  handles.copy(footer, 0)
  footer.writeBigUInt64LE(0x57fb808b247547dbn, 40)
  return Buffer.concat([dataSection, metaSection, indexSection, footer])
}

function domKey(originScope: string, key: string): Buffer {
  return Buffer.concat([Buffer.from(`_${originScope}\x00\x01`, 'latin1'), Buffer.from(key, 'latin1')])
}

function domValue(value: string, utf16 = false): Buffer {
  return utf16
    ? Buffer.concat([Buffer.from([0]), Buffer.from(value, 'utf16le')])
    : Buffer.concat([Buffer.from([1]), Buffer.from(value, 'latin1')])
}

function utf16BeWithLen(text: string): Buffer {
  const body = Buffer.alloc(text.length * 2)
  for (let i = 0; i < text.length; i++) body.writeUInt16BE(text.charCodeAt(i), i * 2)
  return Buffer.concat([encodeVarint(text.length), body])
}

describe('LevelDB, Chromium WebStorage/IndexedDB, Firefox LSNG and Douyin signing matching', () => {
  it('decompresses Snappy literals and backreference copies and rejects malformed streams', () => {
    const unit = Buffer.from('security-sdk/s_sdk_crypt_sdk:')
    const compressed = snappyCompressLiteralAndCopy(unit, 3)
    expect(snappyUncompress(compressed).toString('utf8')).toBe(unit.toString('utf8').repeat(4))
    expect(() => snappyUncompress(Buffer.from([10, (1 << 2) | 1, 0]))).toThrow()
  })

  it('resolves SSTable levels, Snappy blocks, fragmented WAL records and deletion tombstones', async () => {
    const dir = await tempDir('leveldb-reader-')
    const sst1 = buildSstFile([
      { key: Buffer.from('keep'), value: Buffer.from('v1'), sequence: 0n },
      { key: Buffer.from('gone'), value: Buffer.from('old'), sequence: 5n },
    ], true)
    const sst2 = buildSstFile([
      { key: Buffer.from('keep'), value: Buffer.from('v2-l0'), sequence: 10n },
    ], false)
    await fs.writeFile(path.join(dir, '000002.ldb'), sst1)
    await fs.writeFile(path.join(dir, '000004.ldb'), sst2)

    const batch = buildWriteBatch(20n, [
      { deleted: true, key: Buffer.from('gone') },
      { key: Buffer.from('wal'), value: Buffer.from('fresh') },
    ])
    const split = Math.floor(batch.length / 2)
    const logBuf = Buffer.concat([
      buildLogRecord(batch.subarray(0, split), 2),
      buildLogRecord(batch.subarray(split), 4),
    ])
    await fs.writeFile(path.join(dir, '000005.log'), logBuf)

    const manifestEdit = Buffer.concat([
      Buffer.from([2]), encodeVarint(5),
      Buffer.from([7]), encodeVarint(2), encodeVarint(2), encodeVarint(sst1.length), encodeVarint(1), Buffer.from('a'), encodeVarint(1), Buffer.from('z'),
      Buffer.from([7]), encodeVarint(0), encodeVarint(4), encodeVarint(sst2.length), encodeVarint(1), Buffer.from('a'), encodeVarint(1), Buffer.from('z'),
    ])
    await fs.writeFile(path.join(dir, 'MANIFEST-000001'), buildLogRecord(manifestEdit))
    await fs.writeFile(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n')

    const entries = await readLevelDbEntries(dir)
    const map = new Map(entries.map(e => [e.key.toString('utf8'), e.value.toString('utf8')]))
    expect(map.get('keep')).toBe('v2-l0')
    expect(map.get('wal')).toBe('fresh')
    expect(map.has('gone')).toBe(false)
  })

  it('reads Chromium Local Storage and IndexedDB for Douyin origins while isolating unrelated sites', async () => {
    const profileDir = await tempDir('chromium-storage-')
    const lsDir = path.join(profileDir, 'Local Storage', 'leveldb')
    await fs.mkdir(lsDir, { recursive: true })
    const stores = syntheticDouyinSdkStorage()
    const lsBatch = buildWriteBatch(1n, [
      { key: domKey('https://www.douyin.com', DOUYIN_SIGNING_STORAGE_KEYS[0]), value: domValue(stores[DOUYIN_SIGNING_STORAGE_KEYS[0]]!, true) },
      { key: domKey('https://lf-zt.douyin.com/^0https://douyin.com', DOUYIN_SIGNING_STORAGE_KEYS[1]), value: domValue(stores[DOUYIN_SIGNING_STORAGE_KEYS[1]]!) },
      { key: domKey('https://lf-zt.douyin.com/^0https://evil.example', DOUYIN_SIGNING_STORAGE_KEYS[0]), value: domValue('{"data":"forged"}') },
      { key: domKey('https://evil.example', DOUYIN_SIGNING_STORAGE_KEYS[0]), value: domValue('{"data":"forged"}') },
    ])
    await fs.writeFile(path.join(lsDir, '000003.log'), buildLogRecord(lsBatch))

    const idbDir = path.join(profileDir, 'IndexedDB', 'https_live.douyin.com_0.indexeddb.leveldb')
    await fs.mkdir(idbDir, { recursive: true })
    const ssvPayload = Buffer.from(stores[DOUYIN_SIGNING_STORAGE_KEYS[0]]!, 'latin1')
    const blinkValue = Buffer.concat([
      Buffer.from([0x02, 0xff, 0x15, 0xfe]), Buffer.alloc(12),
      Buffer.from([0xff, 0x10, 0x22]), encodeVarint(ssvPayload.length), ssvPayload,
    ])
    const idbBatch = buildWriteBatch(1n, [
      {
        key: Buffer.concat([Buffer.from([0, 0, 0, 0, 201]), utf16BeWithLen('https_live.douyin.com_0@1'), utf16BeWithLen('secure-store')]),
        value: Buffer.from([1]),
      },
      {
        key: Buffer.concat([Buffer.from([0, 1, 0, 0, 200]), utf16BeWithLen('cryptvalues')]),
        value: Buffer.from([1]),
      },
      {
        key: Buffer.concat([Buffer.from([0, 1, 1, 1, 1]), utf16BeWithLen(DOUYIN_SIGNING_STORAGE_KEYS[0])]),
        value: blinkValue,
      },
    ])
    await fs.writeFile(path.join(idbDir, '000003.log'), buildLogRecord(idbBatch))

    const read = await readBrowserWebStorage({ browser: 'edge', directory: profileDir }, {
      hostSuffix: 'douyin.com',
      keys: DOUYIN_SIGNING_STORAGE_KEYS,
      idbDatabase: DOUYIN_SIGNING_IDB.database,
      idbStore: DOUYIN_SIGNING_IDB.store,
    })
    expect(read.map(item => `${item.origin}:${item.source}`).sort()).toEqual([
      'https://lf-zt.douyin.com:local-storage',
      'https://live.douyin.com:indexed-db',
      'https://www.douyin.com:local-storage',
    ])
    expect(JSON.stringify(read)).not.toContain('forged')

    const cookies: BrowserCookie[] = [{ domain: '.douyin.com', path: '/', secure: true, httpOnly: true, session: true, name: 'sessionid', value: 'synthetic-embedded-session' }]
    const matched = matchDouyinSigningStorage(read, {
      accountUid: '12345',
      cookieFingerprint: douyinBrowserCookieFingerprint(cookies),
      userAgent: DOUYIN_USER_AGENT,
    }, douyinBrowserSigningServerProofs(cookies))
    expect(matched).not.toBeNull()
    expect(matched?.accountUid).toBe('12345')

    eraseBrowserWebStorage(read)
    expect(read.every(entry => Object.values(entry.values).every(val => val === ''))).toBe(true)
  })

  it('reads Firefox LSNG SQLite (including Snappy blobs) and legacy webappsstore while excluding containers', async () => {
    const profileDir = await tempDir('firefox-storage-')
    const stores = syntheticDouyinSdkStorage()
    const lsngDir = path.join(profileDir, 'storage', 'default', 'https+++www.douyin.com', 'ls')
    const containerDir = path.join(profileDir, 'storage', 'default', 'https+++www.douyin.com^userContextId=1', 'ls')
    await fs.mkdir(lsngDir, { recursive: true })
    await fs.mkdir(containerDir, { recursive: true })

    const db1 = new DatabaseSync(path.join(lsngDir, 'data.sqlite'))
    db1.exec('CREATE TABLE data (key TEXT PRIMARY KEY, utf16_length INTEGER, conversion_type INTEGER, compression_type INTEGER, last_access_time INTEGER, value BLOB)')
    const rawCrypt = Buffer.from(stores[DOUYIN_SIGNING_STORAGE_KEYS[0]]!, 'latin1')
    db1.prepare('INSERT INTO data VALUES (?, ?, ?, ?, ?, ?)').run(
      DOUYIN_SIGNING_STORAGE_KEYS[0], rawCrypt.length, 1, 1, 0, snappyCompressLiteralAndCopy(rawCrypt, 0),
    )
    db1.close()

    const dbContainer = new DatabaseSync(path.join(containerDir, 'data.sqlite'))
    dbContainer.exec('CREATE TABLE data (key TEXT PRIMARY KEY, utf16_length INTEGER, conversion_type INTEGER, compression_type INTEGER, last_access_time INTEGER, value BLOB)')
    dbContainer.prepare('INSERT INTO data VALUES (?, ?, ?, ?, ?, ?)').run(DOUYIN_SIGNING_STORAGE_KEYS[0], 6, 1, 0, 0, Buffer.from('forged'))
    dbContainer.close()

    const legacy = new DatabaseSync(path.join(profileDir, 'webappsstore.sqlite'))
    legacy.exec('CREATE TABLE webappsstore2 (originKey TEXT, scope TEXT, key TEXT, value TEXT)')
    legacy.prepare('INSERT INTO webappsstore2 VALUES (?, ?, ?, ?)').run(
      'moc.niyuod.evil.:https:443', 'moc.niyuod.evil.:https:443', DOUYIN_SIGNING_STORAGE_KEYS[1], stores[DOUYIN_SIGNING_STORAGE_KEYS[1]]!,
    )
    legacy.close()

    const read = await readBrowserWebStorage({ browser: 'firefox', directory: profileDir }, {
      hostSuffix: 'douyin.com',
      keys: DOUYIN_SIGNING_STORAGE_KEYS,
    })
    expect(read.map(item => item.origin).sort()).toEqual(['https://live.douyin.com', 'https://www.douyin.com'])
    expect(JSON.stringify(read)).not.toContain('forged')

    const material = syntheticDouyinSigningMaterial('sessionid=synthetic-fx-session', DOUYIN_USER_AGENT, '8888')
    const cookieProof = encodeURIComponent(Buffer.from(JSON.stringify({
      ticket: material.ticket, ts_sign: material.tsSign, client_cert: material.clientCertificate,
    })).toString('base64'))
    const cookies: BrowserCookie[] = [
      { domain: '.douyin.com', path: '/', secure: true, httpOnly: true, session: true, name: 'sessionid', value: 'synthetic-fx-session' },
      { domain: 'www.douyin.com', path: '/', secure: true, httpOnly: true, hostOnly: true, session: true, name: 'bd_ticket_guard_server_data', value: cookieProof },
    ]
    const matched = matchDouyinSigningStorage(read, {
      accountUid: '8888',
      cookieFingerprint: douyinBrowserCookieFingerprint(cookies),
      userAgent: DOUYIN_USER_AGENT,
    }, douyinBrowserSigningServerProofs(cookies))
    expect(matched).not.toBeNull()
    expect(matched?.accountUid).toBe('8888')
  })
})
