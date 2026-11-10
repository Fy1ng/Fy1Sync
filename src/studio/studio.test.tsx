/**
 * The studio's own rules: which side a pasted link goes to, how the crossfader splits two
 * volumes, and which way "解说早了 / 解说晚了" moves the offset. Mounted under StrictMode for
 * the same reason the player always has been — the media mounts must survive a remount.
 */

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiClient } from '../app/apiClient'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { primeMediaElement } from '../test/setup'
import { parseRoomInput, roomFromInput, sourceTitle } from './sources'
import { Studio } from './Studio'
import { balanceOf, volumesFor } from './transport'
import { AutoAlign, startAutoAlign } from './sync'

const sessions: Session[] = []

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
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
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
  it('shows the adapting notice once per session across repeated alignment requests', async () => {
    const session = makeSession()
    vi.spyOn(session, 'syncNow').mockResolvedValue({} as Awaited<ReturnType<Session['syncNow']>>)
    const notice = vi.spyOn(session, 'notice')
    startAutoAlign(session)
    startAutoAlign(session)
    await flush()
    expect(notice.mock.calls.filter(([, text]) => text.startsWith('自动对齐适配中:'))).toHaveLength(1)
    expect(session.syncNow).toHaveBeenCalledTimes(2)
  })

  it('defaults alignment to basic mode and exposes the saved-pack selector only in style-pack mode', async () => {
    const session = makeSession()
    session.updateSettings({ profileId: 'saved/iem' })
    render(<SessionProvider session={session}><AutoAlign /></SessionProvider>)
    fireEvent.click(screen.getByRole('button', { name: '对齐选项' }))
    expect(screen.getByRole('radio', { name: '基础模式' })).toBeChecked()
    expect(screen.getByText(/自动查找 0:01-1:55/)).toHaveTextContent('同一回合的正式倒计时')
    expect(screen.queryByRole('combobox', { name: '倒计时样式' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: '样式包模式' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: '倒计时样式' })).toBeInTheDocument())
    expect(session.settings.profileId).toBe('saved/iem')
    fireEvent.click(screen.getByRole('radio', { name: '基础模式' }))
    await waitFor(() => expect(screen.queryByRole('combobox', { name: '倒计时样式' })).not.toBeInTheDocument())
    expect(session.settings.profileId).toBe('saved/iem')
  })

  it('opens on the paste screen when nothing is loaded', async () => {
    renderStudio(makeSession())
    await flush()
    expect(screen.getByRole('dialog', { name: '添加直播间' })).toBeInTheDocument()
    expect(screen.getByLabelText('直播间链接')).toBeInTheDocument()
  })

  it('mounts both media elements and keeps them through a StrictMode remount', async () => {
    const { container } = renderStudio(makeSession())
    await flush()
    const roles = [...container.querySelectorAll('video')].map((video) => video.dataset.role).sort()
    expect(roles).toEqual(['commentary', 'official'])
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

  it('快进画面 holds the voice back and 回退画面 holds the picture back', async () => {
    const session = makeSession()
    // Both sides present: an offset only means something between two sources.
    for (const role of ['official', 'commentary'] as const) {
      void session.loadSource(role, { kind: 'test', url: `/test-sources/${role}.mp4`, input: role, label: role, loop: true, viaProxy: false, platform: 'test' })
    }
    const apply = vi.spyOn(session, 'applyOffset')
    renderStudio(session)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: '快进画面' }))
    await waitFor(() => expect(apply).toHaveBeenCalled())
    expect(apply.mock.calls.at(-1)![0]).toBeLessThan(0)

    apply.mockClear()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '回退画面' }))
    fireEvent.click(screen.getByRole('button', { name: '回退画面' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    expect(apply.mock.calls.at(-1)![0]).toBeGreaterThan(apply.mock.calls[0]![0] as number)
  })

  it('moves the main picture only on ←/→ and nudges the alignment on , and .', async () => {
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
    // After a swap the keys follow the picture on the big screen.
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
