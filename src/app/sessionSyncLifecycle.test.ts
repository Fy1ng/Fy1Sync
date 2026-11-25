import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { primeMediaElement } from '../test/setup'
import type { AutoSyncRunResult } from '../sync/autoSync'
import type { FrameMeasureRequest, FrameMeasurement } from '../sync/frameHashSampler'

let session: Session
afterEach(() => { session?.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })
const source = { kind: 'progressive' as const, url: 'https://example.test/source.mp4', label: '测试', input: '测试', loop: false, viaProxy: false }

async function harness(position = 100) {
  const measureFrames = vi.fn(async (request: FrameMeasureRequest): Promise<FrameMeasurement> => {
    if (request.signal.aborted) return { samples: { official: 0, commentary: 0 }, message: '画面匹配已取消' }
    const residual = request.fresh ? 0 : 5 - request.appliedOffsetSeconds
    const total = request.appliedOffsetSeconds + residual
    return {
      samples: { official: 24, commentary: 24 },
      estimate: {
        status: 'ok',
        residualSeconds: residual,
        totalOffsetSeconds: total,
        direction: Math.abs(total) <= 0.1 ? 'none' : total > 0 ? 'official' : 'commentary',
        rewindSeconds: Math.abs(total) <= 0.1 ? 0 : Math.abs(total),
        confidence: 0.96,
        officialAnchorSpread: 0.01,
        commentaryAnchorSpread: 0.01,
        officialEvents: 24,
        commentaryEvents: 24,
      },
    }
  })
  session = new Session({ measureFrames })
  await session.loadSource('official', source)
  await session.loadSource('commentary', source)
  for (const role of ['official', 'commentary'] as const) {
    Object.defineProperty(session.engine.element(role), 'videoWidth', { configurable: true, value: 1920 })
    Object.defineProperty(session.engine.element(role), 'videoHeight', { configurable: true, value: 1080 })
    primeMediaElement(session.engine.element(role), { duration: 600, currentTime: position })
  }
  await session.setPlaying(true)
  // jsdom has no decoder clock. Advance its real test elements during settling.
  vi.spyOn(session.autoSync as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockImplementation(async ms => {
    for (const role of ['official', 'commentary'] as const) {
      const video = session.engine.element(role)
      primeMediaElement(video, { currentTime: video.currentTime + ms / 1000 * video.playbackRate })
    }
  })
  return { measureFrames }
}

describe('frame-matching synchronization lifecycle', () => {
  it.each([false, true])('holds both playheads during manual seek and respects a later user pause: %s', async userPauses => {
    await harness()
    const original = session.engine.seek.bind(session.engine)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(session.engine, 'seek').mockImplementationOnce(async (role, target) => {
      await pending
      return original(role, target)
    })
    const run = session.syncNow()
    for (let index = 0; index < 20; index++) await Promise.resolve()
    for (const role of ['official', 'commentary'] as const) expect(session.engine.element(role).paused).toBe(true)
    if (userPauses) await session.setPlaying(false)
    release()
    const result = await run
    for (const role of ['official', 'commentary'] as const) expect(session.engine.element(role).paused).toBe(userPauses)
    expect(result.phase).toBe(userPauses ? 'failed' : 'done')
  })

  it('restores the original playback state when a manual seek throws synchronously', async () => {
    await harness()
    vi.spyOn(session.engine, 'seek').mockImplementationOnce(() => { throw new Error('seek failed') })
    expect((await session.syncNow()).failure?.kind).toBe('seek-failed')
    for (const role of ['official', 'commentary'] as const) expect(session.engine.element(role).paused).toBe(false)
  })

  it('invalidates a running measurement when frame-hash region settings change', async () => {
    const h = await harness()
    let finish!: () => void
    const started = new Promise<void>(resolve => {
      h.measureFrames.mockImplementationOnce(async () => {
        resolve()
        await new Promise<void>(done => { finish = done })
        return { samples: { official: 0, commentary: 0 }, message: '画面匹配已取消' }
      })
    })
    const seek = vi.spyOn(session.engine, 'seek')
    const pending = session.measureOnce()
    await started
    session.updateSettings({ frameHashRegions: { official: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, commentary: { x: 0, y: 0, w: 1, h: 1 } } })
    finish()
    expect((await pending).failure?.kind).toBe('cancelled')
    expect(seek).not.toHaveBeenCalled()
    expect(session.profileFor('official')).toBeNull()
  })

  it('does not apply an offset when frame matching cannot find common frames and recovers on fresh evidence', async () => {
    const h = await harness()
    const seek = vi.spyOn(session.engine, 'seek')
    h.measureFrames.mockResolvedValueOnce({ samples: { official: 10, commentary: 10 }, message: '尚未找到共同画面' })
    const result = await session.syncNow()
    expect(result.failure?.kind).toBe('frame-match')
    expect(result.applied).toBe(false)
    expect(seek).not.toHaveBeenCalled()

    const recovered = await session.syncNow()
    expect(recovered.phase).toBe('done')
    expect(recovered.applied).toBe(true)
    expect(session.flush().notices[0]?.text).toBe('已自动对齐')
  })

  it('ignores a cancelled sampling window that finishes late', async () => {
    const h = await harness()
    await session.measureOnce()
    let finish!: () => void
    const started = new Promise<void>(resolve => {
      h.measureFrames.mockImplementationOnce(async () => {
        resolve()
        await new Promise<void>(done => { finish = done })
        return { samples: { official: 5, commentary: 5 }, message: '尚未找到共同画面' }
      })
    })
    const pending = session.syncNow()
    await started
    session.cancelAutoSync()
    finish()
    expect((await pending).failure?.kind).toBe('cancelled')
    expect(session.flush().autoSync.authorized).toBe(false)
  })

  it('writes actual partial rewind on buffer-limit and preserves the requested target', async () => {
    await harness(2)
    const result = await session.syncNow()
    expect(result.failure?.kind).toBe('buffer-limit')
    expect(session.flush()).toMatchObject({ appliedRewind: { official: 2, commentary: 0 }, requestedOffsetSeconds: 5 })
    expect(session.engine.element('official').currentTime).toBe(0)
  })

  it('writes scheduled results back, so repeating the same manual offset cannot undo them', async () => {
    vi.useFakeTimers()
    await harness()
    session.setAutoSyncInterval(15)
    session.setAutoSyncEnabled(true)
    await vi.advanceTimersByTimeAsync(15_500)
    expect(session.flush().appliedRewind.official).toBe(5)
    const before = session.engine.element('official').currentTime
    await session.applyOffset(5)
    expect(session.engine.element('official').currentTime).toBe(before)
    expect(session.flush().autoSync.authorized).toBe(false)
  })

  it('discards a stale run result after a source replacement and restores rates before replacement', async () => {
    await harness()
    let finish!: (result: AutoSyncRunResult) => void
    vi.spyOn(session.autoSync, 'run').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = session.syncNow()
    session.engine.element('official').playbackRate = 0.95
    session.engine.element('commentary').playbackRate = 1.05
    await session.loadSource('official', { ...source, url: 'https://example.test/new.mp4' })
    expect(session.engine.element('official').playbackRate).toBe(1)
    expect(session.engine.element('commentary').playbackRate).toBe(1)
    finish({ applied: true, appliedRewind: { official: 22, commentary: 0 } } as AutoSyncRunResult)
    await pending
    expect(session.flush().appliedRewind.official).toBe(0)
  })
})
