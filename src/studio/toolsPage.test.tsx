/**
 * 取流工具 warns only when ffmpeg is not the bundled build, whose certificate checks are known.
 */

import { Blob as NodeBlob } from 'node:buffer'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Tools } from './SettingsSheet'
import { forgetAll } from '../app/remembered'
import type { SessionSnapshot } from '../app/session'

const { exportPlaybackDiagnostics, playbackDiagnostics } = vi.hoisted(() => ({
  exportPlaybackDiagnostics: vi.fn(),
  playbackDiagnostics: { official: null, commentary: null } as SessionSnapshot['playbackDiagnostics'],
}))
vi.mock('../app/SessionContext', () => ({
  useSession: () => ({ exportPlaybackDiagnostics }),
  useSessionSnapshot: () => ({ playbackDiagnostics }),
}))

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

beforeEach(() => {
  forgetAll()
  playbackDiagnostics.official = null
  playbackDiagnostics.commentary = null
  exportPlaybackDiagnostics.mockReset().mockReturnValue({
    version: 1, official: { samples: [], lastStall: null }, commentary: { samples: [], lastStall: null },
  })
})
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
  it('shows no stall text or separate playback export before a stall exists', async () => {
    stub('bundled')
    render(<Tools />)
    await screen.findByText('内置', { exact: false })
    expect(screen.queryByText(/最近卡顿|暂未记录到卡顿/)).toBeNull()
    expect(screen.queryByRole('button', { name: '导出播放诊断' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '导出诊断报告' })).toHaveLength(1)
    expect(exportPlaybackDiagnostics).not.toHaveBeenCalled()
  })

  it.each(['official', 'commentary'] as const)('shows only the %s stall when the other source has no record', async role => {
    stub('bundled')
    playbackDiagnostics[role] = { durationMs: 2500, category: 'fetch', hint: '播放器未收到新数据', ongoing: false }
    render(<Tools />)
    await screen.findByText('内置', { exact: false })
    const label = role === 'official' ? '画面最近卡顿' : '解说最近卡顿'
    const otherLabel = role === 'official' ? '解说最近卡顿' : '画面最近卡顿'
    expect(screen.getByText(label).closest('div')).toHaveTextContent('2.5 秒，播放器未收到新数据')
    expect(screen.queryByText(otherLabel)).toBeNull()
    expect(screen.queryByText(/尚未恢复|暂未记录到卡顿/)).toBeNull()
  })

  it('shows both source stalls and follows recovery and cleared records', async () => {
    stub('bundled')
    playbackDiagnostics.official = { durationMs: 2500, category: 'fetch', hint: '播放器未收到新数据', ongoing: false }
    playbackDiagnostics.commentary = { durationMs: 4100, category: 'playback', hint: '已收到数据但画面未更新', ongoing: true }
    const view = render(<Tools />)
    await screen.findByText('内置', { exact: false })
    expect(screen.getByText('画面最近卡顿').closest('div')).toHaveTextContent('2.5 秒，播放器未收到新数据')
    expect(screen.getByText('解说最近卡顿').closest('div')).toHaveTextContent('4.1 秒（尚未恢复），已收到数据但画面未更新')
    playbackDiagnostics.commentary = { ...playbackDiagnostics.commentary, durationMs: 5200, ongoing: false }
    view.rerender(<Tools />)
    expect(screen.getByText('解说最近卡顿').closest('div')).toHaveTextContent('5.2 秒，已收到数据但画面未更新')
    expect(screen.queryByText(/尚未恢复/)).toBeNull()
    playbackDiagnostics.official = null
    playbackDiagnostics.commentary = null
    view.rerender(<Tools />)
    expect(screen.queryByText(/最近卡顿|暂未记录到卡顿/)).toBeNull()
  })

  it.each(['failure', 'rejected', 'invalid'] as const)('offers retry for a %s status read without a loading or empty state', async (failure) => {
    const invoke = stub('bundled')
    if (failure === 'rejected') invoke.mockRejectedValueOnce(new Error('read failed'))
    else invoke.mockResolvedValueOnce(failure === 'failure'
      ? { ok: false, code: 'unavailable', message: '工具状态读取失败' }
      : { ok: true, value: {} })
    render(<Tools />)
    expect(screen.getByText('正在读取取流工具状态')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(failure === 'rejected' ? '无法连接 Fy1Sync' : '读取失败')
    expect(screen.queryByText('正在读取取流工具状态')).toBeNull()
    expect(screen.queryByText('暂无取流工具')).toBeNull()
    expect(screen.getByRole('button', { name: '更新 yt-dlp' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('8.1.3', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更新 yt-dlp' })).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(invoke.mock.calls.filter(([method]) => method === 'getToolsStatus')).toHaveLength(2)
  })

  it('shows an empty status only after a successful empty tools read', async () => {
    const invoke = stub('bundled')
    invoke.mockResolvedValueOnce({ ok: true, value: { ...tools(), tools: [] } })
    render(<Tools />)
    expect(screen.queryByText('暂无取流工具')).toBeNull()
    expect(await screen.findByText('暂无取流工具')).toBeInTheDocument()
    expect(screen.queryByText('正在读取取流工具状态')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('says nothing extra for the bundled ffmpeg', async () => {
    stub('bundled')
    render(<Tools />)
    expect(await screen.findByText('内置', { exact: false })).toBeInTheDocument()
    expect(screen.queryByText(/外部 ffmpeg/)).toBeNull()
  })

  it.each(['external', 'PATH'] as const)('warns about certificate checks for a %s ffmpeg', async (source) => {
    stub(source)
    render(<Tools />)
    expect(await screen.findByText(/外部 ffmpeg/)).toBeInTheDocument()
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
    expect(await screen.findByText('诊断报告已导出')).toBeInTheDocument()
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

  it('exports both sources latest playback samples and stalls through the existing report button', async () => {
    stub('bundled')
    exportPlaybackDiagnostics.mockReturnValue({ version: 1,
      official: { samples: [{ at: 1000, currentTime: 20, readyState: 2, paused: false, seeking: false,
        bufferAhead: 0.1, droppedFramesDelta: 3, timerLateMs: 100 }],
        lastStall: { durationMs: 2500, category: 'fetch', ongoing: false, hint: 'PRIVATE_STALL_HINT' } },
      commentary: { samples: [{ at: 2000, currentTime: 21, readyState: 4, paused: false, seeking: false,
        bufferAhead: 4, droppedFramesDelta: 0, timerLateMs: 0 }],
        lastStall: { durationMs: 4100, category: 'playback', ongoing: true, hint: 'PRIVATE_STALL_HINT' } },
    })
    const { create } = download()
    render(<Tools />)
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告已导出')
    expect(exportPlaybackDiagnostics).toHaveBeenCalledOnce()
    const blob = create.mock.calls[0]![0] as unknown as Blob
    const report = JSON.parse(await blob.text())
    expect(report.playback).toMatchObject({
      official: { sampleCount: 1, latest: { at: 1000, currentTime: 20, bufferAhead: 0.1 },
        lastStall: { durationMs: 2500, category: 'fetch', ongoing: false } },
      commentary: { sampleCount: 1, latest: { at: 2000, currentTime: 21, bufferAhead: 4 },
        lastStall: { durationMs: 4100, category: 'playback', ongoing: true } },
    })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_STALL_HINT')
    expect(screen.queryByRole('button', { name: '导出播放诊断' })).toBeNull()
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
    await screen.findByText('诊断报告已导出')
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
    await screen.findByText('诊断报告暂时无法生成，请重试')
    expect(create).not.toHaveBeenCalled()
    expect(screen.queryByText('PRIVATE')).toBeNull()
    failed = false
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告已导出')
    expect(screen.queryByText('诊断报告暂时无法生成，请重试')).toBeNull()
    expect(create).toHaveBeenCalledOnce()
  })

  it('releases the object URL when a download fails, then lets the user retry', async () => {
    stub('bundled')
    const { create, revoke, click } = download()
    click.mockImplementationOnce(() => { throw new Error('download failed PRIVATE') })
    render(<Tools />)
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告导出失败，请重试')
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:feedback')
    fireEvent.click(screen.getByRole('button', { name: '导出诊断报告' }))
    await screen.findByText('诊断报告已导出')
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

  it('shows progress bar, size, speed and cancel button while downloading yt-dlp', async () => {
    const invoke = stub('bundled')
    let cancelled = false
    invoke.mockImplementation(async method => {
      if (method === 'cancelYtdlpUpdate') {
        cancelled = true
        return { ok: true, value: { ...tools(), update: { phase: 'cancelled', message: '已取消更新，已保留原版本', downloadedBytes: 0, totalBytes: 0 } } }
      }
      return { ok: true, value: { ...tools(), update: cancelled
        ? { phase: 'cancelled', message: '已取消更新，已保留原版本', downloadedBytes: 0, totalBytes: 0 }
        : { phase: 'downloading', message: '正在下载并校验…', downloadedVersion: '2026.11.23', downloadedBytes: 5 * 1_048_576, totalBytes: 20 * 1_048_576, bytesPerSecond: 2.5 * 1_048_576 } } }
    })
    render(<Tools />)
    const bar = await screen.findByRole('progressbar', { name: 'yt-dlp 更新进度' })
    expect(bar).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('正在下载 yt-dlp 2026.11.23')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('5.0 MB / 20.0 MB')).toBeInTheDocument()
    expect(screen.getByText('2.50 MB/s')).toBeInTheDocument()
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('cancelYtdlpUpdate', undefined))
    expect(await screen.findByText('已取消更新，已保留原版本')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
})
