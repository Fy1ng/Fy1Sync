import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOUYIN_LOTTERY_POLL_MS, type DouyinLotterySnapshot } from '../../core/douyinLottery'
import { parseDouyinLottery } from '../../../server/douyin/douyinLotteryReader'
import { DOUYIN_LOTTERY_FIXTURE_TARGET as target, douyinLotteryFixture } from '../../../server/douyin/fixtures/douyinLotteryFixture'
import { DouyinLotteryCard } from './DouyinLotteryCard'
import { useDouyinLottery, type DouyinLotteryActions } from './useDouyinLottery'

function Harness({ actions, room = target.room, serial = 1 }: {
  actions: DouyinLotteryActions; room?: string; serial?: number | null
}) {
  const view = useDouyinLottery(room, serial, actions)
  return view && <DouyinLotteryCard view={view} />
}

const active = (seconds = 90) => {
  const now = Date.now()
  return parseDouyinLottery(douyinLotteryFixture(now, seconds), target, now)
}

afterEach(() => vi.useRealTimers())

describe('Douyin lottery card', () => {
  it('shows conditions, offers reversible folding off by default, and scopes the official entry', async () => {
    const read = vi.fn<DouyinLotteryActions['read']>(async () => active())
    const openOfficial = vi.fn<NonNullable<DouyinLotteryActions['openOfficial']>>(async () => ({ ok: false, message: '活动已结束.' }))
    render(<Harness actions={{ read, openOfficial }} />)
    expect(await screen.findByText('发送指定评论: 测试口令')).toBeInTheDocument()
    expect(screen.getByText('参与资格请在官方直播间确认.')).toBeInTheDocument()
    const fold = screen.getByRole('switch', { name: /折叠福袋同文/ })
    expect(fold).not.toBeChecked()
    fireEvent.click(fold)
    expect(fold).toBeChecked()
    fireEvent.click(fold)
    expect(fold).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /打开官方直播间/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('活动已结束.')
    expect(openOfficial).toHaveBeenCalledWith({ ...target, activityId: '9000000000000000042' })
  })

  it('aborts old reads on switching rooms or scenes, and ignores a late old result', async () => {
    let resolvePrevious!: (value: DouyinLotterySnapshot) => void
    const read = vi.fn<DouyinLotteryActions['read']>()
      .mockImplementationOnce(() => new Promise(resolve => { resolvePrevious = resolve }))
      .mockResolvedValue(null)
    const actions = { read }
    const { rerender } = render(<Harness actions={actions} />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    const previousSignal = read.mock.calls[0]![1]
    rerender(<Harness actions={actions} serial={2} />)
    expect(previousSignal.aborted).toBe(true)
    expect(await screen.findByText('暂时无法确认普通福袋状态.')).toBeInTheDocument()
    await act(async () => resolvePrevious(active()))
    expect(screen.queryByText('测试虚拟币')).toBeNull()
    const currentSignal = read.mock.calls[1]![1]
    rerender(<Harness actions={actions} room="douyin:101" />)
    expect(currentSignal.aborted).toBe(true)
    await waitFor(() => expect(read).toHaveBeenLastCalledWith('douyin:101', expect.any(AbortSignal)))
    rerender(<Harness actions={actions} room="douyin:101" serial={null} />)
    expect(screen.getByText('弹幕连接恢复后检测普通福袋.')).toBeInTheDocument()
    expect(read.mock.calls[2]![1].aborted).toBe(true)
  })

  it('expires the card using a monotonic timer and keeps the folding toggle reversible', async () => {
    vi.useFakeTimers()
    const read = vi.fn<DouyinLotteryActions['read']>(async () => active(2))
    const notify = vi.fn()
    render(<Harness actions={{ read, notify }} />)
    await act(async () => {})
    expect(screen.getByLabelText('普通福袋开奖倒计时')).toHaveTextContent('00:02')
    fireEvent.click(screen.getByRole('switch', { name: /普通福袋提醒/ }))
    fireEvent.click(screen.getByRole('switch', { name: /折叠福袋同文/ }))
    vi.setSystemTime(Date.now() + 60_000)
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(screen.getByLabelText('普通福袋开奖倒计时')).toHaveTextContent('00:01')
    expect(notify).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(screen.getByText('当前未检测到进行中的普通福袋.')).toBeInTheDocument()
    expect(screen.queryByLabelText('普通福袋开奖倒计时')).toBeNull()
    expect(screen.getByRole('switch', { name: /折叠福袋同文/ })).toBeChecked()
    await act(async () => vi.advanceTimersByTimeAsync(DOUYIN_LOTTERY_POLL_MS - 2_000))
    expect(read).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
