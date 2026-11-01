import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../app/apiClient'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { StylePackSyncState } from '../../../electron/stylePackSyncContracts'
import { StylePackSyncSettings } from './StylePackSync'

const idle: StylePackSyncState = { phase: 'idle', checkedAt: null, updatedAt: null, installed: 0,
  downloaded: 0, incompatible: 0, message: '等待同步.' }

describe('赛事样式包同步设置', () => {
  it('runs a single manual request, reports the installed count, and prevents duplicate clicks', async () => {
    vi.spyOn(apiClient, 'getStylePackSyncState').mockResolvedValue({ ok: true, value: idle })
    let finish!: (value: Awaited<ReturnType<typeof apiClient.syncStylePacks>>) => void
    const sync = vi.spyOn(apiClient, 'syncStylePacks').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<StylePackSyncSettings />)
    const button = await screen.findByRole('button', { name: '立即同步样式包' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    fireEvent.click(button)
    expect(sync).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '正在同步...' })).toBeDisabled()
    await act(async () => finish({ ok: true, value: { ...idle, phase: 'updated', installed: 2,
      downloaded: 2, checkedAt: 100, updatedAt: 100, message: '已更新 2 个赛事样式包.' } }))
    expect(screen.getByRole('status')).toHaveTextContent('样式包已更新')
    expect(screen.getByText(/已安装 2 个云端样式包/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即同步样式包' })).toBeEnabled()
  })

  it('lets background events supersede a delayed initial read and releases its subscription', async () => {
    let finish!: (value: Awaited<ReturnType<typeof apiClient.getStylePackSyncState>>) => void
    vi.spyOn(apiClient, 'getStylePackSyncState').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    let emit!: (event: FeatureEvent) => void
    const release = vi.fn()
    vi.spyOn(apiClient, 'subscribeFeatures').mockImplementation(listener => { emit = listener; return release })
    const view = render(<StylePackSyncSettings />)
    act(() => emit({ topic: 'stylepacks-state', data: { ...idle, phase: 'current', installed: 3 } }))
    await act(async () => finish({ ok: true, value: idle }))
    expect(screen.getByRole('status')).toHaveTextContent('样式包已是最新')
    expect(screen.getByText(/已安装 3 个云端样式包/)).toBeInTheDocument()
    view.unmount()
    expect(release).toHaveBeenCalledOnce()
  })

  it('clearly shows an unconfigured source and a failed sync without claiming success', async () => {
    vi.spyOn(apiClient, 'getStylePackSyncState').mockResolvedValue({ ok: true,
      value: { ...idle, phase: 'unconfigured', message: '赛事样式包分发源尚未启用.' } })
    let emit!: (event: FeatureEvent) => void
    vi.spyOn(apiClient, 'subscribeFeatures').mockImplementation(listener => { emit = listener; return () => {} })
    vi.spyOn(apiClient, 'syncStylePacks').mockResolvedValue({ ok: true, value: { ...idle,
      phase: 'error', installed: 1, message: '同步失败, 已保留原有样式包.' } })
    render(<StylePackSyncSettings />)
    expect(await screen.findByText('尚未启用云端同步')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即同步样式包' })).toBeDisabled()
    act(() => emit({ topic: 'stylepacks-state', data: { ...idle, installed: 1 } }))
    fireEvent.click(screen.getByRole('button', { name: '立即同步样式包' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('同步失败'))
    expect(screen.getByText(/已安装 1 个云端样式包/)).toBeInTheDocument()
    expect(screen.getByText('同步失败, 已保留原有样式包.')).toBeInTheDocument()
  })
})
