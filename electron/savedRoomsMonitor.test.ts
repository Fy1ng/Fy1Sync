import { afterEach, describe, expect, it, vi } from 'vitest'
import { SavedRoomsStore, type SavedRoomsStorage } from './savedRooms'
import { SavedRoomsMonitor } from './savedRoomsMonitor'
import type { SavedRoomMetadata } from './featureContracts'

const NOW = Date.parse('2026-11-15T00:00:00Z')
const metadata = (patch: Partial<SavedRoomMetadata> = {}): SavedRoomMetadata => ({ roomId: '100', url: 'https://www.douyu.com/100',
  nickname: '测试主播', title: '新直播标题', status: 'live', avatarUrl: null, coverUrl: null, collectedAt: NOW,
  lastStartedAt: NOW - 60_000, startTimeSource: 'platform', ...patch })
const monitors: SavedRoomsMonitor[] = []
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  let raw: SavedRoomsStorage | undefined
  let sequence = 0
  const storage = { load: () => structuredClone(raw), save: (next: SavedRoomsStorage) => { raw = structuredClone(next) } }
  const store = new SavedRoomsStore('', { store: storage, id: () => `id-${++sequence}` })
  const room = store.save({ role: 'official', platform: 'douyu', input: '100', label: '原始收藏' })
  const collect = vi.fn(async () => metadata({ collectedAt: Date.now() }))
  const changed = vi.fn()
  const monitor = new SavedRoomsMonitor({ store, collect, changed })
  monitors.push(monitor)
  return { store, room, collect, monitor, changed, reload: () => new SavedRoomsStore('', { store: storage }) }
}
afterEach(() => { monitors.splice(0).forEach(monitor => monitor.dispose()); vi.useRealTimers() })

describe('saved room metadata lifecycle', () => {
  it('retains the full successful snapshot across failure and restart, then replaces it on success', async () => {
    const f = setup()
    await f.monitor.refresh()
    const first = f.store.list()[0]!.metadata
    vi.setSystemTime(NOW + 16_000)
    f.collect.mockRejectedValueOnce(new Error('upstream timeout with sensitive details'))
    await f.monitor.refresh()
    expect(f.store.list()[0]).toMatchObject({ metadata: first, lastAttemptAt: NOW + 16_000, refreshError: expect.stringContaining('保留') })
    expect(f.reload().list()).toEqual(f.store.list())
    vi.setSystemTime(NOW + 32_000)
    f.collect.mockResolvedValueOnce(metadata({ title: '下一场直播', status: 'offline', collectedAt: Date.now() }))
    await f.monitor.refresh()
    expect(f.store.list()[0]).toMatchObject({ metadata: { title: '下一场直播', status: 'offline' }, refreshError: null })
  })

  it('distinguishes local observations from platform times and preserves the last broadcast after going offline', async () => {
    const f = setup()
    f.collect.mockResolvedValueOnce(metadata({ status: 'offline', lastStartedAt: null, startTimeSource: null }))
    await f.monitor.refresh()
    expect(f.store.list()[0]!.metadata!.lastStartedAt).toBeNull()
    vi.setSystemTime(NOW + 20_000)
    f.collect.mockResolvedValueOnce(metadata({ collectedAt: Date.now(), lastStartedAt: null, startTimeSource: null }))
    await f.monitor.refresh()
    expect(f.store.list()[0]!.metadata).toMatchObject({ lastStartedAt: NOW + 20_000, startTimeSource: 'observed' })
    vi.setSystemTime(NOW + 40_000)
    f.collect.mockResolvedValueOnce(metadata({ collectedAt: Date.now(), status: 'offline', lastStartedAt: null, startTimeSource: null }))
    await f.monitor.refresh()
    expect(f.store.list()[0]!.metadata).toMatchObject({ lastStartedAt: NOW + 20_000, startTimeSource: 'observed', status: 'offline' })
  })

  it('joins duplicate requests across roles and enforces the manual refresh interval', async () => {
    const f = setup()
    f.store.save({ role: 'commentary', platform: 'douyu', input: 'https://www.douyu.com/100', label: '解说' })
    await Promise.all([f.monitor.refresh(), f.monitor.refresh()])
    expect(f.collect).toHaveBeenCalledTimes(1)
    expect(f.store.list().every(room => room.metadata?.nickname === '测试主播')).toBe(true)
    await f.monitor.refresh()
    expect(f.collect).toHaveBeenCalledTimes(1)
  })

  it('polls without an open panel and backs off after errors', async () => {
    const f = setup()
    f.monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.collect).toHaveBeenCalledTimes(1)
    f.collect.mockRejectedValue(new Error('offline network'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.collect).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.collect).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.collect).toHaveBeenCalledTimes(3)
    expect(f.store.list()[0]!.metadata!.nickname).toBe('测试主播')
  })

  it('does not resurrect a removed favorite or update after disposal', async () => {
    const f = setup()
    let resolve!: (value: SavedRoomMetadata) => void
    f.collect.mockReturnValueOnce(new Promise(complete => { resolve = complete }))
    const pending = f.monitor.refresh()
    await vi.advanceTimersByTimeAsync(0)
    f.store.remove({ id: f.room.id })
    resolve(metadata())
    await pending
    expect(f.store.list()).toEqual([])
    expect(f.reload().list()).toEqual([])
    f.monitor.dispose()
    await f.monitor.refresh()
    expect(f.collect).toHaveBeenCalledTimes(1)
  })

  it('bounds an uncooperative provider and cancels shutdown promptly', async () => {
    const f = setup()
    f.collect.mockImplementation(() => new Promise(() => {}))
    const pending = f.monitor.refresh()
    await vi.advanceTimersByTimeAsync(0)
    f.monitor.dispose()
    await pending
    expect(f.store.list()[0]!.metadata).toBeUndefined()
    expect(f.changed).not.toHaveBeenCalled()
  })
})
