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
  vi.spyOn(apiClient, 'getDouyinSendState').mockResolvedValue({ ok: true, value: { loggedIn: false, canSend: false, loginState: 'signed-out', message: '未登录' } })
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
      vi.mocked(apiClient.getDouyinSendState).mockResolvedValue({ ok: true, value: { loggedIn: true, canSend: true, loginState: 'authenticated', message: '已登录' } })
      return { ok: true, value: { cookieCount: 3, authKeysPresent: ['sessionid'] } }
    })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '登录' })).toBeEnabled())
    expect(panel.getByText('未登录')).toBeInTheDocument()
    expect(panel.queryByRole('textbox')).toBeNull()
    expect(panel.getByText(/退出或重新登录会清除原有的弹幕发送授权/)).toBeInTheDocument()
    expect(panel.queryByText(/Chrome|关闭该窗口/)).toBeNull()
    fireEvent.click(panel.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(panel.getByText('已登录')).toBeInTheDocument())
    expect(login).toHaveBeenCalledExactlyOnceWith('douyin')
    await waitFor(() => expect(panel.getByText('已登录，可以发送弹幕')).toBeInTheDocument())
    expect(panel.queryByText(/正在检查能否发送弹幕/)).toBeNull()
    expect(apiClient.getDouyinSendState).toHaveBeenLastCalledWith(true)
    expect(panel.getByRole('button', { name: '重新登录' })).toBeEnabled()
  })

  it('shows the checking line only while the check runs, then what the check found', async () => {
    let finish!: (value: Awaited<ReturnType<typeof apiClient.getDouyinSendState>>) => void
    vi.spyOn(apiClient, 'login').mockImplementation(async () => {
      vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status({ loggedIn: true, cookieCount: 3, authKeysPresent: ['sessionid'] }) })
      vi.mocked(apiClient.getDouyinSendState).mockImplementation(() => new Promise(resolve => { finish = resolve }))
      return { ok: true, value: { cookieCount: 3, authKeysPresent: ['sessionid'], signingReady: true } }
    })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '登录' })).toBeEnabled())
    fireEvent.click(panel.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(panel.getByText('已登录，正在检查能否发送弹幕')).toBeInTheDocument())
    finish({ ok: true, value: { loggedIn: true, canSend: false, loginState: 'authenticated', message: '已登录' } })
    await waitFor(() => expect(panel.getByText('已登录，但暂时不能发送弹幕，请重新登录')).toBeInTheDocument())
    expect(panel.queryByText(/正在检查能否发送弹幕/)).toBeNull()
    expect(panel.getByText('已登录，暂不能发弹幕')).toBeInTheDocument()
  })

  it('drops the checking line when the check cannot confirm the login', async () => {
    vi.spyOn(apiClient, 'login').mockImplementation(async () => {
      vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status({ loggedIn: true, cookieCount: 3, authKeysPresent: ['sessionid'] }) })
      vi.mocked(apiClient.getDouyinSendState).mockResolvedValue({ ok: true, value: { loggedIn: false, canSend: false, loginState: 'unavailable', message: '暂时无法核对抖音账号状态，请检查网络并刷新后重试' } })
      return { ok: true, value: { cookieCount: 3, authKeysPresent: ['sessionid'], signingReady: true } }
    })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '登录' })).toBeEnabled())
    fireEvent.click(panel.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(panel.getByRole('alert')).toHaveTextContent('暂时无法核对抖音账号状态'))
    await waitFor(() => expect(panel.queryByText(/正在检查能否发送弹幕/)).toBeNull())
    expect(panel.queryByText(/可以发送弹幕/)).toBeNull()
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
    fireEvent.click(panel.getByRole('button', { name: '确认退出' }))
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
    vi.mocked(apiClient.getDouyinSendState).mockResolvedValue({ ok: true, value: { loggedIn: true, canSend: true, loginState: 'authenticated', message: '已登录' } })
    vi.spyOn(apiClient, 'logout').mockImplementation(async () => {
      vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: false, code: 'offline', message: '无法读取登录状态' })
      return { ok: true, value: { ok: true as const } }
    })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '退出' })).toBeEnabled())
    fireEvent.click(panel.getByRole('button', { name: '退出' }))
    fireEvent.click(panel.getByRole('button', { name: '确认退出' }))
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

  it('immediately refreshes the open Douyin and YouTube account pages after browser login import', async () => {
    const profileId = 'e'.repeat(32)
    const douyinCandidateId = 'd'.repeat(32)
    const youtubeCandidateId = 'y'.repeat(32)
    const profile = { id: profileId, browser: 'edge' as const, browserName: 'Microsoft Edge', name: '个人', isDefault: true }
    vi.spyOn(apiClient, 'listBrowserImportProfiles').mockResolvedValue({ ok: true, value: { supported: true, profiles: [profile] } })
    vi.spyOn(apiClient, 'listDouyuAccounts').mockResolvedValue({ ok: true, value: { accounts: [], activeAccountId: null, revision: 0 } })
    vi.spyOn(apiClient, 'cancelBrowserImport').mockResolvedValue({ ok: true, value: { cancelled: true } })
    vi.spyOn(apiClient, 'previewBrowserLogins').mockImplementation(async (args) => ({
      ok: true,
      value: {
        id: args.requestId,
        profile,
        expiresAt: Date.now() + 300_000,
        accounts: args.platforms.includes('douyin')
          ? [{ id: douyinCandidateId, platform: 'douyin', state: 'ready', username: '导入抖音号', avatar: 'data:image/png;base64,AQ==', cookieCount: 3 }]
          : [{ id: youtubeCandidateId, platform: 'youtube', state: 'ready', username: '导入 YouTube 号', avatar: 'data:image/png;base64,AQ==', cookieCount: 3 }],
      },
    }))
    let currentStatus = status()
    vi.mocked(apiClient.loginStatus).mockImplementation(async () => ({ ok: true, value: currentStatus }))
    vi.spyOn(apiClient, 'importBrowserLogins').mockImplementation(async (args) => {
      if (args.accountIds.includes(douyinCandidateId)) {
        currentStatus = {
          ...currentStatus,
          douyin: { ...loggedOut, loggedIn: true, cookieCount: 3, authKeysPresent: ['sessionid'], nickname: '导入抖音号', avatar: 'data:image/png;base64,AQ==' },
        }
        vi.mocked(apiClient.getDouyinSendState).mockResolvedValue({
          ok: true,
          value: { loggedIn: true, canSend: false, loginState: 'authenticated', message: '已登录' },
        })
        return { ok: true, value: { outcomes: [{ platform: 'douyin', imported: true, username: '导入抖音号', signingReady: false, message: '已导入账号，但暂时不能发送弹幕，请重新登录' }] } }
      }
      currentStatus = {
        ...currentStatus,
        youtube: { ...loggedOut, loggedIn: true, cookieCount: 3, authKeysPresent: ['SAPISID'], nickname: '导入 YouTube 号', avatar: 'data:image/png;base64,AQ==' },
      }
      return { ok: true, value: { outcomes: [{ platform: 'youtube', imported: true, username: '导入 YouTube 号', message: '已导入账号' }] } }
    })

    mount()
    const douyinPanel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(douyinPanel.getByText('未登录')).toBeInTheDocument())

    fireEvent.click(douyinPanel.getByRole('button', { name: '从浏览器导入' }))
    const douyinDialog = await screen.findByRole('dialog', { name: '从浏览器导入 抖音 账号' })
    await waitFor(() => expect(within(douyinDialog).getByRole('button', { name: '识别账号' })).toBeEnabled())
    fireEvent.click(within(douyinDialog).getByRole('button', { name: '识别账号' }))
    fireEvent.click(await within(douyinDialog).findByRole('button', { name: '导入账号' }))
    await within(douyinDialog).findByText(/已导入账号/)
    fireEvent.click(within(douyinDialog).getByRole('button', { name: '关闭' }))

    await waitFor(() => expect(douyinPanel.getByText('已登录，暂不能发弹幕')).toBeInTheDocument())
    expect(douyinPanel.getByText('导入抖音号')).toBeInTheDocument()
    expect(douyinPanel.getByRole('button', { name: '重新登录' })).toBeEnabled()
    expect(douyinPanel.getByRole('button', { name: '退出' })).toBeEnabled()

    fireEvent.click(screen.getByRole('tab', { name: 'YouTube' }))
    const youtubePanel = within(screen.getByRole('region', { name: 'YouTube' }))
    await waitFor(() => expect(youtubePanel.getByText('未登录')).toBeInTheDocument())

    fireEvent.click(youtubePanel.getByRole('button', { name: '从浏览器导入' }))
    const youtubeDialog = await screen.findByRole('dialog', { name: '从浏览器导入 YouTube 账号' })
    await waitFor(() => expect(within(youtubeDialog).getByRole('button', { name: '识别账号' })).toBeEnabled())
    fireEvent.click(within(youtubeDialog).getByRole('button', { name: '识别账号' }))
    fireEvent.click(await within(youtubeDialog).findByRole('button', { name: '导入账号' }))
    await within(youtubeDialog).findByText(/已导入账号/)
    fireEvent.click(within(youtubeDialog).getByRole('button', { name: '关闭' }))

    await waitFor(() => expect(youtubePanel.getByText('已登录')).toBeInTheDocument())
    expect(youtubePanel.getByText('导入 YouTube 号')).toBeInTheDocument()
    expect(youtubePanel.getByRole('button', { name: '重新登录' })).toBeEnabled()
    expect(youtubePanel.getByRole('button', { name: '退出' })).toBeEnabled()
  })
})
