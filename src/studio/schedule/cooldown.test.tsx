/** Refresh stays unlocked with silent 500ms -> 1s -> 3s throttling, prominent stale notices and timezone clarity. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { Cs2Match, Cs2Schedule } from '../../../electron/featureContracts'
import { ScheduleSheet } from './ScheduleSheet'
import type { ApiResult } from '../../app/apiClient'

const NOW = Date.parse('2026-10-30T06:30:00Z')
const match = (id = 'm1'): Cs2Match => ({
  id, startsAt: NOW + 3_600_000, state: 'upcoming',
  teams: [{ name: 'Heroic', short: null, logo: null }, { name: 'M80', short: null, logo: null }],
  score: null, bestOf: 3, streams: [],
  tournament: { name: 'PGL Major Singapore 2026', stage: 'Stage 1', tier: 1, url: 'https://liquipedia.net/counterstrike/PGL/2026/Singapore/Stage_1', logo: null },
})
const schedule = (over: Partial<Cs2Schedule> = {}): Cs2Schedule =>
  ({ fetchedAt: NOW, source: 'liquipedia', attribution: '赛程数据来自 Liquipedia（CC-BY-SA 3.0）', stale: false, matches: [], ...over })

let reply: (args: unknown) => Cs2Schedule | Promise<Cs2Schedule>
let invokeResult: ((method: string, args: unknown) => Promise<ApiResult<unknown>>) | null
let verificationReply: () => Promise<ApiResult<{ opened: true }>>
let attemptReply: (args: unknown) => Promise<Cs2Schedule>
const blocked = (round = '1', notBefore = NOW, used = false) => schedule({ fetchedAt: 0, stale: true, error: 'Liquipedia 请求受限 (HTTP 429)',
  errorDetail: { status: 429 }, refreshAt: NOW + 120_000, refreshReason: 'upstream-rate-limit', verification: { round, notBefore, used } })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  reply = () => schedule()
  invokeResult = null
  verificationReply = async () => ({ ok: true, value: { opened: true } })
  attemptReply = async () => schedule()
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      if (invokeResult) return invokeResult(method, args)
      return method === 'getCs2Schedule' ? { ok: true, value: await reply(args) }
        : method === 'openLiquipediaVerification' ? verificationReply()
          : method === 'refreshCs2ScheduleAfterVerification' ? { ok: true, value: await attemptReply(args) } : { ok: true, value: [] }
    }),
    subscribeDanmaku: () => () => {},
    subscribeFeatures: () => () => {},
  } as unknown as StreamSyncerBridge)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const seconds = async (count: number) => { for (let i = 0; i < count; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) }) }

describe('schedule silent refresh throttle and error/timezone presentation', () => {
  it('never locks 刷新 with a countdown and silently throttles rapid clicks at 500ms -> 1s -> 3s with 10s reset', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    const invoke = vi.mocked(window.streamSyncer!.invoke)
    const refreshCalls = () => invoke.mock.calls.filter(([method, args]) => method === 'getCs2Schedule' && (args as { refresh?: boolean } | undefined)?.refresh).length

    const button = () => screen.getByRole('button', { name: '刷新' })
    expect(button()).toBeEnabled()

    // Click 1 at t=0 executes immediately and arms 500ms silent cooldown.
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(1)
    expect(button()).toBeEnabled()
    expect(screen.queryByText(/后可刷新/)).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('赛程暂无变化')

    // Click inside 500ms is silently ignored without disabling the button or showing a cooldown prompt.
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(1)
    expect(button()).toBeEnabled()

    // Click 2 at +500ms goes through and arms 1s silent cooldown.
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(2)

    // Click 3 at +1000ms goes through and arms 3s silent cooldown.
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(3)

    await act(async () => { await vi.advanceTimersByTimeAsync(2_999) })
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(3)

    // Click 4 at +3000ms goes through (capped at 3s).
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(4)

    // 10s without clicks resets cooldown back to 500ms.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(5)

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await act(async () => { fireEvent.click(button()) })
    await settle()
    expect(refreshCalls()).toBe(6)
  })

  it('keeps 刷新 enabled even when the schedule carries retry or rate-limit metadata', async () => {
    reply = () => schedule({ stale: true, error: '赛程服务正在维护或同步中（HTTP 503），请稍后重试',
      errorDetail: { status: 503 }, refreshAt: NOW + 30_000, refreshReason: 'retry' })
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(screen.getByText(/读取于/)).toBeInTheDocument()
    expect(screen.getByText('赛程服务正在维护或同步中（HTTP 503），请稍后重试')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.queryByText(/后可刷新/)).toBeNull()
    expect(screen.queryByRole('group', { name: 'Liquipedia 官网验证' })).toBeNull()
  })

  it('renders a prominent stale banner and IPC failures when cached events are already listed', async () => {
    reply = () => schedule({ fetchedAt: NOW - 20 * 60_000, stale: false, matches: [match()] })
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(screen.getByText(/赛程数据已过期/)).toBeInTheDocument()

    invokeResult = async (method) => method === 'getCs2Schedule'
      ? { ok: false, code: 'unavailable', message: 'IPC 刷新失败', detail: { code: 'EPIPE' } }
      : { ok: true, value: [] }
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
    await settle()
    expect(screen.getByText('IPC 刷新失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看原始错误' })).toBeInTheDocument()
  })

  it('labels Beijing timezone cleanly and highlights when the system timezone differs from UTC+8', async () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480)
    const first = render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(screen.getByText(/北京时间（UTC\+8）/)).toBeInTheDocument()
    expect(screen.queryByText(/非北京时间/)).toBeNull()
    first.unmount()

    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-600)
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    expect(screen.getByText(/系统时区（UTC\+10）/)).toBeInTheDocument()
    expect(screen.getByText(/当前比赛时间按系统时区 UTC\+10 显示/)).toBeInTheDocument()
  })

  it('opens verification only on click, prevents duplicate launches, and keeps 刷新 unlocked', async () => {
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
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(invoke.mock.calls.filter(([method]) => method === 'getCs2Schedule')).toHaveLength(callsBefore)
    expect(invoke.mock.calls.filter(([method]) => method === 'refreshCs2ScheduleAfterVerification')).toHaveLength(0)
  })

  it('shows the upstream deadline and slot wait, then removes verification on success', async () => {
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
  })
})
