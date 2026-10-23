import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiClient, type ApiResult } from '../app/apiClient'
import type { DecoderPreferenceState } from '../../electron/decoderPreferences'
import { DecoderSettings } from './DecoderSettings'

const automatic: DecoderPreferenceState = { mode: 'auto', effectiveMode: 'auto', restartRequired: false, forcedByCommandLine: false }
const saved: DecoderPreferenceState = { ...automatic, mode: 'software', restartRequired: true }

beforeEach(() => {
  vi.spyOn(apiClient, 'getDecoderPreferences').mockResolvedValue({ ok: true, value: automatic })
  vi.spyOn(apiClient, 'setDecoderPreferences').mockResolvedValue({ ok: true, value: saved })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const checkbox = () => screen.getByRole('checkbox', { name: '软件解码兼容模式' })

describe('decoder settings controls', () => {
  it('keeps loading disabled until persisted state arrives', async () => {
    let finish!: (value: ApiResult<DecoderPreferenceState>) => void
    vi.mocked(apiClient.getDecoderPreferences).mockReturnValue(new Promise(resolve => { finish = resolve }))
    render(<DecoderSettings />)
    expect(checkbox()).toBeDisabled()
    expect(screen.getByText('正在读取解码设置...')).toBeInTheDocument()
    finish({ ok: true, value: automatic })
    await waitFor(() => expect(checkbox()).toBeEnabled())
    expect(checkbox()).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('当前生效: 自动解码 (硬件优先)')
  })

  it('shows save pending, blocks duplicates and separates saved state from effective mode', async () => {
    let finish!: (value: ApiResult<DecoderPreferenceState>) => void
    vi.mocked(apiClient.setDecoderPreferences).mockReturnValue(new Promise(resolve => { finish = resolve }))
    render(<DecoderSettings />)
    await waitFor(() => expect(checkbox()).toBeEnabled())
    fireEvent.click(checkbox()); fireEvent.click(checkbox())
    expect(checkbox()).toBeDisabled()
    expect(apiClient.setDecoderPreferences).toHaveBeenCalledExactlyOnceWith('software')
    expect(screen.getByText('正在保存解码设置...')).toBeInTheDocument()
    expect(checkbox()).not.toBeChecked()
    finish({ ok: true, value: saved })
    await waitFor(() => expect(checkbox()).toBeEnabled())
    expect(checkbox()).toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('当前生效: 自动解码 (硬件优先). 已保存, 待重启: 软件解码兼容模式.')
  })

  it('keeps last saved choice after failure and permits retry', async () => {
    vi.mocked(apiClient.setDecoderPreferences).mockResolvedValueOnce({ ok: false, code: 'settings-write-failed', message: '解码设置保存失败, 请重试' })
    render(<DecoderSettings />)
    await waitFor(() => expect(checkbox()).toBeEnabled())
    fireEvent.click(checkbox())
    expect(await screen.findByRole('alert')).toHaveTextContent('解码设置保存失败, 请重试')
    expect(checkbox()).not.toBeChecked()
    expect(checkbox()).toBeEnabled()
    fireEvent.click(checkbox())
    await waitFor(() => expect(checkbox()).toBeChecked())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reads saved mode on reopen and reports active software mode after a process restart', async () => {
    const first = render(<DecoderSettings />)
    await waitFor(() => expect(checkbox()).toBeEnabled())
    first.unmount()
    vi.mocked(apiClient.getDecoderPreferences).mockResolvedValue({ ok: true, value: { ...saved, effectiveMode: 'software', restartRequired: false } })
    render(<DecoderSettings />)
    await waitFor(() => expect(checkbox()).toBeChecked())
    expect(screen.getByRole('status')).toHaveTextContent('当前生效: 软件解码兼容模式. 已保存的选择与当前模式一致.')
  })

  it('reports forced startup mode and allows saving auto for future launches', async () => {
    vi.mocked(apiClient.getDecoderPreferences).mockResolvedValue({ ok: true, value: { ...automatic, effectiveMode: 'software', restartRequired: true, forcedByCommandLine: true } })
    render(<DecoderSettings />)
    await waitFor(() => expect(checkbox()).toBeEnabled())
    expect(screen.getByText(/启动参数已强制软件解码/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('待重启: 自动解码 (硬件优先)')
  })

  it('does not apply stale read or save results after the dialog unmounts', async () => {
    let finish!: (value: ApiResult<DecoderPreferenceState>) => void
    vi.mocked(apiClient.setDecoderPreferences).mockReturnValue(new Promise(resolve => { finish = resolve }))
    const first = render(<DecoderSettings />)
    await waitFor(() => expect(checkbox()).toBeEnabled())
    fireEvent.click(checkbox())
    first.unmount()
    render(<DecoderSettings />)
    await waitFor(() => expect(checkbox()).toBeEnabled())
    finish({ ok: true, value: saved })
    await Promise.resolve()
    expect(checkbox()).not.toBeChecked()
  })
})
