import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { LoginStatus, PlatformLoginStatus } from '../../electron/login'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { SettingsSheet } from './SettingsSheet'

const sessions: Session[] = []
const loggedOut: PlatformLoginStatus = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
function status(douyin: Partial<PlatformLoginStatus> = {}): LoginStatus {
  return { youtube: loggedOut, douyu: loggedOut, bilibili: loggedOut, huya: loggedOut, douyin: { ...loggedOut, ...douyin } }
}
function mount(): void {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  render(<SessionProvider session={session}>
    <SettingsSheet target={{ section: 'accounts', account: 'douyin' }} room={null} onClose={() => {}} onWatch={() => {}} onFill={() => {}} />
  </SessionProvider>)
  fireEvent.click(screen.getByRole('tab', { name: '抖音' }))
}
beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async () => ({ ok: true, value: { presets: [] } })) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
  vi.spyOn(apiClient, 'loginStatus').mockResolvedValue({ ok: true, value: status() })
})
afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Douyin current account settings', () => {
  it('does not treat anonymous cookies as authentication and uses the official in-app login flow', async () => {
    vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status({ cookieCount: 2 }) })
    const login = vi.spyOn(apiClient, 'login').mockImplementation(async () => {
      vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status({ loggedIn: true, cookieCount: 3, authKeysPresent: ['sessionid'] }) })
      return { ok: true, value: { cookieCount: 3, authKeysPresent: ['sessionid'] } }
    })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '登录' })).toBeEnabled())
    expect(panel.getByText('未登录')).toBeInTheDocument()
    expect(panel.queryByRole('textbox')).toBeNull()
    expect(panel.getByText(/扫码, 短信, 密码与验证码由隔离的抖音官方登录组件处理/)).toBeInTheDocument()
    expect(panel.queryByText(/Chrome|关闭该窗口/)).toBeNull()
    fireEvent.click(panel.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(panel.getByText('已登录')).toBeInTheDocument())
    expect(login).toHaveBeenCalledExactlyOnceWith('douyin')
    expect(panel.getByText(/请重新加载直播或重连弹幕以更新会话/)).toBeInTheDocument()
    expect(panel.getByRole('button', { name: '重新登录' })).toBeEnabled()
  })

  it('allows expired sessions to log in again and clears the current account on logout', async () => {
    vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status({ cookieCount: 1, authKeysPresent: ['sessionid'], expiresAt: 1 }) })
    const logout = vi.spyOn(apiClient, 'logout').mockImplementation(async () => {
      vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status() })
      return { ok: true, value: { ok: true as const } }
    })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '重新登录' })).toBeEnabled())
    expect(panel.getByText('未登录')).toBeInTheDocument()
    fireEvent.click(panel.getByRole('button', { name: '退出' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '登录' })).toBeEnabled())
    expect(logout).toHaveBeenCalledExactlyOnceWith('douyin')
    expect(panel.queryByRole('button', { name: '退出' })).toBeNull()
    expect(panel.getByRole('status')).toHaveTextContent('已退出抖音')
  })

  it('shows login failure without reporting a successful login or losing retry access', async () => {
    vi.spyOn(apiClient, 'login').mockResolvedValue({ ok: false, code: 'login-failed', message: '未完成官方登录, 请重试' })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '登录' })).toBeEnabled())
    fireEvent.click(panel.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(panel.getByRole('alert')).toHaveTextContent('未完成官方登录'))
    expect(panel.queryByText('已登录')).toBeNull()
    expect(panel.getByRole('button', { name: '登录' })).toBeEnabled()
  })

  it('does not keep showing a logged-in account after logout if the status refresh fails', async () => {
    vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status({ loggedIn: true, cookieCount: 1, authKeysPresent: ['sessionid'] }) })
    vi.spyOn(apiClient, 'logout').mockImplementation(async () => {
      vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: false, code: 'offline', message: '无法读取登录状态' })
      return { ok: true, value: { ok: true as const } }
    })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '退出' })).toBeEnabled())
    fireEvent.click(panel.getByRole('button', { name: '退出' }))
    await waitFor(() => expect(panel.getByRole('alert')).toHaveTextContent('无法读取登录状态'))
    expect(panel.getByText('未登录')).toBeInTheDocument()
    expect(panel.queryByText('已登录')).toBeNull()
  })

  it('recovers from a login-status read failure through the retry control', async () => {
    vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: false, code: 'offline', message: '无法读取登录状态' })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('alert')).toHaveTextContent('无法读取登录状态'))
    vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status() })
    fireEvent.click(panel.getByRole('button', { name: '重新检查登录状态' }))
    await waitFor(() => expect(panel.queryByRole('alert')).toBeNull())
    expect(panel.getByRole('button', { name: '登录' })).toBeEnabled()
  })
})
