import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PrivateJsonStore } from './privateJsonStore'

const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-syncer-json-test-'))
  roots.push(root)
  return { root, store: new PrivateJsonStore(root, 'douyu/state.json') }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('stream-syncer-json-test-')) throw new Error('Unexpected test directory')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
it('loads no defaults from disk and atomically persists private settings', () => {
  const f = fixture()
  expect(f.store.load()).toBeUndefined()
  f.store.save({ version: 1, accounts: [] })
  expect(f.store.load()).toEqual({ version: 1, accounts: [] })
  expect(fs.readdirSync(path.join(f.root, 'douyu'))).toEqual(['state.json'])
})
it('retains the previous file if synchronizing a replacement fails', () => {
  const f = fixture()
  f.store.save({ value: 'old' })
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('sensitive-path') })
  expect(() => f.store.save({ value: 'new' })).toThrow('本地配置保存失败')
  expect(f.store.load()).toEqual({ value: 'old' })
  expect(fs.readdirSync(path.join(f.root, 'douyu'))).toEqual(['state.json'])
})
it('does not replace corrupt or unsupported input on a read error', () => {
  const f = fixture()
  fs.mkdirSync(path.join(f.root, 'douyu'))
  const file = path.join(f.root, 'douyu/state.json')
  fs.writeFileSync(file, '{broken')
  expect(() => f.store.load()).toThrow('本地配置读取失败')
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
})
it('rejects paths escaping the selected app data root', () => {
  const f = fixture()
  expect(() => new PrivateJsonStore(f.root, '../outside.json')).toThrow()
})
it('quarantines corrupt regular files with bounded backup retention and refuses symlinks', () => {
  const f = fixture()
  const dir = path.join(f.root, 'douyu')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'state.json')

  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(file, `\u0000corrupt-${i}`)
    const backup = f.store.quarantineCorrupt(1_700_000_000_000 + i)
    expect(backup).toMatch(/^state\.json\.corrupt-\d+-[0-9a-f]{8}\.bak$/)
    expect(f.store.load()).toBeUndefined()
  }

  const backups = fs.readdirSync(dir).filter(name => name.startsWith('state.json.corrupt-'))
  expect(backups).toHaveLength(3)
  f.store.save({ recovered: true })
  expect(f.store.load()).toEqual({ recovered: true })

  if (process.platform !== 'win32') {
    const outside = path.join(f.root, 'target.json')
    fs.writeFileSync(outside, 'keep')
    fs.rmSync(file)
    fs.symlinkSync(outside, file)
    expect(f.store.quarantineCorrupt()).toBeNull()
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
  }
})
