/**
 * Room statistics only ever show what was received: a value the platform did not give is
 * 未知, never 0. Playback reports follow the matched video and close with false when its
 * progress stops, the source changes, or the room/page goes away.
 */

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { DouyuRoomInsights } from '../../../server/douyu/insightsTypes'
import type { DouyuWatchState } from '../../../server/douyu/watchTypes'

const media = vi.hoisted(() => {
  const initial = () => ({
    danmaku: { room: '100' as string | null },
    media: {
      official: { status: 'ready', paused: true, descriptor: { platform: 'douyu', sourceRoom: '100', url: '/official.m3u8' } },
      commentary: { status: 'empty', paused: true, descriptor: { platform: 'douyu', sourceRoom: '100', url: '/commentary.m3u8' } },
    },
  })
  return { initial, snapshot: initial(), session: { engine: { element: vi.fn() } } }
})

vi.mock('../../app/SessionContext', () => ({
  useSessionSnapshot: () => media.snapshot,
  useSession: () => media.session,
}))

import { RoomInsightsSheet, useDanmakuRate, usePlaybackHeartbeat } from './RoomInsights'

type Call = { method: string; args: unknown }
let calls: Call[] = []
let listeners: Array<(event: FeatureEvent) => void> = []
let responses: Record<string, (args: unknown) => unknown> = {}

const insights = (patch: Partial<DouyuRoomInsights> = {}): DouyuRoomInsights => ({
  room: '100', observedSince: Date.UTC(2026, 9, 26, 4), checkedAt: Date.UTC(2026, 9, 26, 5), connected: true,
  live: null, replay: null, startedAt: null, lastStartedAt: null, broadcastSeconds: null, localWatchSeconds: 0,
  viewers: null, uniqueChatters: 12, uniqueGiftSenders: 0, nobles: null,
  gifts: { count: 3, knownValueMinor: 0, unknownValueCount: 3, totalValueMinor: null, currency: 'YUCHI', scale: 100, valuation: 'catalog-nominal' },
  ranks: null,
  coverage: { source: 'received-events', completeRoomHistory: false, disconnected: false, droppedEvents: 0, unknownSenderEvents: 0, uniqueUsersTruncated: false },
  ...patch,
})

const watchState = (patch: Partial<DouyuWatchState> = {}): DouyuWatchState => ({
  accountId: 'a1', room: '100', phase: 'unverified', reason: null, officialSeconds: null, baselineSeconds: null,
  verifiedIncrease: 0, checkedAt: null, lastHeartbeatAt: null,
  cumulativeSeconds: null, cumulativeBaselineSeconds: null, cumulativeIncrease: 0, cumulativeCheckedAt: null, badgeOwned: null, badgeLevel: null, ...patch,
})

function fakeVideo() {
  const video = document.createElement('video')
  const state = { currentTime: 0, paused: true, seeking: false, ended: false, readyState: 4, error: null as MediaError | null,
    bytes: 0 as number | undefined, frames: 0, dropped: 0 }
  Object.defineProperties(video, {
    currentTime: { get: () => state.currentTime, set: (value: number) => { state.currentTime = value } },
    paused: { get: () => state.paused }, seeking: { get: () => state.seeking }, ended: { get: () => state.ended },
    readyState: { get: () => state.readyState }, error: { get: () => state.error },
    webkitVideoDecodedByteCount: { get: () => state.bytes },
  })
  video.getVideoPlaybackQuality = () => ({ totalVideoFrames: state.frames, droppedVideoFrames: state.dropped,
    corruptedVideoFrames: 0, creationTime: 0 })
  return { video, state }
}

let videos: Record<'official' | 'commentary', ReturnType<typeof fakeVideo>>

beforeEach(() => {
  calls = []
  listeners = []
  videos = { official: fakeVideo(), commentary: fakeVideo() }
  media.session.engine.element.mockImplementation((role: 'official' | 'commentary') => videos[role].video)
  responses = {
    getDouyuRoomInsights: () => insights(),
    refreshDouyuRoomInsights: () => insights(),
    listDouyuAccounts: () => ({ activeAccountId: 'a1', accounts: [{ id: 'a1', label: '主号', active: true, busy: false, login: { loggedIn: true } }] }),
    getDouyuWatchTime: () => ({ accountId: 'a1', room: '100', checkedAt: 1, seconds: null, source: 'douyu-today-watch' }),
    getDouyuFansWatchTime: () => ({ accountId: 'a1', room: '100', checkedAt: 1, seconds: null, badgeOwned: null, badgeLevel: null, source: 'douyu-fanshome-cumulative' }),
    getDanmakuRate: () => ({ room: '100', receivedLastMinute: 0, messagesPerMinute: 0, sampleSeconds: 0, since: null }),
    reportDouyuPlayback: () => insights(),
    getDouyuWatchState: () => watchState(),
    reportDouyuWatchPlayback: () => watchState(),
  }
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      const respond = responses[method]
      return respond ? { ok: true, value: await respond(args) } : { ok: false, code: 'unexpected', message: 'unexpected' }
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeFeatures: (listener: (event: FeatureEvent) => void) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((item) => item !== listener) }
    },
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  media.snapshot = media.initial()
})

const named = (method: string): Call[] => calls.filter((call) => call.method === method)

describe('room insights sheet', () => {
  it('shows the official cumulative seconds and owned badge instead of daily counter as cumulative time', async () => {
    responses.getDouyuFansWatchTime = () => ({ accountId: 'a1', room: '100', checkedAt: 1, seconds: 4810476, badgeOwned: true, badgeLevel: 22, source: 'douyu-fanshome-cumulative' })
    render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    const group = await screen.findByRole('group', { name: '粉丝牌累计观看' })
    await within(group).findByText(/已持有 22 级粉丝牌/)
    expect(group.textContent).toContain('斗鱼粉丝家园累计观看')
    act(() => { for (const listener of listeners) listener({ topic: 'insights', data: { type: 'changed', room: '100' } }) })
    await waitFor(() => expect(named('getDouyuRoomInsights')).toHaveLength(2))
    expect(group.textContent).toContain('已持有 22 级粉丝牌')
    act(() => { for (const listener of listeners) listener({ topic: 'douyu-watch', data: watchState({ phase: 'login-required' }) }) })
    expect(within(group).getByText('未知')).toBeInTheDocument()
  })

  it.each([
    { live: true, replay: false, text: '直播中' },
    { live: true, replay: true, text: '轮播中' },
    { live: false, replay: true, text: '轮播中' },
    { live: false, replay: false, text: '未开播' },
    { live: true, replay: null, text: '直播或轮播状态未确认' },
  ])('distinguishes $text without assuming an unknown replay flag is live', async ({ live, replay, text }) => {
    responses.refreshDouyuRoomInsights = () => insights({ live, replay })
    render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    const group = await screen.findByRole('group', { name: '开播状态' })
    expect(within(group).getByText(text)).toBeInTheDocument()
    expect(named('refreshDouyuRoomInsights')).toHaveLength(1)
  })

  it('refreshes official room status periodically and stops after the sheet closes', async () => {
    vi.useFakeTimers()
    const view = render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    responses.refreshDouyuRoomInsights = () => insights({ live: false, replay: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(within(screen.getByRole('group', { name: '开播状态' })).getByText('轮播中')).toBeInTheDocument()
    expect(named('refreshDouyuRoomInsights')).toHaveLength(2)
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(named('refreshDouyuRoomInsights')).toHaveLength(2)
  })

  it('shows values the platform did not give as 未知, not 0', async () => {
    render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    await screen.findByRole('group', { name: '观众人数' })
    await waitFor(() => expect(named('getDouyuWatchTime')).toHaveLength(1))
    for (const label of ['观众人数', '贵宾人数', '目录标称价值', '已播时长', '本次开播', '上次开播', '官方今日观看']) {
      const group = screen.getByRole('group', { name: label })
      expect(within(group).getByText('未知')).toBeInTheDocument()
    }
    expect(within(screen.getByRole('group', { name: '目录标称价值' })).getByText(/3 件价格未知/)).toBeInTheDocument()
    expect(screen.getByText(/不是房间的完整历史/)).toBeInTheDocument()
  })

  it('shows rank contribution as gold / 100 and never as money', async () => {
    responses.refreshDouyuRoomInsights = () => insights({
      ranks: {
        room: '100', receivedAt: 1, source: 'anonymous-ranklist', unit: 'douyu-gold-divided-by-100', currency: null,
        day: [{ uid: '1', nickname: '甲', gold: 12345, contribution: null }, { uid: '2', nickname: '乙', gold: null, contribution: null }],
        week: null, all: [],
      },
    })
    render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    await screen.findByRole('group', { name: '观众人数' })
    fireEvent.click(screen.getByRole('tab', { name: '榜单' }))
    const table = screen.getByRole('table')
    expect(within(table).getByText('贡献值')).toBeInTheDocument()
    expect(within(table).getByText('123.45')).toBeInTheDocument()
    expect(within(table).getByText('未知')).toBeInTheDocument()
    expect(table.textContent).not.toContain('元')
    fireEvent.click(screen.getByRole('radio', { name: '周榜' }))
    expect(screen.getByText('未收到周榜。')).toBeInTheDocument()
  })

  it('re-reads the room when the main process says it changed, and refreshes on request', async () => {
    render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    await screen.findByRole('group', { name: '观众人数' })
    expect(named('refreshDouyuRoomInsights')).toHaveLength(1)
    responses.getDouyuRoomInsights = () => insights({ uniqueChatters: 40 })
    act(() => { for (const listener of listeners) listener({ topic: 'insights', data: { type: 'changed', room: '999' } }) })
    act(() => { for (const listener of listeners) listener({ topic: 'insights', data: { type: 'changed', room: '100' } }) })
    await screen.findByText('40')
    expect(named('getDouyuRoomInsights')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(named('refreshDouyuRoomInsights')).toHaveLength(2))
  })

  it('only shows cumulative badge growth after a positive cumulative query and confirmed ownership', async () => {
    responses.getDouyuWatchState = () => watchState({ phase: 'reporting', lastHeartbeatAt: 1 })
    render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    const group = await screen.findByRole('group', { name: '官方观时上报' })
    await within(group).findByText('正在上报')
    expect(group.textContent).not.toContain('粉丝牌累计观时已增长')
    act(() => { for (const listener of listeners) listener({ topic: 'douyu-watch', data: watchState({ phase: 'verified', verifiedIncrease: 0 }) }) })
    expect(within(group).getByText('累计观时未确认增长')).toBeInTheDocument()
    act(() => { for (const listener of listeners) listener({ topic: 'douyu-watch', data: watchState({ phase: 'verified', verifiedIncrease: 60 }) }) })
    expect(within(group).getByText('累计观时未确认增长')).toBeInTheDocument()
    act(() => { for (const listener of listeners) listener({ topic: 'douyu-watch', data: watchState({ phase: 'verified', cumulativeIncrease: 60, badgeOwned: true }) }) })
    expect(within(group).getByText('粉丝牌累计观时已增长')).toBeInTheDocument()
    expect(within(group).getByText(/本次粉丝牌累计观看增加 1 分 0 秒/)).toBeInTheDocument()
  })

  it('updates official time from the latest query and clears the old account value on switching', async () => {
    responses.getDouyuWatchTime = () => ({ accountId: 'a1', room: '100', checkedAt: 1, seconds: 60, source: 'douyu-today-watch' })
    render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    const group = await screen.findByRole('group', { name: '官方今日观看' })
    await within(group).findByText('1 分 0 秒')
    act(() => { for (const listener of listeners) listener({ topic: 'douyu-watch', data: watchState({ officialSeconds: 120, checkedAt: 2 }) }) })
    expect(within(group).getByText('2 分 0 秒')).toBeInTheDocument()
    act(() => { for (const listener of listeners) listener({ topic: 'douyu-watch', data: watchState({ accountId: 'a2', room: null }) }) })
    expect(within(group).getByText('未知')).toBeInTheDocument()
    expect(within(group).getByText('当前账号官方观看时长尚未读取')).toBeInTheDocument()
  })

  it('keeps a pushed watch state when an older initial read answers later', async () => {
    let finish!: (value: DouyuWatchState) => void
    responses.getDouyuWatchState = () => new Promise<DouyuWatchState>(resolve => { finish = resolve })
    const { rerender } = render(<RoomInsightsSheet room="100" onClose={() => {}} />)
    await screen.findByRole('group', { name: '官方观时上报' })
    act(() => { for (const listener of listeners) listener({ topic: 'douyu-watch', data: watchState({ phase: 'verified', cumulativeIncrease: 60, badgeOwned: true }) }) })
    await act(async () => { finish(watchState({ phase: 'connecting' })) })
    expect(screen.getByText('粉丝牌累计观时已增长')).toBeInTheDocument()
    responses.refreshDouyuRoomInsights = () => insights({ room: '200' })
    rerender(<RoomInsightsSheet room="200" onClose={() => {}} />)
    await waitFor(() => expect(named('refreshDouyuRoomInsights').at(-1)?.args).toEqual({ room: '200' }))
    expect(within(screen.getByRole('group', { name: '官方观时上报' })).getByText('尚未启动')).toBeInTheDocument()
  })
})

describe('danmaku rate', () => {
  it('does not query Douyu rates for a Huya room', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDanmakuRate('huya:660000'))
    vi.advanceTimersByTime(30_000)
    expect(result.current).toBeNull()
    expect(named('getDanmakuRate')).toEqual([])
  })
  it('is null until something was received, then follows the room', async () => {
    const { result, rerender } = renderHook(({ room }) => useDanmakuRate(room), { initialProps: { room: '100' as string | null } })
    await waitFor(() => expect(named('getDanmakuRate')).toHaveLength(1))
    expect(result.current).toBeNull()
    responses.getDanmakuRate = (args) => ({ room: (args as { room: string }).room, receivedLastMinute: 30, messagesPerMinute: 42, sampleSeconds: 60, since: 1 })
    rerender({ room: '200' })
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe(42))
    expect(named('getDanmakuRate').at(-1)?.args).toEqual({ room: '200' })
    rerender({ room: null })
    expect(result.current).toBeNull()
  })
})

describe('playback heartbeat', () => {
  const reports = (): unknown[] => named('reportDouyuPlayback').map((call) => call.args)
  const watchReports = (): Array<{ role: string; playing: boolean; currentTime: number; decodedBytes: number | null; presentedFrames: number | null }> =>
    named('reportDouyuWatchPlayback').map(call => call.args as { role: string; playing: boolean; currentTime: number; decodedBytes: number | null; presentedFrames: number | null })
  const ready = (role: 'official' | 'commentary', room = '100', platform = 'douyu'): void => {
    media.snapshot = { ...media.snapshot, media: { ...media.snapshot.media,
      [role]: { ...media.snapshot.media[role], status: 'ready', paused: false,
        descriptor: { ...media.snapshot.media[role].descriptor, platform, sourceRoom: room } } } }
    videos[role].state.paused = false
  }
  const progress = (roles: Array<'official' | 'commentary'>): void => {
    act(() => {
      for (const role of roles) {
        videos[role].video.currentTime += 2
        videos[role].state.frames += 120
        if (videos[role].state.bytes !== undefined) videos[role].state.bytes += 1000
      }
      vi.advanceTimersByTime(2000)
    })
  }

  it('never reports Huya playback to Douyu statistics, including after changing rooms', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = renderHook(() => usePlaybackHeartbeat())
    media.snapshot = { ...media.snapshot, danmaku: { room: 'huya:660000' } }
    rerender()
    vi.advanceTimersByTime(15_000)
    window.dispatchEvent(new Event('pagehide'))
    unmount()
    expect(reports()).toEqual([{ room: '100', playing: false }, { room: '100', playing: false }])
    expect(watchReports().some(report => report.playing)).toBe(false)
  })

  it('reports actual progress and keeps a separate local heartbeat, closing on unmount', () => {
    vi.useFakeTimers()
    ready('commentary')
    const { unmount } = renderHook(() => usePlaybackHeartbeat())
    expect(reports()).toEqual([{ room: '100', playing: false }])
    expect(watchReports().at(-1)).toEqual({ role: 'commentary', playing: false, currentTime: 0, decodedBytes: 0, presentedFrames: 0 })
    progress(['commentary'])
    expect(reports().at(-1)).toEqual({ room: '100', playing: true })
    expect(watchReports().at(-1)).toEqual({ role: 'commentary', playing: true, currentTime: 2, decodedBytes: 1000, presentedFrames: 120 })
    progress(['commentary'])
    act(() => { vi.advanceTimersByTime(1000) })
    expect(reports()).toHaveLength(3)
    expect(reports().at(-1)).toEqual({ room: '100', playing: true })
    unmount()
    expect(reports().at(-1)).toEqual({ room: '100', playing: false })
    for (const args of reports()) expect(Object.keys(args as object).sort()).toEqual(['playing', 'room'])
    for (const args of watchReports()) expect(Object.keys(args).sort()).toEqual(['currentTime', 'decodedBytes', 'playing', 'presentedFrames', 'role'])
  })

  it('keeps local time active when one matching source pauses and the other advances', () => {
    vi.useFakeTimers()
    ready('official'); ready('commentary')
    renderHook(() => usePlaybackHeartbeat())
    progress(['official', 'commentary'])
    act(() => {
      videos.commentary.state.paused = true
      videos.commentary.video.dispatchEvent(new Event('pause'))
    })
    expect(reports().at(-1)).toEqual({ room: '100', playing: true })
    progress(['official'])
    expect(watchReports().filter(report => report.role === 'official').at(-1)?.playing).toBe(true)
    expect(watchReports().filter(report => report.role === 'commentary').at(-1)?.playing).toBe(false)
  })

  it('reports false for the old room and establishes a new source baseline', () => {
    vi.useFakeTimers()
    ready('commentary')
    const { rerender } = renderHook(() => usePlaybackHeartbeat())
    progress(['commentary'])
    media.snapshot = { ...media.snapshot, danmaku: { room: '200' } }
    ready('commentary', '200')
    rerender()
    expect(reports().slice(-2)).toEqual([{ room: '100', playing: false }, { room: '200', playing: false }])
    expect(watchReports().at(-1)?.playing).toBe(false)
    progress(['commentary'])
    expect(reports().at(-1)).toEqual({ room: '200', playing: true })
    media.snapshot = { ...media.snapshot, danmaku: { room: null } }
    rerender()
    expect(reports().at(-1)).toEqual({ room: '200', playing: false })
  })

  it.each([['huya', '100'], ['bilibili', '100'], ['douyu', '200']])('does not count %s room %s under the selected room', (platform, room) => {
    vi.useFakeTimers()
    ready('official', room, platform)
    renderHook(() => usePlaybackHeartbeat())
    progress(['official'])
    expect(watchReports()).toEqual([])
    expect(reports()).toEqual([{ room: '100', playing: false }])
  })

  it('stops when media stops advancing even if ready and not paused', () => {
    vi.useFakeTimers()
    ready('official')
    renderHook(() => usePlaybackHeartbeat())
    progress(['official'])
    act(() => { vi.advanceTimersByTime(2000) })
    expect(watchReports().at(-1)?.playing).toBe(false)
    expect(reports().at(-1)).toEqual({ room: '100', playing: false })
  })

  it.each(['paused', 'seeking', 'ended', 'readyState', 'error'] as const)('uses the actual video %s guard even when the session says ready', guard => {
    vi.useFakeTimers()
    ready('official')
    renderHook(() => usePlaybackHeartbeat())
    progress(['official'])
    if (guard === 'readyState') videos.official.state.readyState = 1
    else if (guard === 'error') videos.official.state.error = { code: 3, message: 'synthetic decode error' } as MediaError
    else videos.official.state[guard] = true
    progress(['official'])
    expect(watchReports().at(-1)?.playing).toBe(false)
    expect(reports().at(-1)).toEqual({ room: '100', playing: false })
  })

  it.each(['pause', 'waiting', 'seeking', 'error'])('stops immediately on %s and requires a new progress baseline', event => {
    vi.useFakeTimers()
    ready('official')
    renderHook(() => usePlaybackHeartbeat())
    progress(['official'])
    act(() => { videos.official.video.dispatchEvent(new Event(event)) })
    expect(watchReports().at(-1)?.playing).toBe(false)
    expect(reports().at(-1)).toEqual({ room: '100', playing: false })
    progress(['official'])
    expect(watchReports().at(-1)?.playing).toBe(false)
    progress(['official'])
    expect(watchReports().at(-1)?.playing).toBe(true)
  })

  it('does not count a seeking jump or a frame counter reset as progress', () => {
    vi.useFakeTimers()
    ready('official')
    renderHook(() => usePlaybackHeartbeat())
    progress(['official'])
    act(() => {
      videos.official.state.seeking = true
      videos.official.video.currentTime = 500
      videos.official.state.frames = 0
      vi.advanceTimersByTime(2000)
    })
    expect(watchReports().at(-1)?.playing).toBe(false)
    videos.official.state.seeking = false
    progress(['official'])
    expect(watchReports().at(-1)?.playing).toBe(false)
  })

  it('does not estimate missing byte counters and accepts actual frame progress', () => {
    vi.useFakeTimers()
    ready('official')
    videos.official.state.bytes = undefined
    renderHook(() => usePlaybackHeartbeat())
    act(() => {
      videos.official.state.frames += 1
      vi.advanceTimersByTime(2000)
    })
    expect(watchReports().at(-1)).toEqual({ role: 'official', playing: true, currentTime: 0, decodedBytes: null, presentedFrames: 1 })
  })

  it('releases an old element when the media engine replaces it', () => {
    vi.useFakeTimers()
    ready('official')
    renderHook(() => usePlaybackHeartbeat())
    progress(['official'])
    const previous = videos.official
    videos.official = fakeVideo()
    videos.official.state.paused = false
    progress(['official'])
    expect(watchReports().slice(-2).map(report => report.playing)).toEqual([false, false])
    const count = watchReports().length
    act(() => { previous.video.dispatchEvent(new Event('pause')) })
    expect(watchReports()).toHaveLength(count)
    progress(['official'])
    expect(watchReports().at(-1)?.playing).toBe(true)
  })

  it('closes on pagehide and never restarts from its remaining timers', () => {
    vi.useFakeTimers()
    ready('official')
    renderHook(() => usePlaybackHeartbeat())
    progress(['official'])
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(watchReports().at(-1)?.playing).toBe(false)
    const count = watchReports().length
    progress(['official'])
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(watchReports()).toHaveLength(count)
  })
})
