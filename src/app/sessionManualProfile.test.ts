import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { apiClient } from './apiClient'
import { createEmptyHudStylePack } from '../core/hudStylePack'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import type { RecognitionSampler } from '../recognition/sampler'
import { primeMediaElement } from '../test/setup'
import type { AutoSyncRunResult } from '../sync/autoSync'

let session: Session
afterEach(() => { session?.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })
const profile = createEmptyHudStylePack('saved/original', '原预设')
const source = { kind: 'progressive' as const, url: 'https://example.test/source.mp4', label: '测试', input: '测试', loop: false, viaProxy: false }

async function harness(position = 100) {
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
    createSampler: () => ({ sample, dispose: vi.fn() }) as unknown as RecognitionSampler,

  })
  await session.loadSource('official', source)
  await session.loadSource('commentary', source)
  for (const role of ['official', 'commentary'] as const) {
    Object.defineProperty(session.engine.element(role), 'videoWidth', { configurable: true, value: 1920 })
    Object.defineProperty(session.engine.element(role), 'videoHeight', { configurable: true, value: 1080 })
    primeMediaElement(session.engine.element(role), { duration: 600, currentTime: position })
  }
  session.setProfileForAll(profile)
  return { sample }
}

describe('manual style pack session integration', () => {
  it.each([
    { status: 'failed', reason: 'low-confidence' },
    { status: 'failed', reason: 'blank-frame' },
    { status: 'failed', reason: 'insufficient-templates' },
    { status: 'absent' },
    { status: 'indeterminate', reason: 'hud-content-indeterminate' },
    { status: 'success', reading: { text: '0:20', seconds: 20, confidence: 0.7, scores: [0.7], mediaTime: 100, wallTime: 1000, frameIndex: 1 } },
  ] satisfies RecognitionOutcome[])('keeps the selected HUD pack on unreliable readings ($status) and uses it after recovery', async outcome => {
    const h = await harness()
    const pack = { ...createEmptyHudStylePack('iem/cs2', 'IEM'), revision: 7187 }
    vi.spyOn(apiClient, 'getPreset').mockResolvedValue({ ok: true, value: { profile: pack, etag: 'iem-7187' } })
    expect(await session.selectProfile(pack.id)).toBe(true)
    const seek = vi.spyOn(session.engine, 'seek')
    h.sample.mockImplementationOnce(async (_window, emit) => {
      for (const role of ['official', 'commentary'] as const) emit(role, outcome)
    })
    const result = await session.syncNow()
    expect(result.failure?.kind).toBe('rejected')
    expect(result.applied).toBe(false)
    expect(result.samples).toEqual({ official: 1, commentary: 1 })
    expect(seek).not.toHaveBeenCalled()
    expect(h.sample).toHaveBeenCalledTimes(1)
    expect(session.flush().settings.profileId).toBe('iem/cs2')
    for (const role of ['official', 'commentary'] as const) expect(session.profileFor(role)).toEqual(pack)

    const recovered = await session.syncNow()
    expect(recovered.phase).toBe('done')
    expect(recovered.applied).toBe(true)
    for (const role of ['official', 'commentary'] as const) expect(session.profileFor(role)).toEqual(pack)
  })

  it('requires a manually supplied pack without sampling or creating templates', async () => {
    const h = await harness()
    session.setProfileForAll(null)
    const save = vi.spyOn(apiClient, 'savePreset')
    const seek = vi.spyOn(session.engine, 'seek')
    const result = await session.syncNow()
    expect(result.failure?.kind).toBe('not-ready')
    expect(result.failure?.message).toContain('手动')
    expect(h.sample).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(seek).not.toHaveBeenCalled()
    expect(session.profileFor('official')).toBeNull()
    expect(session.profileFor('commentary')).toBeNull()
  })

  it('ignores a cancelled sampling window that finishes late', async () => {
    const h = await harness()
    await session.measureOnce()
    let finish!: () => void
    const started = new Promise<void>(resolve => {
      h.sample.mockImplementationOnce(async (_window, emit) => {
        resolve()
        await new Promise<void>(done => { finish = done })
        for (const role of ['official', 'commentary'] as const) emit(role, { status: 'failed', reason: 'low-confidence' })
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
    session.setProfileForAll(profile)
    const result = await session.syncNow()
    expect(result.failure?.kind).toBe('buffer-limit')
    expect(session.flush()).toMatchObject({ appliedRewind: { official: 2, commentary: 0 }, requestedOffsetSeconds: 5 })
    expect(session.engine.element('official').currentTime).toBe(0)
  })

  it('writes scheduled results back, so repeating the same manual offset cannot undo them', async () => {
    vi.useFakeTimers()
    await harness()
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
