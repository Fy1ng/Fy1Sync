import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { Cs2Schedule } from '../../../electron/featureContracts'
import { ScheduleSheet } from './ScheduleSheet'

const NOW = Date.parse('2026-11-02T04:00:00Z')
const schedule = (finished = false): Cs2Schedule => ({
  fetchedAt: NOW + (finished ? 60_000 : 0), source: 'liquipedia', attribution: 'Liquipedia', stale: false,
  matches: [{ id: 'same-match', startsAt: NOW - 3600_000, state: finished ? 'finished' : 'live',
    teams: [{ name: 'Team A', short: null, logo: null }, { name: 'Team B', short: null, logo: null }],
    score: finished ? [2, 1] : [0, 0], bestOf: 3, streams: [],
    tournament: { name: 'IEM', stage: null, tier: 1, url: 'https://liquipedia.net/counterstrike/IEM/2026', logo: null } }],
})
let read: (args: unknown) => Promise<Cs2Schedule>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  read = async () => schedule()
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => ({ ok: true, value: method === 'getCs2Schedule' ? await read(args) : [] })),
    subscribeFeatures: () => () => {},
  } as unknown as StreamSyncerBridge)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const match = () => screen.getByRole('listitem', { name: 'Team A 对 Team B' })

describe('schedule match refresh', () => {
  it('reports a completed unchanged source read instead of implying that scores were updated', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('已检查源数据, 赛程暂无变化')
    expect(screen.getByText(/来源读取于/)).toBeInTheDocument()
    expect(screen.getByText('读取时间不代表赛果更新时间.')).toBeInTheDocument()
    expect(match().querySelector('.match-score')).toHaveTextContent('0:0')
  })

  it('keeps a zero score but does not claim that its source confirms live progress', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    const pending = within(match()).getByText('赛果待更新')
    expect(pending).toHaveAttribute('title', '来源当前记录为 0:0, 尚不能确认实际比赛进度. 请以直播画面为准.')
    expect(within(match()).queryByText('直播中')).toBeNull()
    expect(match().querySelector('.match-score')).toHaveTextContent('0:0')
    expect(match()).toHaveAttribute('data-state', 'live')
  })

  it('continues showing nonzero live scores as live progress', async () => {
    read = async () => {
      const value = schedule()
      value.matches[0]!.score = [1, 0]
      return value
    }
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(within(match()).getByText('直播中')).toBeInTheDocument()
    expect(within(match()).queryByText('赛果待更新')).toBeNull()
    expect(match().querySelector('.match-score')).toHaveTextContent('1:0')
  })

  it('keeps the new match status and score when an earlier opening read resolves after manual refresh', async () => {
    let release!: (value: Cs2Schedule) => void
    read = args => (args as { refresh?: boolean } | undefined)?.refresh
      ? Promise.resolve(schedule(true)) : new Promise(resolve => { release = resolve })
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await settle()
    expect(within(screen.getByRole('region', { name: '已结束' })).getByRole('listitem')).toBe(match())
    expect(match().querySelector('.match-score')).toHaveTextContent('2:1')

    await act(async () => { release(schedule()); await Promise.resolve() })
    await settle()
    expect(match()).toHaveAttribute('data-state', 'finished')
    expect(match().querySelector('.match-score')).toHaveTextContent('2:1')
    expect(screen.queryByRole('region', { name: '进行中' })).toBeNull()
  })

  it('changes the same match from live to finished on the automatic minute read', async () => {
    let finished = false
    read = async () => schedule(finished)
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(match()).toHaveAttribute('data-state', 'live')
    expect(match().querySelector('.match-score')).toHaveTextContent('0:0')
    expect(within(match()).getByText('赛果待更新')).toBeInTheDocument()
    finished = true
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(match()).toHaveAttribute('data-state', 'finished')
    expect(match().querySelector('.match-score')).toHaveTextContent('2:1')
    expect(within(match()).queryByText('赛果待更新')).toBeNull()
    expect(within(screen.getByRole('region', { name: '已结束' })).getByRole('listitem')).toBe(match())
  })
})
