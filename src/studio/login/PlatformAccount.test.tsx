import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../app/apiClient'
import type { ApiResult } from '../../app/apiClient'
import type { LoginResult, LoginStatus, PlatformLoginStatus } from '../../../electron/login'
import { forgetAll, remembered } from '../../app/remembered'
import { PlatformAccount } from './PlatformAccount'

vi.mock('../../app/apiClient', () => ({ apiClient: {
  login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn(), subscribeEmbeddedLogin: vi.fn(() => () => {}),
} }))

const anonymous: PlatformLoginStatus = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
const signedIn: PlatformLoginStatus = { ...anonymous, loggedIn: true, cookieCount: 2 }
let status: LoginStatus

beforeEach(() => {
  forgetAll()
  status = { douyu: anonymous, youtube: anonymous, douyin: anonymous, bilibili: anonymous, huya: anonymous }
  vi.mocked(apiClient.loginStatus).mockImplementation(async () => ({ ok: true, value: status }))
  vi.mocked(apiClient.login).mockImplementation(async (platform) => {
    status = { ...status, [platform]: signedIn }
    return { ok: true, value: { cookieCount: 2, authKeysPresent: [] } }
  })
  vi.mocked(apiClient.logout).mockImplementation(async (platform) => {
    status = { ...status, [platform]: anonymous }
    return { ok: true, value: { ok: true } }
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('single-platform account settings', () => {
  it.each(['bilibili', 'huya'] as const)('logs into %s and offers relogin and logout after completion', async (platform) => {
    render(<PlatformAccount platform={platform} />)
    expect(await screen.findByText('未登录')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(apiClient.login).toHaveBeenCalledWith(platform))
    expect(await screen.findByRole('button', { name: '重新登录' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    await waitFor(() => expect(apiClient.logout).toHaveBeenCalledWith(platform))
    expect(await screen.findByText('未登录')).toBeInTheDocument()
  })

  it('refreshes remembered status when the settings page closed during sign-in', async () => {
    let finish!: (result: ApiResult<LoginResult>) => void
    const login = new Promise<ApiResult<LoginResult>>((done) => { finish = done })
    vi.mocked(apiClient.login).mockReturnValue(login)
    const view = render(<PlatformAccount platform="bilibili" />)
    await screen.findByText('未登录')
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    view.unmount()
    status = { ...status, bilibili: signedIn }
    await act(async () => { finish({ ok: true, value: { cookieCount: 2, authKeysPresent: [] } }); await login })
    await waitFor(() => expect(remembered<LoginStatus>('login-status')?.bilibili.loggedIn).toBe(true))
    render(<PlatformAccount platform="bilibili" />)
    expect(screen.getByText('已登录')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新登录' })).toBeInTheDocument()
  })

  it('recovers the controls after a rejected login promise', async () => {
    vi.mocked(apiClient.login).mockRejectedValue(new Error('transport failure'))
    render(<PlatformAccount platform="huya" />)
    await screen.findByText('未登录')
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('账号操作暂时失败, 请重试.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled()
  })
})
