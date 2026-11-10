import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { MediaDescriptor } from '../core/types'
import { Intake } from './Intake'
import { SourceChip } from './SourceChip'
import { douyinDanmakuRoom, LoginOffer, parseRoomInput, roomFromInput, sourceTitle, SourceLoaderProvider, useSourceLoader } from './sources'

const sessions: Session[] = []

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  return session
}

function mount(session: Session, children: React.ReactNode): void {
  render(<SessionProvider session={session}><SourceLoaderProvider>{children}</SourceLoaderProvider></SessionProvider>)
}

beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      if (method === 'getDanmakuFeatures') return { ok: true, value: { affixes: { enabled: false, prefix: '', suffix: '' } } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: vi.fn(() => () => {}),
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function resolvedDouyin() {
  return { ok: true as const, value: { ok: true as const, stream: {
    platform: 'douyin' as const, kind: 'hls' as const, url: 'app://app/media/douyin-session',
    label: '抖音主播', channel: '12345', sourceRoom: '7123456789012345678', danmakuRoom: 'douyin:12345', requiresProxy: false,
    qualities: [{ id: 'origin', label: '原画' }, { id: 'hd', label: '高清' }], quality: 'origin',
  } } }
}

describe('Douyin source selection and chat isolation', () => {
  it('offers Douyin for a bare room, resolves it with the selected platform, and preserves quality choices', async () => {
    const session = makeSession()
    session.connectDanmaku('9999')
    const connect = vi.spyOn(session, 'connectDanmaku')
    const disconnect = vi.spyOn(session, 'disconnectDanmaku')
    const load = vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue(resolvedDouyin())
    mount(session, <Intake onClose={() => {}} onSchedule={() => {}} pendingFile={null} />)
    fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: '12345678901234567890' } })
    fireEvent.click(screen.getByRole('radio', { name: '抖音' }))
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(load).toHaveBeenCalledWith('commentary', expect.objectContaining({
      input: '12345678901234567890', platform: 'douyin', sourceRoom: '7123456789012345678', danmakuRoom: 'douyin:12345',
      sourceQuality: 'origin', sourceQualities: resolvedDouyin().value.stream.qualities,
    })))
    expect(resolve).toHaveBeenCalledWith('https://live.douyin.com/12345678901234567890', 'douyin', 'commentary', undefined, true)
    expect(connect).toHaveBeenCalledExactlyOnceWith('douyin:12345')
    expect(disconnect).toHaveBeenCalled()
    expect(session.snapshot.danmaku.room).toBe('douyin:12345')
    expect(screen.queryByRole('button', { name: /登录抖音/ })).toBeNull()
  })

  it.each(['9999', 'huya:660000'])('clears previous chat even if Douyin resolution fails: %s', async previous => {
    const session = makeSession()
    session.connectDanmaku(previous)
    const connect = vi.spyOn(session, 'connectDanmaku')
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: false, code: 'test', message: '直播间未开播' })
    function Load(): React.ReactNode {
      const loader = useSourceLoader()
      return <button onClick={() => void loader.loadInput('commentary', 'https://v.douyin.com/abc/')}>load</button>
    }
    mount(session, <Load />)
    fireEvent.click(screen.getByRole('button', { name: 'load' }))
    await waitFor(() => expect(session.snapshot.danmaku.room).toBeNull())
    expect(connect).not.toHaveBeenCalled()
  })

  it('subscribes the canonical namespaced web room for share input without requiring login', async () => {
    const session = makeSession()
    const connect = vi.spyOn(session, 'connectDanmaku')
    const login = vi.spyOn(apiClient, 'loginStatus')
    vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    vi.spyOn(apiClient, 'resolve').mockResolvedValue(resolvedDouyin())
    function Load(): React.ReactNode {
      const loader = useSourceLoader()
      return <button onClick={() => void loader.loadInput('commentary', '直播分享 https://v.douyin.com/abc/。')}>load</button>
    }
    mount(session, <Load />)
    fireEvent.click(screen.getByRole('button', { name: 'load' }))
    await waitFor(() => expect(session.loadSource).toHaveBeenCalled())
    expect(connect).toHaveBeenCalledExactlyOnceWith('douyin:12345')
    expect(login).not.toHaveBeenCalled()
  })

  it('restores and reconnects Douyin chat while keeping its display free of a Douyu room editor', async () => {
    const session = makeSession()
    const descriptor: MediaDescriptor = {
      kind: 'test', url: '/test-sources/commentary.mp4', input: '12345', label: '抖音主播',
      platform: 'douyin', sourceRoom: '7123456789012345678', danmakuRoom: 'douyin:12345', loop: false, viaProxy: false,
    }
    await act(async () => { await session.loadSource('commentary', descriptor) })
    session.connectDanmaku('huya:660000')
    const connect = vi.spyOn(session, 'connectDanmaku')
    function Restore(): React.ReactNode {
      const loader = useSourceLoader()
      return <><button onClick={() => void loader.loadDescriptor('commentary', descriptor)}>restore</button><SourceChip role="commentary" /></>
    }
    mount(session, <Restore />)
    fireEvent.click(screen.getByRole('button', { name: 'restore' }))
    await waitFor(() => expect(session.snapshot.danmaku.room).toBe('douyin:12345'))
    fireEvent.click(screen.getByRole('button', { name: /解说.*抖音 12345/ }))
    expect(screen.getByRole('radio', { name: '抖音' })).toBeChecked()
    expect(screen.queryByLabelText('弹幕房间号')).toBeNull()
    expect(screen.queryByRole('button', { name: '连接' })).toBeNull()
    expect(screen.getByText(/抖音弹幕: 正在连接房间 12345/)).toBeInTheDocument()
    const retry = vi.spyOn(apiClient, 'reconnectDanmaku').mockResolvedValue({ ok: true, value: { room: 'douyin:12345' } })
    fireEvent.click(screen.getByRole('button', { name: '重连抖音弹幕' }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith('douyin:12345'))
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('does not guess a web room from a user profile or long share id', () => {
    expect(parseRoomInput('dy 9999')).toEqual({ room: '9999', platform: 'douyu' })
    expect(parseRoomInput('抖音 12345678901234567890')).toEqual({ room: '12345678901234567890', platform: 'douyin' })
    expect(parseRoomInput('douyin:12345')).toEqual({ room: '12345', platform: 'douyin' })
    expect(roomFromInput('https://www.douyin.com/user/12345')).toBeNull()
    expect(roomFromInput('https://webcast.amemv.com/webcast/reflow/7123456789012345678')).toBeNull()
    expect(sourceTitle({ kind: 'hls', url: 'x', input: 'https://live.douyin.com/12345', label: '主播',
      loop: false, viaProxy: false, platform: 'douyin' })).toBe('抖音 12345')
    expect(sourceTitle({ kind: 'hls', url: 'x', input: 'https://webcast.amemv.com/webcast/reflow/7123456789012345678',
      label: '抖音主播', sourceRoom: '7123456789012345678', loop: false, viaProxy: false, platform: 'douyin' })).toBe('抖音主播')
    expect(douyinDanmakuRoom({ input: 'https://v.douyin.com/abc/', danmakuRoom: 'douyin:12345' })).toBe('douyin:12345')
    expect(douyinDanmakuRoom({ input: 'https://live.douyin.com/12345' })).toBe('douyin:12345')
    expect(douyinDanmakuRoom({ input: 'https://webcast.amemv.com/webcast/reflow/7123456789012345678' })).toBeNull()
    expect(douyinDanmakuRoom({ input: 'https://v.douyin.com/abc/', danmakuRoom: '9999' })).toBeNull()
  })

  it.each([false, true])('offers a Douyin login retry for restricted streams, signed in: %s', async signedIn => {
    const session = makeSession()
    const status = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
    vi.spyOn(apiClient, 'loginStatus').mockResolvedValue({ ok: true, value: {
      youtube: status, douyu: status, douyin: { ...status, loggedIn: signedIn },
    } })
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false,
      failure: { code: 'restricted', reason: 'sign-in', message: '需要抖音登录' },
    } })
    const login = vi.spyOn(apiClient, 'login').mockResolvedValue({ ok: true, value: { cookieCount: 1, authKeysPresent: ['sessionid'] } })
    vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    function Load(): React.ReactNode {
      const loader = useSourceLoader()
      return <><button onClick={() => void loader.loadInput('commentary', '12345', 'douyin')}>load</button><LoginOffer role="commentary" /></>
    }
    mount(session, <Load />)
    fireEvent.click(screen.getByRole('button', { name: 'load' }))
    await waitFor(() => expect(screen.getByText(signedIn ? '重新登录抖音后重试' : '登录抖音后重试')).toBeInTheDocument())
    resolve.mockResolvedValue(resolvedDouyin())
    fireEvent.click(screen.getByRole('button', { name: signedIn ? '重新登录' : '登录' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(login).toHaveBeenCalledExactlyOnceWith('douyin')
    await waitFor(() => expect(session.snapshot.danmaku.room).toBe('douyin:12345'))
  })

  it('continues playback if the chat subscription fails', async () => {
    const session = makeSession()
    vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    vi.spyOn(session, 'connectDanmaku').mockImplementation(() => { throw new Error('offline') })
    const play = vi.spyOn(session, 'setPlaying').mockResolvedValue(undefined)
    vi.spyOn(apiClient, 'resolve').mockResolvedValue(resolvedDouyin())
    function Load(): React.ReactNode {
      const loader = useSourceLoader()
      return <button onClick={() => void loader.loadInput('commentary', '12345', 'douyin')}>load</button>
    }
    mount(session, <Load />)
    fireEvent.click(screen.getByRole('button', { name: 'load' }))
    await waitFor(() => expect(play).toHaveBeenCalledWith(true))
  })

  it('clears Douyin chat when switching commentary to a platform without accompanying chat', async () => {
    const session = makeSession()
    session.connectDanmaku('douyin:12345')
    vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: true, stream: {
      platform: 'youtube', kind: 'hls', url: 'app://app/media/youtube-session', label: 'YouTube', channel: 'abcdef', requiresProxy: false,
    } } })
    function Load(): React.ReactNode {
      const loader = useSourceLoader()
      return <button onClick={() => void loader.loadInput('commentary', 'https://www.youtube.com/watch?v=abcdef')}>load</button>
    }
    mount(session, <Load />)
    fireEvent.click(screen.getByRole('button', { name: 'load' }))
    await waitFor(() => expect(session.snapshot.danmaku.room).toBeNull())
  })

  it('does not reconnect an older restored chat after a newer Douyin source finishes', async () => {
    const session = makeSession()
    let firstDone!: () => void
    const first = new Promise<void>(resolve => { firstDone = resolve })
    vi.spyOn(session, 'loadSource').mockReturnValueOnce(first).mockResolvedValue(undefined)
    const connect = vi.spyOn(session, 'connectDanmaku')
    const descriptor: MediaDescriptor = { kind: 'hls', url: 'app://app/media/douyin-session', input: 'https://v.douyin.com/abc/',
      platform: 'douyin', label: '抖音', loop: false, viaProxy: false, sourceRoom: '7123456789012345678' }
    let loader!: ReturnType<typeof useSourceLoader>
    function Load(): React.ReactNode { loader = useSourceLoader(); return null }
    mount(session, <Load />)
    let older!: Promise<void>
    act(() => { older = loader.loadDescriptor('commentary', { ...descriptor, danmakuRoom: 'douyin:11111' }) })
    await act(async () => { await loader.loadDescriptor('commentary', { ...descriptor, danmakuRoom: 'douyin:22222' }) })
    await act(async () => { firstDone(); await older })
    expect(connect).toHaveBeenCalledExactlyOnceWith('douyin:22222')
  })

  it('does not restore the old Douyin source when embedded login ends after a source change', async () => {
    const session = makeSession()
    const loggedOut = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
    vi.spyOn(apiClient, 'loginStatus').mockResolvedValue({ ok: true, value: { youtube: loggedOut, douyu: loggedOut, douyin: loggedOut } })
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValueOnce({ ok: true, value: { ok: false,
      failure: { code: 'restricted', reason: 'sign-in', message: '需要抖音登录' },
    } }).mockResolvedValue({ ok: true, value: { ok: true, stream: {
      platform: 'youtube', kind: 'hls', url: 'app://app/media/youtube-session', label: 'YouTube', channel: 'abcdef', requiresProxy: false,
    } } })
    let finishLogin!: () => void
    vi.spyOn(apiClient, 'login').mockImplementation(() => new Promise(done => { finishLogin = () => done({ ok: true, value: { cookieCount: 1, authKeysPresent: ['sessionid'] } }) }))
    const load = vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    let loader!: ReturnType<typeof useSourceLoader>
    function Load(): React.ReactNode { loader = useSourceLoader(); return <LoginOffer role="commentary" /> }
    mount(session, <Load />)
    await act(async () => { await loader.loadInput('commentary', '12345', 'douyin') })
    await waitFor(() => expect(screen.getByText('登录抖音后重试')).toBeInTheDocument())
    let loggingIn!: Promise<void>
    act(() => { loggingIn = loader.login('commentary') })
    await act(async () => { await loader.loadInput('commentary', 'https://www.youtube.com/watch?v=abcdef') })
    await act(async () => { finishLogin(); await loggingIn })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledExactlyOnceWith('commentary', expect.objectContaining({ platform: 'youtube' }))
    expect(loader.state.commentary.loggingIn).toBe(false)
  })

  it('leaves an embedded-login cancellation as a retryable source state without an error', async () => {
    const session = makeSession()
    const loggedOut = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
    vi.spyOn(apiClient, 'loginStatus').mockResolvedValue({ ok: true, value: { youtube: loggedOut, douyu: loggedOut, douyin: loggedOut } })
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false,
      failure: { code: 'restricted', reason: 'sign-in', message: '需要抖音登录' },
    } })
    vi.spyOn(apiClient, 'login').mockResolvedValue({ ok: false, code: 'login-cancelled', message: '登录已取消' })
    let loader!: ReturnType<typeof useSourceLoader>
    function Load(): React.ReactNode { loader = useSourceLoader(); return <LoginOffer role="commentary" /> }
    mount(session, <Load />)
    await act(async () => { await loader.loadInput('commentary', '12345', 'douyin') })
    await waitFor(() => expect(screen.getByText('登录抖音后重试')).toBeInTheDocument())
    await act(async () => { await loader.login('commentary') })
    expect(loader.state.commentary).toMatchObject({ problem: null, loggingIn: false, login: 'douyin' })
  })
})
