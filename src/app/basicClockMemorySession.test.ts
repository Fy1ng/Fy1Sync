import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { BasicClockProgress } from '../recognition/protocol'
import type { RecognitionSampler } from '../recognition/sampler'
import type { MediaDescriptor, RecognitionOutcome, SourceRole } from '../core/types'
import type { SettingsStorage } from './settings'
import { primeMediaElement } from '../test/setup'
import * as buildSearch from '../core/basicClockSearch'

const sessions: Session[] = []
beforeEach(() => vi.spyOn(buildSearch, 'getBasicClockSearchRoi').mockReturnValue(null))
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks() })
const roi = { x: .44, y: .04, w: .12, h: .08 }
const another = { x: .25, y: .12, w: .18, h: .1 }
const source = (id: string): MediaDescriptor => ({ kind: 'progressive', url: 'https://cdn.example.test/' + id + '.mp4',
  input: 'https://www.youtube.com/watch?v=' + id, platform: 'youtube', label: id, viaProxy: false, loop: false })
function storage(): SettingsStorage {
  let raw: string | null = null
  return { getItem: () => raw, setItem: (_key, value) => { raw = value } }
}
function locked(mode: 'auto' | 'manual' | 'memory' = 'auto', region = roi): BasicClockProgress {
  return { diagnostic: { status: 'locked', mode, roi: region, text: '1:20', inputSize: { width: 1920, height: 1080 } },
    debug: null, frameIndex: 20, receivedAt: 1000 }
}
function clock(emit: (role: SourceRole, outcome: RecognitionOutcome) => void): void {
  for (const role of ['official', 'commentary'] as const) for (let second = 0; second < 3; second++) for (let frame = 0; frame < 2; frame++) {
    emit(role, { status: 'success', reading: { text: '0:' + (59 - second), seconds: 59 - second, confidence: .95, scores: [.95],
      mediaTime: 100 + second + frame / 30, wallTime: 1000 + second * 1000 + frame * 1000 / 30, frameIndex: second * 2 + frame } })
  }
}
async function harness(saved: SettingsStorage) {
  let session: Session
  let readingAt = 0
  const sample = vi.fn(async (_duration: number, emit: (role: SourceRole, outcome: RecognitionOutcome) => void) => {
    for (const role of ['official', 'commentary'] as const) session.receiveBasicProgress(role, locked())
    clock(emit)
  })
  session = new Session({ storage: saved, readingClock: () => readingAt,
    createSampler: () => ({ sample: (window: number, emit: (role: SourceRole, outcome: RecognitionOutcome) => void) =>
      sample(window, (role, outcome) => {
        if (outcome.status === 'success') readingAt = outcome.reading.wallTime
        emit(role, outcome)
      }), dispose: vi.fn() }) as unknown as RecognitionSampler })
  sessions.push(session)
  await attach(session, 'official', source('official123'))
  await attach(session, 'commentary', source('commentary123'))
  await session.setPlaying(true)
  return { session, sample }
}
async function attach(session: Session, role: SourceRole, descriptor: MediaDescriptor): Promise<void> {
  await session.loadSource(role, descriptor)
  const video = session.engine.element(role)
  Object.defineProperties(video, { videoWidth: { configurable: true, value: 1920 }, videoHeight: { configurable: true, value: 1080 } })
  primeMediaElement(video, { duration: 600, currentTime: 100 })
}

describe('persistent automatic clock memories', () => {
  it('retains each live role envelope when both roles share one persisted source key', async () => {
    const { session, sample } = await harness(storage())
    await attach(session, 'commentary', source('official123'))
    await session.setPlaying(true)
    const wider = { ...roi, x: roi.x - .002, w: roi.w + .004 }
    sample.mockImplementationOnce(async (_duration, emit) => {
      session.receiveBasicProgress('official', locked('auto', roi))
      session.receiveBasicProgress('commentary', locked('auto', wider))
      clock(emit)
    })
    expect((await session.measureOnce()).phase).toBe('done')
    expect(session.settings.basicClockMemory).toHaveLength(1)
    expect(session.profileFor('official')).toMatchObject({ roi, roiOrigin: 'memory' })
    expect(session.profileFor('commentary')).toMatchObject({ roi: wider, roiOrigin: 'memory' })
    session.setBasicClockRoi(null)
    expect(session.profileFor('official')).not.toHaveProperty('roi')
    expect(session.profileFor('commentary')).not.toHaveProperty('roi')
  })

  it('records confirmed source regions without changing the active sampling profile, then restores them after restart', async () => {
    const saved = storage()
    const { session, sample } = await harness(saved)
    sample.mockImplementationOnce(async (_duration, emit) => {
      const before = session.profileFor('official')
      session.receiveBasicProgress('official', locked())
      session.receiveBasicProgress('commentary', locked())
      expect(session.profileFor('official')).toBe(before)
      expect(session.profileFor('official')).not.toHaveProperty('roi')
      clock(emit)
    })
    expect((await session.measureOnce()).phase).toBe('done')
    expect(session.settings.basicClockMemory).toHaveLength(2)
    expect(session.profileFor('official')).toMatchObject({ roi, roiOrigin: 'memory' })
    const restart = await harness(saved)
    expect(restart.session.profileFor('official')).toMatchObject({ roi, roiOrigin: 'memory' })
    expect(restart.session.profileFor('commentary')).toMatchObject({ roi, roiOrigin: 'memory' })
    const cache = restart.session.settings.basicClockMemory
    restart.sample.mockImplementationOnce(async (_duration, emit) => {
      restart.session.receiveBasicProgress('official', locked('memory', another))
      clock(emit)
    })
    await restart.session.measureOnce()
    expect(restart.session.settings.basicClockMemory).toBe(cache)
    expect(restart.session.profileFor('official')).toMatchObject({ roi, roiOrigin: 'memory' })
  })

  it('does not record candidates, unbound results, manual selections or results from a cancelled source', async () => {
    const { session, sample } = await harness(storage())
    session.receiveBasicProgress('official', locked())
    expect(session.settings.basicClockMemory).toEqual([])
    sample.mockImplementationOnce(async (_duration, emit) => {
      session.receiveBasicProgress('official', { ...locked(), diagnostic: { ...locked().diagnostic, status: 'confirming' } })
      session.receiveBasicProgress('commentary', locked('manual'))
      clock(emit)
    })
    await session.measureOnce()
    expect(session.settings.basicClockMemory).toEqual([])
    let finish!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    sample.mockImplementationOnce(async () => {
      started()
      await new Promise<void>(resolve => { finish = resolve })
      session.receiveBasicProgress('official', locked())
    })
    const run = session.measureOnce()
    await waiting
    await attach(session, 'official', source('replacement123'))
    finish()
    await run
    expect(session.settings.basicClockMemory).toEqual([])
  })

  it('keeps the shared manual selection ahead of both memories and explicitly resets the current pair', async () => {
    const saved = storage()
    const { session } = await harness(saved)
    await session.measureOnce()
    session.setBasicClockRoi(another)
    expect(session.profileFor('official')).toMatchObject({ roi: another, roiOrigin: 'manual' })
    expect(session.profileFor('commentary')).toMatchObject({ roi: another, roiOrigin: 'manual' })
    const restart = await harness(saved)
    expect(restart.session.profileFor('official')).toMatchObject({ roi: another, roiOrigin: 'manual' })
    restart.session.setBasicClockRoi(null)
    expect(restart.session.settings.basicClockMemory).toEqual([])
    expect(restart.session.profileFor('official')).not.toHaveProperty('roi')
    expect(restart.session.profileFor('commentary')).not.toHaveProperty('roi')
    await attach(restart.session, 'commentary', source('otherRoom123'))
    expect(restart.session.profileFor('commentary')).not.toHaveProperty('roi')
  })

  it('limits remembered positions to the fixed production search interval after restart', async () => {
    const saved = storage()
    const { session } = await harness(saved)
    await session.measureOnce()
    expect(session.profileFor('official')).toMatchObject({ roiOrigin: 'memory' })
    vi.spyOn(buildSearch, 'getBasicClockSearchRoi').mockReturnValue({ x: .05, y: .5, w: .3, h: .2 })
    const restarted = await harness(saved)
    for (const role of ['official', 'commentary'] as const) {
      expect(restarted.session.profileFor(role)).not.toHaveProperty('roi')
      expect(restarted.session.profileFor(role)).toHaveProperty('searchRoi')
    }
    expect(restarted.session.settings.basicClockMemory).toHaveLength(2)
  })

  it('reuses the same proportional layout at another resolution but not at another aspect ratio', async () => {
    const { session } = await harness(storage())
    await session.measureOnce()
    const video = session.engine.element('official')
    Object.defineProperties(video, { videoWidth: { configurable: true, value: 3840 }, videoHeight: { configurable: true, value: 2160 } })
    expect(session.profileFor('official')).toMatchObject({ roi, roiOrigin: 'memory' })
    Object.defineProperties(video, { videoWidth: { configurable: true, value: 1440 }, videoHeight: { configurable: true, value: 1080 } })
    expect(session.profileFor('official')).not.toHaveProperty('roi')
  })
})
