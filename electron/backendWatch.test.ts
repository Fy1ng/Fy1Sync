import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackendRuntime, type BackendRuntimeOptions } from './backendRuntime'
import { DanmakuFeatures } from './danmakuFeatures'
import { ActivityPreferencesStore } from './activityPreferences'
import { DanmakuRelay } from '../server/danmaku/relay'
import { DouyuInsightsGateway } from '../server/douyu/insightsGateway'
import { resolveConfig } from '../server/config'
import type { DouyuTasksSnapshot } from '../server/douyu/types'
import type { DouyuWatchPlaybackReport } from '../server/douyu/watchTypes'

const temporaryRoot = path.resolve(os.tmpdir())
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks(); vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'watch-backend-test-'))
  const accountListeners = new Set<(event: { type: 'changed' } | { type: 'invalidated'; accountId: string }) => void>()
  const taskListeners = new Set<(snapshot: DouyuTasksSnapshot) => void>()
  const accounts = { activeAccountId: 'default', isBusy: () => false, activeLoginStatus: async () => ({ loggedIn: true }),
    cookieHeader: vi.fn(async () => { throw new Error('Real credentials are not available in this fixture') }),
    subscribe: (listener: Parameters<typeof accountListeners.add>[0]) => { accountListeners.add(listener); return () => { accountListeners.delete(listener) } } }
  const state: DouyuTasksSnapshot = { activeAccountId: 'default', currentRoom: '100', retainedRooms: [], tasks: [],
    runtime: { foreground: true, locked: false, suspended: false } }
  const tasks = { snapshot: () => structuredClone(state), subscribe: (listener: (snapshot: DouyuTasksSnapshot) => void) => { taskListeners.add(listener); return () => { taskListeners.delete(listener) } } }
  const source = { room: '100', cdn: 'tct-h5', generation: 'one', bytes: 1000 }
  let hasSource = true
  const acquisition = { subscribe: () => () => {}, describe: () => null, watchSource: vi.fn(() => hasSource ? { ...source } : null) }
  const run = vi.fn(async (_id: string, _room: string, signal: AbortSignal) => new Promise<void>(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve()
  }))
  const watchRead = vi.spyOn(DouyuInsightsGateway.prototype, 'readWatchTime').mockImplementation(async (accountId, room) => ({
    accountId, room, checkedAt: Date.now(), seconds: 10, source: 'douyu-today-watch',
  }))
  vi.spyOn(DouyuInsightsGateway.prototype, 'readFansWatchTime').mockImplementation(async (accountId, room) => ({
    accountId, room, checkedAt: Date.now(), seconds: 1000, badgeOwned: true, badgeLevel: 22, source: 'douyu-fanshome-cumulative',
  }))
  const roomRead = vi.spyOn(DouyuInsightsGateway.prototype, 'readRoom').mockImplementation(async room => ({
    room, checkedAt: Date.now(), roomName: 'fixture', nickname: '', ownerUid: null, live: true, replay: false,
    startedAt: null, lastStartedAt: null, popularity: null, viewers: null, source: 'douyu-h5room',
  }))
  const relay = new DanmakuRelay({ createClient: () => { throw new Error('No real chat transport in this fixture') } })
  const options = { userDataDir: root, proxy: resolveConfig({}).proxy, relay, accounts, tasks, acquisition, watchGateway: { run },
    danmaku: new DanmakuFeatures({ load: () => undefined, save() {} }),
    activityPreferences: new ActivityPreferencesStore({ load: () => undefined, save() {} }),
    resolveRoom: async (room: string) => ({ ok: true, identity: { room, inputRoom: room } }),
    createPipWindow: vi.fn(), chooseCaptureDestination: async () => null, validatePng: () => false,
    ffmpegPath: async () => '', openExternal: async () => {}, notifyLive() {},
  } as unknown as BackendRuntimeOptions
  const backend = createBackendRuntime(options)
  cleanups.push(async () => {
    await backend.dispose(); relay.closeAll()
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith('watch-backend-test-')) throw new Error('Unexpected fixture root')
    fs.rmSync(root, { recursive: true, force: true })
  })
  const sample = (currentTime: number, overrides: Partial<DouyuWatchPlaybackReport> = {}) => backend.api.invoke('reportDouyuWatchPlayback', {
    role: 'commentary', playing: true, currentTime, decodedBytes: null, presentedFrames: null, ...overrides,
  }, { senderId: 1 })
  return { backend, run, sample, source, watchRead, roomRead, accounts, accountListeners, state, taskListeners,
    noSource: () => { hasSource = false } }
}

describe('watch bridge source authority', () => {
  it('refreshes room status without the data sheet and stops watching when the stream becomes replay', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0)
    await f.sample(1); await vi.advanceTimersByTimeAsync(2000); await f.sample(3); await vi.advanceTimersByTimeAsync(0)
    expect(f.run).toHaveBeenCalledTimes(1)
    f.roomRead.mockResolvedValue({ room: '100', checkedAt: Date.now(), roomName: 'fixture', nickname: '', ownerUid: null,
      live: true, replay: true, startedAt: null, lastStartedAt: null, popularity: null, viewers: null, source: 'douyu-h5room' })
    for (let i = 0; i < 29; i++) { await vi.advanceTimersByTimeAsync(2000); await f.sample(5 + i * 2) }
    expect(f.roomRead).toHaveBeenCalledTimes(2)
    expect(f.backend.watch.snapshot()).toMatchObject({ phase: 'paused' })
    expect(f.backend.watch.snapshot().reason).toContain('轮播')
    expect(f.run.mock.calls[0]![2].aborted).toBe(true)
  })

  it('uses the main-owned source and current account, then cancels on lock', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(0)
    await f.sample(1)
    await vi.advanceTimersByTimeAsync(2000)
    f.source.bytes += 1234
    await f.sample(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.run.mock.calls[0]!.slice(0, 2)).toEqual(['default', '100'])
    expect(f.accounts.cookieHeader).not.toHaveBeenCalled()
    expect(f.watchRead).toHaveBeenCalledWith('default', '100', expect.any(AbortSignal))
    f.state.runtime.locked = true
    for (const listener of f.taskListeners) listener(structuredClone(f.state))
    expect(f.run.mock.calls[0]![2].aborted).toBe(true)
  })

  it('rejects caller room/account fields, accessors, invalid counters and missing sender IDs', async () => {
    const f = fixture()
    const good = { role: 'commentary', playing: true, currentTime: 1, decodedBytes: null, presentedFrames: null }
    const getter = vi.fn(() => 1)
    for (const args of [ { ...good, room: '200' }, { ...good, accountId: 'second' }, { ...good, cdn: 'fake' },
      { ...good, currentTime: NaN }, { ...good, decodedBytes: -1 }, { ...good, playing: 'true' },
      Object.defineProperty({ ...good }, 'currentTime', { get: getter }) ]) {
      expect(await f.backend.api.invoke('reportDouyuWatchPlayback', args, { senderId: 1 })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    expect(getter).not.toHaveBeenCalled()
    expect(await f.backend.api.invoke('reportDouyuWatchPlayback', good)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.run).not.toHaveBeenCalled()
  })

  it('does not acquire a gateway for another selected room or a source that has closed', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0)
    f.source.room = '200'
    await f.sample(1); await vi.advanceTimersByTimeAsync(2000); await f.sample(3)
    expect(f.run).not.toHaveBeenCalled()
    f.noSource()
    await vi.advanceTimersByTimeAsync(2000); await f.sample(5)
    expect(f.run).not.toHaveBeenCalled()
  })

  it('invalidates the same account generation and discards previous observed watch records', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0)
    await f.sample(1); await vi.advanceTimersByTimeAsync(2000); await f.sample(3); await vi.advanceTimersByTimeAsync(0)
    expect(f.backend.watch.snapshot().baselineSeconds).toBe(10)
    for (const listener of f.accountListeners) listener({ type: 'invalidated', accountId: 'default' })
    expect(f.run.mock.calls[0]![2].aborted).toBe(true)
    expect(f.backend.watch.snapshot().baselineSeconds).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.run).toHaveBeenCalledTimes(1)
  })
})
