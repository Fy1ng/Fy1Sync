import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { apiClient } from './apiClient'
import { createEmptyProfile } from '../core/profileSchema'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import { AutoProfileController } from '../recognition/autoProfile'
import type { RecognitionSampler } from '../recognition/sampler'
import { primeMediaElement } from '../test/setup'
import type { AutoSyncRunResult } from '../sync/autoSync'
import type { ScoreGuardResult } from '../recognition/score'

let session: Session
afterEach(() => { session?.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })
const profile = createEmptyProfile('saved/original', '原预设')
const source = { kind: 'progressive' as const, url: 'https://example.test/source.mp4', label: '测试', input: '测试', loop: false, viaProxy: false }
const frames = Array.from({ length: 30 }, (_, i) => ({ width: 1, height: 1, mediaTime: i / 8, wallTime: i * 125, pixels: new Uint8ClampedArray(4) }))

async function harness(automatic = true, position = 100) {
  const checkScore = vi.fn(async (): Promise<ScoreGuardResult> => ({ status: 'pass', checkedAt: 0, generation: 'test' }))
  const sample = vi.fn(async (_window: number, emit: (role: SourceRole, outcome: RecognitionOutcome) => void) => {
    for (const role of ['official', 'commentary'] as const) {
      for (let index = 0; index < 3; index++) for (let stable = 0; stable < 2; stable++) {
        emit(role, { status: 'success', reading: {
          text: `0:${59 - index}`, seconds: 59 - index, scores: [0.95], confidence: 0.95,
          mediaTime: position + index + stable / 30,
          wallTime: 1000 + index * 1000 + stable * 1000 / 30 + (role === 'commentary' ? 5000 : 0),
          frameIndex: index * 2 + stable,
        } })
      }
    }
  })
  session = new Session({
    createSampler: () => ({ sample, dispose: vi.fn(), scoreGeneration: () => 'test',
      checkScore,
    }) as unknown as RecognitionSampler,
    ...(automatic ? { createAutoProfiles: (options: ConstructorParameters<typeof import('../recognition/autoProfile').OnlineAutoProfiles>[0]) => {
      const client = {
        locate: vi.fn(async () => ({ status: 'success' as const, backend: 'wasm' as const, windowId: 1,
          candidates: [{ roi: profile.roi, score: 0.95, period: 1, jitter: 0, eventTimes: [1, 2, 3], persistence: 1, glyphScore: 1 }] })),
        learn: vi.fn(async () => ({ status: 'success' as const, backend: 'wasm' as const, profile, report: {
          profile, confidence: 0.95, learnedChars: ['0', '1', ':'], missingChars: [], observations: 12, consistentOffsets: 1, reason: null,
        } })), cancel: vi.fn(), dispose: vi.fn(),
      }
      const controller = new AutoProfileController({ client: () => client, capture: async () => frames, use: options.use, changed: options.changed })
      return { controller, monitor: vi.fn(), reset: role => controller.reset(role),
        suspend: () => { controller.cancel('official'); controller.cancel('commentary') }, dispose: () => controller.dispose() }
    } } : {}),
  })
  await session.loadSource('official', source)
  await session.loadSource('commentary', source)
  for (const role of ['official', 'commentary'] as const) primeMediaElement(session.engine.element(role), { duration: 600, currentTime: position })
  return { sample, checkScore }
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('automatic profile session integration', () => {
  it('keeps the session offset and both playheads when score evidence is unavailable', async () => {
    const h = await harness(false)
    h.checkScore.mockResolvedValue({ status: 'unknown', reason: 'score-unavailable', checkedAt: 0, generation: 'test' })
    session.setProfileForAll(profile)
    const seek = vi.spyOn(session.engine, 'seek')
    const result = await session.syncNow()
    expect(result.failure?.kind).toBe('score-unknown')
    expect(seek).not.toHaveBeenCalled()
    expect(session.flush()).toMatchObject({ appliedRewind: { official: 0, commentary: 0 }, requestedOffsetSeconds: 0 })
    for (const role of ['official', 'commentary'] as const) {
      expect(session.engine.element(role).currentTime).toBe(100)
      expect(session.engine.element(role).playbackRate).toBe(1)
    }
  })

  it('lets a manual playback decision cancel an active alignment before changing playback', async () => {
    const h = await harness(false)
    let release!: () => void
    h.sample.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    session.setProfileForAll(profile)
    const seek = vi.spyOn(session.engine, 'seek')
    const pending = session.syncNow()
    await settle()
    expect(session.autoSync.isRunning).toBe(true)
    await session.setPlaying(false)
    release()
    expect((await pending).failure?.kind).toBe('cancelled')
    expect(session.autoSync.autoApplyAuthorized).toBe(false)
    expect(seek).not.toHaveBeenCalled()
    for (const role of ['official', 'commentary'] as const) expect(session.engine.element(role).paused).toBe(true)
  })

  it('holds sync until both candidates are accepted, aligns and never saves implicitly', async () => {
    const h = await harness()
    const save = vi.spyOn(apiClient, 'savePreset')
    const pending = session.syncNow()
    await settle()
    expect(session.flush().autoProfiles.official.phase).toBe('ready')
    expect(h.sample).not.toHaveBeenCalled()
    session.acceptAutoProfile('official')
    await settle()
    expect(h.sample).not.toHaveBeenCalled()
    session.acceptAutoProfile('commentary')
    const result = await pending
    expect(result.phase).toBe('done')
    expect(session.flush().profiles.official?.id).toBe('session/official')
    expect(session.flush().profiles.commentary?.id).toBe('session/commentary')
    expect(session.flush().appliedRewind).toEqual({ official: 5, commentary: 0 })
    expect(save).not.toHaveBeenCalled()
  })

  it('cancel during candidate confirmation ends the run without seeking', async () => {
    await harness()
    const seek = vi.spyOn(session.engine, 'seek')
    const pending = session.syncNow()
    await settle()
    session.cancelAutoSync()
    const result = await pending
    expect(result.failure?.kind).toBe('cancelled')
    expect(seek).not.toHaveBeenCalled()
    for (const role of ['official', 'commentary'] as const) expect(session.engine.element(role).playbackRate).toBe(1)
  })

  it('cancels one source without waiting for or discarding the other candidate', async () => {
    await harness()
    const pending = session.syncNow()
    await settle()
    session.cancelAutoProfile('official')
    expect((await pending).failure?.kind).toBe('cancelled')
    expect(session.flush().autoProfiles.commentary.phase).toBe('ready')
    session.acceptAutoProfile('commentary')
    expect(session.flush().profiles.commentary?.id).toBe('session/commentary')
  })

  it('restores positions and offsets when the requested rewind exceeds the buffer', async () => {
    await harness(false, 2)
    session.setProfileForAll(profile)
    const result = await session.syncNow()
    expect(result.failure?.kind).toBe('buffer-limit')
    expect(result.rollback?.status).toBe('restored')
    expect(session.flush()).toMatchObject({ appliedRewind: { official: 0, commentary: 0 }, requestedOffsetSeconds: 0 })
    expect(session.engine.element('official').currentTime).toBe(2)
  })

  it('writes scheduled results back, so repeating the same manual offset cannot undo them', async () => {
    vi.useFakeTimers()
    await harness(false)
    session.setProfileForAll(profile)
    session.setAutoSyncInterval(15)
    session.setAutoSyncEnabled(true)
    await vi.advanceTimersByTimeAsync(15_500)
    expect(session.flush().appliedRewind.official).toBe(5)
    const before = session.engine.element('official').currentTime
    await session.applyOffset(5)
    expect(session.engine.element('official').currentTime).toBe(before)
    expect(session.flush().autoSync.authorized).toBe(false)
  })

  it('discards a stale run result after source replacement and preserves an unrelated peer rate', async () => {
    await harness(false)
    let finish!: (result: AutoSyncRunResult) => void
    vi.spyOn(session.autoSync, 'run').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = session.syncNow()
    session.engine.element('official').playbackRate = 0.95
    session.engine.element('commentary').playbackRate = 1.05
    await session.loadSource('official', { ...source, url: 'https://example.test/new.mp4' })
    expect(session.engine.element('official').playbackRate).toBe(1)
    expect(session.engine.element('commentary').playbackRate).toBe(1.05)
    finish({ applied: true, appliedRewind: { official: 22, commentary: 0 } } as AutoSyncRunResult)
    await pending
    expect(session.flush().appliedRewind.official).toBe(0)
  })

  it('only explicit save writes a fresh preset id, leaving the original preset intact', async () => {
    await harness()
    const pending = session.measureOnce()
    await settle()
    session.acceptAutoProfile('official'); session.acceptAutoProfile('commentary')
    await pending
    const save = vi.spyOn(apiClient, 'savePreset').mockResolvedValue({ ok: true, value: { id: 'new', etag: 'new', updatedAt: 1 } })
    expect(await session.saveAutoProfile('official')).toBe(true)
    expect(save.mock.calls[0]?.[0]).toMatch(/^auto\/official-/u)
    expect(save.mock.calls[0]?.[0]).not.toBe(profile.id)
    expect(profile.id).toBe('saved/original')
  })
})
