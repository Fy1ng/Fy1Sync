import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { crc32 } from 'node:zlib'
import test from 'node:test'
import { compareMacTrees, preflightMacZip } from './check-package-mac.mjs'

function zip(entries) {
  const local = [], central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data ?? ''), header = Buffer.alloc(30), record = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc32(data), 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE(20, 6)
    record.writeUInt32LE(crc32(data), 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    local.push(header, name, data); central.push(record, name)
    offset += header.length + name.length + data.length
  }
  const table = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, table, end])
}

test('macOS package comparison includes executable mode, symlink target and complete inventory', () => {
  const tree = new Map([['Contents/MacOS/Fy1Sync', { type: 'file', size: 5, sha256: 'fixed', executable: true }], ['Contents/Frameworks/Electron.framework/Versions/Current', { type: 'link', link: 'A' }]])
  compareMacTrees(tree, new Map(tree))
  assert.throws(() => compareMacTrees(tree, new Map()))
  const altered = new Map(tree); altered.set('Contents/MacOS/Fy1Sync', { ...tree.get('Contents/MacOS/Fy1Sync'), executable: false })
  assert.throws(() => compareMacTrees(tree, altered))
  altered.set('Contents/Frameworks/Electron.framework/Versions/Current', { type: 'link', link: '/outside' })
  assert.throws(() => compareMacTrees(tree, altered))
})

test('macOS ZIP checks reject traversal, unlisted members and changed links before extraction', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-mac-zip-'))
  const expected = new Map([['Contents/MacOS/Fy1Sync', { type: 'file' }], ['Contents/Frameworks/Electron.framework/Versions/Current', { type: 'link', link: 'A' }]])
  const good = [{ name: 'Fy1Sync.app/Contents/MacOS/Fy1Sync', data: 'app' }, { name: 'Fy1Sync.app/Contents/Frameworks/Electron.framework/Versions/Current', data: 'A', mode: 0o120777 }]
  try {
    const file = path.join(temporary, 'app.zip')
    await writeFile(file, zip(good))
    await preflightMacZip(file, expected)
    for (const entries of [
      [...good, { name: '../outside', data: 'bad' }],
      [...good, { name: 'Fy1Sync.app/Contents/unknown', data: 'bad' }],
      [good[0], { ...good[1], data: '/outside' }],
      [...good, good[0]],
    ]) {
      await writeFile(file, zip(entries))
      await assert.rejects(preflightMacZip(file, expected))
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
