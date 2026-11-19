import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HuyaOnTvCard, HuyaRoomWatchStatus, type HuyaOnTvCardProps } from './HuyaOnTvCard'
import type { HuyaOnTvSnapshot } from '../../server/platforms/huyaOnTv'

const room = 'huya:99798'
const observedAt = 1_800_000_000_000
const active: HuyaOnTvSnapshot = { room, status: 'active', observedAt, activity: {
  id: '4096', title: '合成主题', prize: '合成奖品', mode: 2, conditions: ['个人资格未查询'],
  cost: '需要指定礼物', qualification: 'unknown', endsAt: 1_800_000_200_000, serverNow: 1_800_000_140_000,
} }
const props = (): HuyaOnTvCardProps => ({
  room, snapshot: active, connected: true, reminders: false, onRemindersChange: vi.fn(),
})

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(observedAt) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('shows prizes and conditions and counts down using the panel time anchor', async () => {
  const openOfficialRoom = vi.fn(async () => ({ ok: true } as const))
  const input = props()
  const view = render(<HuyaOnTvCard {...input} openOfficialRoom={openOfficialRoom} />)
  expect(screen.getByText('奖品: 合成奖品')).toBeInTheDocument()
  expect(screen.getByText('需要指定礼物')).toBeInTheDocument()
  expect(screen.getByText('个人资格未查询')).toBeInTheDocument()
  expect(screen.getByLabelText('上电视开奖倒计时')).toHaveTextContent('01:00')
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(screen.getByLabelText('上电视开奖倒计时')).toHaveTextContent('00:58')
  fireEvent.click(screen.getByRole('switch', { name: '上电视活动提醒' }))
  expect(input.onRemindersChange).toHaveBeenCalledWith(true)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开虎牙官方房间' })) })
  expect(openOfficialRoom).toHaveBeenCalledWith(room)
  expect(screen.queryByRole('button', { name: /赠送|参与|兑奖/ })).toBeNull()
  view.rerender(<HuyaOnTvCard {...input} room="huya:123" />)
  expect(screen.queryByText('奖品: 合成奖品')).toBeNull()
  expect(screen.queryByRole('button', { name: '打开虎牙官方房间' })).toBeNull()
})

it('renders none, ended, stale and disconnected activity states', () => {
  const input = props()
  const view = render(<HuyaOnTvCard {...input} snapshot={{ room, status: 'none', observedAt, activity: null }} />)
  expect(screen.getByRole('status')).toHaveTextContent('当前未检测到上电视')
  view.rerender(<HuyaOnTvCard {...input} snapshot={{ ...active, status: 'ended' }} />)
  expect(screen.getByRole('status')).toHaveTextContent('本轮已结束')
  view.rerender(<HuyaOnTvCard {...input} snapshot={{ ...active, observedAt: observedAt - 46_000 }} />)
  expect(screen.getByRole('status')).toHaveTextContent('暂不可用')
  expect(screen.queryByText('奖品: 合成奖品')).toBeNull()
  view.rerender(<HuyaOnTvCard {...input} connected={false} />)
  expect(screen.getByRole('status')).toHaveTextContent('连接恢复后继续检测')
})

it('keeps account watch evidence independent of the active panel', () => {
  render(<HuyaRoomWatchStatus room={room} />)
  expect(screen.getByText('本房官方今日及累计观看时长未验证')).toBeInTheDocument()
  expect(screen.getByText(/看过 可查询浏览记录/)).toBeInTheDocument()
})
