import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolsStatus } from '../../electron/toolsService'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { ToolSettings } from './ToolSettings'
const initial: ToolsStatus = {
  tools: [{ name: 'yt-dlp', source: 'external', version: '2026.09.01', available: true }],
  provider: { available: true, source: 'bundled', version: '2.0.2' },
  update: { phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: '仅手动更新' },
  externalYtdlp: true, fixturesAvailable: false, bundledAvailable: true,
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('tool settings', () => {
  it('keeps the actual external version distinct from the downloaded version', async () => {
    const invoke = vi.fn(async method => ({ ok: true, value: method === 'updateYtdlp' ? { ...initial, update: { ...initial.update, phase: 'ready', downloadedVersion: '2026.10.21', activeVersion: '2026.10.21', message: '已校验下载' } } : initial }))
    vi.stubGlobal('streamSyncer', { invoke } as unknown as StreamSyncerBridge)
    render(<ToolSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: '检查并更新 yt-dlp' })).toBeEnabled())
    expect(screen.getByText(/不会替换外部文件/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '检查并更新 yt-dlp' }))
    await screen.findByText(/下载版本: 2026.10.21/)
    expect(screen.getByText('yt-dlp: 2026.09.01 (外部配置)')).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('updateYtdlp', undefined)
    expect(invoke).not.toHaveBeenCalledWith('resolve', expect.anything())
  })
  it('disables duplicate actions while an update is pending', async () => {
    let finish!: (value: unknown) => void
    const invoke = vi.fn(method => method === 'updateYtdlp' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ ok: true, value: initial }))
    vi.stubGlobal('streamSyncer', { invoke } as unknown as StreamSyncerBridge)
    render(<ToolSettings />)
    const button = screen.getByRole('button', { name: '检查并更新 yt-dlp' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button); fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(invoke.mock.calls.filter(call => call[0] === 'updateYtdlp')).toHaveLength(1)
    finish({ ok: false, message: '更新失败' })
    await screen.findByRole('alert')
    await waitFor(() => expect(button).toBeEnabled())
  })
})
