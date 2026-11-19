import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { BrowserImportOutcome, BrowserImportPreview } from '../../../electron/browserImportContracts'
import { BrowserImportButton, BrowserLoginImportProvider } from './BrowserLoginImport'

vi.mock('../../app/apiClient', () => ({ apiClient: {
  listBrowserImportProfiles: vi.fn(), listDouyuAccounts: vi.fn(), previewBrowserLogins: vi.fn(),
  importBrowserLogins: vi.fn(), cancelBrowserImport: vi.fn(), loginStatus: vi.fn(),
} }))

const profile = { id: 'e'.repeat(32), browser: 'edge' as const, browserName: 'Microsoft Edge', name: '个人', isDefault: true }
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
  vi.mocked(apiClient.cancelBrowserImport).mockResolvedValue({ ok: true, value: { cancelled: true } })
  vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: false, code: 'fixture', message: '测试状态' })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

async function begin(): Promise<HTMLElement> {
  render(<BrowserLoginImportProvider><BrowserImportButton batch /></BrowserLoginImportProvider>)
  fireEvent.click(screen.getByRole('button', { name: '批量导入登录态' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '识别登录态' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '识别登录态' }))
  const button = await screen.findByRole('button', { name: '导入所选登录态 (2)' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  await screen.findByText('正在导入所选登录态...')
  return screen.getByRole('dialog', { name: '批量导入登录态' })
}

describe('browser import cancellation results', () => {
  it.each(['取消', '关闭', 'Escape', 'native-cancel'])('keeps the dialog and partial results after %s during import', async trigger => {
    const dialog = await begin()
    if (trigger === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' })
    else if (trigger === 'native-cancel') expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(false)
    else fireEvent.click(within(dialog).getByRole('button', { name: trigger }))
    await waitFor(() => expect(apiClient.cancelBrowserImport).toHaveBeenCalledWith(previewId))
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('正在停止剩余项，已导入项会保留在结果中。')).toBeInTheDocument()
    await act(async () => finish({ ok: true, value: { outcomes: [
      { platform: 'douyu', imported: true, message: '登录态已导入.' },
      { platform: 'youtube', imported: false, message: '已取消，未导入。' },
    ] } }))
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('登录态已导入.', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('已取消，未导入。', { exact: false })).toBeInTheDocument()
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
    await act(async () => finish({ ok: true, value: { outcomes: accounts.map(account => ({ platform: account.platform, imported: false, message: '已取消，未导入。' })) } }))
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })
})
