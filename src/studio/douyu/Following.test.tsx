/**
 * Followed rooms: unknown start times stay unknown, quick open goes where the button says,
 * and the live-notification switch sends exactly the scope that was chosen.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import { Session } from '../../app/session'
import { SessionProvider } from '../../app/SessionContext'
import type { DouyuFollowedRooms } from '../../../server/douyu/insightsTypes'
import { Following } from './Following'
import { resetLiveNotices } from './followingNotices'
import type { DouyuData } from './useDouyu'

type Call = { method: string; args: unknown }
let calls: Call[] = []
let listeners: Array<(event: FeatureEvent) => void> = []
let responses: Record<string, (args: unknown) => { ok: boolean; value?: unknown; code?: string; message?: string }> = {}
const sessions: Session[] = []

const followed = (patch: Partial<DouyuFollowedRooms> = {}): DouyuFollowedRooms => ({
  accountId: 'a1', checkedAt: 1, coverage: 'all-pages', pageCount: 1, reason: null,
  rooms: [
    { room: '100', roomName: '甲的直播间', nickname: '甲', live: true, replay: false, startedAt: null, popularity: 999, url: 'https://www.douyu.com/100' },
    { room: '200', roomName: '乙的直播间', nickname: '乙', live: false, replay: false, startedAt: null, popularity: null, url: 'https://www.douyu.com/200' },
  ],
  ...patch,
})

const dataFor = (loggedIn = true): DouyuData => ({
  active: { id: 'a1', label: '主号', active: true, busy: false, login: { loggedIn } },
}) as unknown as DouyuData

beforeEach(() => {
  calls = []
  listeners = []
  responses = {
    getDouyuFollowedRooms: () => ({ ok: true, value: followed() }),
    openStreamSession: (args) => ({ ok: true, value: { id: 'extra-1', input: (args as { input: string }).input, phase: 'opening', stream: null, buffer: null, error: null } }),
    setDouyuLiveNotifications: (args) => {
      const value = args as { enabled: boolean; rooms?: string[]; accountId?: string }
      return { ok: true, value: { enabled: value.enabled, rooms: value.rooms ?? [], followedAccountId: value.enabled ? value.accountId ?? null : null } }
    },
  }
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      const respond = responses[method]
      if (respond) return respond(args)
      return { ok: true, value: { presets: [] } }
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
  resetLiveNotices()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.unstubAllGlobals()
})

const named = (method: string): Call[] => calls.filter((call) => call.method === method)

function renderFollowing(onWatch = vi.fn(), data = dataFor()): { onWatch: typeof onWatch } {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  render(<SessionProvider session={session}><div className="studio"><Following data={data} onWatch={onWatch} /></div></SessionProvider>)
  return { onWatch }
}

const row = (name: RegExp): HTMLElement => screen.getByRole('group', { name })

describe('followed rooms', () => {
  it('lists the rooms with an unknown start time as unknown, not as zero', async () => {
    renderFollowing()
    await screen.findByRole('group', { name: /甲的直播间/ })
    expect(within(row(/甲的直播间/)).getByText('直播中')).toBeInTheDocument()
    expect(within(row(/甲的直播间/)).getByText('开播时间未知 · 已播时长未知')).toBeInTheDocument()
    expect(within(row(/乙的直播间/)).getByText('未开播')).toBeInTheDocument()
    expect(screen.getByText(/已读取全部 1 页/)).toBeInTheDocument()
    expect(named('getDouyuFollowedRooms')).toEqual([{ method: 'getDouyuFollowedRooms', args: { accountId: 'a1' } }])
  })

  it('says when only part of the list was read', async () => {
    responses.getDouyuFollowedRooms = () => ({ ok: true, value: followed({ coverage: 'partial', pageCount: 3, reason: '分页读取中断' }) })
    renderFollowing()
    expect(await screen.findByText(/仅读取到部分关注列表（3 页/)).toHaveTextContent('分页读取中断')
  })

  it('does not read without a signed-in account', async () => {
    renderFollowing(vi.fn(), dataFor(false))
    expect(screen.getByText('当前账号未登录，无法读取关注列表。')).toBeInTheDocument()
    await act(async () => {})
    expect(named('getDouyuFollowedRooms')).toEqual([])
  })

  it('watches as commentary through onWatch and opens an extra stream through IPC', async () => {
    const { onWatch } = renderFollowing()
    await screen.findByRole('group', { name: /甲的直播间/ })
    fireEvent.click(within(row(/甲的直播间/)).getByRole('button', { name: '作为解说观看' }))
    expect(onWatch).toHaveBeenCalledWith('100')
    expect(named('openStreamSession')).toEqual([])

    fireEvent.click(within(row(/乙的直播间/)).getByRole('button', { name: '同屏观看' }))
    await waitFor(() => expect(named('openStreamSession')).toEqual([{ method: 'openStreamSession', args: { input: '200', platform: 'douyu' } }]))
    expect(await within(row(/乙的直播间/)).findByText('已在同屏打开')).toBeInTheDocument()
  })

  it('shows why an extra stream could not be opened', async () => {
    responses.openStreamSession = () => ({ ok: false, code: 'stream-limit', message: '已达到当前直播会话资源上限' })
    renderFollowing()
    await screen.findByRole('group', { name: /甲的直播间/ })
    fireEvent.click(within(row(/甲的直播间/)).getByRole('button', { name: '同屏观看' }))
    expect(await within(row(/甲的直播间/)).findByRole('alert')).toHaveTextContent('已达到当前直播会话资源上限')
  })
})

describe('live notifications', () => {
  it('is off by default and sends the chosen rooms', async () => {
    renderFollowing()
    await screen.findByRole('group', { name: /甲的直播间/ })
    const toggle = screen.getByRole('switch', { name: /开播提醒/ })
    expect(toggle).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: '开播提醒 房间 100' }))
    expect(named('setDouyuLiveNotifications')).toEqual([])
    fireEvent.click(toggle)
    await waitFor(() => expect(named('setDouyuLiveNotifications').map((call) => call.args))
      .toEqual([{ enabled: true, rooms: ['100'], accountId: 'a1' }]))
    await waitFor(() => expect(screen.getByRole('switch', { name: /开播提醒/ })).toBeChecked())

    fireEvent.click(screen.getByRole('checkbox', { name: '开播提醒 房间 200' }))
    await waitFor(() => expect(named('setDouyuLiveNotifications').at(-1)?.args).toEqual({ enabled: true, rooms: ['100', '200'], accountId: 'a1' }))
  })

  it('sends the whole follow list with the account, and off when switched off', async () => {
    renderFollowing()
    await screen.findByRole('group', { name: /甲的直播间/ })
    fireEvent.click(screen.getByRole('radio', { name: '全部关注' }))
    fireEvent.click(screen.getByRole('switch', { name: /开播提醒/ }))
    await waitFor(() => expect(named('setDouyuLiveNotifications').map((call) => call.args)).toEqual([{ enabled: true, accountId: 'a1' }]))
    await screen.findByText(/已对当前账号的全部关注开启提醒/)
    fireEvent.click(screen.getByRole('switch', { name: /开播提醒/ }))
    await waitFor(() => expect(named('setDouyuLiveNotifications').at(-1)?.args).toEqual({ enabled: false }))
  })

  it('never sends an empty room choice as "every room"', async () => {
    renderFollowing()
    await screen.findByRole('group', { name: /甲的直播间/ })
    fireEvent.click(screen.getByRole('switch', { name: /开播提醒/ }))
    await waitFor(() => expect(named('setDouyuLiveNotifications').map((call) => call.args)).toEqual([{ enabled: false }]))
    expect(await screen.findByText('请在下方列表中选择需要提醒的房间。')).toBeInTheDocument()
  })

  it('shows live notices and monitor errors from the insights topic', async () => {
    renderFollowing()
    await screen.findByRole('group', { name: /甲的直播间/ })
    fireEvent.click(screen.getByRole('radio', { name: '全部关注' }))
    fireEvent.click(screen.getByRole('switch', { name: /开播提醒/ }))
    await screen.findByText(/已对当前账号的全部关注开启提醒/)
    const emit = (data: unknown): void => act(() => { for (const listener of listeners) listener({ topic: 'insights', data }) })
    const notification = { id: '200:5:1', room: '200', occurredAt: 5, source: 'follow-list' }
    emit({ type: 'live', notification })
    emit({ type: 'live', notification })
    const notices = screen.getByRole('list', { name: '开播通知' })
    expect(within(notices).getAllByText('乙的直播间（200） 已开播')).toHaveLength(1)
    emit({ type: 'monitor-error', accountId: 'a1', message: '关注列表不完整, 本轮未生成开播提醒.' })
    expect(screen.getByText(/监控状态：关注列表不完整/)).toBeInTheDocument()
  })
})
