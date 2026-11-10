import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { OnlineUpdateItemState, OnlineUpdateState } from '../../../electron/onlineUpdateContracts'
import type { ApiResult } from '../../app/apiClient'
import { AppUpdateSettings } from './AppUpdate'

const empty: OnlineUpdateItemState = {
  phase: 'unavailable', version: null, revision: null, notes: null, downloadedBytes: 0, totalBytes: null,
  message: '尚未读取签名清单.',
}
const base: OnlineUpdateState = {
  phase: 'idle', source: 'github', availableSources: ['github', 'gitcode'], currentAppVersion: '0.2.0',
  currentFrontendRevision: 1, bridgeVersion: 1, checkedAt: null, frontend: empty, application: empty,
  canRollbackFrontend: false, message: '手动检查签名更新.',
}
const available: OnlineUpdateState = {
  ...base, checkedAt: Date.UTC(2026, 10, 1),
  frontend: { ...empty, phase: 'available', version: '0.2.0-ui.2', revision: 2, totalBytes: 2_097_152,
    notes: '前端更新内容\n<script>not executable</script>', message: '有可用前端更新.' },
  application: { ...empty, phase: 'available', version: '0.3.0', totalBytes: 20_971_520, message: '有可用完整应用更新.' },
}
const success = <T,>(value: T): ApiResult<T> => ({ ok: true, value })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const invoke = vi.fn<(method: string, args: unknown) => Promise<unknown>>()
const listeners = new Set<(event: FeatureEvent) => void>()
const handlers = new Map<string, (args: unknown) => unknown>()
let current: OnlineUpdateState

function publish(state: OnlineUpdateState) {
  current = state
  act(() => { for (const listener of listeners) listener({ topic: 'online-update', data: state }) })
}
const calls = (method: string) => invoke.mock.calls.filter(call => call[0] === method)
const frontend = () => within(screen.getByRole('region', { name: '前端更新' }))
const application = () => within(screen.getByRole('region', { name: '完整应用更新' }))

beforeEach(() => {
  current = structuredClone(base)
  handlers.clear()
  listeners.clear()
  invoke.mockReset()
  invoke.mockImplementation(async (method, args) => {
    if (handlers.has(method)) return handlers.get(method)!(args)
    switch (method) {
      case 'getOnlineUpdateState':
      case 'checkOnlineUpdate':
      case 'cancelOnlineUpdate': return success(structuredClone(current))
      case 'setOnlineUpdateSource':
        current = { ...current, source: (args as { source: 'github' | 'gitcode' }).source }
        return success(structuredClone(current))
      case 'downloadOnlineUpdate': {
        const kind = (args as { kind: 'frontend' | 'application' }).kind
        current = { ...current, [kind]: { ...current[kind], phase: 'ready', message: '下载已完成.' } }
        return success(structuredClone(current))
      }
      case 'applyOnlineUpdate':
      case 'rollbackFrontendUpdate': return success({ accepted: false })
      default: return { ok: false, code: 'unknown-method', message: method }
    }
  })
  vi.stubGlobal('streamSyncer', {
    invoke: invoke as StreamSyncerBridge['invoke'],
    subscribeFeatures(listener: (event: FeatureEvent) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('signed online update settings', () => {
  it('reads local state on mount without checking, downloading or installing', async () => {
    render(<AppUpdateSettings />)
    expect(await screen.findByText('0.2.0')).toBeInTheDocument()
    expect(screen.getByText('r1')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('github')
    expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled()
    expect(invoke).toHaveBeenCalledExactlyOnceWith('getOnlineUpdateState', undefined)
    expect(screen.queryByRole('button', { name: '应用并重启' })).toBeNull()
    expect(screen.queryByRole('button', { name: '安装完整更新' })).toBeNull()
    expect(screen.getByText(/不刷新当前画面/)).toBeInTheDocument()
    expect(screen.getByText(/仅支持 Windows x64 已安装版/)).toBeInTheDocument()
  })

  it('saves only the selected source and locks duplicate changes until it is saved', async () => {
    const saved = deferred<ApiResult<OnlineUpdateState>>()
    handlers.set('setOnlineUpdateSource', () => saved.promise)
    render(<AppUpdateSettings />)
    const select = await screen.findByRole('combobox', { name: '更新来源' })
    await waitFor(() => expect(select).toBeEnabled())
    fireEvent.change(select, { target: { value: 'gitcode' } })
    fireEvent.change(select, { target: { value: 'gitcode' } })
    expect(select).toBeDisabled()
    expect(select).toHaveValue('github')
    expect(calls('setOnlineUpdateSource')).toEqual([['setOnlineUpdateSource', { source: 'gitcode' }]])
    await act(async () => saved.resolve(success({ ...base, source: 'gitcode' })))
    expect(select).toHaveValue('gitcode')
    expect(select).toBeEnabled()
    expect(calls('checkOnlineUpdate')).toHaveLength(0)
    expect(calls('downloadOnlineUpdate')).toHaveLength(0)
  })

  it('checks manually, prevents a second check and displays text-only release notes', async () => {
    const checked = deferred<ApiResult<OnlineUpdateState>>()
    handlers.set('checkOnlineUpdate', () => checked.promise)
    render(<AppUpdateSettings />)
    await screen.findByText('0.2.0')
    const button = screen.getByRole('button', { name: '检查更新' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: '正在检查...' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '更新来源' })).toBeDisabled()
    expect(calls('checkOnlineUpdate')).toHaveLength(1)
    await act(async () => checked.resolve(success(available)))
    expect(frontend().getByRole('button', { name: '下载前端更新' })).toBeEnabled()
    expect(application().getByRole('button', { name: '下载完整更新' })).toBeEnabled()
    fireEvent.click(frontend().getByText('前端更新说明'))
    expect(frontend().getByText(/<script>not executable<\/script>/)).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    expect(calls('downloadOnlineUpdate')).toHaveLength(0)
  })

  it.each(['frontend', 'application'] as const)('does not apply a downloaded %s update without another click', async kind => {
    current = structuredClone(available)
    render(<AppUpdateSettings />)
    const label = kind === 'frontend' ? '下载前端更新' : '下载完整更新'
    fireEvent.click(await screen.findByRole('button', { name: label }))
    const apply = await screen.findByRole('button', { name: kind === 'frontend' ? '应用并重启' : '安装完整更新' })
    expect(calls('downloadOnlineUpdate')).toEqual([['downloadOnlineUpdate', { kind }]])
    expect(calls('applyOnlineUpdate')).toHaveLength(0)
    fireEvent.click(apply)
    await screen.findByText('操作已取消, 当前应用继续运行.')
    expect(calls('applyOnlineUpdate')).toEqual([['applyOnlineUpdate', { kind }]])
    expect(apply).toBeEnabled()
  })

  it('requires a separate rollback click and keeps the current state when native confirmation is cancelled', async () => {
    current = { ...base, currentFrontendRevision: 3, canRollbackFrontend: true }
    const confirmation = deferred<ApiResult<{ accepted: boolean }>>()
    handlers.set('rollbackFrontendUpdate', () => confirmation.promise)
    render(<AppUpdateSettings />)
    const button = await screen.findByRole('button', { name: '回退前端' })
    expect(calls('rollbackFrontendUpdate')).toHaveLength(0)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(calls('rollbackFrontendUpdate')).toHaveLength(1)
    await act(async () => confirmation.resolve(success({ accepted: false })))
    expect(screen.getByText('r3')).toBeInTheDocument()
    expect(button).toBeEnabled()
  })

  it('keeps cancellation available during a pending download and ignores the old download response', async () => {
    current = structuredClone(available)
    const download = deferred<ApiResult<OnlineUpdateState>>()
    const cancelled = deferred<ApiResult<OnlineUpdateState>>()
    handlers.set('downloadOnlineUpdate', () => download.promise)
    handlers.set('cancelOnlineUpdate', () => cancelled.promise)
    render(<AppUpdateSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '下载前端更新' }))
    const progress: OnlineUpdateState = { ...available,
      frontend: { ...available.frontend, phase: 'downloading', downloadedBytes: 1_048_576, message: '正在下载前端.' } }
    publish(progress)
    expect(frontend().getByRole('progressbar', { name: '前端更新下载进度' })).toHaveAttribute('value', '50')
    expect(frontend().getByText('1.0 MB / 2.0 MB')).toBeInTheDocument()
    expect(application().getByRole('button', { name: '下载完整更新' })).toBeDisabled()
    const cancel = screen.getByRole('button', { name: '取消下载' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    expect(calls('cancelOnlineUpdate')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '正在取消...' })).toBeDisabled()
    await act(async () => cancelled.resolve(success(available)))
    await act(async () => download.resolve(success(progress)))
    expect(frontend().getByRole('button', { name: '下载前端更新' })).toBeEnabled()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(calls('applyOnlineUpdate')).toHaveLength(0)
  })

  it('shows an existing download after reopening and can cancel it without a local download request', async () => {
    current = { ...available, application: { ...available.application, phase: 'downloading', downloadedBytes: 4_194_304 } }
    render(<AppUpdateSettings />)
    const button = await screen.findByRole('button', { name: '取消下载' })
    expect(button).toBeEnabled()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '更新来源' })).toBeDisabled()
    expect(application().getByText('4.0 MB / 20.0 MB')).toBeInTheDocument()
    fireEvent.click(button)
    await waitFor(() => expect(calls('cancelOnlineUpdate')).toHaveLength(1))
    expect(calls('downloadOnlineUpdate')).toHaveLength(0)
  })

  it('allows retrying cancellation when the first cancel request fails', async () => {
    current = { ...available, frontend: { ...available.frontend, phase: 'downloading' } }
    handlers.set('cancelOnlineUpdate', () => ({ ok: false, code: 'fixture', message: '取消请求未完成.' }))
    render(<AppUpdateSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '取消下载' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('取消请求未完成.')
    await waitFor(() => expect(screen.getByRole('button', { name: '取消下载' })).toBeEnabled())
    handlers.set('cancelOnlineUpdate', () => success(available))
    fireEvent.click(screen.getByRole('button', { name: '取消下载' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消下载' })).toBeNull())
    expect(frontend().getByRole('button', { name: '下载前端更新' })).toBeEnabled()
    expect(calls('cancelOnlineUpdate')).toHaveLength(2)
  })

  it('never offers incompatible updates and preserves an already downloaded frontend when checks fail', async () => {
    current = { ...available, phase: 'error', message: '所选来源暂不可用.',
      frontend: { ...available.frontend, phase: 'ready' },
      application: { ...available.application, phase: 'incompatible', message: '此运行方式不支持应用内安装.' } }
    render(<AppUpdateSettings />)
    expect(await screen.findByRole('button', { name: '应用并重启' })).toBeEnabled()
    expect(application().getByText('当前客户端不适用')).toBeInTheDocument()
    expect(application().queryByRole('button', { name: '下载完整更新' })).toBeNull()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('github')
  })

  it('does not invent usable sources for an unconfigured build', async () => {
    current = { ...base, phase: 'unconfigured', availableSources: [] }
    render(<AppUpdateSettings />)
    expect(await screen.findByText('未配置签名发布源')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '更新来源' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '下载前端更新' })).toBeNull()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('ignores a late initial snapshot after a newer main-process event', async () => {
    const initial = deferred<ApiResult<OnlineUpdateState>>()
    handlers.set('getOnlineUpdateState', () => initial.promise)
    render(<AppUpdateSettings />)
    publish({ ...available, source: 'gitcode' })
    expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('gitcode')
    await act(async () => initial.resolve(success(base)))
    expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('gitcode')
    expect(frontend().getByRole('button', { name: '下载前端更新' })).toBeEnabled()
  })

  it('does not overwrite a newer pushed state with an older operation result', async () => {
    const checked = deferred<ApiResult<OnlineUpdateState>>()
    handlers.set('checkOnlineUpdate', () => checked.promise)
    render(<AppUpdateSettings />)
    await screen.findByText('0.2.0')
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    publish({ ...available, frontend: { ...available.frontend, phase: 'ready' } })
    await act(async () => checked.resolve(success(base)))
    expect(frontend().getByRole('button', { name: '应用并重启' })).toBeEnabled()
    expect(calls('applyOnlineUpdate')).toHaveLength(0)
  })

  it('rereads state after a transport failure without losing a staged package or switching sources', async () => {
    current = { ...available, source: 'gitcode', frontend: { ...available.frontend, phase: 'ready' } }
    handlers.set('checkOnlineUpdate', () => { throw new Error('Offline fixture transport error') })
    render(<AppUpdateSettings />)
    const check = await screen.findByRole('button', { name: '检查更新' })
    await waitFor(() => expect(check).toBeEnabled())
    fireEvent.click(check)
    await screen.findByRole('alert')
    await waitFor(() => expect(calls('getOnlineUpdateState')).toHaveLength(2))
    expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('gitcode')
    expect(frontend().getByRole('button', { name: '应用并重启' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled()
    expect(calls('setOnlineUpdateSource')).toHaveLength(0)
  })

  it('allows a local status retry when the initial read fails', async () => {
    handlers.set('getOnlineUpdateState', () => ({ ok: false, code: 'fixture', message: '无法读取更新状态.' }))
    render(<AppUpdateSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取更新状态.')
    handlers.delete('getOnlineUpdateState')
    fireEvent.click(screen.getByRole('button', { name: '重新读取状态' }))
    expect(await screen.findByText('0.2.0')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls('getOnlineUpdateState')).toHaveLength(2)
    expect(calls('checkOnlineUpdate')).toHaveLength(0)
  })

  it('recovers from a failed source save using main state and leaves refresh manual', async () => {
    handlers.set('setOnlineUpdateSource', () => ({ ok: false, code: 'save-failed', message: '来源未能保存.' }))
    render(<AppUpdateSettings />)
    await screen.findByText('0.2.0')
    fireEvent.change(screen.getByRole('combobox', { name: '更新来源' }), { target: { value: 'gitcode' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('来源未能保存.')
    await waitFor(() => expect(screen.getByRole('combobox', { name: '更新来源' })).toBeEnabled())
    expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('github')
    expect(calls('checkOnlineUpdate')).toHaveLength(0)
    expect(calls('downloadOnlineUpdate')).toHaveLength(0)
  })

  it('ignores a previous StrictMode mount response and unsubscribes on unmount', async () => {
    const oldRead = deferred<ApiResult<OnlineUpdateState>>()
    let reads = 0
    handlers.set('getOnlineUpdateState', () => ++reads === 1 ? oldRead.promise : success({ ...available, source: 'gitcode' }))
    const view = render(<StrictMode><AppUpdateSettings /></StrictMode>)
    await waitFor(() => expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('gitcode'))
    expect(listeners.size).toBe(1)
    await act(async () => oldRead.resolve(success(base)))
    expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('gitcode')
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('prevents duplicate installation while native confirmation is open', async () => {
    current = { ...available, application: { ...available.application, phase: 'ready' } }
    const confirmation = deferred<ApiResult<{ accepted: boolean }>>()
    handlers.set('applyOnlineUpdate', () => confirmation.promise)
    render(<AppUpdateSettings />)
    const button = await screen.findByRole('button', { name: '安装完整更新' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(frontend().getByRole('button', { name: '下载前端更新' })).toBeDisabled()
    expect(calls('applyOnlineUpdate')).toHaveLength(1)
    await act(async () => confirmation.resolve(success({ accepted: true })))
    expect(screen.queryByText('操作已取消, 当前应用继续运行.')).toBeNull()
  })

  it('does not let unrelated feature events replace update state', async () => {
    render(<AppUpdateSettings />)
    await screen.findByText('0.2.0')
    act(() => { for (const listener of listeners) listener({ topic: 'cs2-schedule', data: { type: 'logos-updated' } }) })
    expect(screen.getByRole('combobox', { name: '更新来源' })).toHaveValue('github')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
