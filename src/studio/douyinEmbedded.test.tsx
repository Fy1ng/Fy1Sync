import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbeddedLoginState } from '../../electron/embeddedLoginContracts'
import type { LoginStatus } from '../../electron/login'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { ApiResult } from '../app/apiClient'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { Studio } from './Studio'

const sessions: Session[] = []
const listeners = new Set<(state: EmbeddedLoginState | null) => void>()
const attempt: EmbeddedLoginState = { id: 'douyin-attempt', platform: 'douyin', purpose: 'login', phase: 'ready', presentation: 'form' }
const loggedOut = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
const status = (loggedIn: boolean): LoginStatus => ({ youtube: loggedOut, douyu: loggedOut,
  douyin: { ...loggedOut, loggedIn, cookieCount: loggedIn ? 1 : 0, authKeysPresent: loggedIn ? ['sessionid'] : [] } })

function emit(value: EmbeddedLoginState | null): void {
  for (const listener of listeners) listener(value)
}
function mount(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  render(<SessionProvider session={session}><Studio /></SessionProvider>)
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  fireEvent.click(screen.getByRole('tab', { name: '抖音' }))
  return session
}

beforeEach(() => {
  listeners.clear()
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
  vi.spyOn(apiClient, 'loginStatus').mockResolvedValue({ ok: true, value: status(false) })
  vi.spyOn(apiClient, 'getEmbeddedLogin').mockResolvedValue({ ok: true, value: null })
  vi.spyOn(apiClient, 'subscribeEmbeddedLogin').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(apiClient, 'setEmbeddedLoginViewport').mockResolvedValue({ ok: true, value: { ok: true } })
  vi.spyOn(apiClient, 'cancelEmbeddedLogin').mockResolvedValue({ ok: true, value: { ok: true } })
  vi.spyOn(apiClient, 'retryEmbeddedLogin').mockResolvedValue({ ok: true, value: { ok: true } })
  vi.spyOn(apiClient, 'backEmbeddedLogin').mockResolvedValue({ ok: true, value: { ok: true } })
})
afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Douyin embedded login in the main studio', () => {
  it('mounts the global modal from account settings, blocks player shortcuts and leaves settings open after cancel', async () => {
    let finish!: (value: ApiResult<{ cookieCount: number; authKeysPresent: string[] }>) => void
    const login = vi.spyOn(apiClient, 'login').mockImplementation(() => {
      emit(attempt)
      return new Promise(resolve => { finish = resolve })
    })
    const session = mount()
    const toggle = vi.spyOn(session, 'togglePlaying')
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '登录' })).toBeEnabled())
    fireEvent.click(panel.getByRole('button', { name: '登录' }))
    expect(login).toHaveBeenCalledExactlyOnceWith('douyin')
    expect(screen.getByRole('dialog', { name: '抖音登录' })).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('请在应用内完成抖音官方登录或验证, 成功后自动关闭')).toBeInTheDocument()
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    expect(toggle).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' })
    await waitFor(() => expect(apiClient.cancelEmbeddedLogin).toHaveBeenCalledWith('douyin-attempt'))
    await act(async () => { emit(null); finish({ ok: false, code: 'login-cancelled', message: '登录已取消' }); await Promise.resolve() })
    expect(screen.queryByRole('dialog', { name: '抖音登录' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '抖音' })).toHaveAttribute('aria-selected', 'true')
    expect(panel.queryByRole('alert')).toBeNull()
    expect(panel.getByRole('button', { name: '登录' })).toBeEnabled()
  })

  it('automatically removes the login card and refreshes account state after authentication succeeds', async () => {
    let finish!: (value: ApiResult<{ cookieCount: number; authKeysPresent: string[] }>) => void
    vi.spyOn(apiClient, 'login').mockImplementation(() => { emit(attempt); return new Promise(resolve => { finish = resolve }) })
    mount()
    const panel = within(screen.getByRole('region', { name: '抖音' }))
    await waitFor(() => expect(panel.getByRole('button', { name: '登录' })).toBeEnabled())
    fireEvent.click(panel.getByRole('button', { name: '登录' }))
    expect(screen.getByRole('dialog', { name: '抖音登录' })).toBeInTheDocument()
    vi.mocked(apiClient.loginStatus).mockResolvedValue({ ok: true, value: status(true) })
    await act(async () => { emit(null); finish({ ok: true, value: { cookieCount: 1, authKeysPresent: ['sessionid'] } }); await Promise.resolve() })
    await waitFor(() => expect(panel.getByText('已登录')).toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: '抖音登录' })).toBeNull()
    expect(panel.getByRole('button', { name: '重新登录' })).toBeEnabled()
  })
})
