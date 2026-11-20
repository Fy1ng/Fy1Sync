/** A refresh blocked by Liquipedia's quota counts down on the button and frees itself. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { Cs2Schedule } from '../../../electron/featureContracts'
import { ScheduleSheet } from './ScheduleSheet'
import type { ApiResult } from '../../app/apiClient'

const NOW = Date.parse('2026-10-30T06:30:00Z')
const schedule = (over: Partial<Cs2Schedule> = {}): Cs2Schedule =>
  ({ fetchedAt: NOW, source: 'liquipedia', attribution: '赛程数据来自 Liquipedia（CC-BY-SA 3.0）', stale: false, matches: [], ...over })

let reply: (args: unknown) => Cs2Schedule
let verificationReply: () => Promise<ApiResult<{ opened: true }>>
let attemptReply: (args: unknown) => Promise<Cs2Schedule>
const blocked = (round = '1', notBefore = NOW, used = false) => schedule({ fetchedAt: 0, stale: true, error: 'Liquipedia 请求受限 (HTTP 429)',
  errorDetail: { status: 429 }, refreshAt: NOW + 120_000, refreshReason: 'upstream-rate-limit', verification: { round, notBefore, used } })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  reply = () => schedule()
  verificationReply = async () => ({ ok: true, value: { opened: true } })
  attemptReply = async () => schedule()
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => method === 'getCs2Schedule' ? { ok: true, value: reply(args) }
      : method === 'openLiquipediaVerification' ? verificationReply()
        : method === 'refreshCs2ScheduleAfterVerification' ? { ok: true, value: await attemptReply(args) } : { ok: true, value: [] }),
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
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: /12 秒后可刷新/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '打开官网验证' })).toBeNull()

    await seconds(5)
    expect(screen.getByRole('button', { name: '7 秒后可刷新' })).toBeDisabled()

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
    expect(screen.getByRole('button', { name: '25 秒后可刷新' })).toBeDisabled()
    await seconds(12)
    expect(screen.getByRole('button', { name: '13 秒后可刷新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /13 秒后可刷新/ })).toBeDisabled()
  })

  it('shows completed source feedback without a cooldown when the refresh went through', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('赛程暂无变化')
    expect(screen.queryByText(/还需 \d+ 秒/)).toBeNull()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })

  it('honors an upstream block from the initial read and preserves it after reopening and minute polling', async () => {
    reply = () => schedule({ fetchedAt: 0, stale: true, error: 'Liquipedia 请求受限 (HTTP 429)',
      errorDetail: { status: 429 }, refreshAt: NOW + 120_000, refreshReason: 'upstream-rate-limit' })
    const first = render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: '2 分钟后可刷新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '打开官网验证' })).toBeEnabled()
    expect(screen.queryByText(/每 30 秒/)).toBeNull()
    first.unmount()
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(screen.getByRole('button', { name: '2 分钟后可刷新' })).toBeDisabled()
    await seconds(61)
    expect(screen.getByRole('button', { name: '59 秒后可刷新' })).toBeDisabled()
    await seconds(59)
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '打开官网验证' })).toBeNull()
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
    expect(screen.queryByRole('status')).toBeNull()
    // A later successful snapshot can establish that another window has recovered.
    reply = () => schedule({ fetchedAt: NOW + 1_000 })
    await act(async () => { scheduleChanged() })
    await settle()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '打开官网验证' })).toBeNull()
  })

  it('opens verification only on click, prevents duplicate launches, and keeps the retry deadline', async () => {
    reply = () => blocked()
    let finish!: () => void
    verificationReply = () => new Promise(resolve => { finish = () => resolve({ ok: true, value: { opened: true } }) })
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    const invoke = vi.mocked(window.streamSyncer!.invoke)
    expect(invoke).not.toHaveBeenCalledWith('openLiquipediaVerification', undefined)
    const callsBefore = invoke.mock.calls.filter(([method]) => method === 'getCs2Schedule').length
    const open = screen.getByRole('button', { name: '打开官网验证' })
    expect(screen.queryByRole('button', { name: '已完成验证，立即刷新' })).toBeNull()
    await act(async () => { fireEvent.click(open); fireEvent.click(open) })
    expect(invoke.mock.calls.filter(([method]) => method === 'openLiquipediaVerification')).toEqual([['openLiquipediaVerification', undefined]])
    expect(screen.getByRole('button', { name: '正在打开官网' })).toBeDisabled()
    await act(async () => { finish() })
    const group = within(screen.getByRole('group', { name: 'Liquipedia 官网验证' }))
    expect(group.getByRole('button', { name: '已完成验证，立即刷新' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '2 分钟后可刷新' })).toBeDisabled()
    expect(invoke.mock.calls.filter(([method]) => method === 'getCs2Schedule')).toHaveLength(callsBefore)
    expect(invoke.mock.calls.filter(([method]) => method === 'refreshCs2ScheduleAfterVerification')).toHaveLength(0)
  })

  it('shows the upstream deadline and slot wait, then removes the countdown on success', async () => {
    reply = () => blocked('1', NOW + 2_000)
    let finish!: (value: Cs2Schedule) => void
    const attempt = vi.fn(() => new Promise<Cs2Schedule>(resolve => { finish = resolve }))
    attemptReply = attempt
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开官网验证' })) })
    const early = screen.getByRole('button', { name: /最早可试：/ })
    expect(early).toBeDisabled()
    fireEvent.click(early)
    expect(attempt).not.toHaveBeenCalled()
    await seconds(2)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '已完成验证，立即刷新' })) })
    expect(attempt).toHaveBeenCalledExactlyOnceWith({ round: '1' })
    expect(screen.getByRole('button', { name: '正在等待刷新' })).toBeDisabled()
    await act(async () => { finish(schedule({ fetchedAt: Date.now(), verificationResult: 'recovered' })) })
    expect(screen.getByRole('status')).toHaveTextContent('赛程已更新')
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.queryByRole('group', { name: 'Liquipedia 官网验证' })).toBeNull()
  })

  it('requires a new browser opening after another 429 and disables a consumed round on other failures', async () => {
    reply = () => blocked()
    attemptReply = async () => ({ ...blocked('2'), verificationResult: 'rate-limited' })
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    const open = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开官网验证' })) })
    const tryRefresh = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: '已完成验证，立即刷新' })) })
    await open()
    await tryRefresh()
    expect(screen.getByRole('status')).toHaveTextContent('验证未对应用的请求生效')
    expect(screen.queryByRole('button', { name: '已完成验证，立即刷新' })).toBeNull()
    attemptReply = async () => ({ ...blocked('2', NOW, true), verificationResult: 'failed' })
    await open()
    await tryRefresh()
    expect(screen.getByRole('status')).toHaveTextContent('冷却未解除')
    expect(screen.getByRole('button', { name: '本轮已尝试' })).toBeDisabled()
  })

  it('keeps browser launch failures inspectable and leaves verification available for retry', async () => {
    reply = () => blocked()
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
