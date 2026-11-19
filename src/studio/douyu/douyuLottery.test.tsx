import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DouyuLotterySnapshot } from '../../../server/douyu/douyuLotteryTypes'
import { DouyuLotteryCard, DouyuLotteryCommandGroup, matchDouyuLotteryCommand, useDouyuLottery, type DouyuLotteryActions } from './douyuLottery'

const NOW = Date.parse('2026-11-17T00:00:00Z')
const COMMAND = ' 原文口令 <img> '
const data = (room = '100', id = '456'): DouyuLotterySnapshot => ({
  room, status: 'active', serverNow: NOW,
  activity: { id, room, prize: '<script>奖品</script>', prizeCount: 1, startsAt: NOW - 60_000, endsAt: NOW + 5_000,
    joinType: 1, command: COMMAND, conditions: ['需要关注和粉丝团身份'], eligibility: 'unknown', gift: null, cost: null },
})
const actions = {
  read: vi.fn<DouyuLotteryActions['read']>(),
  openOfficialRoom: vi.fn<DouyuLotteryActions['openOfficialRoom']>(),
  notify: vi.fn(() => vi.fn()),
}
let monotonic = 0
async function advance(ms: number) {
  monotonic += ms
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
function Harness({ room = '100', connected = true }: { room?: string; connected?: boolean }) {
  const view = useDouyuLottery(room, connected, actions)
  return <DouyuLotteryCard view={view} />
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  monotonic = 0
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  actions.read.mockReset().mockImplementation(async room => ({ ok: true, value: data(room) }))
  actions.openOfficialRoom.mockReset().mockResolvedValue({ ok: true, value: { opened: true } })
  actions.notify.mockClear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

it('uses platform time, displays literal text and cleans up an expired reminder', async () => {
  render(<Harness />)
  await act(async () => {})
  expect(screen.getByText('<script>奖品</script>（1 份）')).toBeInTheDocument()
  expect(document.querySelector('.douyu-lottery script, .douyu-lottery img')).toBeNull()
  expect(screen.getByRole('switch', { name: '抽奖提醒' })).not.toBeChecked()
  expect(screen.getByLabelText('真实开奖倒计时')).toHaveTextContent('0:05')
  fireEvent.click(screen.getByRole('switch', { name: '抽奖提醒' }))
  expect(actions.notify).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '打开官方房间' }))
  await act(async () => {})
  expect(actions.openOfficialRoom).toHaveBeenCalledWith('100', '456')
  vi.setSystemTime('2030-01-01')
  await advance(5_000)
  expect(screen.queryByLabelText('真实开奖倒计时')).toBeNull()
  expect(actions.notify.mock.results[0]!.value).toHaveBeenCalled()
})

it('shows a gift price without displaying a previous text command', async () => {
  const value = data()
  value.activity = { ...value.activity!, joinType: 2, gift: { id: '22', name: '礼物', count: 3, priceOriginal: '150' },
    cost: { currency: 'YUCHI', totalMinor: 450, scale: 100 } }
  actions.read.mockResolvedValue({ ok: true, value })
  render(<Harness />)
  await act(async () => {})
  expect(screen.getByText(/礼物标价 4.5 鱼翅/)).toBeInTheDocument()
  expect(screen.queryByText(/官方口令/)).toBeNull()
})

it('ignores old room reads, shows failures and stops polling on disconnect', async () => {
  let finish!: (result: Awaited<ReturnType<DouyuLotteryActions['read']>>) => void
  actions.read.mockImplementation(room => room === '100' ? new Promise(resolve => { finish = resolve }) : Promise.reject(new Error('offline')))
  const view = render(<Harness />)
  await act(async () => {})
  view.rerender(<Harness room="200" />)
  await act(async () => { finish({ ok: true, value: data() }) })
  expect(screen.getByText('抽奖状态或官方时间暂时无法确认')).toBeInTheDocument()
  view.rerender(<Harness room="200" connected={false} />)
  await advance(30_000)
  expect(actions.read).toHaveBeenCalledTimes(2)
})

it('tags only exact same-room text received during the observed text round', () => {
  const snapshot = data()
  const message = { room: '100', text: COMMAND, receivedAt: NOW + 1 }
  expect(matchDouyuLotteryCommand(snapshot, NOW, message)).toBe('456')
  expect(matchDouyuLotteryCommand(snapshot, NOW, { ...message, text: COMMAND.trim() })).toBeNull()
  expect(matchDouyuLotteryCommand(snapshot, NOW, { ...message, room: '200' })).toBeNull()
  expect(matchDouyuLotteryCommand(snapshot, NOW, { ...message, system: true })).toBeNull()
  expect(matchDouyuLotteryCommand(snapshot, NOW, { ...message, receivedAt: NOW - 1 })).toBeNull()
  expect(matchDouyuLotteryCommand(snapshot, NOW, { ...message, receivedAt: NOW + 5000 })).toBeNull()
  expect(matchDouyuLotteryCommand({ ...snapshot, activity: { ...snapshot.activity!, joinType: 2 } }, NOW, message)).toBeNull()
  const next = { ...snapshot, activity: { ...snapshot.activity!, id: '789' } }
  expect(matchDouyuLotteryCommand(next, NOW + 3_000, message)).toBeNull()
  expect(matchDouyuLotteryCommand(next, NOW, message)).toBe('789')
})

it('keeps suspected commands expandable and the announcement outside the fold', () => {
  render(<><DouyuLotteryCommandGroup count={2}><div>用户手打同文</div><div>另一条同文</div></DouyuLotteryCommandGroup><div>开奖公告</div></>)
  const summary = screen.getByText('2 条疑似抽奖口令')
  const details = summary.closest('details')!
  expect(details.open).toBe(false)
  expect(screen.getByText('开奖公告').closest('details')).toBeNull()
  fireEvent.click(summary)
  expect(details.open).toBe(true)
  expect(details).toContainElement(screen.getByText('用户手打同文'))
})
