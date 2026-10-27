/**
 * Room statistics only ever show what was received: a value the platform did not give is
 * 未知, never 0; and the watch-time heartbeat only reports a playing flag, always closing
 * with false when the room or the page goes away.
 */

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { DouyuRoomInsights } from '../../../server/douyu/insightsTypes'

const media = vi.hoisted(() => {
  const initial = () => ({
    danmaku: { room: '100' as string | null },
    media: {
      official: { status: 'ready', paused: true },
      commentary: { status: 'empty', paused: true },
    },
  })
  return { initial, snapshot: initial() }
})

vi.mock('../../app/SessionContext', () => ({
  useSessionSnapshot: () => media.snapshot,
  useSession: () => ({}),
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

beforeEach(() => {
  calls = []
  listeners = []
  responses = {
    getDouyuRoomInsights: () => insights(),
    refreshDouyuRoomInsights: () => insights(),
    listDouyuAccounts: () => ({ activeAccountId: 'a1', accounts: [{ id: 'a1', label: '主号', active: true, busy: false, login: { loggedIn: true } }] }),
    getDouyuWatchTime: () => ({ accountId: 'a1', room: '100', checkedAt: 1, seconds: null, source: 'douyu-today-watch' }),
    getDanmakuRate: () => ({ room: '100', receivedLastMinute: 0, messagesPerMinute: 0, sampleSeconds: 0, since: null }),
    reportDouyuPlayback: () => insights(),
  }
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      const respond = responses[method]
      return respond ? { ok: true, value: respond(args) } : { ok: false, code: 'unexpected', message: 'unexpected' }
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
    responses.getDouyuRoomInsights = () => insights({
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
    expect(named('getDouyuRoomInsights')).toHaveLength(1)
    responses.getDouyuRoomInsights = () => insights({ uniqueChatters: 40 })
    act(() => { for (const listener of listeners) listener({ topic: 'insights', data: { type: 'changed', room: '999' } }) })
    act(() => { for (const listener of listeners) listener({ topic: 'insights', data: { type: 'changed', room: '100' } }) })
    await screen.findByText('40')
    expect(named('getDouyuRoomInsights')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(named('refreshDouyuRoomInsights')).toEqual([{ method: 'refreshDouyuRoomInsights', args: { room: '100' } }]))
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

  it('never reports Huya playback to Douyu statistics, including after changing rooms', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = renderHook(() => usePlaybackHeartbeat())
    media.snapshot = { ...media.snapshot, danmaku: { room: 'huya:660000' } }
    rerender()
    vi.advanceTimersByTime(15_000)
    window.dispatchEvent(new Event('pagehide'))
    unmount()
    expect(reports()).toEqual([{ room: '100', playing: false }, { room: '100', playing: false }])
  })

  it('reports the playing flag on change and every 5 s, and false on unmount', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = renderHook(() => usePlaybackHeartbeat())
    expect(reports()).toEqual([{ room: '100', playing: false }])
    vi.advanceTimersByTime(5_000)
    expect(reports()).toHaveLength(1)

    media.snapshot = { ...media.snapshot, media: { ...media.snapshot.media, commentary: { status: 'ready', paused: false } } }
    rerender()
    expect(reports().at(-1)).toEqual({ room: '100', playing: true })
    vi.advanceTimersByTime(5_000)
    expect(reports()).toHaveLength(3)
    expect(reports().at(-1)).toEqual({ room: '100', playing: true })

    unmount()
    expect(reports().at(-1)).toEqual({ room: '100', playing: false })
    for (const args of reports()) expect(Object.keys(args as object).sort()).toEqual(['playing', 'room'])
  })

  it('keeps playing while one source plays and the other is paused', () => {
    media.snapshot = { ...media.snapshot, media: { official: { status: 'ready', paused: false }, commentary: { status: 'ready', paused: true } } }
    renderHook(() => usePlaybackHeartbeat())
    expect(reports()).toEqual([{ room: '100', playing: true }])
  })

  it('reports false for the old room before the new room', () => {
    media.snapshot = { ...media.snapshot, media: { ...media.snapshot.media, commentary: { status: 'ready', paused: false } } }
    const { rerender } = renderHook(() => usePlaybackHeartbeat())
    media.snapshot = { ...media.snapshot, danmaku: { room: '200' } }
    rerender()
    expect(reports()).toEqual([
      { room: '100', playing: true },
      { room: '100', playing: false },
      { room: '200', playing: true },
    ])
    media.snapshot = { ...media.snapshot, danmaku: { room: null } }
    rerender()
    expect(reports().at(-1)).toEqual({ room: '200', playing: false })
  })
})
