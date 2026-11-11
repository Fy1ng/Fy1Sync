import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../../app/apiClient'
import type { EmbeddedLoginState } from '../../../electron/embeddedLoginContracts'
import { apiClient } from '../../app/apiClient'
import { EmbeddedLoginOverlay, useEmbeddedLoginState } from './EmbeddedLogin'

vi.mock('../../app/apiClient', () => ({ apiClient: {
  getEmbeddedLogin: vi.fn(), subscribeEmbeddedLogin: vi.fn(), setEmbeddedLoginViewport: vi.fn(),
  cancelEmbeddedLogin: vi.fn(), retryEmbeddedLogin: vi.fn(), backEmbeddedLogin: vi.fn(), loginStatus: vi.fn(),
} }))

const ATTEMPT: EmbeddedLoginState = { id: 'attempt-a', platform: 'douyu', purpose: 'login', phase: 'loading' }
const listeners = new Set<(state: EmbeddedLoginState | null) => void>()
const emit = (state: EmbeddedLoginState | null): void => {
  act(() => { for (const listener of listeners) listener(state) })
}
function MountedOverlay(): React.ReactNode {
  return <div className="studio"><EmbeddedLoginOverlay state={useEmbeddedLoginState()} /></div>
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}

beforeEach(() => {
  listeners.clear()
  vi.mocked(apiClient.getEmbeddedLogin).mockResolvedValue({ ok: true, value: null })
  vi.mocked(apiClient.subscribeEmbeddedLogin).mockImplementation((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  vi.mocked(apiClient.setEmbeddedLoginViewport).mockResolvedValue({ ok: true, value: { ok: true } })
  vi.mocked(apiClient.cancelEmbeddedLogin).mockResolvedValue({ ok: true, value: { ok: true } })
  vi.mocked(apiClient.retryEmbeddedLogin).mockResolvedValue({ ok: true, value: { ok: true } })
  vi.mocked(apiClient.backEmbeddedLogin).mockResolvedValue({ ok: true, value: { ok: true } })
  vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: false, code: 'unavailable', message: '不可用' })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('the embedded login card', () => {
  it('keeps a newer event when the initial snapshot arrives late', async () => {
    const query = deferred<ApiResult<EmbeddedLoginState | null>>()
    vi.mocked(apiClient.getEmbeddedLogin).mockReturnValue(query.promise)
    const view = render(<StrictMode><MountedOverlay /></StrictMode>)
    emit({ ...ATTEMPT, platform: 'huya', phase: 'ready' })
    expect(screen.getByRole('dialog', { name: '虎牙登录' })).toBeInTheDocument()
    await act(async () => { query.resolve({ ok: true, value: ATTEMPT }); await query.promise })
    expect(screen.getByRole('dialog', { name: '虎牙登录' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '斗鱼登录' })).toBeNull()
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('does not reopen a finished attempt when an old query returns', async () => {
    const query = deferred<ApiResult<EmbeddedLoginState | null>>()
    vi.mocked(apiClient.getEmbeddedLogin).mockReturnValue(query.promise)
    render(<MountedOverlay />)
    emit(ATTEMPT)
    emit(null)
    await act(async () => { query.resolve({ ok: true, value: ATTEMPT }); await query.promise })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cancels only the visible attempt and keeps the settings Escape untouched', async () => {
    const underlyingKey = vi.fn()
    window.addEventListener('keydown', underlyingKey)
    const view = render(<MountedOverlay />)
    emit(ATTEMPT)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(apiClient.cancelEmbeddedLogin).toHaveBeenCalledWith('attempt-a'))
    expect(underlyingKey).not.toHaveBeenCalled()
    emit(null)
    emit({ ...ATTEMPT, id: 'attempt-b', platform: 'bilibili' })
    fireEvent.click(screen.getByRole('button', { name: '关闭哔哩哔哩登录' }))
    await waitFor(() => expect(apiClient.cancelEmbeddedLogin).toHaveBeenLastCalledWith('attempt-b'))
    view.unmount()
    window.removeEventListener('keydown', underlyingKey)
    expect(apiClient.cancelEmbeddedLogin).toHaveBeenCalledTimes(2)
  })

  it('syncs the host rectangle on resize and hides the old native view on replacement and unmount', async () => {
    let bounds = { left: 100.2, top: 120.1, right: 859.9, bottom: 599.9, width: 759.7, height: 479.8 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ ...bounds, x: bounds.left, y: bounds.top, toJSON: () => ({}) }))
    const view = render(<MountedOverlay />)
    emit({ ...ATTEMPT, phase: 'ready' })
    expect(apiClient.setEmbeddedLoginViewport).toHaveBeenLastCalledWith({ id: 'attempt-a', visible: true,
      rect: { x: 101, y: 121, width: 758, height: 478 } })
    bounds = { left: 50, top: 80, right: 1050, bottom: 900, width: 1000, height: 820 }
    fireEvent.resize(window)
    await waitFor(() => expect(apiClient.setEmbeddedLoginViewport).toHaveBeenLastCalledWith({ id: 'attempt-a', visible: true,
      rect: { x: 50, y: 80, width: window.innerWidth - 50, height: window.innerHeight - 80 } }))
    emit({ ...ATTEMPT, id: 'attempt-b', platform: 'huya', phase: 'ready' })
    expect(apiClient.setEmbeddedLoginViewport).toHaveBeenCalledWith({ id: 'attempt-a', visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } })
    view.unmount()
    expect(apiClient.setEmbeddedLoginViewport).toHaveBeenLastCalledWith({ id: 'attempt-b', visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } })
  })

  it('shows loading placeholders without a local credential form and retries failures', async () => {
    render(<MountedOverlay />)
    emit(ATTEMPT)
    expect(screen.getByText('扫码登录')).toBeInTheDocument()
    expect(screen.getByText('短信 / 密码登录')).toBeInTheDocument()
    expect(document.querySelector('input, form, img, canvas')).toBeNull()
    emit({ ...ATTEMPT, phase: 'failed', message: '连接失败' })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(apiClient.retryEmbeddedLogin).toHaveBeenCalledWith('attempt-a'))
    expect(screen.getByText('连接失败')).toBeInTheDocument()
  })

  it('hides native content while the renderer document is hidden', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 80, right: 780, bottom: 560,
      x: 20, y: 80, width: 760, height: 480, toJSON: () => ({}) })
    render(<MountedOverlay />)
    emit({ ...ATTEMPT, phase: 'ready' })
    expect(apiClient.setEmbeddedLoginViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
    hidden.mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    expect(apiClient.setEmbeddedLoginViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    expect(apiClient.setEmbeddedLoginViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  })

  it('handles a failed cancel without losing the card', async () => {
    vi.mocked(apiClient.cancelEmbeddedLogin).mockRejectedValue(new Error('transport unavailable'))
    render(<MountedOverlay />)
    emit(ATTEMPT)
    fireEvent.click(screen.getByRole('button', { name: '关闭斗鱼登录' }))
    expect(await screen.findByText('暂时无法关闭, 请重试.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '斗鱼登录' })).toBeInTheDocument()
  })

  it('uses a plain website card for manual room pages', () => {
    render(<MountedOverlay />)
    emit({ ...ATTEMPT, purpose: 'website' })
    expect(screen.getByRole('dialog', { name: '斗鱼网页' })).toHaveClass('is-website')
    expect(screen.getByText('正在打开官方网页')).toBeInTheDocument()
    expect(screen.queryByText('扫码登录')).toBeNull()
  })

  it('keeps official verification inside the same card and returns without retrying login', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 80, right: 780, bottom: 560,
      x: 20, y: 80, width: 760, height: 480, toJSON: () => ({}) })
    vi.mocked(apiClient.getEmbeddedLogin).mockResolvedValue({ ok: true, value: { ...ATTEMPT, phase: 'challenge', presentation: 'official' } })
    render(<MountedOverlay />)
    expect(await screen.findByText('完成安全验证后将继续登录')).toBeInTheDocument()
    expect(apiClient.setEmbeddedLoginViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
    fireEvent.click(screen.getByRole('button', { name: '返回统一登录' }))
    await waitFor(() => expect(apiClient.backEmbeddedLogin).toHaveBeenCalledWith('attempt-a'))
    expect(apiClient.retryEmbeddedLogin).not.toHaveBeenCalled()
    expect(document.querySelector('input, form')).toBeNull()
  })

  it('shows a cropped captcha slot with a return action that never retries', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 80, right: 780, bottom: 560,
      x: 20, y: 80, width: 760, height: 480, toJSON: () => ({}) })
    render(<MountedOverlay />)
    emit({ ...ATTEMPT, phase: 'challenge', presentation: 'captcha', message: '请完成人机验证' })
    expect(screen.getByRole('heading', { name: '人机验证' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '斗鱼登录' })).toHaveClass('is-captcha')
    expect(screen.getAllByText('完成后返回登录')).toHaveLength(2)
    expect(apiClient.setEmbeddedLoginViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
    expect(screen.queryByRole('button', { name: '返回统一登录' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回登录' }))
    await waitFor(() => expect(apiClient.backEmbeddedLogin).toHaveBeenCalledWith('attempt-a'))
    expect(apiClient.retryEmbeddedLogin).not.toHaveBeenCalled()
    expect(document.querySelector('input, form')).toBeNull()
  })
})
