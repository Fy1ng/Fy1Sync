import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WindowState } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { TitleBar } from './TitleBar'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete document.documentElement.dataset.titlebar })

function fixture(platform: 'darwin' | 'win32') {
  const state: WindowState = { maximized: false, fullscreen: false, focused: true }
  vi.stubGlobal('streamSyncer', { platform })
  vi.spyOn(apiClient, 'getWindowState').mockResolvedValue({ ok: true, value: state })
  let publish!: (state: WindowState) => void
  vi.spyOn(apiClient, 'subscribeWindowState').mockImplementation(listener => { publish = listener; return () => {} })
  return { state, publish: (next: WindowState) => publish(next) }
}

describe('desktop title bar', () => {
  it('reserves macOS traffic light space without drawing duplicate Windows buttons', async () => {
    const f = fixture('darwin')
    const { container } = render(<TitleBar detail="倒计时样式编辑器" />)
    await screen.findByText('Fy1Sync')
    expect(container.querySelector('.titlebar')).toHaveAttribute('data-platform', 'mac')
    expect(container.querySelector('.titlebar-controls')).toBeNull()
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument()
    await waitFor(() => expect(document.documentElement.dataset.titlebar).toBe('custom'))
    act(() => f.publish({ ...f.state, fullscreen: true }))
    expect(container.querySelector('.titlebar')).toBeNull()
    expect(document.documentElement.dataset.titlebar).toBe('native')
    act(() => f.publish({ ...f.state, focused: false }))
    expect(container.querySelector('.titlebar')).toHaveAttribute('data-focused', 'false')
  })

  it('keeps Windows caption controls wired to the existing IPC', async () => {
    const f = fixture('win32')
    const control = vi.spyOn(apiClient, 'windowControl').mockResolvedValue({ ok: true, value: f.state })
    render(<TitleBar />)
    fireEvent.click(await screen.findByRole('button', { name: '最小化' }))
    await waitFor(() => expect(control).toHaveBeenCalledExactlyOnceWith('minimize'))
    expect(screen.getByRole('button', { name: '最大化' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })
})
