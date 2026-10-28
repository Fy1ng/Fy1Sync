import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackendRuntime, type BackendRuntimeOptions } from './backendRuntime'
import { NativePrivatePermissions } from './privateStorage'
import { DanmakuFeatures } from './danmakuFeatures'
import { ActivityPreferencesStore } from './activityPreferences'
import type { SavedRoom } from './featureContracts'
import { DanmakuRelay } from '../server/danmaku/relay'
import { DouyuInsightsGateway } from '../server/douyu/insightsGateway'
import { DouyuInventoryService } from '../server/douyu/inventoryService'
import type { DouyuFollowedRooms, DouyuWatchTime } from '../server/douyu/insightsTypes'
import type { DouyuInventorySnapshot } from '../server/douyu/inventoryTypes'
import type { DouyuTasksSnapshot } from '../server/douyu/types'
import { resolveConfig } from '../server/config'

const runtimeRoot = path.resolve('.runtime-cache')
const secondAccount = '00000000-0000-4000-8000-000000000002'
type AccountEvent = { type: 'changed' } | { type: 'invalidated'; accountId: string }
const fixtures: Array<{ root: string; dispose: () => Promise<void> }> = []

function fixture() {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(runtimeRoot, 'backend-cache-test-'))
  vi.spyOn(NativePrivatePermissions.prototype, 'protect').mockImplementation(() => {})
  vi.spyOn(NativePrivatePermissions.prototype, 'verify').mockImplementation(() => {})
  const accountListeners = new Set<(event: AccountEvent) => void>()
  const taskListeners = new Set<(state: DouyuTasksSnapshot) => void>()
  let loggedIn = true
  const accountPort = {
    activeAccountId: 'default',
    isBusy: () => false,
    activeLoginStatus: async () => ({ loggedIn }),
    cookieHeader: vi.fn(async () => { throw new Error('network credentials must not be requested in this fixture') }),
    subscribe: (listener: (event: AccountEvent) => void) => {
      accountListeners.add(listener)
      return () => { accountListeners.delete(listener) }
    },
  }
  const state: DouyuTasksSnapshot = {
    activeAccountId: 'default', currentRoom: '100', retainedRooms: [], tasks: [],
    runtime: { foreground: true, locked: false, suspended: false },
  }
  const taskPort = {
    snapshot: () => structuredClone(state),
    subscribe: (listener: (value: DouyuTasksSnapshot) => void) => {
      taskListeners.add(listener)
      return () => { taskListeners.delete(listener) }
    },
  }
  let followedRevision = 0, inventoryRevision = 0, watchRevision = 0
  const followed = vi.spyOn(DouyuInsightsGateway.prototype, 'readFollowedRooms').mockImplementation(async accountId => ({
    accountId, checkedAt: ++followedRevision, coverage: 'all-pages', pageCount: 1, rooms: [], reason: null,
  }))
  const watch = vi.spyOn(DouyuInsightsGateway.prototype, 'readWatchTime').mockImplementation(async (accountId, room) => ({
    accountId, room, checkedAt: ++watchRevision, seconds: watchRevision, source: 'douyu-today-watch',
  }))
  const inventory = vi.spyOn(DouyuInventoryService.prototype, 'read').mockImplementation(async (accountId, room) => ({
    accountId, room: room ?? state.currentRoom!, checkedAt: ++inventoryRevision, items: [], message: '',
    totals: { quantity: 0, knownValue: [], unvaluedItems: 0, knownIntimacy: 0, unknownIntimacyItems: 0 },
  }))
  const relay = new DanmakuRelay({ createClient: () => { throw new Error('No real relay connections in this fixture') } })
  const danmaku = new DanmakuFeatures({ load: () => undefined, save() {} })
  const options = {
    userDataDir: root, proxy: resolveConfig({}).proxy, relay, danmaku,
    accounts: accountPort, tasks: taskPort,
    acquisition: { subscribe: () => () => {}, describe: () => null },
    resolveRoom: async (room: string) => ({ ok: true, identity: { room, inputRoom: room } }),
    activityPreferences: new ActivityPreferencesStore({ load: () => undefined, save() {} }),
    createPipWindow: vi.fn(), chooseCaptureDestination: async () => null, validatePng: () => false,
    ffmpegPath: async () => '', openExternal: async () => {}, notifyLive() {},
  } as unknown as BackendRuntimeOptions
  const runtime = createBackendRuntime(options)
  fixtures.push({ root, dispose: async () => { relay.closeAll(); await runtime.dispose() } })
  const invoke = async <T>(method: string, args: unknown): Promise<T> => {
    const result = await runtime.api.invoke(method, args)
    if (!result.ok) throw new Error(`${method}: ${result.code}`)
    return result.value as T
  }
  const emitAccount = (event: AccountEvent) => { for (const listener of [...accountListeners]) listener(event) }
  const emitTasks = () => { for (const listener of [...taskListeners]) listener(taskPort.snapshot()) }
  return { root, runtime, invoke, followed, inventory, watch, state, accountPort, emitAccount, emitTasks,
    setLoggedIn: (value: boolean) => { loggedIn = value } }
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.dispose()
    if (path.dirname(item.root) !== runtimeRoot || !path.basename(item.root).startsWith('backend-cache-test-')) throw new Error('Unexpected fixture directory')
    fs.rmSync(item.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('backend read-cache integration', () => {
  it('wires all three read methods through short caches and honors explicit refresh', async () => {
    const f = fixture()
    for (const [method, args, provider] of [
      ['getDouyuFollowedRooms', { accountId: 'default' }, f.followed],
      ['getDouyuInventory', { accountId: 'default', room: '100' }, f.inventory],
      ['getDouyuWatchTime', { accountId: 'default', room: '100' }, f.watch],
    ] as const) {
      const first = await f.invoke(method, args)
      expect(await f.invoke(method, args)).toEqual(first)
      expect(provider).toHaveBeenCalledTimes(1)
      expect(await f.invoke(method, { ...args, refresh: true })).not.toEqual(first)
      expect(provider).toHaveBeenCalledTimes(2)
    }
  })

  it.each(['getDouyuFollowedRooms', 'getDouyuInventory', 'getDouyuWatchTime'])(
    'rejects invalid refresh on %s before loading', async method => {
      const f = fixture()
      expect(await f.runtime.api.invoke(method, { accountId: 'default', ...(method === 'getDouyuFollowedRooms' ? {} : { room: '100' }), refresh: 1 }))
        .toMatchObject({ ok: false, code: 'invalid-arguments' })
      expect(f.followed).not.toHaveBeenCalled()
      expect(f.inventory).not.toHaveBeenCalled()
      expect(f.watch).not.toHaveBeenCalled()
    },
  )

  it('keeps room-specific inventory/watch results separate, including the current-room default', async () => {
    const f = fixture()
    const first = await f.invoke<DouyuInventorySnapshot>('getDouyuInventory', { accountId: 'default' })
    expect(first.room).toBe('100')
    expect(await f.invoke('getDouyuInventory', { accountId: 'default', room: '100' })).toEqual(first)
    expect((await f.invoke<DouyuInventorySnapshot>('getDouyuInventory', { accountId: 'default', room: '200' })).room).toBe('200')
    await f.invoke('getDouyuWatchTime', { accountId: 'default', room: '100' })
    await f.invoke('getDouyuWatchTime', { accountId: 'default', room: '200' })
    expect(f.inventory).toHaveBeenCalledTimes(2)
    expect(f.watch).toHaveBeenCalledTimes(2)
  })

  it.each(['changed', 'invalidated'] as const)('invalidates every read cache on account %s events', async type => {
    const f = fixture()
    const reads = [
      ['getDouyuFollowedRooms', { accountId: 'default' }],
      ['getDouyuInventory', { accountId: 'default', room: '100' }],
      ['getDouyuWatchTime', { accountId: 'default', room: '100' }],
    ] as const
    for (const [method, args] of reads) await f.invoke(method, args)
    f.emitAccount(type === 'changed' ? { type } : { type, accountId: 'default' })
    for (const [method, args] of reads) await f.invoke(method, args)
    expect(f.followed).toHaveBeenCalledTimes(2)
    expect(f.inventory).toHaveBeenCalledTimes(2)
    expect(f.watch).toHaveBeenCalledTimes(2)
  })

  it('clears cached values when switching accounts and switching back', async () => {
    const f = fixture()
    const first = await f.invoke<DouyuFollowedRooms>('getDouyuFollowedRooms', { accountId: 'default' })
    f.accountPort.activeAccountId = secondAccount
    f.emitAccount({ type: 'changed' })
    const second = await f.invoke<DouyuFollowedRooms>('getDouyuFollowedRooms', { accountId: secondAccount })
    expect(second.accountId).toBe(secondAccount)
    f.accountPort.activeAccountId = 'default'
    f.emitAccount({ type: 'changed' })
    expect(await f.invoke('getDouyuFollowedRooms', { accountId: 'default' })).not.toEqual(first)
    expect(f.followed).toHaveBeenCalledTimes(3)
  })

  it('clears caches after task events, including completed writes and late queue settlement', async () => {
    const f = fixture()
    for (let revision = 1; revision <= 3; revision++) {
      const followed = await f.invoke<DouyuFollowedRooms>('getDouyuFollowedRooms', { accountId: 'default' })
      const inventory = await f.invoke<DouyuInventorySnapshot>('getDouyuInventory', { accountId: 'default' })
      const watch = await f.invoke<DouyuWatchTime>('getDouyuWatchTime', { accountId: 'default', room: '100' })
      expect([followed.checkedAt, inventory.checkedAt, watch.checkedAt]).toEqual([revision, revision, revision])
      f.emitTasks()
    }
  })

  it('continues checking login and active-account guards even when the DTO is cached', async () => {
    const f = fixture()
    await f.invoke('getDouyuFollowedRooms', { accountId: 'default' })
    f.setLoggedIn(false)
    expect(await f.runtime.api.invoke('getDouyuFollowedRooms', { accountId: 'default' })).toMatchObject({ ok: false, code: 'login-required' })
    f.accountPort.activeAccountId = secondAccount
    expect(await f.runtime.api.invoke('getDouyuFollowedRooms', { accountId: 'default' })).toMatchObject({ ok: false, code: 'account-changed' })
    expect(f.followed).toHaveBeenCalledTimes(1)
  })

  it('does not reuse a failed provider response', async () => {
    const f = fixture()
    f.followed.mockRejectedValueOnce(new Error('offline'))
    expect(await f.runtime.api.invoke('getDouyuFollowedRooms', { accountId: 'default' })).toMatchObject({ ok: false })
    expect((await f.invoke<DouyuFollowedRooms>('getDouyuFollowedRooms', { accountId: 'default' })).accountId).toBe('default')
    expect(f.followed).toHaveBeenCalledTimes(2)
  })
})

describe('saved-room runtime integration', () => {
  it('wires list/save/remove through the private persistent store', async () => {
    const f = fixture(), input = { role: 'official', platform: 'douyu', input: '6657', label: '赛事直播' }
    expect(await f.invoke('listSavedRooms', undefined)).toEqual([])
    const saved = await f.invoke<SavedRoom>('saveRoom', input)
    expect(saved).toMatchObject(input)
    expect(saved.id).toEqual(expect.any(String))
    expect(saved.savedAt).toEqual(expect.any(Number))
    expect(await f.invoke('listSavedRooms', undefined)).toEqual([saved])
    expect(JSON.parse(fs.readFileSync(path.join(f.root, 'rooms', 'saved.json'), 'utf8'))).toMatchObject({ version: 1, rooms: [saved] })
    expect(await f.invoke('saveRoom', { ...input, label: '新名称' })).toEqual({ ...saved, label: '新名称' })
    expect(await f.invoke('removeSavedRoom', { id: saved.id })).toEqual({ removed: true })
    expect(await f.invoke('removeSavedRoom', { id: saved.id })).toEqual({ removed: false })
    expect(await f.invoke('listSavedRooms', undefined)).toEqual([])
  })

  it('rejects unexpected list arguments and local-file inputs through IPC', async () => {
    const f = fixture()
    expect(await f.runtime.api.invoke('listSavedRooms', {})).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await f.runtime.api.invoke('saveRoom', { role: 'official', platform: 'file', input: 'file:///C:/video.mp4', label: '本地视频' }))
      .toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await f.invoke('listSavedRooms', undefined)).toEqual([])
  })
})
