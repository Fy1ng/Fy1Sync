import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { hlsLoader } from '../media/hlsController'
import { createEmptyHudStylePack } from '../core/hudStylePack'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import type { RecognitionSampler } from '../recognition/sampler'
import { primeMediaElement } from '../test/setup'

const sessions: Session[] = []
const source = { kind: 'progressive' as const, url: '/test.mp4', input: 'test', label: '测试', loop: false, viaProxy: false }
const originalLoader = hlsLoader.load
const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }

function hlsFixture() {
  const instances: FakeHls[] = []
  class FakeHls {
    static isSupported = () => true
    static Events = { MANIFEST_PARSED: 'manifest', LEVEL_LOADED: 'playlist', LEVEL_SWITCHING: 'switching',
      LEVEL_SWITCHED: 'switched', FRAG_CHANGED: 'changed', FRAG_LOADING: 'loading', FRAG_LOADED: 'loaded',
      FRAG_BUFFERED: 'buffered', ERROR: 'error' }
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' }
    handlers = new Map<string, (event: string, data: any) => void>()
    levels = []
    currentLevel = -1
    nextLevel = -1
    autoLevelEnabled = true
    liveSyncPosition = 90
    constructor() { instances.push(this) }
    on(event: string, handler: (event: string, data: any) => void) { this.handlers.set(event, handler) }
    emit(event: string, data: any = {}) { this.handlers.get(event)?.(event, data) }
    loadSource() {}
    attachMedia() {}
    destroy() {}
    startLoad() {}
    recoverMediaError() {}
  }
  hlsLoader.load = async () => ({ default: FakeHls }) as unknown as Awaited<ReturnType<typeof hlsLoader.load>>
  return instances
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => {
  sessions.splice(0).forEach(session => session.dispose())
  hlsLoader.load = originalLoader
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function harness(options: { hls?: boolean; sampler?: RecognitionSampler; readingClock?: () => number } = {}) {
  const session = new Session({ createSampler: () => options.sampler ?? null, readingClock: options.readingClock })
  sessions.push(session)
  for (const role of ['official', 'commentary'] as const) {
    await session.loadSource(role, { ...source, kind: options.hls ? 'hls' : 'progressive' })
    primeMediaElement(session.engine.element(role), { currentTime: 100 })
  }
  await session.setPlaying(true)
  const step = async (official = 0.5, commentary = 0.5) => {
    for (const role of ['official', 'commentary'] as const) {
      const video = session.engine.element(role)
      primeMediaElement(video, { currentTime: video.currentTime + (role === 'official' ? official : commentary) })
    }
    await vi.advanceTimersByTimeAsync(500)
    session.flush()
  }
  const stall = async () => { for (let i = 0; i < 4; i++) await step(0, 0.5) }
  const recover = async () => { await step(); await step() }
  await step()
  return { session, step, stall, recover }
}

describe('playback recovery authorization', () => {
  it.each(['disabled', 'revoked'] as const)('only prompts after a stall when %s, without moving either picture', async mode => {
    const h = await harness()
    if (mode === 'revoked') { h.session.setAutoSyncEnabled(true); await h.session.applyOffset(0); await h.step() }
    const run = vi.spyOn(h.session.autoSync, 'run')
    const authorize = vi.spyOn(h.session.autoSync, 'authorize')
    const seek = vi.spyOn(h.session.engine, 'seek')
    await h.stall(); await h.recover()
    expect(h.session.flush().playbackRecovery).toEqual({ kind: 'stall', driftSeconds: 2 })
    expect(run).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    expect(seek).not.toHaveBeenCalled()
    expect(h.session.engine.element('official').currentTime).toBe(mode === 'revoked' ? 102 : 101.5)
    expect(h.session.engine.element('commentary').currentTime).toBe(mode === 'revoked' ? 104 : 103.5)
    if (mode === 'revoked') expect(h.session.autoSync.autoApplyAuthorized).toBe(false)
  })

  it('runs once without reauthorizing and keeps the prompt after failure', async () => {
    const h = await harness()
    h.session.setAutoSyncEnabled(true)
    const authorize = vi.spyOn(h.session.autoSync, 'authorize')
    const run = vi.spyOn(h.session.autoSync, 'run')
    await h.stall(); await h.recover()
    for (let i = 0; i < 8; i++) await h.step()
    expect(run).toHaveBeenCalledTimes(1)
    expect(authorize).not.toHaveBeenCalled()
    expect(h.session.flush().playbackRecovery?.kind).toBe('stall')
    expect(h.session.autoSync.result?.failure).not.toBeNull()
  })

  it('shares the running gate with a simultaneous scheduler tick', async () => {
    let finish!: () => void
    const sample = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const h = await harness({ sampler: { sample, dispose() {} } as unknown as RecognitionSampler })
    h.session.setProfileForAll(createEmptyHudStylePack('test'))
    h.session.setAutoSyncInterval(15)
    h.session.setAutoSyncEnabled(true)
    await h.stall(); await h.recover()
    expect(sample).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sample).toHaveBeenCalledTimes(1)
    await h.session.applyOffset(0)
    expect(h.session.autoSync.autoApplyAuthorized).toBe(false)
    finish(); await tick()
    expect(h.session.flush().playbackRecovery).toBeNull()
  })

  it('coalesces recovery with a due scheduler tick even when failure is immediate', async () => {
    const h = await harness()
    h.session.setAutoSyncInterval(15)
    h.session.setAutoSyncEnabled(true)
    const run = vi.spyOn(h.session.autoSync, 'run')
    for (let i = 0; i < 24; i++) await h.step()
    await h.stall(); await h.recover()
    expect(run).toHaveBeenCalledTimes(1)
    expect(h.session.flush().playbackRecovery?.kind).toBe('stall')
    expect(h.session.flush().autoSync.nextRunInSeconds).toBe(15)
  })

  it.each(['offset', 'seek', 'source'] as const)('clears the prompt on manual %s', async action => {
    const h = await harness()
    await h.stall(); await h.recover()
    expect(h.session.flush().playbackRecovery).not.toBeNull()
    if (action === 'offset') await h.session.applyOffset(1)
    if (action === 'seek') await h.session.seekPlayback('official', -1)
    if (action === 'source') await h.session.loadSource('official', source)
    expect(h.session.flush().playbackRecovery).toBeNull()
  })

  it.each(['explicit', 'recovery'] as const)('clears the prompt after successful %s alignment', async mode => {
    let baseline: Record<SourceRole, number> | undefined
    let readingAt = 0
    const sampler = { dispose() {}, async sample(_window: number, emit: (role: SourceRole, outcome: RecognitionOutcome) => void) {
      baseline ??= { official: h.session.engine.element('official').currentTime, commentary: h.session.engine.element('commentary').currentTime }
      for (const role of ['official', 'commentary'] as const) for (let index = 0; index < 3; index++) for (let stable = 0; stable < 2; stable++) {
        emit(role, { status: 'success', reading: { text: `0:${59 - index}`, seconds: 59 - index,
          scores: [0.95], confidence: 0.95, mediaTime: 100 + index + stable / 30,
          wallTime: (readingAt = 1000 + index * 1000 + stable * 1000 / 30 + (role === 'commentary' ? 5000 : 0)
            + (baseline[role] - h.session.engine.element(role).currentTime) * 1000), frameIndex: index * 2 + stable } })
      }
    } } as unknown as RecognitionSampler
    const h = await harness({ sampler, readingClock: () => readingAt })
    vi.spyOn(h.session.autoSync as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockImplementation(async ms => {
      for (const role of ['official', 'commentary'] as const) {
        const video = h.session.engine.element(role)
        primeMediaElement(video, { currentTime: video.currentTime + ms / 1000 * video.playbackRate })
      }
    })
    h.session.setProfileForAll(createEmptyHudStylePack('test'))
    if (mode === 'recovery') h.session.setAutoSyncEnabled(true)
    const authorize = vi.spyOn(h.session.autoSync, 'authorize')
    await h.stall(); await h.recover()
    if (mode === 'explicit') expect(h.session.flush().playbackRecovery).not.toBeNull()
    const aligning = mode === 'explicit' ? h.session.syncNow() : null
    await vi.advanceTimersByTimeAsync(1000)
    const result = aligning ? await aligning : h.session.autoSync.result
    expect(result?.applied).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(mode === 'explicit' ? 1 : 0)
    expect(h.session.flush().playbackRecovery).toBeNull()
  })

  it.each(['pip', 'changing', 'seek', 'quality'] as const)('discards observation across %s and rebuilds its baseline', async mode => {
    const instances = hlsFixture()
    const h = await harness({ hls: true })
    const video = h.session.engine.element('official')
    let generation = 0
    if (mode === 'pip') h.session.setPresentationReduced(true)
    if (mode === 'changing') generation = h.session.beginSourceChange('official')
    if (mode === 'seek') Object.defineProperty(video, 'seeking', { configurable: true, value: true })
    if (mode === 'quality') instances[0]!.emit('switching')
    await h.stall()
    instances[0]!.emit('changed', { frag: { cc: 1 } })
    instances[0]!.emit('changed', { frag: { cc: 2 } })
    await h.step(0, 0.5)
    if (mode === 'pip') h.session.setPresentationReduced(false)
    if (mode === 'changing') h.session.endSourceChange('official', generation)
    if (mode === 'seek') Object.defineProperty(video, 'seeking', { configurable: true, value: false })
    if (mode === 'quality') instances[0]!.emit('switched', { level: 0 })
    await h.recover(); await h.step()
    expect(h.session.flush().playbackRecovery).toBeNull()
  })

  it('diagnoses a single playing source even when its peer is empty', async () => {
    const h = await harness()
    h.session.unloadSource('commentary')
    for (let i = 0; i < 5; i++) await h.step(0, 0)
    expect(h.session.flush().playbackDiagnostics.official).toMatchObject({ ongoing: true })
    expect(h.session.flush().playbackRecovery).toBeNull()
  })

  it('rebuilds the baseline even if a quality switch begins and ends between ticks', async () => {
    const instances = hlsFixture()
    const h = await harness({ hls: true })
    await h.stall()
    instances[0]!.emit('switching')
    instances[0]!.emit('switched', { level: 0 })
    await h.recover(); await h.step()
    expect(h.session.flush().playbackRecovery).toBeNull()
  })

  it('waits for stalled playback to recover before handling a content discontinuity', async () => {
    const instances = hlsFixture()
    const h = await harness({ hls: true })
    instances[0]!.emit('changed', { frag: { cc: 1 } })
    await h.stall()
    instances[0]!.emit('changed', { frag: { cc: 2 } })
    await h.step(0, 0.5)
    expect(h.session.flush().playbackRecovery).toBeNull()
    await h.recover()
    expect(h.session.flush().playbackRecovery).toEqual({ kind: 'reconnect', driftSeconds: null })
  })

  it('stops sampling on suspend and dispose', async () => {
    const h = await harness()
    h.session.suspend()
    const before = h.session.exportPlaybackDiagnostics()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.session.exportPlaybackDiagnostics()).toEqual(before)
    h.session.dispose()
    await vi.advanceTimersByTimeAsync(5000)
  })
})

describe('hls renderer evidence and continuity', () => {
  it('ignores initial, equal and decreasing cc; only increasing cc prompts', async () => {
    const instances = hlsFixture()
    const h = await harness({ hls: true })
    for (const cc of [4, 4, 3]) {
      instances[0]!.emit('changed', { frag: { cc } })
      await h.step()
      expect(h.session.flush().playbackRecovery).toBeNull()
    }
    instances[0]!.emit('changed', { frag: { cc: 5 } })
    await h.step()
    expect(h.session.flush().playbackRecovery).toEqual({ kind: 'reconnect', driftSeconds: null })
  })

  it('ignores continuity and telemetry from the previous attachment generation', async () => {
    const instances = hlsFixture()
    const h = await harness({ hls: true })
    const old = instances[0]!
    old.emit('changed', { frag: { cc: 1 } })
    await h.session.loadSource('official', source)
    primeMediaElement(h.session.engine.element('official'), { currentTime: 20 })
    await h.session.engine.element('official').play()
    old.emit('changed', { frag: { cc: 2 } })
    old.emit('playlist', { details: { live: true, fragments: [{ start: 0, duration: 999 }] } })
    old.emit('loading', { frag: { type: 'main', cc: 2, level: 0, sn: 1, start: 0, duration: 999 } })
    await h.step()
    expect(h.session.flush().playbackRecovery).toBeNull()
    expect(h.session.engine.playbackSample('official')).toMatchObject({ discontinuities: 0, playlistEnd: null, fragment: null })
  })

  it('records playlist edges and fragment elapsed phases without exporting requests', async () => {
    const instances = hlsFixture()
    const h = await harness({ hls: true })
    const player = instances[0]!
    const frag = { type: 'main', cc: 1, level: 0, sn: 1, start: 100, duration: 4, url: 'secret-url' }
    player.emit('playlist', { details: { live: true, fragments: [frag] } })
    player.emit('loading', { frag })
    await vi.advanceTimersByTimeAsync(200)
    player.emit('loaded', { frag })
    const loaded = h.session.engine.playbackSample('official')
    expect(loaded).toMatchObject({ playlistStart: 100, playlistEnd: 104,
      fragment: { phase: 'loaded', start: 100, end: 104 } })
    expect(loaded.fragment!.loadMs).toBeGreaterThanOrEqual(200)
    expect(loaded.fragment!.elapsedMs).toBe(0)
    player.emit('buffered', { frag })
    player.emit('loaded', { frag: { ...frag, sn: 0 } })
    expect(h.session.engine.playbackSample('official').fragment?.phase).toBe('buffered')
    await h.step()
    expect(JSON.stringify(h.session.exportPlaybackDiagnostics())).not.toContain('secret-url')
  })
})
