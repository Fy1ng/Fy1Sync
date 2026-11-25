import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { SourceRole } from '../core/types'
import type { AutoSyncFailure, AutoSyncRunResult } from '../sync/autoSync'

let session: Session
afterEach(() => { session?.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })
const source = { kind: 'progressive' as const, url: 'https://example.test/source.mp4', label: '测试', input: '测试', loop: false, viaProxy: false }

async function loaded(): Promise<Session> {
  session = new Session()
  await session.loadSource('official', source)
  await session.loadSource('commentary', source)
  // jsdom never becomes measurable; the realignment after a refresh is covered elsewhere.
  vi.spyOn(session as unknown as { realignWhenReady(): Promise<void> }, 'realignWhenReady').mockResolvedValue(undefined)
  return session
}

const failed = (kind: AutoSyncFailure['kind']): AutoSyncRunResult =>
  ({ phase: 'failed', applied: false, dryRun: false, failure: { kind, message: '失败' } }) as unknown as AutoSyncRunResult
const succeeded = (): AutoSyncRunResult => ({ phase: 'done', applied: true, dryRun: false }) as unknown as AutoSyncRunResult
const track = (result: AutoSyncRunResult): void =>
  (session as unknown as { trackSyncOutcome(result: AutoSyncRunResult): void }).trackSyncOutcome(result)
const flush = async (): Promise<void> => { for (let index = 0; index < 10; index++) await Promise.resolve() }

describe('refreshSources', () => {
  it('re-resolves every loaded side through the registered refresher and guards re-entry', async () => {
    await loaded()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const refresher = vi.fn(async (_role: SourceRole) => { await gate; return true })
    session.setSourceRefresher(refresher)
    const first = session.refreshSources(undefined, { realign: false })
    await flush()
    expect(session.snapshot.refreshing).toBe(true)
    expect(await session.refreshSources(undefined, { realign: false })).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(refresher.mock.calls.map(([role]) => role).sort()).toEqual(['commentary', 'official'])
    expect(session.snapshot.refreshing).toBe(false)
  })

  it('does nothing without a refresher or a loaded side', async () => {
    session = new Session()
    session.setSourceRefresher(vi.fn(async () => true))
    expect(await session.refreshSources()).toBe(false)
  })
})

describe('automatic refresh after repeated failures', () => {
  it('refreshes once the configured number of consecutive matching failures is reached', async () => {
    await loaded()
    const refresher = vi.fn(async () => true)
    session.setSourceRefresher(refresher)
    session.updateSettings({ autoRefreshFailures: 3 })
    track(failed('frame-match'))
    track(failed('no-samples'))
    await flush()
    expect(refresher).not.toHaveBeenCalled()
    track(failed('verify-failed'))
    await flush()
    expect(refresher).toHaveBeenCalledTimes(2)
  })

  it('ignores cancelled and unauthorized runs, and a success resets the streak', async () => {
    await loaded()
    const refresher = vi.fn(async () => true)
    session.setSourceRefresher(refresher)
    session.updateSettings({ autoRefreshFailures: 2 })
    track(failed('frame-match'))
    track(failed('cancelled'))
    track(failed('unauthorized'))
    track(succeeded())
    track(failed('frame-match'))
    await flush()
    expect(refresher).not.toHaveBeenCalled()
  })

  it('is off at 0 and waits out the cooldown between refreshes', async () => {
    await loaded()
    const refresher = vi.fn(async () => true)
    session.setSourceRefresher(refresher)
    session.updateSettings({ autoRefreshFailures: 0 })
    for (let index = 0; index < 5; index++) track(failed('frame-match'))
    await flush()
    expect(refresher).not.toHaveBeenCalled()

    session.updateSettings({ autoRefreshFailures: 1 })
    track(failed('frame-match'))
    await flush()
    await vi.waitFor(() => expect(session.snapshot.refreshing).toBe(false))
    expect(refresher).toHaveBeenCalledTimes(2)
    track(failed('frame-match'))
    await flush()
    expect(refresher).toHaveBeenCalledTimes(2)
  })

  it('tries a backup picture before refreshing when automatic picking is on', async () => {
    await loaded()
    const refresher = vi.fn(async () => true)
    const recovery = vi.fn(async () => true)
    session.setSourceRefresher(refresher)
    session.setCandidateRecovery(recovery)
    session.updateSettings({ autoRefreshFailures: 1, autoPickCandidate: true })
    track(failed('frame-match'))
    await flush()
    expect(recovery).toHaveBeenCalledTimes(1)
    expect(refresher).not.toHaveBeenCalled()
  })

  it('manual offset input resets the streak', async () => {
    await loaded()
    const refresher = vi.fn(async () => true)
    session.setSourceRefresher(refresher)
    session.updateSettings({ autoRefreshFailures: 2 })
    track(failed('frame-match'))
    void session.applyOffset(1).catch(() => undefined)
    track(failed('frame-match'))
    await flush()
    expect(refresher).not.toHaveBeenCalled()
  })
})
