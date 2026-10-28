import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_METHODS } from './featureContracts'
import { SavedRoomsStore, type SavedRoomsOptions, type SavedRoomsStorage } from './savedRooms'

const runtime = path.resolve('.runtime-cache')
const roots: string[] = []
const source = { role: 'official' as const, input: '6657', platform: 'douyu', label: '赛事直播' }

function fixture(options: SavedRoomsOptions = {}) {
  fs.mkdirSync(runtime, { recursive: true })
  const root = fs.mkdtempSync(path.join(runtime, 'saved-rooms-test-'))
  roots.push(root)
  const permissions = { protect: vi.fn(), verify: vi.fn() }
  let sequence = 0, time = 1000
  const create = () => new SavedRoomsStore(root, { permissions, id: () => `id-${++sequence}`, now: () => time++, ...options })
  return { root, file: path.join(root, 'rooms', 'saved.json'), permissions, create, store: create() }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== runtime || !path.basename(root).startsWith('saved-rooms-test-')) throw new Error('Unexpected test directory')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('saved room storage', () => {
  it('registers all public methods in the IPC whitelist', () => {
    expect(FEATURE_METHODS).toEqual(expect.arrayContaining(['listSavedRooms', 'saveRoom', 'removeSavedRoom']))
  })

  it('persists privately, returns descending savedAt order and reloads without temporary files', () => {
    const f = fixture()
    expect(f.store.list()).toEqual([])
    const first = f.store.save(source)
    const second = f.store.save({ ...source, input: '1234' })
    expect(f.store.list()).toEqual([second, first])
    expect(f.create().list()).toEqual([second, first])
    expect(f.permissions.protect).toHaveBeenCalledWith(expect.stringContaining('.saved.json-'), false)
    expect(fs.readdirSync(path.dirname(f.file))).toEqual(['saved.json'])
  })

  it('deduplicates by role/platform/input and updates only the label on the original record', () => {
    const f = fixture()
    const first = f.store.save(source)
    expect(f.store.save({ ...source, label: '新名称' })).toEqual({ ...first, label: '新名称' })
    const commentary = f.store.save({ ...source, role: 'commentary' })
    expect(commentary.id).not.toBe(first.id)
    expect(f.store.list()).toHaveLength(2)
    expect(f.create().list()).toHaveLength(2)
  })

  it('removes a saved room and returns false for a missing id', () => {
    const f = fixture(), room = f.store.save(source)
    expect(f.store.remove({ id: room.id })).toEqual({ removed: true })
    expect(f.store.remove({ id: room.id })).toEqual({ removed: false })
    expect(f.create().list()).toEqual([])
  })

  it('enforces 100 records while allowing an update at the limit', () => {
    let value: SavedRoomsStorage | undefined
    const f = fixture({ store: { load: () => value, save: next => { value = structuredClone(next) } } })
    for (let index = 1; index <= 100; index++) f.store.save({ ...source, input: String(index) })
    expect(f.store.list()).toHaveLength(100)
    expect(() => f.store.save({ ...source, input: '101' })).toThrow('最多收藏100个直播间')
    expect(f.store.save({ ...source, input: '1', label: '已更新' }).label).toBe('已更新')
    expect(value?.rooms).toHaveLength(100)
  })

  it('detaches returned rows and storage snapshots from its in-memory state', () => {
    const save = vi.fn((value: SavedRoomsStorage) => { value.rooms[0]!.label = 'changed by store' })
    const f = fixture({ store: { load: () => undefined, save } })
    const room = f.store.save(source)
    room.label = 'changed by caller'
    f.store.list()[0]!.input = '999'
    expect(f.store.list()[0]).toMatchObject(source)
  })

  it('preserves in-memory state after a failed save or removal', () => {
    const save = vi.fn()
    const f = fixture({ store: { load: () => undefined, save } })
    const room = f.store.save(source)
    save.mockImplementation(() => { throw new Error('disk failure') })
    expect(() => f.store.save({ ...source, label: 'changed' })).toThrow('直播间收藏保存失败')
    expect(() => f.store.remove({ id: room.id })).toThrow('直播间收藏保存失败')
    expect(f.store.list()).toEqual([room])
  })

  it('retains a corrupt JSON file during recovery and recovers on the next explicit save', () => {
    const f = fixture()
    fs.mkdirSync(path.dirname(f.file))
    fs.writeFileSync(f.file, '{broken')
    const recovered = f.create()
    expect(recovered.list()).toEqual([])
    expect(fs.readFileSync(f.file, 'utf8')).toBe('{broken')
    const room = recovered.save(source)
    expect(f.create().list()).toEqual([room])
  })

  it.each([
    { version: 2, rooms: [] },
    { version: 1, rooms: [{ ...source, id: 'id-1', savedAt: 0, platform: 'file' }] },
    { version: 1, rooms: [{ ...source, id: 'id-1', savedAt: -1 }] },
    { version: 1, rooms: [{ ...source, id: 'id-1', savedAt: 0 }, { ...source, id: 'id-1', savedAt: 1 }] },
    { version: 1, rooms: [{ ...source, id: 'id-1', savedAt: 0 }, { ...source, id: 'id-2', savedAt: 1 }] },
  ])('recovers safely from invalid stored schema %#', raw => {
    const save = vi.fn(), f = fixture({ store: { load: () => raw, save } })
    expect(f.store.list()).toEqual([])
    expect(save).not.toHaveBeenCalled()
  })

  it('does not bypass failed private file permissions when recovering from a read error', () => {
    const f = fixture()
    f.store.save(source)
    f.permissions.verify.mockImplementation(() => { throw new Error('permission failure') })
    const recovered = f.create()
    expect(recovered.list()).toEqual([])
    expect(() => recovered.save(source)).toThrow('直播间收藏保存失败')
  })
})

describe('saved room validation', () => {
  it.each([
    ['youtube', 'https://www.youtube.com/watch?v=abc'],
    ['twitch', 'https://www.twitch.tv/eslcs'],
    ['douyu', 'https://www.douyu.com/6657'],
    ['bilibili', 'https://live.bilibili.com/1234'],
    ['huya', 'https://www.huya.com/6657'],
    ['direct', 'https://cdn.example.com/live.m3u8'],
  ])('accepts the reusable %s source', (platform, input) => {
    const f = fixture()
    expect(f.store.save({ ...source, platform, input })).toMatchObject({ ...source, platform, input })
  })

  it('keeps the original input and accepts the exact character limits', () => {
    const f = fixture(), prefix = 'https://www.youtube.com/watch?v='
    const input = prefix + 'a'.repeat(500 - prefix.length)
    expect(f.store.save({ ...source, input, platform: 'youtube', label: '字'.repeat(100) })).toMatchObject({ input, label: '字'.repeat(100) })
    expect(f.store.save({ ...source, input: ' 6657 ' }).input).toBe(' 6657 ')
  })

  it.each([
    { role: 'other' }, { role: null }, { platform: 'file' }, { platform: 'test' }, { platform: 'unknown' },
    { input: '' }, { input: ' ' }, { input: '1'.repeat(501) }, { input: '6657\n' }, { input: '6657\x7f' },
    { input: '6657\x85' }, { input: 'file:///C:/video.mp4' }, { input: 'C:\\video.mp4' }, { input: 'C:/video.mp4' },
    { input: '\\\\server\\video.mp4' }, { input: '/test-sources/stream.m3u8', platform: 'direct' },
    { input: './video.mp4', platform: 'direct' }, { input: '../video.mp4', platform: 'direct' },
    { input: '~/video.mp4', platform: 'direct' }, { input: 'blob:https://app.test/id' }, { input: 'data:video/mp4,abc' },
    { input: 'https://www.twitch.tv/eslcs', platform: 'douyu' }, { input: 'not-a-room' },
    { label: '' }, { label: '字'.repeat(101) }, { label: 'bad\rlabel' }, { id: 'renderer-id' }, { savedAt: 0 },
  ])('rejects invalid source data %# before writing', patch => {
    const f = fixture()
    expect(() => f.store.save({ ...source, ...patch })).toThrow('收藏直播间参数无效')
    expect(f.store.list()).toEqual([])
    expect(fs.existsSync(f.file)).toBe(false)
  })

  it('rejects accessors without executing them', () => {
    const f = fixture(), getter = vi.fn(() => '6657')
    const input = { ...source }
    Object.defineProperty(input, 'input', { enumerable: true, get: getter })
    expect(() => f.store.save(input)).toThrow('收藏直播间参数无效')
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([null, [], {}, { id: '' }, { id: 'a'.repeat(161) }, { id: 'id\n' }, { id: 'id', extra: true }])(
    'rejects invalid removal parameters %#', input => {
      expect(() => fixture().store.remove(input)).toThrow('收藏直播间参数无效')
    },
  )
})
