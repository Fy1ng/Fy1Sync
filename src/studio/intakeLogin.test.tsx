import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { notifyLoginStateChanged } from '../core/loginEvents'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { Intake } from './Intake'
import { SourceLoaderProvider } from './sources'

const sessions: Session[] = []
let signedIn = false
let youtubeSignedIn = false

function mount(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
  render(<SessionProvider session={session}><SourceLoaderProvider>
    <Intake onClose={() => {}} onSchedule={() => {}} />
  </SourceLoaderProvider></SessionProvider>)
  return session
}

const stepDown = { ok: true as const, value: { ok: true as const, stream: {
  platform: 'douyu' as const, kind: 'hls' as const, url: 'app://app/media/douyu', label: '斗鱼 6979222',
  channel: '6979222', sourceRoom: '6979222', requiresProxy: false, quality: '4', qualities: [{ id: '0', label: '原画' }, { id: '4', label: '蓝光' }],
} } }

beforeEach(() => {
  signedIn = false
  youtubeSignedIn = false
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'loginStatus') return { ok: true, value: { douyu: { loggedIn: signedIn }, youtube: { loggedIn: youtubeSignedIn }, twitch: { loggedIn: signedIn }, bilibili: { loggedIn: signedIn }, huya: { loggedIn: signedIn } } }
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function addDouyuRoom(): Promise<void> {
  fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
  const field = screen.getByLabelText('直播间链接')
  fireEvent.change(field, { target: { value: '6979222' } })
  fireEvent.click(screen.getByRole('radio', { name: '斗鱼' }))
  fireEvent.submit(field.closest('form')!)
}

describe('the login offer on the intake screen', () => {
  it('offers a Douyu login when the room came back below 原画, and reloads after it', async () => {
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue(stepDown)
    const login = vi.spyOn(apiClient, 'login').mockImplementation(async () => { signedIn = true; return { ok: true, value: { cookieCount: 4, authKeysPresent: ['acf_uid'] } } })
    mount()
    await addDouyuRoom()
    const offer = await screen.findByText('登录后可尝试原画')
    fireEvent.click(offer.parentElement!.querySelector('button')!)
    await waitFor(() => expect(login).toHaveBeenCalledWith('douyu'))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(resolve.mock.calls[1]![0]).toBe('6979222')
    expect(resolve.mock.calls[1]![2]).toBe('commentary')
  })

  it('says nothing to someone already signed in, or when 原画 came back', async () => {
    signedIn = true
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue(stepDown)
    mount()
    await addDouyuRoom()
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    await new Promise((done) => setTimeout(done, 20))
    expect(screen.queryByText(/可尝试原画/)).toBeNull()

    cleanup()
    signedIn = false
    resolve.mockResolvedValue({ ok: true, value: { ok: true, stream: { ...stepDown.value.stream, quality: '0' } } })
    mount()
    await addDouyuRoom()
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    await new Promise((done) => setTimeout(done, 20))
    expect(screen.queryByText(/可尝试原画/)).toBeNull()
  })

  it('offers a YouTube login to retry when YouTube refuses without one', async () => {
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false, failure: { code: 'restricted', message: 'YouTube 要求登录, 或此直播受到访问限制.' } } })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' } })
    fireEvent.submit(field.closest('form')!)
    expect(await screen.findByRole('button', { name: '登录 YouTube 并重试' })).toBeInTheDocument()
  })

  it('offers a fresh login, not a first one, when a signed-in YouTube account is refused', async () => {
    youtubeSignedIn = true
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false, failure: {
      code: 'restricted', reason: 'bot-check', message: 'YouTube 要求验证不是机器人, 当前网络暂时不能观看.', hint: '换一个代理节点, 或稍后重试.',
    } } })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' } })
    fireEvent.submit(field.closest('form')!)
    expect(await screen.findByRole('button', { name: '重新登录 YouTube 并重试' })).toBeInTheDocument()
  })

  it('surfaces invalidated YouTube login wording, refreshes login status, and offers re-login without anonymous retry', async () => {
    youtubeSignedIn = false
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false, failure: {
      code: 'restricted',
      reason: 'cookies-invalidated',
      message: 'YouTube 登录状态已失效，请重新登录',
      hint: '如从日常浏览器导入，浏览器后台轮换会使登录态失效，建议使用独立窗口登录',
    } } })
    const statusSpy = vi.spyOn(apiClient, 'loginStatus')
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' } })
    fireEvent.submit(field.closest('form')!)
    expect(await screen.findByText(/YouTube 登录状态已失效，请重新登录/)).toBeInTheDocument()
    expect(screen.getByText(/浏览器后台轮换会使登录态失效/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '登录 YouTube 并重试' })).toBeInTheDocument()
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(statusSpy).toHaveBeenCalled()
  })

  it('offers no login for a region refusal, which signing in cannot lift', async () => {
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false, failure: {
      code: 'restricted', reason: 'geo-restricted', message: '此直播在当前网络所在的地区不可观看.',
    } } })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' } })
    fireEvent.submit(field.closest('form')!)
    expect(await screen.findByText('此直播在当前网络所在的地区不可观看.')).toBeInTheDocument()
    await new Promise((done) => setTimeout(done, 20))
    expect(screen.queryByText(/并重试|可尝试原画/)).toBeNull()
  })

  it.each([
    ['bilibili', '哔哩哔哩', 'https://live.bilibili.com/21452505', 'login-required', undefined],
    ['huya', '虎牙', 'https://www.huya.com/kpl', 'restricted', 'sign-in'],
  ] as const)('offers and invokes %s sign-in only for an explicit authentication refusal', async (platform, name, input, code, reason) => {
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false, failure: {
      code, reason, message: '平台要求登录后观看.',
    } } })
    const login = vi.spyOn(apiClient, 'login').mockResolvedValue({ ok: false, code: 'login-cancelled', message: '登录已取消' })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: input } })
    fireEvent.submit(field.closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: `登录${name}并重试` }))
    await waitFor(() => expect(login).toHaveBeenCalledWith(platform))
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('登录已取消')).toBeNull()
  })

  it.each(['bilibili', 'huya'] as const)('does not call a quality fallback on %s an invalid login', async (platform) => {
    signedIn = true
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: true, stream: {
      ...stepDown.value.stream, platform, danmakuRoom: undefined,
    } } })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: platform === 'bilibili' ? 'https://live.bilibili.com/21452505' : 'https://www.huya.com/kpl' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(apiClient.resolve).toHaveBeenCalled())
    expect(screen.queryByText(/登录.*并重试|可尝试原画/)).toBeNull()
  })

  it('automatically retries a login-blocked room when login state is imported or completed in settings', async () => {
    const resolve = vi.spyOn(apiClient, 'resolve')
      .mockResolvedValueOnce({ ok: true, value: { ok: false, failure: { code: 'login-required', message: '平台要求登录后观看.' } } })
      .mockResolvedValueOnce({ ok: true, value: { ok: true, stream: { ...stepDown.value.stream, platform: 'bilibili', quality: '0' } } })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://live.bilibili.com/21452505' } })
    fireEvent.submit(field.closest('form')!)
    expect(await screen.findByRole('button', { name: '登录哔哩哔哩并重试' })).toBeInTheDocument()

    signedIn = true
    notifyLoginStateChanged(['bilibili'], 'import')

    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(resolve.mock.calls[1]![0]).toBe('https://live.bilibili.com/21452505')
  })

  it('offers Twitch re-authentication on expired Twitch login and retries automatically on browser import', async () => {
    signedIn = true
    const resolve = vi.spyOn(apiClient, 'resolve')
      .mockResolvedValueOnce({ ok: true, value: { ok: false, failure: { code: 'login-required', message: '平台要求登录或登录信息已失效' } } })
      .mockResolvedValueOnce({ ok: true, value: { ok: true, stream: { ...stepDown.value.stream, platform: 'twitch', quality: '1440p60' } } })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://www.twitch.tv/pgl' } })
    fireEvent.submit(field.closest('form')!)
    expect(await screen.findByRole('button', { name: '重新登录 Twitch 并重试' })).toBeInTheDocument()

    notifyLoginStateChanged(['twitch'], 'import')
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(resolve.mock.calls[1]![0]).toBe('https://www.twitch.tv/pgl')
  })
})
