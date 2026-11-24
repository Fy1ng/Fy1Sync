import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { BilibiliLotteryClient, BilibiliLotterySnapshot } from '../core/bilibiliLottery'
import { BilibiliLotteryCard, BilibiliLotteryCards, type BilibiliLotterySource } from './BilibiliLotteryCard'
import { BilibiliLotteryReplayMessages } from './BilibiliLotteryMessageClue'
import { parseBilibiliLottery } from '../../server/platforms/bilibiliLottery'
import { bilibiliLotteryFixture, bilibiliLotteryReplayFixture } from '../../server/platforms/fixtures/bilibiliLottery'

let listeners: Array<(event: { topic: string; data: unknown }) => void>
let respond: () => Promise<BilibiliLotterySnapshot>
let invoke: ReturnType<typeof vi.fn>
let client: BilibiliLotteryClient
const source = (input = '21452505'): BilibiliLotterySource => ({ slot: 'commentary', input, platform: 'bilibili', active: true })
const fresh = (patch: Record<string, unknown> = {}) => parseBilibiliLottery(bilibiliLotteryFixture(patch), '21452505', Date.now())
beforeEach(() => {
  listeners = []
  respond = async () => fresh({ award_name: '<测试奖品原文>' })
  invoke = vi.fn(async (method: string) => ({ ok: true, value: method === 'readBilibiliLottery' ? await respond() : {} }))
  client = { feature: invoke as BilibiliLotteryClient['feature'], subscribeFeatures: listener => {
    listeners.push(listener); return () => { listeners = listeners.filter(item => item !== listener) }
  } }
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const expandCard = () => { (document.querySelector('.bilibili-lottery-card') as HTMLDetailsElement).open = true }

/** Every rule of a stylesheet that names the card group, as it is written in the source. */
function cardGroupRules(file: string): string {
  const css = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/[^{}]*\{[^{}]*\}/g)].map(match => match[0]).filter(rule => rule.split('{')[0]!.includes('.bilibili-lottery-cards')).join('\n')
}

describe('Bilibili lottery cards in the chat drawer', () => {
  const withStyles = (run: () => void): void => {
    const style = document.createElement('style')
    // The component's own rules first, then the player's, as a browser's cascade resolves them.
    style.textContent = cardGroupRules('./bilibiliLottery.css') + '\n' + cardGroupRules('./studio.css')
    document.head.append(style)
    try { run() } finally { style.remove() }
  }

  it('joins the drawer flow instead of floating over the picture', () => withStyles(() => {
    render(<div className="studio"><aside className="drawer"><BilibiliLotteryCards sources={[source()]} client={client} /></aside></div>)
    const group = document.querySelector('.drawer > .bilibili-lottery-cards')!
    expect(group).not.toBeNull()
    expect(getComputedStyle(group).position).toBe('static')
    expect(getComputedStyle(group).maxWidth).toBe('none')
  }))

  it('keeps its floating placement outside the drawer', () => withStyles(() => {
    render(<div className="studio"><BilibiliLotteryCards sources={[source()]} client={client} /></div>)
    expect(getComputedStyle(document.querySelector('.bilibili-lottery-cards')!).position).toBe('absolute')
  }))
})

describe('Bilibili lottery card and lifecycle hook', () => {
  it('renders escaped prize, exact candidates and fixed official entry with reminders off', async () => {
    render(<BilibiliLotteryCards sources={[source()]} client={client} />)
    await screen.findByText('<测试奖品原文>，3 份')
    expandCard()
    expect(screen.getByRole('checkbox', { name: '提醒新天选福袋' })).not.toBeChecked()
    expect(screen.getByText(/同文弹幕不能证明已参与/)).toBeInTheDocument()
    expect(screen.getByText('另一条精确口令')).toBeInTheDocument()
    expect([...document.querySelectorAll('code')].map(element => element.textContent)).toContain(' 测试口令 ')
    expect(screen.queryByRole('button', { name: '一键参与' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开官方直播间' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('openBilibiliLotteryRoom', expect.objectContaining({
      slot: 'commentary', room: '21452505', activityId: '771',
    })))
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('setBilibiliLotteryReminders', expect.objectContaining({ enabled: true })))
  })
  it('advances independently of media delay, marks expiry and refuses stale open', async () => {
    vi.useFakeTimers()
    let monotonic = 100
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    respond = async () => fresh({ time: 2 })
    render(<BilibiliLotteryCard client={client} slot="commentary" input="21452505" />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getAllByText('00:02 后开奖')).toHaveLength(2)
    monotonic += 2200
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(screen.getByText('本轮已结束')).toBeInTheDocument()
    monotonic += 66_000
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('活动信息待官方确认')).toBeInTheDocument()
    expandCard()
    expect(screen.getByRole('button', { name: '打开官方直播间' })).toBeDisabled()
  })
  it('ignores late old-room responses and stops on loading, source removal and unmount', async () => {
    let finish!: (snapshot: BilibiliLotterySnapshot) => void
    respond = () => new Promise(resolve => { finish = resolve })
    const view = render(<BilibiliLotteryCards sources={[source()]} client={client} />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('readBilibiliLottery', expect.objectContaining({ input: '21452505' })))
    const finishOld = finish
    view.rerender(<BilibiliLotteryCards sources={[source('21452506')]} client={client} />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stopBilibiliLottery', expect.objectContaining({ slot: 'commentary' })))
    await act(async () => finishOld(fresh({ reminder: true })))
    expect(screen.queryByText('<测试奖品原文>，3 份')).not.toBeInTheDocument()
    view.rerender(<BilibiliLotteryCards sources={[{ ...source('21452506'), loading: true }]} client={client} />)
    expect(document.querySelector('.bilibili-lottery-card')).toBeNull()
    view.unmount()
    await act(async () => finish(fresh()))
  })
  it('immediately cancels an in-flight response on authentication invalidation', async () => {
    let finish!: (snapshot: BilibiliLotterySnapshot) => void
    respond = () => new Promise(resolve => { finish = resolve })
    const onSnapshot = vi.fn(), onReminder = vi.fn()
    render(<BilibiliLotteryCard client={client} slot="commentary" input="21452505" onSnapshot={onSnapshot} onReminder={onReminder} />)
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    const finishOld = finish
    respond = async () => fresh({ lot_status: 2, award_name: '下一账号的活动' })
    act(() => listeners.forEach(listener => listener({ topic: 'bilibili-lottery-invalidated', data: {} })))
    await act(async () => finishOld(fresh({ award_name: '旧账号活动' })))
    await screen.findByText('下一账号的活动，3 份')
    expect(screen.queryByText('旧账号活动，3 份')).not.toBeInTheDocument()
    expect(onReminder).not.toHaveBeenCalled()
    expect(onSnapshot).toHaveBeenCalledTimes(1)
  })
  it('refreshes on reconnect and displays unsupported transports explicitly', async () => {
    const view = render(<BilibiliLotteryCards sources={[source()]} client={client} />)
    await screen.findByText('<测试奖品原文>，3 份')
    const reads = invoke.mock.calls.filter(call => call[0] === 'readBilibiliLottery').length
    view.rerender(<BilibiliLotteryCards sources={[{ ...source(), reconnectKey: 'reconnected' }]} client={client} />)
    await waitFor(() => expect(invoke.mock.calls.filter(call => call[0] === 'readBilibiliLottery').length).toBeGreaterThan(reads))
    view.unmount()
    invoke.mockResolvedValue({ ok: false, code: 'not-available', message: '哔哩哔哩活动暂不可用' })
    render(<BilibiliLotteryCard client={client} slot="official" input="21452505" />)
    await screen.findAllByText('哔哩哔哩活动暂不可用')
    expandCard()
    expect(screen.getByRole('button', { name: '打开官方直播间' })).toBeDisabled()
  })
  it('suppresses a reminder that expires while the transport response is delayed', async () => {
    const onReminder = vi.fn()
    render(<BilibiliLotteryCard client={client} slot="commentary" input="21452505" onReminder={onReminder} />)
    await screen.findByText('<测试奖品原文>，3 份')
    expandCard()
    const stale = { ...fresh({ time: 1 }), reminder: true, checkedAt: Date.now() - 2000 }
    respond = async () => stale
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(screen.getByText('本轮已结束')).toBeInTheDocument())
    expect(onReminder).not.toHaveBeenCalled()
  })
  it('offers the official fallback when the room is known but login is required', async () => {
    respond = async () => parseBilibiliLottery({ code: -101 }, '21452505', Date.now())
    render(<BilibiliLotteryCard client={client} slot="commentary" input="21452505" />)
    await screen.findByText('登录已失效或需要登录')
    expandCard()
    fireEvent.click(screen.getByRole('button', { name: '打开官方直播间' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('openBilibiliLotteryRoom', expect.objectContaining({
      room: '21452505', activityId: null,
    })))
  })
})

describe('Bilibili same-text replay presentation', () => {
  it('keeps every raw message and lets manually typed same-text messages expand', () => {
    const replay = bilibiliLotteryReplayFixture()
    const history = replay.samples.map(sample => parseBilibiliLottery(sample.raw, '21452505', sample.checkedAt))
    render(<BilibiliLotteryReplayMessages messages={replay.messages} history={history} />)
    const rows = document.querySelectorAll('[data-message-id]')
    expect(rows).toHaveLength(replay.messages.length)
    expect(document.querySelectorAll('.bilibili-lottery-message-clue')).toHaveLength(4)
    const hand = document.querySelector('[data-message-id="synthetic-hand-typed"] details') as HTMLDetailsElement
    expect(hand.open).toBe(false)
    hand.open = true
    expect(hand.textContent).toContain('测试口令')
    expect(hand.textContent).toContain('同文不能证明已参与')
    const announcement = document.querySelector('[data-message-id="synthetic-announcement"]')!
    expect(announcement.querySelector('details')).toBeNull()
    expect(announcement.textContent).toBe('测试口令')
    const expired = document.querySelector('[data-message-id="synthetic-after-empty"]')!
    expect(expired.querySelector('details')).toBeNull()
    expect(expired.textContent).toBe('下一轮口令')
  })
})
