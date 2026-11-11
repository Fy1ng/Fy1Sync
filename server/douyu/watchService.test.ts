import { afterEach, describe, expect, it, vi } from 'vitest'
import { DouyuGatewayCoordinator } from './gatewayCoordinator'
import { DouyuWatchService, type DouyuWatchContext } from './watchService'
import type { DouyuWatchPlaybackReport } from './watchTypes'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const coordinator = new DouyuGatewayCoordinator()
  let signal: AbortSignal | undefined
  let heartbeat: ((at: number) => void) | undefined
  let stats: (() => { bytes: number; cdn: string }) | undefined
  let seconds: number | null = 100
  let cumulativeSeconds: number | null = 1000
  let badgeOwned: boolean | null = true
  const run = vi.fn(async (_account: string, _room: string, value: AbortSignal, sample: () => { bytes: number; cdn: string }, ack: (at: number) => void) => {
    signal = value; heartbeat = ack; stats = sample
    await new Promise<void>(resolve => {
      value.addEventListener('abort', () => resolve(), { once: true })
      if (value.aborted) resolve()
    })
  })
  const read = vi.fn(async (accountId: string, room: string) => ({ accountId, room, checkedAt: Date.now(), seconds, source: 'douyu-today-watch' as const }))
  const readCumulative = vi.fn(async (accountId: string, room: string) => ({ accountId, room, checkedAt: Date.now(), seconds: cumulativeSeconds,
    badgeOwned, badgeLevel: badgeOwned ? 22 : null, source: 'douyu-fanshome-cumulative' as const }))
  const service = new DouyuWatchService({ coordinator, run, readWatchTime: read, readFansWatchTime: readCumulative })
  const context: DouyuWatchContext = { accountId: 'default', room: '100', loggedIn: true, busy: false, locked: false, suspended: false, live: true, replay: false }
  service.setContext(context)
  let time = 0, bytes = 0
  const report = (playing = true, changes: Partial<DouyuWatchPlaybackReport> = {}, room = '100', generation = '1') => {
    time += playing ? 2 : 0; bytes += 1000
    return service.report(1, { role: 'commentary', playing, currentTime: time, decodedBytes: null, presentedFrames: null, ...changes },
      { room, cdn: 'tct-h5', bytes, generation })
  }
  const tick = async () => { await vi.advanceTimersByTimeAsync(2000); report(); await vi.advanceTimersByTimeAsync(0) }
  const start = async () => { report(false); await tick() }
  cleanups.push(async () => { await service.dispose(); coordinator.dispose() })
  return { service, coordinator, context, run, read, readCumulative, report, tick, start,
    signal: () => signal, ack: () => heartbeat?.(Date.now()), stats: () => stats?.(), setSeconds: (value: number | null) => { seconds = value },
    setCumulative: (value: number | null) => { cumulativeSeconds = value }, setBadge: (value: boolean | null) => { badgeOwned = value } }
}

describe('real playback watch leases', () => {
  it.each([
    { live: true, replay: true, reason: '轮播' },
    { live: false, replay: false, reason: '未开播' },
    { live: true, replay: null, reason: '尚未确认' },
    { live: null, replay: false, reason: '尚未确认' },
  ])('does not keep viewing reports alive for $reason', async ({ live, replay, reason }) => {
    const f = fixture(); await f.start()
    f.service.setContext({ ...f.context, live, replay })
    expect(f.signal()?.aborted).toBe(true)
    expect(f.service.snapshot()).toMatchObject({ phase: 'paused' })
    expect(f.service.snapshot().reason).toContain(reason)
    await vi.advanceTimersByTimeAsync(0)
    f.service.setContext(f.context)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.run).toHaveBeenCalledTimes(2)
  })

  it('requires progress and keeps an acknowledged connection separate from official credit', async () => {
    const f = fixture()
    f.report()
    expect(f.run).not.toHaveBeenCalled()
    await f.tick()
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.service.snapshot().baselineSeconds).toBe(100)
    f.ack()
    expect(f.service.snapshot()).toMatchObject({ phase: 'reporting', verifiedIncrease: 0 })
    expect(f.stats()).toEqual({ bytes: 1000, cdn: 'tct-h5' })
    expect(f.stats()).toEqual({ bytes: 0, cdn: 'tct-h5' })
  })

  it.each(['locked', 'suspended', 'busy'] as const)('stops the connection immediately when %s', async gate => {
    const f = fixture(); await f.start()
    f.service.setContext({ ...f.context, [gate]: true })
    expect(f.signal()?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.snapshot().phase).toBe(gate === 'busy' ? 'login-required' : 'paused')
  })

  it('stops on pause, renderer loss and expired progress reports', async () => {
    const f = fixture(); await f.start()
    f.report(false)
    expect(f.signal()?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await f.tick()
    expect(f.run).toHaveBeenCalledTimes(2)
    f.service.releaseSender(1)
    expect(f.signal()?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await f.start()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(f.signal()?.aborted).toBe(true)
    expect(f.service.snapshot().phase).toBe('paused')
  })

  it('does not accept another room, a media-clock jump or a replaced source as continuing playback', async () => {
    const f = fixture(); await f.start()
    f.report(true, {}, '200')
    expect(f.signal()?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    f.report(true, { currentTime: 900 })
    await vi.advanceTimersByTimeAsync(2000)
    f.report(true, { currentTime: 1900 })
    expect(f.run).toHaveBeenCalledTimes(1)
    f.report(true, {}, '100', 'replacement')
    expect(f.service.snapshot().phase).toBe('paused')
  })

  it('cancels account ownership before switching away and requires fresh playback for the new account', async () => {
    const f = fixture(); await f.start()
    f.service.setContext({ ...f.context, accountId: 'second' })
    expect(f.signal()?.aborted).toBe(true)
    expect(f.service.snapshot()).toMatchObject({ accountId: 'second', baselineSeconds: null, verifiedIncrease: 0, phase: 'paused' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.run).toHaveBeenCalledTimes(1)
  })

  it('yields to a short operation, then resumes only with live playback', async () => {
    const f = fixture(); await f.start()
    let release!: () => void
    const short = f.coordinator.runShort('default', new AbortController().signal, () => new Promise<void>(resolve => { release = resolve }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.snapshot().phase).toBe('yielding')
    expect(f.signal()?.aborted).toBe(true)
    release(); await short
    await vi.advanceTimersByTimeAsync(0)
    expect(f.run).toHaveBeenCalledTimes(2)
  })

  it('verifies official increments after heartbeats while playback remains fresh', async () => {
    const f = fixture(); await f.start(); f.ack(); f.setSeconds(160); f.setCumulative(1060)
    for (let i = 0; i < 30; i++) await f.tick()
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.service.snapshot()).toMatchObject({ phase: 'verified', officialSeconds: 160, baselineSeconds: 100, verifiedIncrease: 60,
      cumulativeSeconds: 1060, cumulativeBaselineSeconds: 1000, cumulativeIncrease: 60, badgeOwned: true })
  })

  it('cannot pass cumulative acceptance based on daily growth alone', async () => {
    const f = fixture(); await f.start(); f.ack(); f.setSeconds(714)
    for (let i = 0; i < 30; i++) await f.tick()
    expect(f.service.snapshot()).toMatchObject({ phase: 'unverified', verifiedIncrease: 614, cumulativeIncrease: 0 })
    expect(f.service.snapshot().reason).toContain('粉丝牌累计观时')
  })
  it('keeps cumulative baselines independent from daily rollovers and query failures', async () => {
    const f = fixture(); await f.start(); f.ack()
    f.setSeconds(5); f.setCumulative(1060)
    for (let i = 0; i < 30; i++) await f.tick()
    expect(f.service.snapshot()).toMatchObject({ cumulativeBaselineSeconds: 1000, cumulativeIncrease: 60, baselineSeconds: 5, phase: 'verified' })
    f.readCumulative.mockRejectedValue(new Error('unavailable'))
    for (let i = 0; i < 30; i++) await f.tick()
    expect(f.service.snapshot()).toMatchObject({ phase: 'unverified', cumulativeSeconds: null, cumulativeIncrease: 0, badgeOwned: null })
  })

  it('requires an owned badge and re-establishes the baseline after acquiring one', async () => {
    const f = fixture(); f.setBadge(false); f.setCumulative(0); await f.start(); f.ack()
    f.setCumulative(60)
    for (let i = 0; i < 30; i++) await f.tick()
    expect(f.service.snapshot()).toMatchObject({ phase: 'unverified', badgeOwned: false })
    f.setBadge(true); f.setCumulative(120)
    for (let i = 0; i < 30; i++) await f.tick()
    expect(f.service.snapshot()).toMatchObject({ cumulativeBaselineSeconds: 120, cumulativeIncrease: 0 })
  })

  it('leaves missing official records unverified and resets a declining daily counter', async () => {
    const f = fixture(); await f.start(); f.ack(); f.setSeconds(null)
    for (let i = 0; i < 30; i++) await f.tick()
    expect(f.service.snapshot()).toMatchObject({ phase: 'unverified', officialSeconds: null, verifiedIncrease: 0 })
    f.setSeconds(5)
    for (let i = 0; i < 30; i++) await f.tick()
    expect(f.service.snapshot()).toMatchObject({ phase: 'unverified', baselineSeconds: 5, verifiedIncrease: 0 })
  })

  it('bounds failed reconnects instead of treating unsupported protocols as success', async () => {
    const f = fixture()
    f.run.mockRejectedValue(new Error('synthetic sensitive payload'))
    await f.start()
    for (let i = 0; i < 60; i++) await f.tick()
    expect(f.run).toHaveBeenCalledTimes(4)
    expect(f.service.snapshot()).toMatchObject({ phase: 'failed', verifiedIncrease: 0 })
    expect(JSON.stringify(f.service.snapshot())).not.toContain('synthetic sensitive payload')
  })

  it('stops retrying a known unsupported protocol and can recover after explicit login renewal', async () => {
    const f = fixture()
    f.run.mockRejectedValue(Object.assign(new Error('Unsupported fixture'), { code: 'protocol-unsupported' }))
    await f.start()
    for (let i = 0; i < 10; i++) await f.tick()
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.service.snapshot().reason).toContain('尚未支持')
    f.service.setContext({ ...f.context, loggedIn: false })
    f.service.setContext(f.context)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.run).toHaveBeenCalledTimes(2)
  })
})
