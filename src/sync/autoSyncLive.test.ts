import { describe, expect, it } from 'vitest'
import { AutoSyncController, type AutoSyncDeps } from './autoSync'
import type { AppliedRewind, SourceRole } from '../core/types'

function livePair(options: { seekDelay?: number; landingError?: number; falseSeek?: boolean; frozenAfterSeek?: boolean;
  contentShift?: number; neverResume?: boolean; interruptVerification?: boolean; staleLastFrames?: boolean;
  respectCompleted?: boolean } = {}) {
  const positions = { official: 500, commentary: 500 }
  const rates = { official: 1, commentary: 1 }
  const revisions = { official: 0, commentary: 0 }
  const stalls = { official: 0, commentary: 0 }
  const seeks: Array<{ role: SourceRole; to: number }> = []
  const rewinds: AppliedRewind[] = []
  const sampleDurations: number[] = []
  const rateChanges: Array<{ role: SourceRole; rate: number }> = []
  let now = 1000, windows = 0
  const advance = async (ms: number) => {
    for (const role of ['official', 'commentary'] as const) {
      positions[role] += Math.max(0, now + ms - Math.max(now, stalls[role])) / 1000 * rates[role]
    }
    now += ms
  }
  const deps: AutoSyncDeps = {
    now: () => now,
    sleep: advance,
    snapshot: role => ({ role, currentTime: positions[role], ready: true,
      timebase: { kind: 'live', seekableStart: 400, seekableEnd: 1000 } }),
    playbackState: role => ({ paused: false, seeking: false, ended: false, readyState: now < stalls[role] ? 2 : 4,
      busy: false, observationRevision: revisions[role], discontinuities: 0 }),
    setPlaybackRate: (role, rate) => { rates[role] = rate; rateChanges.push({ role, rate }) },
    onAppliedRewind: rewind => rewinds.push(rewind),
    seek: async (role, to) => {
      seeks.push({ role, to })
      revisions[role]++
      positions[role] = to + (options.landingError ?? 0)
      stalls[role] = now + (options.seekDelay ?? 0)
      await advance(options.seekDelay ?? 0)
      if (options.neverResume) stalls[role] = Infinity
      return !options.falseSeek
    },
    sample: async (ms, emit, signal) => {
      windows++
      const startedAt = now
      for (let elapsed = 0; elapsed < ms && !signal.aborted && !(options.respectCompleted && signal.completed); elapsed += 50) {
        for (const role of ['official', 'commentary'] as const) {
          if (now < stalls[role] || (options.staleLastFrames && windows > 1 && elapsed >= 2500)) continue
          const zeroAt = (role === 'official' ? 600 : 605)
            + (seeks.length && role === 'commentary' ? options.contentShift ?? 0 : 0)
          const seconds = options.frozenAfterSeek && seeks.length ? 80 : Math.floor(zeroAt - positions[role] + 1e-7)
          emit(role, { status: 'success', reading: { text: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
            seconds, confidence: .95, scores: [.95], mediaTime: positions[role], wallTime: now, frameIndex: now / 50 } })
        }
        if (options.interruptVerification && windows > 1 && elapsed === 1000) {
          revisions.official++
          positions.official += 2
        }
        await advance(50)
      }
      sampleDurations.push(now - startedAt)
    },
  }
  return { deps, positions, rates, seeks, rewinds, sampleDurations, rateChanges, windows: () => windows,
    error: () => positions.official - positions.commentary + 5 + (seeks.length ? options.contentShift ?? 0 : 0) }
}

describe('live visual verification', () => {
  it('detects, seeks and verifies with performance frame timestamps and Date-style run timestamps', async () => {
    const pair = livePair({ respectCompleted: true })
    const frameClock = pair.deps.now!
    pair.deps.readingClock = frameClock
    pair.deps.now = () => 1_800_000_000_000 + frameClock()
    const result = await new AutoSyncController(pair.deps, { detectWindowSeconds: 12, verificationWindowSeconds: 12 })
      .run({ official: 0, commentary: 0 })
    expect(result.phase, JSON.stringify(result)).toBe('done')
    expect(result.startedAt).toBe(1_800_000_001_000)
    expect(result.finishedAt).toBeGreaterThan(result.startedAt)
    expect(pair.windows()).toBe(2)
    expect(pair.sampleDurations.every(duration => duration < 3000)).toBe(true)
    expect(pair.seeks).toHaveLength(1)
    expect(Math.abs(pair.error())).toBeLessThanOrEqual(.15)
    expect(pair.rateChanges.every(change => change.rate === 1)).toBe(true)
  })

  it('rejects stale verification captures even when fresh results arrive under different clock epochs', async () => {
    const pair = livePair({ respectCompleted: true })
    const frameClock = pair.deps.now!
    pair.deps.now = () => 1_800_000_000_000 + frameClock()
    pair.deps.readingClock = () => frameClock() + (pair.windows() > 1 ? 601 : 0)
    const result = await new AutoSyncController(pair.deps, { maxCorrectionPasses: 0 })
      .run({ official: 0, commentary: 0 })
    expect(result.failure?.kind).toBe('verify-failed')
    expect(pair.windows()).toBe(2)
    expect(pair.seeks).toHaveLength(1)
    expect(pair.sampleDurations[1]).toBe(4000)
    expect(pair.rateChanges.every(change => change.rate === 1)).toBe(true)
  })

  it('ends detection and each verification window as soon as fresh two-tick evidence agrees', async () => {
    const pair = livePair({ respectCompleted: true })
    const result = await new AutoSyncController(pair.deps, { detectWindowSeconds: 12, verificationWindowSeconds: 12 })
      .run({ official: 0, commentary: 0 })
    expect(result.phase, JSON.stringify(result)).toBe('done')
    expect(pair.windows()).toBe(2)
    expect(pair.sampleDurations[0]).toBeGreaterThanOrEqual(2000)
    expect(pair.sampleDurations.every(duration => duration >= 1000 && duration < 3000)).toBe(true)
    expect(result.estimate?.officialEvents).toBeGreaterThanOrEqual(2)
    expect(result.estimate?.commentaryEvents).toBeGreaterThanOrEqual(2)
    expect(result.divergence).toBeLessThanOrEqual(.15)
    expect(pair.rateChanges.every(change => change.rate === 1)).toBe(true)
  })

  it('corrects peer progress during a delayed live seek, then verifies fresh clock ticks', async () => {
    const pair = livePair({ seekDelay: 700 })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 }, 'silent')
    expect(result.phase, JSON.stringify(result)).toBe('done')
    expect(pair.windows()).toBeGreaterThanOrEqual(3)
    expect(Math.abs(pair.error())).toBeLessThanOrEqual(.15)
    expect(result.divergence).toBeLessThanOrEqual(.15)
    expect(pair.rates).toEqual({ official: 1, commentary: 1 })
    expect(pair.rewinds.at(-1)).toEqual(result.appliedRewind)
  })

  it('uses visual evidence to recover a nearby live landing rejected by the seek tolerance', async () => {
    const pair = livePair({ landingError: .45, falseSeek: true })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 }, 'silent')
    expect(result.phase, JSON.stringify(result)).toBe('done')
    expect(Math.abs(pair.error())).toBeLessThanOrEqual(.15)
  })

  it('catches changed displayed content even when currentTime reached the requested target', async () => {
    const pair = livePair({ contentShift: .65 })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 })
    expect(result.phase, JSON.stringify(result)).toBe('done')
    expect(pair.windows()).toBeGreaterThanOrEqual(3)
    expect(Math.abs(pair.error())).toBeLessThanOrEqual(.15)
    expect(pair.seeks.length).toBeGreaterThanOrEqual(2)
    expect(pair.rateChanges.every(change => change.rate === 1)).toBe(true)
  })

  it('allows a silent small visual correction after a large initial seek', async () => {
    const pair = livePair({ contentShift: .65, respectCompleted: true })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 }, 'silent')
    expect(result.phase, JSON.stringify(result)).toBe('done')
    expect(pair.seeks).toHaveLength(1)
    expect(pair.rateChanges.some(change => change.rate !== 1)).toBe(true)
    expect(pair.rates).toEqual({ official: 1, commentary: 1 })
    expect(Math.abs(pair.error())).toBeLessThanOrEqual(.15)
  })

  it.each([.2, .5, 1.9])('uses only seeks for a manual %s second verification correction', async contentShift => {
    const pair = livePair({ contentShift, respectCompleted: true })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 })
    expect(result.phase, JSON.stringify(result)).toBe('done')
    expect(pair.seeks).toHaveLength(2)
    expect(pair.rateChanges.every(change => change.rate === 1)).toBe(true)
    expect(pair.rewinds.at(-1)).toEqual(result.appliedRewind)
    expect(Math.abs(pair.error())).toBeLessThanOrEqual(.15)
  })

  it.each([1.99, 2, 2.01])('enforces the silent rate boundary on a fresh %s second verification correction', async contentShift => {
    const pair = livePair({ contentShift, respectCompleted: true })
    const result = await new AutoSyncController(pair.deps, { seekThresholdSeconds: 5 })
      .run({ official: 0, commentary: 0 }, 'silent')
    expect(result.phase, JSON.stringify(result)).toBe('done')
    expect(pair.seeks).toHaveLength(contentShift < 2 ? 1 : 2)
    expect(pair.rateChanges.some(change => change.rate !== 1)).toBe(contentShift < 2)
    expect(pair.rewinds.at(-1)).toEqual(result.appliedRewind)
    expect(pair.rates).toEqual({ official: 1, commentary: 1 })
    expect(Math.abs(pair.error())).toBeLessThanOrEqual(.15)
  })

  it('does not claim success when a landed stream only displays a frozen clock', async () => {
    const pair = livePair({ frozenAfterSeek: true })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 })
    expect(result.failure?.kind).toBe('verify-failed')
    expect(result.failure?.message).toContain('复核未通过')
    expect(pair.windows()).toBe(4)
    expect(pair.seeks).toHaveLength(1)
  })

  it('bounds a live seek that never resumes and restores playback rates', async () => {
    const pair = livePair({ neverResume: true })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 })
    expect(result.failure?.kind).toBe('verify-failed')
    expect(result.failure?.message).toContain('暂停或缓冲')
    expect(pair.windows()).toBe(1)
    expect(pair.rates).toEqual({ official: 1, commentary: 1 })
  })

  it('rejects earlier good jumps when the decoder stops delivering frames at the end of verification', async () => {
    const pair = livePair({ staleLastFrames: true })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 })
    expect(result.failure?.kind).toBe('verify-failed')
    expect(pair.windows()).toBe(4)
    expect(pair.seeks).toHaveLength(1)
  })

  it('discards verification across repeated timeline discontinuities without looping forever', async () => {
    const pair = livePair({ interruptVerification: true })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 })
    expect(result.failure?.kind).toBe('verify-failed')
    expect(pair.windows()).toBe(4)
    expect(pair.rates).toEqual({ official: 1, commentary: 1 })
  })

  it('does not apply another correction after cancellation during fresh verification', async () => {
    const pair = livePair({ seekDelay: 500 })
    const original = pair.deps.sample
    const controller = new AutoSyncController(pair.deps)
    pair.deps.sample = async (...args) => {
      if (pair.windows() === 1) controller.cancel()
      await original(...args)
    }
    const result = await controller.run({ official: 0, commentary: 0 })
    expect(result.failure?.kind).toBe('cancelled')
    expect(pair.seeks).toHaveLength(1)
    expect(pair.rates).toEqual({ official: 1, commentary: 1 })
    expect(controller.autoApplyAuthorized).toBe(false)
  })

  it('does not relax an unconfirmed VOD seek merely because live recovery exists', async () => {
    const pair = livePair({ landingError: .45, falseSeek: true })
    const snapshot = pair.deps.snapshot
    pair.deps.snapshot = role => ({ ...snapshot(role)!, timebase: { kind: 'vod', duration: 1000 } })
    const result = await new AutoSyncController(pair.deps).run({ official: 0, commentary: 0 })
    expect(result.failure?.kind).toBe('seek-failed')
    expect(pair.windows()).toBe(1)
  })
})
