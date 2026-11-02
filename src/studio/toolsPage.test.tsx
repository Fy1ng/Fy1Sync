/**
 * 取流工具 warns only when ffmpeg is not the bundled build, whose certificate checks are known.
 */

import { Blob as NodeBlob } from 'node:buffer'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Tools } from './SettingsSheet'

const { exportPlaybackDiagnostics } = vi.hoisted(() => ({ exportPlaybackDiagnostics: vi.fn() }))
vi.mock('../app/SessionContext', () => ({ useSession: () => ({ exportPlaybackDiagnostics }) }))

function tools(source: 'bundled' | 'external' | 'PATH' = 'bundled') {
  return { tools: [{ name: 'ffmpeg', source, version: '8.1.3', available: true }], fixturesAvailable: false,
    provider: { available: true, source: 'bundled' }, update: { phase: 'idle', message: '', downloadedBytes: 0, totalBytes: 0 } }
}

function stub(source: 'bundled' | 'external' | 'PATH') {
  const invoke = vi.fn<(method: string, args?: unknown) => Promise<unknown>>(async method => method === 'getToolsStatus'
    ? { ok: true, value: tools(source) } : { ok: true, value: {} })
  vi.stubGlobal('streamSyncer', {
    invoke: invoke as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
  return invoke
}

beforeEach(() => exportPlaybackDiagnostics.mockReset().mockReturnValue({
  version: 1, official: { samples: [], lastStall: null }, commentary: { samples: [], lastStall: null },
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function download() {
  vi.stubGlobal('Blob', NodeBlob)
  const create = vi.fn((_blob: Blob) => 'blob:feedback')
  const revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = create; static override revokeObjectURL = revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { create, revoke, click }
}

describe('取流工具', () => {
  it('says nothing extra for the bundled ffmpeg', async () => {
    stub('bundled')
    render(<Tools />)
    expect(await screen.findByText('内置', { exact: false })).toBeInTheDocument()
    expect(screen.queryByText(/非内置的 ffmpeg/)).toBeNull()
  })

  it.each(['external', 'PATH'] as const)('warns about certificate checks for a %s ffmpeg', async (source) => {
    stub(source)
    render(<Tools />)
    expect(await screen.findByText(/非内置的 ffmpeg/)).toBeInTheDocument()
  })

  it('exports an empty diagnostics report before a video exists even when tools status fails', async () => {
    const invoke = stub('bundled')
    invoke.mockImplementation(async method => method === 'getToolsStatus'
      ? { ok: false, code: 'unavailable', message: '工具管理不可用' }
      : { ok: true, value: { schemaVersion: 1, attempts: [], Cookie: 'PRIVATE' } })
    const { create, revoke, click } = download()
    render(<Tools />)
    expect(await screen.findByText('工具管理不可用')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: '导出诊断报告' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(await screen.findByText('诊断报告已生成, 请查看下载文件.')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('getAcquisitionDiagnostics', undefined)
    expect(invoke.mock.calls.filter(([method]) => method === 'getAcquisitionDiagnostics')).toHaveLength(1)
    expect(invoke.mock.calls.some(([method]) => ['resolve', 'updateYtdlp', 'login'].includes(method))).toBe(false)
    expect(exportPlaybackDiagnostics).toHaveBeenCalledOnce()
    const blob = create.mock.calls[0]![0] as unknown as Blob
    expect(blob.type).toBe('application/json')
    const report = JSON.parse(await blob.text())
    expect(report).toMatchObject({ schemaVersion: 1, acquisition: { attempts: [] },
      playback: { official: { sampleCount: 0, latest: null, lastStall: null } } })
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(click.mock.instances[0]).toHaveProperty('download', 'Fy1Sync-diagnostics.json')
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:feedback')
  })

  it('keeps export independent of an update and rejects duplicate clicks while its report is pending', async () => {
    let finish!: (value: { ok: true; value: object }) => void
    const invoke = stub('bundled')
    invoke.mockImplementation(async method => method === 'getAcquisitionDiagnostics'
      ? new Promise<{ ok: true; value: object }>(resolve => { finish = resolve })
      : { ok: true, value: { ...tools(), update: { phase: 'downloading', message: '下载中', downloadedBytes: 1, totalBytes: 10 } } })
    download()
    render(<Tools />)
    await screen.findByText(/下载中/)
    expect(screen.getByRole('button', { name: '更新 yt-dlp' })).toBeDisabled()
    const button = screen.getByRole('button', { name: '导出诊断报告' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: '正在导出' })).toBeDisabled()
    expect(invoke.mock.calls.filter(([method]) => method === 'getAcquisitionDiagnostics')).toHaveLength(1)
    await act(async () => finish({ ok: true, value: { attempts: [] } }))
    expect(screen.getByRole('button', { name: '导出诊断报告' })).toBeEnabled()
  })

  it('downloads a failed pre-playback attempt without needing a loaded media source', async () => {
    const invoke = stub('bundled')
    invoke.mockImplementation(async method => method === 'getAcquisitionDiagnostics'
      ? { ok: true, value: { generatedAt: 120, attempts: [{ id: 1, startedAt: 100, endedAt: 110,
        role: 'official', operation: 'open', status: 'failed', droppedEvents: 0,
        events: [{ at: 110, stage: 'complete', status: 'failed', code: 'youtube-hls-missing', url: 'MEDIA_SECRET' }] }] } }
      : { ok: true, value: tools() })
    const { create } = download()
    render(<Tools />)
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告已生成, 请查看下载文件.')
    const blob = create.mock.calls[0]![0] as unknown as Blob
    const report = JSON.parse(await blob.text())
    expect(report.acquisition.attempts).toMatchObject([{ status: 'failed', events: [{ code: 'youtube-hls-missing' }] }])
    expect(report.playback.official.sampleCount).toBe(0)
    expect(JSON.stringify(report)).not.toContain('MEDIA_SECRET')
  })

  it('allows retry after an IPC failure and never downloads an error payload', async () => {
    let failed = true
    const invoke = stub('bundled')
    invoke.mockImplementation(async method => method === 'getAcquisitionDiagnostics'
      ? failed ? { ok: false, code: 'missing', message: 'PRIVATE' } : { ok: true, value: { attempts: [] } }
      : { ok: true, value: tools() })
    const { create } = download()
    render(<Tools />)
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告暂时无法生成, 请重试.')
    expect(create).not.toHaveBeenCalled()
    expect(screen.queryByText('PRIVATE')).toBeNull()
    failed = false
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告已生成, 请查看下载文件.')
    expect(screen.queryByText('诊断报告暂时无法生成, 请重试.')).toBeNull()
    expect(create).toHaveBeenCalledOnce()
  })

  it('releases the object URL when a download fails, then lets the user retry', async () => {
    stub('bundled')
    const { create, revoke, click } = download()
    click.mockImplementationOnce(() => { throw new Error('download failed PRIVATE') })
    render(<Tools />)
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告导出失败, 请重试.')
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:feedback')
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告已生成, 请查看下载文件.')
    expect(create).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/PRIVATE/)).toBeNull()
  })

  it('does not start a download when its pending report resolves after the page closed', async () => {
    let finish!: (value: { ok: true; value: object }) => void
    const invoke = stub('bundled')
    invoke.mockImplementation(async method => method === 'getAcquisitionDiagnostics'
      ? new Promise<{ ok: true; value: object }>(resolve => { finish = resolve }) : { ok: true, value: tools() })
    const { create } = download()
    const view = render(<Tools />)
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    view.unmount()
    await act(async () => finish({ ok: true, value: { attempts: [] } }))
    expect(create).not.toHaveBeenCalled()
    expect(exportPlaybackDiagnostics).not.toHaveBeenCalled()
  })

  it('preserves tool update and restore actions alongside diagnostics', async () => {
    const invoke = stub('bundled')
    invoke.mockImplementation(async () => ({ ok: true, value: { ...tools(),
      update: { phase: 'idle', message: '', downloadedBytes: 0, totalBytes: 0, activeVersion: '2026.10.26', previousVersion: '2026.10.21' } } }))
    render(<Tools />)
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复上一版本' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '恢复上一版本' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('restoreYtdlp', { target: 'previous' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复内置版本' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '恢复内置版本' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('restoreYtdlp', { target: 'bundled' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '更新 yt-dlp' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '更新 yt-dlp' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('updateYtdlp', undefined))
    expect(screen.getByRole('button', { name: '导出诊断报告' })).toBeEnabled()
  })
})
