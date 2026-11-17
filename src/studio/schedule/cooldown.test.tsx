/** A refresh Liquipedia's 30-second limit turned away says so, counts down and frees itself. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { Cs2Schedule } from '../../../electron/featureContracts'
import { ScheduleSheet } from './ScheduleSheet'
import type { ApiResult } from '../../app/apiClient'

const NOW = Date.parse('2026-10-30T06:30:00Z')
const schedule = (over: Partial<Cs2Schedule> = {}): Cs2Schedule =>
  ({ fetchedAt: NOW, source: 'liquipedia', attribution: '赛程数据来自 Liquipedia (CC-BY-SA 3.0)', stale: false, matches: [], ...over })

let reply: (args: unknown) => Cs2Schedule
let verificationReply: () => Promise<ApiResult<{ opened: true }>>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  reply = () => schedule()
  verificationReply = async () => ({ ok: true, value: { opened: true } })
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => method === 'getCs2Schedule' ? { ok: true, value: reply(args) }
      : method === 'openLiquipediaVerification' ? verificationReply() : { ok: true, value: [] }),
    subscribeDanmaku: () => () => {},
    subscribeFeatures: () => () => {},
  } as unknown as StreamSyncerBridge)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
/** Each tick re-renders and schedules the next, so step one second at a time. */
const seconds = async (count: number) => { for (let i = 0; i < count; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) }) }

describe('schedule refresh cooldown', () => {
  it('disables 刷新 with the reason and seconds left, then frees it', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    reply = (args) => (args as { refresh?: boolean } | undefined)?.refresh ? schedule({ refreshAt: NOW + 12_000 }) : schedule()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Liquipedia 限制每 30 秒刷新一次, 还需 12 秒')
    expect(screen.getByRole('button', { name: /12 秒后可刷新/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '打开官网验证' })).toBeNull()

    await seconds(5)
    expect(screen.getByRole('status')).toHaveTextContent('还需 7 秒')

    await seconds(7)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })

  it('keeps counting down through the minute poll', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    // Refresh at second 50, turned away for 25 s; the sheet's own read comes at second 60.
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000) })
    reply = (args) => (args as { refresh?: boolean } | undefined)?.refresh ? schedule({ refreshAt: Date.now() + 25_000 }) : schedule()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('还需 25 秒')
    await seconds(12)
    expect(screen.getByRole('status')).toHaveTextContent('还需 13 秒')
    expect(screen.getByRole('button', { name: /13 秒后可刷新/ })).toBeDisabled()
  })

  it('shows completed source feedback without a cooldown when the refresh went through', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('已检查源数据, 赛程暂无变化')
    expect(screen.queryByText(/还需 \d+ 秒/)).toBeNull()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })

  it('honors an upstream block from the initial read and preserves it after reopening and minute polling', async () => {
    reply = () => schedule({ fetchedAt: 0, stale: true, error: 'Liquipedia 请求受限 (HTTP 429)',
      errorDetail: { status: 429 }, refreshAt: NOW + 120_000, refreshReason: 'upstream-rate-limit' })
    const first = render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Liquipedia 返回 HTTP 429')
    expect(screen.getByRole('button', { name: '2 分钟后可刷新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '打开官网验证' })).toBeEnabled()
    expect(screen.queryByText(/每 30 秒/)).toBeNull()
    first.unmount()
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(screen.getByRole('button', { name: '2 分钟后可刷新' })).toBeDisabled()
    await seconds(61)
    expect(screen.getByRole('status')).toHaveTextContent('59 秒后重试')
    await seconds(59)
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '打开官网验证' })).toBeEnabled()
    expect(screen.queryByText('已解除限制')).toBeNull()
  })

  it('reflects an upstream cooldown arriving through a background schedule notification', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    const { scheduleChanged } = await import('./store')
    reply = () => schedule({ stale: true, error: '429', refreshAt: NOW + 900_000, refreshReason: 'upstream-rate-limit' })
    await act(async () => { scheduleChanged() })
    await settle()
    expect(screen.getByRole('button', { name: '15 分钟后可刷新' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('HTTP 429')
    // A later successful snapshot can establish that another window has recovered.
    reply = () => schedule({ fetchedAt: NOW + 1_000 })
    await act(async () => { scheduleChanged() })
    await settle()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '打开官网验证' })).toBeNull()
  })

  it('opens verification only on click, prevents duplicate launches, and keeps the retry deadline', async () => {
    reply = () => schedule({ fetchedAt: 0, stale: true, error: 'Liquipedia 请求受限 (HTTP 429)',
      errorDetail: { status: 429 }, refreshAt: NOW + 120_000, refreshReason: 'upstream-rate-limit' })
    let finish!: () => void
    verificationReply = () => new Promise(resolve => { finish = () => resolve({ ok: true, value: { opened: true } }) })
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    const invoke = vi.mocked(window.streamSyncer!.invoke)
    expect(invoke).not.toHaveBeenCalledWith('openLiquipediaVerification', undefined)
    const callsBefore = invoke.mock.calls.filter(([method]) => method === 'getCs2Schedule').length
    const open = screen.getByRole('button', { name: '打开官网验证' })
    await act(async () => { fireEvent.click(open); fireEvent.click(open) })
    expect(invoke.mock.calls.filter(([method]) => method === 'openLiquipediaVerification')).toEqual([['openLiquipediaVerification', undefined]])
    expect(screen.getByRole('button', { name: '正在打开官网...' })).toBeDisabled()
    await act(async () => { finish() })
    const group = within(screen.getByRole('group', { name: 'Liquipedia 官网验证' }))
    expect(group.getByRole('status')).toHaveTextContent('已在浏览器打开 Liquipedia')
    expect(screen.getByRole('button', { name: '2 分钟后可刷新' })).toBeDisabled()
    expect(invoke.mock.calls.filter(([method]) => method === 'getCs2Schedule')).toHaveLength(callsBefore)
  })

  it('keeps browser launch failures inspectable and leaves verification available for retry', async () => {
    reply = () => schedule({ stale: true, error: 'Liquipedia 请求受限 (HTTP 429)', errorDetail: { status: 429 } })
    verificationReply = async () => ({ ok: false, code: 'internal-error', message: '无法打开浏览器', detail: { code: 'EACCES' } })
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开官网验证' })) })
    const group = within(screen.getByRole('group', { name: 'Liquipedia 官网验证' }))
    expect(group.getByRole('alert')).toHaveTextContent('无法打开官网验证页面')
    fireEvent.click(group.getByRole('button', { name: '查看原始错误' }))
    expect(group.getByRole('region', { name: '原始错误信息' })).toHaveTextContent('EACCES')
    expect(group.getByRole('button', { name: '打开官网验证' })).toBeEnabled()
    expect(group.queryByRole('status')).toBeNull()
  })
})
