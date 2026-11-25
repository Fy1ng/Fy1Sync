import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient, type ApiResult } from '../../app/apiClient'
import { forgetAll } from '../../app/remembered'
import type { LoginStatus } from '../../../electron/cookies'
import type { BrowserImportOutcome, BrowserImportPreview } from '../../../electron/browserImportContracts'
import { BrowserImportButton, BrowserLoginImportProvider } from './BrowserLoginImport'

vi.mock('../../app/apiClient', () => ({ apiClient: {
  listBrowserImportProfiles: vi.fn(), listDouyuAccounts: vi.fn(), previewBrowserLogins: vi.fn(), previewManualCookies: vi.fn(),
  closeImportBrowser: vi.fn(), importBrowserLogins: vi.fn(), cancelBrowserImport: vi.fn(), loginStatus: vi.fn(),
} }))

const profile = { id: 'e'.repeat(32), browser: 'edge' as const, browserName: 'Microsoft Edge', name: '个人', isDefault: true }
const chromeProfile = { id: 'c'.repeat(32), browser: 'chrome' as const, browserName: 'Google Chrome', name: '工作', isDefault: true }
const accounts: BrowserImportPreview['accounts'] = [
  { id: 'd'.repeat(32), platform: 'douyu', state: 'ready', username: '测试斗鱼账号', cookieCount: 2 },
  { id: 'y'.repeat(32), platform: 'youtube', state: 'ready', username: '测试 YouTube 账号', cookieCount: 2 },
]
let finish!: (value: ApiResult<{ outcomes: BrowserImportOutcome[] }>) => void
let previewId: string

beforeEach(() => {
  vi.mocked(apiClient.listBrowserImportProfiles).mockResolvedValue({ ok: true, value: { supported: true, profiles: [profile] } })
  vi.mocked(apiClient.listDouyuAccounts).mockResolvedValue({ ok: true, value: { accounts: [], activeAccountId: null, revision: 0 } })
  vi.mocked(apiClient.previewBrowserLogins).mockImplementation(async args => {
    previewId = args.requestId
    return { ok: true, value: { id: previewId, profile, expiresAt: Date.now() + 300000, accounts } }
  })
  vi.mocked(apiClient.importBrowserLogins).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.mocked(apiClient.closeImportBrowser).mockResolvedValue({ ok: true, value: { status: 'closed', browserName: 'Microsoft Edge' } })
  vi.mocked(apiClient.cancelBrowserImport).mockResolvedValue({ ok: true, value: { cancelled: true } })
  vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: false, code: 'fixture', message: '测试状态' })
})
afterEach(() => { cleanup(); forgetAll(); vi.clearAllMocks() })

async function begin(): Promise<HTMLElement> {
  render(<BrowserLoginImportProvider><BrowserImportButton batch /></BrowserLoginImportProvider>)
  fireEvent.click(screen.getByRole('button', { name: '批量导入账号' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '识别账号' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '识别账号' }))
  const button = await screen.findByRole('button', { name: '导入所选账号（2）' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  await screen.findByText('正在导入所选账号…')
  return screen.getByRole('dialog', { name: '批量导入账号' })
}

describe('browser import cancellation results', () => {
  it.each(['douyu', 'bilibili', 'huya', 'douyin', 'youtube'] as const)('verifies and confirms a pasted Cookie for %s', async platform => {
    vi.mocked(apiClient.previewManualCookies).mockImplementation(async args => ({ ok: true, value: {
      id: args.requestId, profile, expiresAt: Date.now() + 300000,
      accounts: [{ id: 'd'.repeat(32), platform, state: 'ready', username: '手动账号', cookieCount: 2 }],
    } }))
    vi.mocked(apiClient.importBrowserLogins).mockResolvedValue({ ok: true, value: { outcomes: [{ platform, imported: true, message: '已导入账号' }] } })
    render(<BrowserLoginImportProvider><BrowserImportButton platform={platform} /></BrowserLoginImportProvider>)
    fireEvent.click(screen.getByRole('button', { name: '导入 Cookie' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Cookie 文本' }), { target: { value: 'Cookie: secret=value' } })
    fireEvent.click(screen.getByRole('button', { name: '验证账号' }))
    await screen.findByText('手动账号')
    expect(apiClient.previewManualCookies).toHaveBeenCalledWith(expect.objectContaining({ platform, text: 'Cookie: secret=value' }))
    expect(apiClient.listBrowserImportProfiles).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    await screen.findByText('已导入账号', { exact: false })
    expect(apiClient.loginStatus).toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Cookie 文本' })).toBeNull()
  })
  it('loads a selected cookie file and keeps errors retryable', async () => {
    vi.mocked(apiClient.previewManualCookies).mockResolvedValue({ ok: false, code: 'manual-cookie-invalid', message: 'Cookie 格式无效' })
    render(<BrowserLoginImportProvider><BrowserImportButton platform="bilibili" /></BrowserLoginImportProvider>)
    fireEvent.click(screen.getByRole('button', { name: '导入 Cookie' }))
    const file = new File(['file-cookie'], 'cookies.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: async () => 'file-cookie' })
    fireEvent.change(screen.getByLabelText('选择 Cookie 文件'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Cookie 文本' })).toHaveValue('file-cookie'))
    fireEvent.click(screen.getByRole('button', { name: '验证账号' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cookie 格式无效')
    expect(screen.getByRole('button', { name: '验证账号' })).toBeEnabled()
  })
  it.each(['取消', '关闭', 'Escape', 'native-cancel'])('keeps the dialog and partial results after %s during import', async trigger => {
    const dialog = await begin()
    if (trigger === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' })
    else if (trigger === 'native-cancel') expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(false)
    else fireEvent.click(within(dialog).getByRole('button', { name: trigger }))
    await waitFor(() => expect(apiClient.cancelBrowserImport).toHaveBeenCalledWith(previewId))
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('正在停止剩余导入，已导入的账号会保留')).toBeInTheDocument()
    await act(async () => finish({ ok: true, value: { outcomes: [
      { platform: 'douyu', imported: true, message: '登录态已导入.' },
      { platform: 'youtube', imported: false, message: '已取消，未导入' },
    ] } }))
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('登录态已导入.', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('已取消，未导入', { exact: false })).toBeInTheDocument()
    expect(dialog.querySelector('.browser-import-footer')).toBeNull()
    expect(within(dialog).getAllByRole('button', { name: '关闭' })).toHaveLength(1)
    expect(within(dialog).queryByRole('button', { name: '完成' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('retains the dialog and allows retrying a failed stop request', async () => {
    vi.mocked(apiClient.cancelBrowserImport).mockResolvedValueOnce({ ok: false, code: 'fixture', message: '停止请求失败' })
    const dialog = await begin()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('停止请求失败')
    const cancel = within(dialog).getByRole('button', { name: '取消' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    await waitFor(() => expect(apiClient.cancelBrowserImport).toHaveBeenCalledTimes(2))
    await act(async () => finish({ ok: true, value: { outcomes: accounts.map(account => ({ platform: account.platform, imported: false, message: '已取消，未导入' })) } }))
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })
})

describe('browser close confirmation in import dialog', () => {
  it('requires secondary confirmation, supports cancel/Escape/browser switch, and closes the selected browser', async () => {
    vi.mocked(apiClient.listBrowserImportProfiles).mockResolvedValue({
      ok: true,
      value: { supported: true, profiles: [profile, chromeProfile] },
    })
    vi.mocked(apiClient.previewBrowserLogins).mockResolvedValueOnce({
      ok: false,
      code: 'browser-import-browser-in-use',
      message: '此浏览器用户正在使用中。请先保存浏览内容，完全退出浏览器后重试。',
    })
    render(<BrowserLoginImportProvider><BrowserImportButton batch /></BrowserLoginImportProvider>)
    fireEvent.click(screen.getByRole('button', { name: '批量导入账号' }))
    const dialog = await screen.findByRole('dialog', { name: '批量导入账号' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '识别账号' })).toBeEnabled())

    fireEvent.click(within(dialog).getByRole('button', { name: '识别账号' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('正在使用中')

    const closeTrigger = within(dialog).getByRole('button', { name: '关闭浏览器' })
    expect(closeTrigger).toHaveClass('is-danger')
    fireEvent.click(closeTrigger)
    expect(apiClient.closeImportBrowser).not.toHaveBeenCalled()

    const confirmBox = within(dialog).getByRole('alertdialog', { name: '确认关闭 Microsoft Edge' })
    expect(confirmBox).toHaveTextContent('Microsoft Edge')
    expect(within(confirmBox).getByRole('button', { name: '暂不关闭' })).toHaveFocus()

    // Escape dismisses only the secondary confirmation without closing the import dialog.
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(dialog).toBeInTheDocument()
    expect(closeTrigger).toHaveFocus()

    // Cancelling via button also aborts without invoking closeImportBrowser.
    fireEvent.click(closeTrigger)
    fireEvent.click(within(dialog).getByRole('button', { name: '暂不关闭' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(apiClient.closeImportBrowser).not.toHaveBeenCalled()

    // Switching browser dismisses the confirmation so the previous browser cannot be closed by mistake.
    fireEvent.click(closeTrigger)
    fireEvent.change(within(dialog).getByLabelText('浏览器'), { target: { value: 'Google Chrome' } })
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()

    // Confirming closes the newly selected Chrome profile and shows status.
    vi.mocked(apiClient.closeImportBrowser).mockResolvedValueOnce({
      ok: true,
      value: { status: 'closed', browserName: 'Google Chrome' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭浏览器' }))
    const chromeConfirm = within(dialog).getByRole('alertdialog', { name: '确认关闭 Google Chrome' })
    fireEvent.click(within(chromeConfirm).getByRole('button', { name: '确认关闭' }))
    await waitFor(() => expect(apiClient.closeImportBrowser).toHaveBeenCalledWith({
      requestId: expect.any(String),
      profileId: chromeProfile.id,
    }))
    expect(await within(dialog).findByText('已关闭 Google Chrome，现在可以点击「识别账号」继续')).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('reports not-running status and close failures cleanly', async () => {
    vi.mocked(apiClient.closeImportBrowser)
      .mockResolvedValueOnce({ ok: true, value: { status: 'not-running', browserName: 'Microsoft Edge' } })
      .mockResolvedValueOnce({ ok: false, code: 'browser-import-close-failed', message: '未能完全关闭对应浏览器，请先保存浏览内容，手动完全退出浏览器后重试。' })
    render(<BrowserLoginImportProvider><BrowserImportButton batch /></BrowserLoginImportProvider>)
    fireEvent.click(screen.getByRole('button', { name: '批量导入账号' }))
    const dialog = await screen.findByRole('dialog', { name: '批量导入账号' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '关闭浏览器' })).toBeEnabled())

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭浏览器' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '确认关闭' }))
    expect(await within(dialog).findByText('Microsoft Edge 当前未运行，可直接点击「识别账号」')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭浏览器' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '确认关闭' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('未能完全关闭对应浏览器')
  })
})

describe('official YouTube login protection in browser import', () => {
  const signedOut = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
  const makeStatus = (youtube: Partial<LoginStatus['youtube']>): LoginStatus => ({
    youtube: { ...signedOut, ...youtube },
    twitch: signedOut,
    douyu: signedOut,
    bilibili: signedOut,
    huya: signedOut,
    douyin: signedOut,
  })

  it('leaves YouTube unchecked by default when an official login exists and requires secondary confirmation on check', async () => {
    vi.mocked(apiClient.loginStatus).mockResolvedValue({
      ok: true,
      value: makeStatus({ loggedIn: true, loginSource: 'official', cookieCount: 4, authKeysPresent: ['LOGIN_INFO', 'SAPISID'] }),
    })
    render(<BrowserLoginImportProvider><BrowserImportButton batch /></BrowserLoginImportProvider>)
    fireEvent.click(screen.getByRole('button', { name: '批量导入账号' }))
    const dialog = await screen.findByRole('dialog', { name: '批量导入账号' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '识别账号' })).toBeEnabled())

    fireEvent.click(within(dialog).getByRole('button', { name: '识别账号' }))
    const douyuBox = await within(dialog).findByRole('checkbox', { name: '导入斗鱼' })
    const youtubeBox = within(dialog).getByRole('checkbox', { name: '导入YouTube' })
    expect(douyuBox).toBeChecked()
    expect(youtubeBox).not.toBeChecked()
    expect(within(dialog).getByText('已有官方登录态，不建议使用浏览器导入')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '导入所选账号（1）' })).toBeEnabled()

    // Clicking YouTube opens secondary confirmation without checking it yet.
    fireEvent.click(youtubeBox)
    expect(youtubeBox).not.toBeChecked()
    const confirmBox = within(dialog).getByRole('alertdialog', { name: '确认勾选 YouTube 浏览器导入' })
    expect(confirmBox).toHaveTextContent('检测到已有官方登录态，不建议使用浏览器导入')
    expect(within(confirmBox).getByRole('button', { name: '暂不勾选' })).toHaveFocus()

    // Escape dismisses only the secondary confirmation and keeps YouTube unchecked.
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(dialog).toBeInTheDocument()
    expect(youtubeBox).not.toBeChecked()
    expect(youtubeBox).toHaveFocus()

    // Clicking cancel button also keeps YouTube unchecked.
    fireEvent.click(youtubeBox)
    fireEvent.click(within(dialog).getByRole('button', { name: '暂不勾选' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(youtubeBox).not.toBeChecked()

    // Confirming checks YouTube and updates the selected count.
    fireEvent.click(youtubeBox)
    fireEvent.click(within(dialog).getByRole('button', { name: '确认勾选' }))
    expect(within(dialog).queryByRole('alertdialog')).toBeNull()
    expect(youtubeBox).toBeChecked()
    expect(within(dialog).getByRole('button', { name: '导入所选账号（2）' })).toBeEnabled()
  })

  it('protects single-platform YouTube import when official login is active, while keeping browser-import sessions checked by default', async () => {
    vi.mocked(apiClient.previewBrowserLogins).mockImplementation(async args => ({
      ok: true,
      value: { id: args.requestId, profile, expiresAt: Date.now() + 300000, accounts: [accounts[1]!] },
    }))
    vi.mocked(apiClient.loginStatus).mockResolvedValueOnce({
      ok: true,
      value: makeStatus({ loggedIn: true, loginSource: 'official', cookieCount: 4, authKeysPresent: ['LOGIN_INFO', 'SAPISID'] }),
    }).mockResolvedValueOnce({
      ok: true,
      value: makeStatus({ loggedIn: true, loginSource: 'official', cookieCount: 4, authKeysPresent: ['LOGIN_INFO', 'SAPISID'] }),
    })

    const { unmount } = render(<BrowserLoginImportProvider><BrowserImportButton platform="youtube" /></BrowserLoginImportProvider>)
    fireEvent.click(screen.getByRole('button', { name: '从浏览器导入' }))
    const dialog = await screen.findByRole('dialog', { name: '从浏览器导入 YouTube 账号' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '识别账号' })).toBeEnabled())
    fireEvent.click(within(dialog).getByRole('button', { name: '识别账号' }))

    const youtubeBox = await within(dialog).findByRole('checkbox', { name: '导入YouTube' })
    const importButton = within(dialog).getByRole('button', { name: '导入账号' })
    expect(youtubeBox).not.toBeChecked()
    expect(importButton).toBeDisabled()

    fireEvent.click(youtubeBox)
    fireEvent.click(within(dialog).getByRole('button', { name: '确认勾选' }))
    expect(youtubeBox).toBeChecked()
    expect(importButton).toBeEnabled()
    unmount()
    forgetAll()

    // When existing YouTube login came from browser-import, default selection stays checked without confirmation.
    vi.mocked(apiClient.loginStatus).mockResolvedValue({
      ok: true,
      value: makeStatus({ loggedIn: true, loginSource: 'browser-import', cookieCount: 4, authKeysPresent: ['LOGIN_INFO', 'SAPISID'] }),
    })
    render(<BrowserLoginImportProvider><BrowserImportButton platform="youtube" /></BrowserLoginImportProvider>)
    fireEvent.click(screen.getByRole('button', { name: '从浏览器导入' }))
    const secondDialog = await screen.findByRole('dialog', { name: '从浏览器导入 YouTube 账号' })
    await waitFor(() => expect(within(secondDialog).getByRole('button', { name: '识别账号' })).toBeEnabled())
    fireEvent.click(within(secondDialog).getByRole('button', { name: '识别账号' }))
    expect(await within(secondDialog).findByRole('checkbox', { name: '导入YouTube' })).toBeChecked()
    expect(within(secondDialog).queryByRole('alertdialog')).toBeNull()
  })
})
