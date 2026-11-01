/** A refresh Liquipedia's 30-second limit turned away says so, counts down and frees itself. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { Cs2Schedule } from '../../../electron/featureContracts'
import { ScheduleSheet } from './ScheduleSheet'

const NOW = Date.parse('2026-10-30T06:30:00Z')
const schedule = (over: Partial<Cs2Schedule> = {}): Cs2Schedule =>
  ({ fetchedAt: NOW, source: 'liquipedia', attribution: '赛程数据来自 Liquipedia (CC-BY-SA 3.0)', stale: false, matches: [], ...over })

let reply: (args: unknown) => Cs2Schedule
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  reply = () => schedule()
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => method === 'getCs2Schedule' ? { ok: true, value: reply(args) } : { ok: true, value: [] }),
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
    expect(screen.getByRole('status')).toHaveTextContent('Liquipedia 限制每 30 秒刷新一次，还需 12 秒')
    expect(screen.getByRole('button', { name: /12 秒后可刷新/ })).toBeDisabled()

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

  it('shows nothing extra when the refresh went through', async () => {
    render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })
})
