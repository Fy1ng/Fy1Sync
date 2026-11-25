import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../app/apiClient'
import type { ApiResult } from '../../app/apiClient'
import type { LoginResult, LoginStatus, PlatformLoginStatus } from '../../../electron/login'
import { forgetAll, remembered } from '../../app/remembered'
import { BrowserLoginImportProvider } from './BrowserLoginImport'
import { refreshLoginStatus } from './status'
import { PlatformAccount } from './PlatformAccount'

vi.mock('../../app/apiClient', () => ({ apiClient: {
  login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn(), subscribeEmbeddedLogin: vi.fn(() => () => {}),
  listBrowserImportProfiles: vi.fn(), listDouyuAccounts: vi.fn(), previewBrowserLogins: vi.fn(),
  importBrowserLogins: vi.fn(), cancelBrowserImport: vi.fn(), closeImportBrowser: vi.fn(),
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
  it.each(['bilibili', 'huya'] as const)('does not mistake a failed %s read for logged out and allows retry', async (platform) => {
    vi.mocked(apiClient.loginStatus).mockResolvedValueOnce({ ok: false, code: 'unavailable', message: '账号读取失败' })
    render(<PlatformAccount platform={platform} />)
    expect(screen.getByText('正在检查登录状态')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('账号读取失败')
    expect(screen.getByText('登录状态读取失败')).toBeInTheDocument()
    expect(screen.queryByText('正在检查登录状态')).toBeNull()
    expect(screen.queryByText('未登录')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('未登录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(apiClient.loginStatus).toHaveBeenCalledTimes(2)
  })

  it('recovers from a rejected status read without displaying stale login status as current', async () => {
    const view = render(<PlatformAccount platform="bilibili" />)
    await screen.findByText('未登录')
    view.unmount()
    vi.mocked(apiClient.loginStatus).mockRejectedValueOnce(new Error('read failed'))
    render(<PlatformAccount platform="bilibili" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取')
    expect(screen.getByText('登录状态读取失败')).toBeInTheDocument()
    expect(screen.queryByText('未登录')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('未登录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers retry when the status response does not contain the requested platform', async () => {
    vi.mocked(apiClient.loginStatus).mockResolvedValueOnce({ ok: true, value: { douyu: anonymous, youtube: anonymous } as LoginStatus })
    render(<PlatformAccount platform="huya" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('账号状态读取失败')
    expect(screen.queryByText('未登录')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('未登录')).toBeInTheDocument()
  })

  it('does not turn a successful post-login refresh into a read error when the initial read finishes late', async () => {
    let finish!: (value: ApiResult<LoginStatus>) => void
    const initial = new Promise<ApiResult<LoginStatus>>(resolve => { finish = resolve })
    vi.mocked(apiClient.loginStatus).mockReturnValueOnce(initial)
    render(<PlatformAccount platform="bilibili" />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('已登录')).toBeInTheDocument()
    await act(async () => { finish({ ok: true, value: { ...status, bilibili: anonymous } }); await initial })
    expect(screen.getByText('已登录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('登录状态读取失败')).toBeNull()
  })

  it.each(['bilibili', 'huya'] as const)('logs into %s and offers relogin and logout after completion', async (platform) => {
    render(<PlatformAccount platform={platform} />)
    expect(await screen.findByText('未登录')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(apiClient.login).toHaveBeenCalledWith(platform))
    expect(await screen.findByRole('button', { name: '重新登录' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }))
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
    expect(await screen.findByText('账号操作暂时失败，请重试')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled()
  })

  it.each([
    ['bilibili', '哔哩哔哩', '测试哔哩哔哩账号'],
    ['huya', '虎牙', '测试虎牙账号'],
  ] as const)('immediately refreshes the open %s page after browser login import without re-entering', async (platform, name, nickname) => {
    const profileId = 'e'.repeat(32)
    const accountId = 'a'.repeat(32)
    vi.mocked(apiClient.listBrowserImportProfiles).mockResolvedValue({
      ok: true,
      value: { supported: true, profiles: [{ id: profileId, browser: 'edge', browserName: 'Microsoft Edge', name: '个人', isDefault: true }] },
    })
    vi.mocked(apiClient.listDouyuAccounts).mockResolvedValue({ ok: true, value: { accounts: [], activeAccountId: null, revision: 0 } })
    vi.mocked(apiClient.previewBrowserLogins).mockImplementation(async (args) => ({
      ok: true,
      value: {
        id: args.requestId,
        profile: { id: profileId, browser: 'edge', browserName: 'Microsoft Edge', name: '个人', isDefault: true },
        expiresAt: Date.now() + 300_000,
        accounts: [{ id: accountId, platform, state: 'ready', username: nickname, avatar: 'data:image/png;base64,AQ==', cookieCount: 3 }],
      },
    }))
    vi.mocked(apiClient.importBrowserLogins).mockImplementation(async () => {
      status = { ...status, [platform]: { ...signedIn, nickname, avatar: 'data:image/png;base64,AQ==' } }
      return { ok: true, value: { outcomes: [{ platform, imported: true, username: nickname, message: '已导入账号' }] } }
    })
    vi.mocked(apiClient.cancelBrowserImport).mockResolvedValue({ ok: true, value: { cancelled: true } })

    render(<BrowserLoginImportProvider><PlatformAccount platform={platform} /></BrowserLoginImportProvider>)
    expect(await screen.findByText('未登录')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '从浏览器导入' }))
    const dialog = await screen.findByRole('dialog', { name: `从浏览器导入 ${name} 账号` })
    await waitFor(() => expect(screen.getByRole('button', { name: '识别账号' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '识别账号' }))
    const applyButton = await screen.findByRole('button', { name: '导入账号' })
    await waitFor(() => expect(applyButton).toBeEnabled())
    fireEvent.click(applyButton)

    await screen.findByText('已导入账号', { exact: false })
    fireEvent.click(dialog.querySelector('button[aria-label="关闭"]')!)

    expect(screen.getByText('已登录')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(nickname))).toBeInTheDocument()
    expect(screen.getByRole('img', { name: `${nickname}的头像` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新登录' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出' })).toBeInTheDocument()
  })

  it('does not show a false read error when another login status refresh overlaps post-login refresh', async () => {
    let finishFirst!: (value: ApiResult<LoginStatus>) => void
    let finishSecond!: (value: ApiResult<LoginStatus>) => void
    render(<PlatformAccount platform="bilibili" />)
    expect(await screen.findByText('未登录')).toBeInTheDocument()

    vi.mocked(apiClient.login).mockImplementationOnce(async () => {
      status = { ...status, bilibili: { ...signedIn, nickname: '内嵌登录用户' } }
      vi.mocked(apiClient.loginStatus)
        .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
        .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve }))
      return { ok: true, value: { cookieCount: 2, authKeysPresent: ['SESSDATA'] } }
    })

    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(finishFirst).toBeTypeOf('function'))
    const overlapping = refreshLoginStatus()
    await act(async () => {
      finishSecond({ ok: true, value: status })
      finishFirst({ ok: true, value: status })
      await overlapping
    })

    expect(screen.getByText('已登录')).toBeInTheDocument()
    expect(screen.getByText(/内嵌登录用户/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('登录状态读取失败')).toBeNull()
  })
})
