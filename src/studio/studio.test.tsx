/**
 * The studio's own rules: which side a pasted link goes to, how the crossfader splits two
 * volumes, and which way "回退画面 / 快进画面" moves the offset. Mounted under StrictMode for
 * the same reason the player always has been — the media mounts must survive a remount.
 */

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { apiClient } from '../app/apiClient'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { EmbeddedLoginState } from '../../electron/embeddedLoginContracts'
import { primeMediaElement } from '../test/setup'
import { parseRoomInput, roomFromInput, sourceTitle, SourceLoaderProvider } from './sources'
import { Studio } from './Studio'
import { balanceOf, volumesFor } from './transport'
import { AutoAlign, startAutoAlign } from './sync'
import { Intake } from './Intake'

const sessions: Session[] = []
const embeddedLoginListeners = new Set<(state: EmbeddedLoginState | null) => void>()

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  return session
}

function renderStudio(session: Session): ReturnType<typeof render> {
  return render(<StrictMode><SessionProvider session={session}><Studio /></SessionProvider></StrictMode>)
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  embeddedLoginListeners.clear()
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      if (method === 'getEmbeddedLogin') return { ok: true, value: null }
      if (method === 'loginStatus') return { ok: true, value: { douyu: { loggedIn: false }, youtube: { loggedIn: false }, bilibili: { loggedIn: false }, huya: { loggedIn: false } } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeEmbeddedLogin: (listener) => {
      embeddedLoginListeners.add(listener)
      return () => { embeddedLoginListeners.delete(listener) }
    },
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.unstubAllGlobals()
})

describe('typed rooms', () => {
  it('leaves a bare number to the viewer and reads a platform prefix', () => {
    expect(parseRoomInput('6979222')).toEqual({ room: '6979222', platform: null })
    expect(parseRoomInput('b 21452505')).toEqual({ room: '21452505', platform: 'bilibili' })
    expect(parseRoomInput('斗鱼9999')).toEqual({ room: '9999', platform: 'douyu' })
    expect(parseRoomInput('虎牙 660000')).toEqual({ room: '660000', platform: 'huya' })
    expect(parseRoomInput('huya:kpl')).toEqual({ room: 'kpl', platform: 'huya' })
    expect(parseRoomInput('hy lpl')).toEqual({ room: 'lpl', platform: 'huya' })
    expect(parseRoomInput('kpl')).toEqual({ room: 'kpl', platform: null })
    expect(parseRoomInput('huya:room-name')).toEqual({ room: 'room-name', platform: 'huya' })
    expect(parseRoomInput('huya-room')).toEqual({ room: 'huya-room', platform: null })
    expect(parseRoomInput('room-name')).toEqual({ room: 'room-name', platform: null })
    expect(parseRoomInput('huya ' + 'a'.repeat(65))).toBeNull()
    expect(parseRoomInput('https://www.huya.com/kpl')).toBeNull()
    expect(parseRoomInput('https://www.douyu.com/9999')).toBeNull()
  })

  it('names a room by what was typed, not by the id it resolved to', () => {
    expect(roomFromInput('https://www.douyu.com/9999')).toBe('9999')
    expect(roomFromInput('https://www.douyu.com/topic/xyz?rid=288016')).toBe('288016')
    expect(roomFromInput('https://live.bilibili.com/21452505?spm=1')).toBe('21452505')
    expect(roomFromInput('https://m.huya.com/kpl?from=share')).toBe('kpl')
    expect(roomFromInput('https://www.huya.com/room-name')).toBe('room-name')
    expect(sourceTitle({ kind: 'hls', url: 'x', input: 'huya.com/kpl', label: '虎牙 660000', loop: false, viaProxy: false, platform: 'huya', sourceRoom: '660000' })).toBe('虎牙 kpl')
    const douyu = { kind: 'hls' as const, url: 'x', input: 'douyu.com/9999', label: '斗鱼 6979222', loop: false, viaProxy: true, platform: 'douyu' as const, sourceRoom: '6979222' }
    expect(sourceTitle(douyu)).toBe('斗鱼 9999')
  })

  it('does not say the platform twice', () => {
    expect(sourceTitle({ kind: 'hls', url: 'x', input: 'https://www.youtube.com/watch?v=a', label: 'YouTube 直播', loop: false, viaProxy: false, platform: 'youtube' }))
      .toBe('YouTube 直播')
  })
})

describe('the balance slider', () => {
  it('plays both at full in the middle and silences the far side at each end', () => {
    expect(volumesFor(0)).toEqual({ official: 1, commentary: 1 })
    expect(volumesFor(1)).toEqual({ official: 0, commentary: 1 })
    expect(volumesFor(-1)).toEqual({ official: 1, commentary: 0 })
    expect(volumesFor(0.25)).toEqual({ official: 0.75, commentary: 1 })
  })

  it('reads back the position it set', () => {
    for (const position of [-1, -0.4, 0, 0.3, 1]) {
      const { official, commentary } = volumesFor(position)
      expect(balanceOf(official, commentary)).toBeCloseTo(position, 2)
    }
  })
})

describe('the studio', () => {
  it('opens native-login cards above settings and keeps the login visible when settings closes', async () => {
    renderStudio(makeSession())
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const settings = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(within(settings).getByRole('tablist', { name: '设置分区' })).getByRole('tab', { name: '账号' }))
    fireEvent.click(within(within(settings).getByRole('tablist', { name: '账号平台' })).getByRole('tab', { name: '哔哩哔哩' }))
    expect(await screen.findByText('哔哩哔哩账号')).toBeInTheDocument()
    const login = vi.spyOn(apiClient, 'login').mockResolvedValue({ ok: false, code: 'login-cancelled', message: '登录已取消' })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(login).toHaveBeenCalledWith('bilibili'))
    act(() => {
      for (const listener of embeddedLoginListeners) listener({ id: 'settings-login', platform: 'bilibili', purpose: 'login', phase: 'loading' })
    })
    expect(screen.getByRole('dialog', { name: '哔哩哔哩登录' })).toBeInTheDocument()
    fireEvent.click(settings.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!)
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '哔哩哔哩登录' })).toBeInTheDocument()
    act(() => { for (const listener of embeddedLoginListeners) listener(null) })
    expect(screen.queryByRole('dialog', { name: '哔哩哔哩登录' })).toBeNull()
  })

  it('starts repeated alignment requests without an adapting notice', async () => {
    const session = makeSession()
    for (const role of ['official', 'commentary'] as const) {
      await session.loadSource(role, { kind: 'progressive', url: `https://example.test/${role}.mp4`,
        input: `${role}.mp4`, label: role, loop: false, viaProxy: false })
      primeMediaElement(session.engine.element(role))
    }
    session.flush()
    vi.spyOn(session, 'syncNow').mockResolvedValue({} as Awaited<ReturnType<Session['syncNow']>>)
    const notice = vi.spyOn(session, 'notice')
    startAutoAlign(session)
    startAutoAlign(session)
    await flush()
    expect(notice).not.toHaveBeenCalled()
    expect(session.syncNow).toHaveBeenCalledTimes(2)
  })

  it('keeps the player chrome hidden during shortcut, pointer-leave and scheduled alignment runs', async () => {
    vi.useFakeTimers()
    try {
      let releaseSample!: () => void
      const session = new Session({
        measureFrames: () => new Promise(resolve => {
          releaseSample = () => resolve({ samples: { official: 0, commentary: 0 }, message: '已取消' })
        }),
      })
      sessions.push(session)
      for (const role of ['official', 'commentary'] as const) {
        await session.loadSource(role, { kind: 'progressive', url: `https://example.test/${role}.mp4`,
          input: `${role}.mp4`, label: role, loop: false, viaProxy: false })
        primeMediaElement(session.engine.element(role), { duration: 600, currentTime: 100 })
      }
      await session.setPlaying(true)
      session.flush()

      const { container } = renderStudio(session)
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      const theater = container.querySelector('main.theater') as HTMLElement
      // Let the initial 3.2 s idle timer hide the chrome.
      await act(async () => { await vi.advanceTimersByTimeAsync(3500) })
      expect(theater).toHaveAttribute('data-chrome', 'off')

      // Pressing shortcut A (even when focus sits inside .theater) must not reveal chrome.
      theater.tabIndex = -1
      theater.focus()
      await act(async () => {
        fireEvent.keyDown(theater, { code: 'KeyA', key: 'a', bubbles: true })
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(session.snapshot.autoSync.phase).toBe('sampling')
      expect(theater).toHaveAttribute('data-chrome', 'off')

      // Moving pointer into theater reveals chrome; leaving hides it immediately even while sampling.
      fireEvent.pointerMove(theater)
      expect(theater).toHaveAttribute('data-chrome', 'on')
      fireEvent.pointerLeave(theater)
      expect(theater).toHaveAttribute('data-chrome', 'off')

      await act(async () => {
        session.cancelAutoSync()
        releaseSample?.()
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(theater).toHaveAttribute('data-chrome', 'off')

      // Scheduled periodic alignment also runs without waking the dock or topbar.
      session.setAutoSyncInterval(15)
      session.setAutoSyncEnabled(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(15_100) })
      expect(session.snapshot.autoSync.phase).toBe('sampling')
      expect(theater).toHaveAttribute('data-chrome', 'off')
      session.cancelAutoSync()
      releaseSample?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens frame-matching settings directly from the alignment options menu', async () => {
    const session = makeSession()
    renderStudio(session)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    fireEvent.click(screen.getByRole('button', { name: '对齐选项' }))
    fireEvent.click(screen.getByRole('button', { name: '调整匹配区域' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    expect(within(dialog).getByRole('tabpanel', { name: '画面匹配' })).toBeInTheDocument()
  })

  it('reveals the first presented picture while the other source is still absent', async () => {
    const session = makeSession()
    let present!: () => void
    Object.defineProperty(session.engine.element('commentary'), 'requestVideoFrameCallback', {
      configurable: true, value: (callback: () => void) => { present = callback; return 1 },
    })
    renderStudio(session)
    await flush()
    await act(async () => {
      await session.loadSource('commentary', { kind: 'progressive', url: 'https://example.test/commentary.mp4',
        input: 'commentary.mp4', label: '解说', loop: false, viaProxy: false })
      primeMediaElement(session.engine.element('commentary'))
      session.flush()
    })
    expect(screen.getByRole('dialog', { name: '添加直播间' })).toBeInTheDocument()
    act(() => { present(); session.flush() })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加直播间' })).not.toBeInTheDocument())
    expect(session.snapshot.media.commentary.firstFrame).toBe(true)
    expect(session.snapshot.media.official.status).toBe('empty')
    expect(screen.getByRole('button', { name: '准备中' })).toBeDisabled()
  })

  it('keeps alignment and its shortcut disabled until both synchronization buffers are ready', async () => {
    let publish!: Parameters<typeof apiClient.subscribeBuffer>[0]
    const subscribe = vi.spyOn(apiClient, 'subscribeBuffer').mockImplementation(listener => { publish = listener; return () => {} })
    try {
      const session = makeSession()
      const sync = vi.spyOn(session, 'syncNow').mockResolvedValue({} as Awaited<ReturnType<Session['syncNow']>>)
      render(<SessionProvider session={session}><AutoAlign /></SessionProvider>)
      await act(async () => {
        for (const role of ['official', 'commentary'] as const) {
          await session.loadSource(role, { kind: 'progressive', url: `app://app/buffer/${role}/index.m3u8`,
            input: role, label: role, loop: false, viaProxy: false })
          primeMediaElement(session.engine.element(role), { duration: Infinity, seekableEnd: 2 })
          publish({ role, state: 'buffering', hasVideo: true, completeSegments: 1, seconds: 2 })
        }
        session.flush()
      })
      expect(screen.getByRole('button', { name: '准备中' })).toBeDisabled()
      act(() => startAutoAlign(session))
      expect(sync).not.toHaveBeenCalled()
      await act(async () => {
        expect(await session.autoSync.dryRun({ official: 0, commentary: 0 })).toMatchObject({
          applied: false, failure: { kind: 'not-ready', message: '请等待两路播放和缓冲就绪' },
        })
      })
      act(() => {
        publish({ role: 'official', state: 'ready', hasVideo: true, completeSegments: 2, seconds: 4 })
        session.flush()
      })
      expect(screen.getByRole('button', { name: '准备中' })).toBeDisabled()
      act(() => {
        publish({ role: 'commentary', state: 'ready', hasVideo: true, completeSegments: 2, seconds: 4 })
        session.flush()
      })
      expect(screen.getByRole('button', { name: '自动对齐' })).toBeEnabled()
      expect(screen.queryByText('适配中')).toBeNull()
      expect(screen.queryByText(/对不准时可手动微调/)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '自动对齐' }))
      expect(sync).toHaveBeenCalledTimes(1)
    } finally { subscribe.mockRestore() }
  })

  it('keeps an explicitly reopened source dialog available while an existing picture is visible', async () => {
    const session = makeSession()
    let present!: () => void
    Object.defineProperty(session.engine.element('commentary'), 'requestVideoFrameCallback', {
      configurable: true, value: (callback: () => void) => { present = callback; return 1 },
    })
    await session.loadSource('commentary', { kind: 'progressive', url: 'https://example.test/commentary.mp4',
      input: 'commentary.mp4', label: '解说', loop: false, viaProxy: false })
    primeMediaElement(session.engine.element('commentary'))
    present()
    session.flush()
    const close = vi.fn()
    render(<SessionProvider session={session}><SourceLoaderProvider>
      <Intake onClose={close} onSchedule={() => {}} />
    </SourceLoaderProvider></SessionProvider>)
    await flush()
    expect(screen.getByRole('dialog', { name: '添加直播间' })).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '开始观看' }))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('opens on the paste screen when nothing is loaded', async () => {
    renderStudio(makeSession())
    await flush()
    expect(screen.getByRole('dialog', { name: '添加直播间' })).toBeInTheDocument()
    expect(screen.getByLabelText('直播间链接')).toBeInTheDocument()
  })

  it.each(['intake', 'player'] as const)('ignores file drops across the %s and prevents file navigation', async mode => {
    const session = makeSession()
    const load = vi.spyOn(session, 'loadSource')
    const resolve = vi.spyOn(apiClient, 'resolve')
    try {
      const { container } = renderStudio(session)
      await flush()
      if (mode === 'player') fireEvent.click(screen.getByRole('button', { name: '跳过' }))
      const targets = [container.querySelector('video')!, document.body]
      if (mode === 'intake') targets.push(screen.getByRole('textbox', { name: '直播间链接' }))
      for (const target of targets) {
        const dataTransfer = { types: ['Files'], files: [new File(['video'], 'dropped.mp4', { type: 'video/mp4' })] }
        expect(fireEvent.dragOver(target, { dataTransfer })).toBe(false)
        expect(fireEvent.drop(target, { dataTransfer })).toBe(false)
      }
      expect(load).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
      expect(session.snapshot.media.official.status).toBe('empty')
      expect(session.snapshot.media.commentary.status).toBe('empty')
      expect(screen.queryByText(/已拖入|dropped.mp4/)).toBeNull()
      expect(screen.queryByRole('dialog', { name: '添加直播间' }) !== null).toBe(mode === 'intake')
    } finally {
      load.mockRestore()
      resolve.mockRestore()
    }
  })

  it('leaves text drag events alone and releases file guards on unmount', async () => {
    const { unmount } = renderStudio(makeSession())
    await flush()
    expect(fireEvent.drop(document.body, { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true)
    unmount()
    expect(fireEvent.drop(document.body, { dataTransfer: { types: ['Files'], files: [] } })).toBe(true)
  })

  it('mounts both media elements and keeps them through a StrictMode remount', async () => {
    const { container } = renderStudio(makeSession())
    await flush()
    const roles = [...container.querySelectorAll('video')].map((video) => video.dataset.role).sort()
    expect(roles).toEqual(['commentary', 'official'])
  })

  it('offers a hidden preview beside its source chip until restored or removed', async () => {
    const session = makeSession()
    for (const role of ['official', 'commentary'] as const) {
      await session.loadSource(role, { kind: 'test', url: `/test-sources/${role}.mp4`, input: role, label: role, loop: true, viaProxy: false, platform: 'test' })
    }
    session.flush()
    renderStudio(session)
    await flush()

    const hidePreview = { name: '隐藏小画面' }
    const showPreview = { name: '显示小画面' }
    const source = screen.getByRole('button', { name: /^解说：/ })
    expect(screen.queryByRole('button', showPreview)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', hidePreview))
    expect(screen.queryByRole('button', hidePreview)).not.toBeInTheDocument()
    const restore = screen.getByRole('button', showPreview)
    expect(restore).toBeVisible()
    expect(restore).toHaveAttribute('title', '显示小画面')
    expect(source.nextElementSibling).toBe(restore)

    fireEvent.click(restore)
    expect(screen.getByRole('button', { name: '将解说切换为主画面' })).toBeVisible()
    expect(screen.queryByRole('button', showPreview)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', hidePreview))
    fireEvent.click(source)
    expect(source).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', showPreview)).toBeVisible()

    const panel = screen.getByRole('dialog', { name: '解说片源' })
    fireEvent.click(within(panel).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(source).toHaveAttribute('data-status', 'empty'))
    expect(screen.queryByRole('button', showPreview)).not.toBeInTheDocument()
  })

  it('can be skipped into an empty player, with a way back to adding sources', async () => {
    renderStudio(makeSession())
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    expect(screen.queryByRole('dialog', { name: '添加直播间' })).toBeNull()
    // Nothing to align yet, so the nudges are off rather than silently doing nothing.
    expect(screen.getByRole('button', { name: '回退画面' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '添加直播间' }))
    expect(screen.getByRole('dialog', { name: '添加直播间' })).toBeInTheDocument()
  })

  it('asks which platform a bare room number belongs to as soon as it is typed', async () => {
    renderStudio(makeSession())
    await flush()
    const field = screen.getByLabelText('直播间链接')
    const add = screen.getByRole('button', { name: '添加' })
    // Nothing to type into until a side is picked.
    expect(field).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
    expect(field).toBeEnabled()
    fireEvent.change(field, { target: { value: '6979222' } })
    const ask = screen.getByRole('radiogroup', { name: '选择房间号所属平台' })
    expect(ask).toHaveTextContent('6979222')
    // No platform yet: nothing to add.
    expect(add).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: '哔哩哔哩' }))
    expect(screen.getByRole('radio', { name: '哔哩哔哩' })).toHaveAttribute('aria-checked', 'true')
    expect(add).toBeEnabled()
    expect(screen.getByRole('radio', { name: '斗鱼' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '虎牙' })).toBeInTheDocument()
  })

  it('fills the side the viewer picked, not the side the link suggests', async () => {
    const session = makeSession()
    renderStudio(session)
    await flush()
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false, failure: { code: 'not-live', message: '未开播' } } })
    // 画面 is picked first; a YouTube link would once have gone there anyway, so use 解说.
    fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
    expect(screen.getByRole('radio', { name: /解说/ })).toHaveAttribute('aria-checked', 'true')
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    expect(resolve.mock.calls[0]![2]).toBe('commentary')
  })

  it('closes the paste screen on Escape even with nothing loaded', async () => {
    renderStudio(makeSession())
    await flush()
    fireEvent.keyDown(screen.getByLabelText('直播间链接'), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '添加直播间' })).toBeNull()
  })

  it('回退解说 holds the voice back and 回退画面 holds the picture back', async () => {
    const session = makeSession()
    // Both sides present: an offset only means something between two sources.
    for (const role of ['official', 'commentary'] as const) {
      void session.loadSource(role, { kind: 'test', url: `/test-sources/${role}.mp4`, input: role, label: role, loop: true, viaProxy: false, platform: 'test' })
    }
    const apply = vi.spyOn(session, 'applyOffset')
    renderStudio(session)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: '回退解说' }))
    await waitFor(() => expect(apply).toHaveBeenCalled())
    expect(apply.mock.calls.at(-1)![0]).toBeLessThan(0)

    apply.mockClear()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '回退画面' }))
    fireEvent.click(screen.getByRole('button', { name: '回退画面' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    expect(apply.mock.calls.at(-1)![0]).toBeGreaterThan(apply.mock.calls[0]![0] as number)
  })

  it('seeks the main screen on ←/→, nudges the alignment on , and ., and respects the shortcuts toggle', async () => {
    const session = makeSession()
    for (const role of ['official', 'commentary'] as const) {
      void session.loadSource(role, { kind: 'test', url: `/test-sources/${role}.mp4`, input: role, label: role, loop: true, viaProxy: false, platform: 'test' })
    }
    const seek = vi.spyOn(session, 'seekPlayback').mockResolvedValue(true)
    const apply = vi.spyOn(session, 'applyOffset')
    renderStudio(session)
    await flush()

    fireEvent.keyDown(window, { code: 'ArrowLeft' })
    expect(seek.mock.calls).toEqual([['official', -5]])
    fireEvent.keyDown(window, { code: 'ArrowRight', shiftKey: true })
    expect(seek).toHaveBeenLastCalledWith('official', 30)
    await act(async () => session.swapRoles())
    fireEvent.keyDown(window, { code: 'ArrowLeft' })
    expect(seek).toHaveBeenLastCalledWith('commentary', -5)
    expect(seek).toHaveBeenCalledTimes(3)
    expect(apply).not.toHaveBeenCalled()

    // , is 回退画面: the picture is held back, a positive offset.
    fireEvent.keyDown(window, { code: 'Comma' })
    await waitFor(() => expect(apply).toHaveBeenCalled())
    expect(apply.mock.calls.at(-1)![0]).toBe(session.settings.largeStepSeconds)
    await flush()
    const last = Number(apply.mock.calls.at(-1)![0])
    fireEvent.keyDown(window, { code: 'Period', shiftKey: true })
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    expect(Number(apply.mock.calls.at(-1)![0]) - last).toBe(-session.settings.smallStepSeconds)
    await flush()
    const next = Number(apply.mock.calls.at(-1)![0])
    fireEvent.keyDown(window, { code: 'BracketLeft', shiftKey: true })
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(3))
    expect(Number(apply.mock.calls.at(-1)![0]) - next).toBe(session.settings.smallStepSeconds)
    await flush()
    const previous = Number(apply.mock.calls.at(-1)![0])
    fireEvent.keyDown(window, { code: 'BracketRight' })
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(4))
    expect(Number(apply.mock.calls.at(-1)![0]) - previous).toBe(-session.settings.largeStepSeconds)

    await act(async () => session.updateSettings({
      shortcuts: { ...session.settings.shortcuts, seekBack: ['KeyJ'], nudgeForward: ['KeyK'] },
      smallStepSeconds: 0.25, largeStepSeconds: 10,
    }))
    fireEvent.keyDown(window, { code: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(window, { code: 'Period', shiftKey: true })
    expect(seek).toHaveBeenCalledTimes(3)
    expect(apply).toHaveBeenCalledTimes(4)
    fireEvent.keyDown(window, { code: 'KeyJ', shiftKey: true })
    expect(seek).toHaveBeenLastCalledWith('commentary', -30)
    const beforeFine = Number(apply.mock.calls.at(-1)![0])
    fireEvent.keyDown(window, { code: 'KeyK', shiftKey: true })
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(5))
    expect(Number(apply.mock.calls.at(-1)![0]) - beforeFine).toBe(-0.25)

    // Turning off shortcutsEnabled blocks shortcut dispatch until re-enabled.
    await act(async () => session.updateSettings({ shortcutsEnabled: false }))
    fireEvent.keyDown(window, { code: 'KeyJ', shiftKey: true })
    fireEvent.keyDown(window, { code: 'KeyK', shiftKey: true })
    expect(seek).toHaveBeenCalledTimes(4)
    expect(apply).toHaveBeenCalledTimes(5)
  })

  it('consumes a recorded key before player dispatch and immediately uses the new binding and tooltip', async () => {
    const session = makeSession()
    renderStudio(session)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    const danmaku = screen.getByRole('button', { name: '弹' })
    expect(danmaku).toHaveAttribute('title', '弹幕（D）')
    expect(danmaku).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const dialog = screen.getByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('tab', { name: '快捷键' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '全屏：修改 F' }))
    expect(fireEvent.keyDown(window, { code: 'KeyD' })).toBe(false)
    expect(within(dialog).getByText('D 已被「开关弹幕」占用')).toBeInTheDocument()
    expect(danmaku).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '开关弹幕：修改 D' }))
    await act(async () => { fireEvent.keyDown(window, { key: 'j', code: 'KeyK' }) })
    expect(danmaku).toHaveAttribute('title', '弹幕（K）')
    expect(danmaku).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    fireEvent.keyDown(window, { code: 'KeyD' })
    expect(danmaku).toHaveAttribute('aria-pressed', 'true')
    await act(async () => { fireEvent.keyDown(window, { code: 'KeyK' }) })
    expect(danmaku).toHaveAttribute('aria-pressed', 'false')
    await act(async () => session.updateSettings({ shortcuts: { ...session.settings.shortcuts, toggleDanmaku: [] } }))
    expect(danmaku).toHaveAttribute('title', '弹幕')
    fireEvent.keyDown(window, { code: 'KeyK' })
    expect(danmaku).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not dispatch shortcuts from editable fields, dialogs, modifier chords or embedded login', async () => {
    const session = makeSession()
    renderStudio(session)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    render(<>
      <input aria-label="输入框" />
      <div tabIndex={0} contentEditable="plaintext-only" data-testid="editable" />
      <div role="dialog"><button type="button">对话框内按钮</button></div>
    </>)
    const code = 'KeyD'
    for (const target of [screen.getByRole('textbox', { name: '输入框' }), screen.getByTestId('editable'), screen.getByRole('button', { name: '对话框内按钮' })]) {
      target.focus()
      fireEvent.keyDown(target, { code })
      expect(session.settings.danmaku.enabled).toBe(true)
    }
    for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      fireEvent.keyDown(window, { code, ...modifiers })
      expect(session.settings.danmaku.enabled).toBe(true)
    }
    act(() => {
      for (const listener of embeddedLoginListeners) listener({ id: 'shortcut-guard', platform: 'bilibili', purpose: 'login', phase: 'loading' })
    })
    fireEvent.keyDown(window, { code })
    expect(session.settings.danmaku.enabled).toBe(true)
  })

  it('sends a dragged time line through the session, for the main picture only', async () => {
    const session = makeSession()
    for (const role of ['official', 'commentary'] as const) {
      void session.loadSource(role, { kind: 'test', url: `/test-sources/${role}.mp4`, input: role, label: role, loop: true, viaProxy: false, platform: 'test' })
    }
    await flush()
    primeMediaElement(session.engine.element('official'), { duration: 600, currentTime: 100 })
    const seekTo = vi.spyOn(session, 'seekPlaybackTo').mockResolvedValue(true)
    const raw = vi.spyOn(session.engine, 'seek')
    renderStudio(session)
    await flush()

    const line = screen.getByRole('slider', { name: '播放进度' })
    fireEvent.change(line, { target: { value: '40' } })
    fireEvent.pointerUp(line)
    expect(seekTo).toHaveBeenCalledWith('official', 40)
    expect(raw).not.toHaveBeenCalled()
  })

  it('puts a lone commentary on the big screen and gives it back when the picture arrives', async () => {
    const session = makeSession()
    renderStudio(session)
    await flush()
    await act(async () => {
      await session.loadSource('commentary', { kind: 'test', url: '/test-sources/commentary.mp4', input: 'c', label: 'c', loop: true, viaProxy: false, platform: 'test' })
    })
    await waitFor(() => expect(session.snapshot.mainRole).toBe('commentary'))
    await act(async () => {
      await session.loadSource('official', { kind: 'test', url: '/test-sources/official.mp4', input: 'o', label: 'o', loop: true, viaProxy: false, platform: 'test' })
    })
    await waitFor(() => expect(session.snapshot.mainRole).toBe('official'))
  })

  it('says which side waits, not a signed number', async () => {
    const session = makeSession()
    renderStudio(session)
    await flush()
    expect(screen.getByRole('button', { name: /未调整/ })).toBeInTheDocument()
  })
})
