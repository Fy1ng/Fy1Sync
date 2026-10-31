import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { createDesktopService, type DesktopServiceDeps } from '../server/api'
import type { DouyuAccountsSnapshot } from '../server/douyu/types'
import type { DouyuAccountManager } from './douyuAccounts'
import { installIpcHandlers, type IpcHandlerOptions } from './ipc'
import type { DesktopMethod, StreamSyncerBridge } from './contracts'
import type { NetworkPreferenceState } from './networkPreferences'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('electron', () => electron)

const cleanups: Array<() => void> = []
const snapshot: DouyuAccountsSnapshot = { revision: 7, activeAccountId: 'default', accounts: [
  { id: 'default', label: '主账号', active: true, busy: false,
    login: { loggedIn: true, cookieCount: 1, authKeysPresent: ['acf_uid'], expiresAt: null, hasSessionCookies: true } },
] }
const preferences: NetworkPreferenceState = { domesticRouting: 'direct', systemProxy: { type: 'PAC' } }

function serviceFixture(available = true) {
  const get = vi.fn(async () => structuredClone(preferences))
  const set = vi.fn(async (domesticRouting: 'direct' | 'system') => ({ ...structuredClone(preferences), domesticRouting }))
  let accountListener: ((state: DouyuAccountsSnapshot) => void) | undefined
  const releaseAccounts = vi.fn()
  const accounts = {
    snapshot: vi.fn(async () => structuredClone(snapshot)),
    subscribeSnapshots: vi.fn((listener: (state: DouyuAccountsSnapshot) => void) => { accountListener = listener; return releaseAccounts }),
  } as unknown as DouyuAccountManager
  const relay = { closeAll: vi.fn(), roomCount: 0, subscribe: vi.fn() } as unknown as DesktopServiceDeps['relay']
  const service = createDesktopService({
    dataDir: path.join(process.cwd(), '.runtime-cache', 'codex-network-impl-20261030', 'network-ipc-no-io'),
    proxy: { enabled: true, hosts: [], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: 100 },
    registerMedia: () => { throw new Error('Network access is forbidden in this fixture') },
    fetchImpl: vi.fn(async () => { throw new Error('Network access is forbidden in this fixture') }) as unknown as typeof fetch,
    relay, douyuAccounts: accounts, networkPreferences: available ? { get, set } : undefined,
    resolveDouyuRoom: vi.fn(async () => ({ ok: false as const, failure: { code: 'upstream-error' as const, message: '离线测试' } })),
  })
  cleanups.push(() => service.dispose())
  return { service, get, set, accounts, releaseAccounts, emit: (state: DouyuAccountsSnapshot) => accountListener?.(state) }
}

function contents(id = 1): WebContents {
  return Object.assign(new EventEmitter(), { id, mainFrame: { url: 'app://app/' }, isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents
}
function ipcFixture(options: IpcHandlerOptions = {}) {
  const f = serviceFixture()
  const main = contents()
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) } as unknown as IpcMain
  const installed = installIpcHandlers(ipc, main, f.service, options)
  cleanups.push(() => installed.dispose())
  const invoke = (sender: WebContents, method: unknown, args: unknown, frame = sender.mainFrame) => handlers.get('stream-syncer:invoke')!(
    { sender, senderFrame: frame } as IpcMainInvokeEvent, method, args)
  return { ...f, main, installed, invoke }
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

describe('network preference service validation', () => {
  it('returns the proxy summary and persists only the two supported domestic modes', async () => {
    const f = serviceFixture()
    await expect(f.service.invoke('getNetworkPreferences', undefined)).resolves.toEqual({ ok: true, value: preferences })
    expect(f.get).toHaveBeenCalledOnce()
    for (const domesticRouting of ['direct', 'system'] as const) {
      await expect(f.service.invoke('setNetworkPreferences', { domesticRouting })).resolves.toEqual({ ok: true, value: { ...preferences, domesticRouting } })
    }
    expect(f.set.mock.calls).toEqual([['direct'], ['system']])
  })

  it.each([null, {}, [], 'system', { extra: true }])('rejects get arguments %j before accessing preferences', async args => {
    const f = serviceFixture()
    await expect(f.service.invoke('getNetworkPreferences', args)).resolves.toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(f.get).not.toHaveBeenCalled()
  })

  it.each([undefined, null, [], 'system', {}, { domesticRouting: null }, { domesticRouting: 'proxy' },
    { domesticRouting: 'DIRECT' }, { domesticRouting: 'system', proxyUrl: 'http://user:private@localhost:7890' }])
    ('rejects invalid set payload %j before accessing preferences', async args => {
      const f = serviceFixture()
      await expect(f.service.invoke('setNetworkPreferences', args)).resolves.toMatchObject({ ok: false, code: 'invalid-arguments' })
      expect(f.set).not.toHaveBeenCalled()
    })

  it('does not execute accessor payloads and reports absent settings explicitly', async () => {
    const f = serviceFixture(false)
    const getter = vi.fn(() => 'system')
    const args = Object.defineProperty({}, 'domesticRouting', { enumerable: true, get: getter })
    await expect(f.service.invoke('setNetworkPreferences', args)).resolves.toMatchObject({ code: 'invalid-arguments' })
    expect(getter).not.toHaveBeenCalled()
    await expect(f.service.invoke('getNetworkPreferences', undefined)).resolves.toMatchObject({ code: 'not-available' })
    await expect(f.service.invoke('setNetworkPreferences', { domesticRouting: 'system' })).resolves.toMatchObject({ code: 'not-available' })
  })
})

describe('network and account IPC authority', () => {
  it('routes validated preference calls from the trusted main frame and denies forged frames', async () => {
    const f = ipcFixture()
    await expect(f.invoke(f.main, 'getNetworkPreferences', undefined)).resolves.toEqual({ ok: true, value: preferences })
    await expect(f.invoke(f.main, 'setNetworkPreferences', { domesticRouting: 'system' })).resolves.toMatchObject({ ok: true, value: { domesticRouting: 'system' } })
    await expect(f.invoke(f.main, 'setNetworkPreferences', { domesticRouting: 'proxy' })).resolves.toMatchObject({ code: 'invalid-arguments' })
    await expect(f.invoke(f.main, 'setNetworkPreferences', { domesticRouting: 'direct' }, { url: 'app://app/' } as typeof f.main.mainFrame))
      .resolves.toMatchObject({ code: 'forbidden' })
    expect(f.set).toHaveBeenCalledExactlyOnceWith('system')
  })

  it('relays account revision snapshots from the service and releases them on disposal', async () => {
    const f = ipcFixture()
    expect(f.accounts.subscribeSnapshots).toHaveBeenCalledOnce()
    f.emit(snapshot)
    expect(f.main.send).toHaveBeenCalledExactlyOnceWith('stream-syncer:douyu-accounts', snapshot)
    await expect(f.invoke(f.main, 'listDouyuAccounts', undefined)).resolves.toEqual({ ok: true, value: snapshot })
    Object.assign(f.main.mainFrame, { url: 'https://untrusted.invalid/' })
    f.emit({ ...snapshot, revision: 8 })
    expect(f.main.send).toHaveBeenCalledOnce()
    f.installed.dispose()
    expect(f.releaseAccounts).toHaveBeenCalledOnce()
    Object.assign(f.main.mainFrame, { url: 'app://app/' })
    f.emit({ ...snapshot, revision: 9 })
    expect(f.main.send).toHaveBeenCalledOnce()
  })

  it('requires an explicit account event grant for additional registered windows', () => {
    const extra = contents(2)
    const f = ipcFixture({ extraContents: [extra] })
    f.emit(snapshot)
    expect(f.main.send).toHaveBeenCalledWith('stream-syncer:douyu-accounts', snapshot)
    expect(extra.send).not.toHaveBeenCalled()
  })

  it('checks the account topic grant for every broadcast and stops after unregister', () => {
    const extra = contents(2)
    let permitted = true
    const allowEvent = vi.fn((id, event) => permitted && id === 2 && event.topic === 'douyu-accounts')
    const f = ipcFixture({ extraContents: [extra], allowEvent })
    f.emit(snapshot)
    expect(allowEvent).toHaveBeenCalledWith(2, { topic: 'douyu-accounts', data: snapshot })
    expect(extra.send).toHaveBeenCalledExactlyOnceWith('stream-syncer:douyu-accounts', snapshot)
    permitted = false
    f.emit({ ...snapshot, revision: 8 })
    expect(extra.send).toHaveBeenCalledOnce()
    permitted = true
    extra.emit('destroyed')
    f.emit({ ...snapshot, revision: 9 })
    expect(extra.send).toHaveBeenCalledOnce()
  })
})

describe('network and account preload contract', () => {
  async function bridge(): Promise<StreamSyncerBridge> {
    vi.resetModules()
    await import('./preload')
    return electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as StreamSyncerBridge
  }

  it('exposes typed network methods through the existing whitelist and rejects arbitrary methods', async () => {
    const api = await bridge()
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: true, value: preferences })
    await expect(api.invoke('getNetworkPreferences', undefined)).resolves.toEqual({ ok: true, value: preferences })
    await api.invoke('setNetworkPreferences', { domesticRouting: 'system' })
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['stream-syncer:invoke', 'getNetworkPreferences', undefined],
      ['stream-syncer:invoke', 'setNetworkPreferences', { domesticRouting: 'system' }],
    ])
    await expect(api.invoke('setProxyAddress' as DesktopMethod, undefined)).resolves.toMatchObject({ code: 'unknown-method' })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(2)
  })

  it('subscribes account snapshots on the fixed channel and suppresses callbacks after release', async () => {
    const api = await bridge()
    const listener = vi.fn()
    const release = api.subscribeDouyuAccounts!(listener)
    expect(electron.ipcRenderer.on).toHaveBeenCalledExactlyOnceWith('stream-syncer:douyu-accounts', expect.any(Function))
    const receive = electron.ipcRenderer.on.mock.calls[0]![1] as (event: unknown, state: DouyuAccountsSnapshot) => void
    receive({ sender: 'privileged event is hidden' }, snapshot)
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot)
    release()
    receive({}, { ...snapshot, revision: 8 })
    expect(listener).toHaveBeenCalledOnce()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('stream-syncer:douyu-accounts', receive)
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  })
})
