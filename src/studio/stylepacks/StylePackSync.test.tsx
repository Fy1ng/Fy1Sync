import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../../app/apiClient'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { StylePackSourceId, StylePackSyncState } from '../../../electron/stylePackSyncContracts'
import { StylePackSyncSettings } from './StylePackSync'

const api = vi.hoisted(() => ({
  getStylePackSyncState: vi.fn<() => Promise<ApiResult<StylePackSyncState>>>(),
  syncStylePacks: vi.fn<() => Promise<ApiResult<StylePackSyncState>>>(),
  setStylePackSyncSource: vi.fn<(source: StylePackSourceId) => Promise<ApiResult<StylePackSyncState>>>(),
  subscribeFeatures: vi.fn<(listener: (event: FeatureEvent) => void) => () => void>(),
}))
vi.mock('../../app/apiClient', () => ({ apiClient: api }))

const idle: StylePackSyncState = { phase: 'idle', checkedAt: null, updatedAt: null, installed: 0,
  downloaded: 0, incompatible: 0, message: '等待同步.', source: 'github', availableSources: ['github', 'gitcode'], catalogRevision: null }

beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset())
  api.getStylePackSyncState.mockResolvedValue({ ok: true, value: idle })
  api.syncStylePacks.mockResolvedValue({ ok: true, value: { ...idle, phase: 'current' } })
  api.setStylePackSyncSource.mockImplementation(async source => ({ ok: true, value: { ...idle, source } }))
  api.subscribeFeatures.mockReturnValue(() => {})
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function ready() {
  const view = render(<StylePackSyncSettings />)
  const source = screen.getByRole('combobox', { name: '样式包来源' })
  await waitFor(() => expect(source).toBeEnabled())
  return { ...view, source, refresh: screen.getByRole('button', { name: '手动刷新' }) }
}

describe('赛事样式包选源与刷新', () => {
  it('loads the configured source without initiating downloads and shows only trusted source choices', async () => {
    api.getStylePackSyncState.mockResolvedValue({ ok: true, value: { ...idle, source: 'gitcode', installed: 1, catalogRevision: 7 } })
    const view = await ready()
    expect(view.source).toHaveValue('gitcode')
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['GitHub', 'GitCode'])
    expect(screen.getByText('当前来源: GitCode / 清单版本: 7')).toBeInTheDocument()
    expect(screen.getByText(/已安装 1 个云端样式包/)).toBeInTheDocument()
    expect(api.syncStylePacks).not.toHaveBeenCalled()
    expect(api.setStylePackSyncSource).not.toHaveBeenCalled()
    expect(screen.getByText(/本机修改优先保留/)).toBeInTheDocument()
  })

  it('runs one manual refresh, locks the source and reports the installed catalog', async () => {
    const pending = deferred<ApiResult<StylePackSyncState>>()
    api.syncStylePacks.mockReturnValue(pending.promise)
    const view = await ready()
    fireEvent.click(view.refresh)
    fireEvent.click(view.refresh)
    fireEvent.change(view.source, { target: { value: 'gitcode' } })
    expect(api.syncStylePacks).toHaveBeenCalledExactlyOnceWith()
    expect(api.setStylePackSyncSource).not.toHaveBeenCalled()
    expect(view.source).toBeDisabled()
    expect(screen.getByRole('button', { name: '正在刷新...' })).toBeDisabled()
    await act(async () => pending.resolve({ ok: true, value: { ...idle, phase: 'updated', installed: 2,
      downloaded: 2, checkedAt: 100, updatedAt: 100, catalogRevision: 3, message: '已更新 2 个赛事样式包.' } }))
    expect(screen.getByRole('status')).toHaveTextContent('样式包已更新')
    expect(screen.getByText(/已安装 2 个云端样式包/)).toBeInTheDocument()
    expect(screen.getByText(/上次检查:/)).toBeInTheDocument()
    expect(screen.getByText('当前来源: GitHub / 清单版本: 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '手动刷新' })).toBeEnabled()
    expect(view.source).toBeEnabled()
  })

  it('saves a selected source without optimistic success or an automatic refresh', async () => {
    const pending = deferred<ApiResult<StylePackSyncState>>()
    api.setStylePackSyncSource.mockReturnValue(pending.promise)
    const view = await ready()
    fireEvent.change(view.source, { target: { value: 'gitcode' } })
    fireEvent.change(view.source, { target: { value: 'gitcode' } })
    fireEvent.click(view.refresh)
    expect(api.setStylePackSyncSource).toHaveBeenCalledExactlyOnceWith('gitcode')
    expect(api.syncStylePacks).not.toHaveBeenCalled()
    expect(view.source).toHaveValue('github')
    expect(view.source).toBeDisabled()
    expect(view.refresh).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('正在保存来源...')
    await act(async () => pending.resolve({ ok: true, value: { ...idle, source: 'gitcode' } }))
    expect(view.source).toHaveValue('gitcode')
    expect(view.source).toBeEnabled()
    expect(api.syncStylePacks).not.toHaveBeenCalled()
    expect(screen.getByText(/只访问所选源/)).toBeInTheDocument()
  })

  it.each(['response', 'rejection'] as const)('keeps the original source after a save %s and permits a retry', async mode => {
    if (mode === 'response') api.setStylePackSyncSource.mockResolvedValueOnce({ ok: false, code: 'save-failed', message: '来源未能保存.' })
    else api.setStylePackSyncSource.mockRejectedValueOnce(new Error('transport failed'))
    const view = await ready()
    fireEvent.change(view.source, { target: { value: 'gitcode' } })
    expect(await screen.findByRole('alert')).toHaveTextContent(mode === 'response' ? '来源未能保存.' : '保存样式包来源失败')
    expect(view.source).toHaveValue('github')
    expect(view.source).toBeEnabled()
    fireEvent.change(view.source, { target: { value: 'gitcode' } })
    await waitFor(() => expect(view.source).toHaveValue('gitcode'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.setStylePackSyncSource).toHaveBeenCalledTimes(2)
    expect(api.syncStylePacks).not.toHaveBeenCalled()
  })

  it('does not send unchanged, unavailable or arbitrary source identifiers', async () => {
    api.getStylePackSyncState.mockResolvedValue({ ok: true, value: { ...idle, availableSources: ['github'] } })
    const view = await ready()
    expect(screen.getByRole('option', { name: 'GitCode' })).toBeDisabled()
    for (const source of ['github', 'gitcode', 'https://untrusted.test/manifest.json']) fireEvent.change(view.source, { target: { value: source } })
    expect(api.setStylePackSyncSource).not.toHaveBeenCalled()
    expect(api.syncStylePacks).not.toHaveBeenCalled()
  })

  it('lets background events supersede a delayed initial read and releases its subscription', async () => {
    const pending = deferred<ApiResult<StylePackSyncState>>()
    api.getStylePackSyncState.mockReturnValue(pending.promise)
    let emit!: (event: FeatureEvent) => void
    const release = vi.fn()
    api.subscribeFeatures.mockImplementation(listener => { emit = listener; return release })
    const view = render(<StylePackSyncSettings />)
    expect(screen.getByRole('combobox', { name: '样式包来源' })).toBeDisabled()
    act(() => emit({ topic: 'stylepacks-state', data: { ...idle, phase: 'current', installed: 3, source: 'gitcode', catalogRevision: 9 } }))
    await act(async () => pending.resolve({ ok: true, value: idle }))
    expect(screen.getByRole('status')).toHaveTextContent('样式包已是最新')
    expect(screen.getByRole('combobox', { name: '样式包来源' })).toHaveValue('gitcode')
    expect(screen.getByText('当前来源: GitCode / 清单版本: 9')).toBeInTheDocument()
    view.unmount()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each(['source', 'sync'] as const)('does not overwrite newer subscription state with a delayed %s response', async kind => {
    let emit!: (event: FeatureEvent) => void
    api.subscribeFeatures.mockImplementation(listener => { emit = listener; return () => {} })
    const pending = deferred<ApiResult<StylePackSyncState>>()
    api.setStylePackSyncSource.mockReturnValue(pending.promise)
    api.syncStylePacks.mockReturnValue(pending.promise)
    const view = await ready()
    if (kind === 'source') fireEvent.change(view.source, { target: { value: 'gitcode' } })
    else fireEvent.click(view.refresh)
    act(() => emit({ topic: 'stylepacks-state', data: { ...idle, phase: 'updated', source: 'gitcode', catalogRevision: 12, installed: 4 } }))
    await act(async () => pending.resolve({ ok: true, value: { ...idle, phase: 'current', catalogRevision: 1 } }))
    expect(view.source).toHaveValue('gitcode')
    expect(screen.getByText('当前来源: GitCode / 清单版本: 12')).toBeInTheDocument()
    expect(screen.getByText(/已安装 4 个云端样式包/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('样式包已更新')
    expect(view.source).toBeEnabled()
  })

  it('disables unconfigured sources but keeps errors switchable and manually refreshable', async () => {
    api.getStylePackSyncState.mockResolvedValue({ ok: true, value: { ...idle, phase: 'unconfigured', availableSources: [], message: '赛事样式包分发源尚未启用.' } })
    let emit!: (event: FeatureEvent) => void
    api.subscribeFeatures.mockImplementation(listener => { emit = listener; return () => {} })
    api.syncStylePacks.mockResolvedValueOnce({ ok: true, value: { ...idle, phase: 'error', installed: 1, message: '同步失败, 已保留原有样式包.' } })
    render(<StylePackSyncSettings />)
    expect(await screen.findByText('尚未启用云端同步')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '手动刷新' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '样式包来源' })).toBeDisabled()
    act(() => emit({ topic: 'stylepacks-state', data: { ...idle, phase: 'error', installed: 1 } }))
    fireEvent.click(screen.getByRole('button', { name: '手动刷新' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('同步失败'))
    expect(screen.getByText('同步失败, 已保留原有样式包.')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '样式包来源' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '手动刷新' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '手动刷新' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('样式包已是最新'))
    expect(api.syncStylePacks).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected manual refresh without claiming an update and permits another click', async () => {
    api.syncStylePacks.mockRejectedValueOnce(new Error('transport failed'))
    const view = await ready()
    fireEvent.click(view.refresh)
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新样式包失败')
    expect(screen.getByRole('status')).toHaveTextContent('等待同步')
    expect(screen.getByRole('button', { name: '手动刷新' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '手动刷新' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('样式包已是最新'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not apply a source response after unmount', async () => {
    const pending = deferred<ApiResult<StylePackSyncState>>()
    api.setStylePackSyncSource.mockReturnValue(pending.promise)
    const release = vi.fn()
    api.subscribeFeatures.mockReturnValue(release)
    const view = await ready()
    fireEvent.change(view.source, { target: { value: 'gitcode' } })
    view.unmount()
    await act(async () => pending.resolve({ ok: true, value: { ...idle, source: 'gitcode' } }))
    expect(release).toHaveBeenCalledOnce()
    expect(api.syncStylePacks).not.toHaveBeenCalled()
  })
})
