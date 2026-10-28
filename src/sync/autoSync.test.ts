import { describe, expect, it, vi } from 'vitest'
import { AutoSyncController, type AutoSyncDeps } from './autoSync'
import type { AppliedRewind, MediaSnapshot, RecognitionOutcome, SourceRole } from '../core/types'
import { NO_REWIND } from '../core/types'
import type { ScoreGuardRequest, ScoreGuardResult, ScoreReading } from '../recognition/score'

/**
 * A promise the test releases by hand, to hold a run open at a chosen point.
 * Written as a helper because assigning the resolver to a `let` inside the executor
 * leaves TypeScript narrowing it to `null` at every call site.
 */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** A countdown reading the ClockJumpDetector will accept. */
function reading(text: string, seconds: number, mediaTime: number, wallTime: number): RecognitionOutcome {
  return {
    status: 'success',
    reading: {
      text,
      seconds,
      scores: [0.95],
      confidence: 0.95,
      mediaTime,
      wallTime,
      frameIndex: Math.round(mediaTime * 30),
    },
  }
}

/**
 * Emit a decreasing countdown for one role. `wallOffsetMs` shifts the whole stream
 * on the shared wall clock, which is what a delayed source looks like.
 */
function countdown(
  role: SourceRole,
  values: readonly number[],
  wallOffsetMs: number,
  emit: (role: SourceRole, outcome: RecognitionOutcome) => void,
  startMediaTime = 100,
): void {
  values.forEach((value, index) => {
    const text = `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
    const wall = 1000 + index * 1000 + wallOffsetMs
    const mediaTime = startMediaTime + index
    // Two frames per value so the detector's stability requirement is met.
    emit(role, reading(text, value, mediaTime, wall))
    emit(role, reading(text, value, mediaTime + 0.033, wall + 33))
  })
}

type Positions = Record<SourceRole, number>

function makeDeps(
  overrides: Partial<AutoSyncDeps> = {},
  init: {
    positions?: Positions
    official?: readonly number[]
    commentary?: readonly number[]
    officialWallOffsetMs?: number
    commentaryWallOffsetMs?: number
    seekShortfall?: number
  } = {},
): { deps: AutoSyncDeps; positions: Positions; seeks: Array<{ role: SourceRole; to: number }> } {
  const positions: Positions = { ...(init.positions ?? { official: 500, commentary: 500 }) }
  const seeks: Array<{ role: SourceRole; to: number }> = []

  const deps: AutoSyncDeps = {
    sample: async (_windowMs, onOutcome) => {
      countdown('official', init.official ?? [119, 118, 117], init.officialWallOffsetMs ?? 0, onOutcome)
      countdown(
        'commentary',
        init.commentary ?? [119, 118, 117],
        init.commentaryWallOffsetMs ?? 0,
        onOutcome,
      )
    },
    snapshot: (role): MediaSnapshot => ({
      role,
      currentTime: positions[role],
      timebase: { kind: 'live', seekableStart: 0, seekableEnd: 600 },
      ready: true,
    }),
    seek: async (role, target) => {
      seeks.push({ role, to: target })
      positions[role] = target - (init.seekShortfall ?? 0)
      return true
    },
    now: () => 1_000,
    sleep: async () => {},
    checkScore: async () => ({ status: 'pass', checkedAt: 1_000, generation: 'fixture' }),
    scoreGeneration: () => 'fixture',
    ...overrides,
  }
  return { deps, positions, seeks }
}

const applied: AppliedRewind = { ...NO_REWIND }

function scoreReading(left: number, right: number): ScoreReading {
  return {
    left, right, leftQuality: 0.95, rightQuality: 0.95, reason: null,
    mediaTime: 500, wallTime: 1_000, source: 'fixture', generation: 1,
    width: 1920, height: 1080, segment: 1, frameIndex: 1,
  }
}

function scoreResult(status: ScoreGuardResult['status'], reason?: string): ScoreGuardResult {
  return {
    status, reason, checkedAt: 1_000, generation: 'fixture',
    official: scoreReading(9, 8), commentary: scoreReading(status === 'mismatch' ? 7 : 9, status === 'mismatch' ? 7 : 8),
  }
}

describe('AutoSyncController score guard', () => {
  it.each([
    ['mismatch', 'score-mismatch'], ['unknown', 'score-unknown'], ['transition', 'score-transition'],
  ] as const)('blocks %s before either seek or rate adjustment, including dry runs', async (status, kind) => {
    for (const residual of [5, 0.5]) {
      for (const dryRun of [false, true]) {
        const rates: Positions = { official: 1, commentary: 1 }
        const setRate = vi.fn((role: SourceRole, rate: number) => { rates[role] = rate })
        const onAppliedRewind = vi.fn()
        const fixture = makeDeps({
          checkScore: async () => scoreResult(status), setPlaybackRate: setRate, onAppliedRewind,
        }, { commentaryWallOffsetMs: residual * 1000 })
        const controller = new AutoSyncController(fixture.deps, { scoreWaitSeconds: 0 })
        const result = await (dryRun ? controller.dryRun(applied) : controller.run(applied))
        expect(result.failure?.kind).toBe(kind)
        expect(result.scoreCheck?.status).toBe(status)
        expect(result.applied).toBe(false)
        expect(fixture.seeks).toHaveLength(0)
        expect(fixture.positions).toEqual({ official: 500, commentary: 500 })
        expect(rates).toEqual({ official: 1, commentary: 1 })
        expect(setRate).not.toHaveBeenCalled()
        expect(onAppliedRewind).not.toHaveBeenCalled()
      }
    }
  })

  it('includes both numeric scores when they disagree', async () => {
    const fixture = makeDeps({ checkScore: async () => scoreResult('mismatch') }, { commentaryWallOffsetMs: 5_000 })
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.failure?.message).toBe('两路比分不同（官方 9:8，解说 7:7），未调整')
  })

  it('does not silently bypass an unsupported score backend', async () => {
    const fixture = makeDeps({ checkScore: undefined }, { commentaryWallOffsetMs: 5_000 })
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.failure?.kind).toBe('score-unknown')
    expect(result.scoreCheck?.reason).toBe('unsupported')
    expect(fixture.seeks).toEqual([])
  })

  it('waits a finite number of times for history and never applies on timeout', async () => {
    const check = vi.fn(async () => scoreResult('unknown', 'history-insufficient'))
    const fixture = makeDeps({ checkScore: check }, { commentaryWallOffsetMs: 18_000 })
    const result = await new AutoSyncController(fixture.deps, { scoreWaitSeconds: 0.5 }).run(applied)
    expect(check).toHaveBeenCalledTimes(3)
    expect(result.failure?.kind).toBe('score-unknown')
    expect(fixture.seeks).toEqual([])
  })

  it('replans from the current playheads after waiting for the boundary to settle', async () => {
    const fixture = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    let checks = 0
    fixture.deps.checkScore = async request => {
      expect(request.residualSeconds).toBe(5)
      checks += 1
      fixture.positions.official += 1
      fixture.positions.commentary += 1
      return scoreResult(checks === 1 ? 'transition' : 'pass')
    }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(checks).toBe(2)
    expect(result.phase).toBe('done')
    expect(fixture.seeks).toEqual([{ role: 'official', to: 497 }])
  })

  it('uses residual rather than the total carried rewind for score comparison', async () => {
    const check = vi.fn(async (_request: ScoreGuardRequest) => scoreResult('pass'))
    const fixture = makeDeps({ checkScore: check }, { commentaryWallOffsetMs: 5_000 })
    const result = await new AutoSyncController(fixture.deps).dryRun({ official: 8, commentary: 2 })
    expect(result.estimate?.totalOffsetSeconds).toBe(11)
    expect(check.mock.calls[0]?.[0]).toMatchObject({ residualSeconds: 5 })
  })

  it('rejects a source generation change while score evidence is awaited', async () => {
    let generation = 'fixture'
    const fixture = makeDeps({
      scoreGeneration: () => generation,
      checkScore: async () => { generation = 'replacement'; return scoreResult('pass') },
    }, { commentaryWallOffsetMs: 5_000 })
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.scoreCheck?.reason).toBe('generation-changed')
    expect(result.applied).toBe(false)
    expect(fixture.seeks).toEqual([])
  })

  it('rejects a measurement if relative playback progress changes during score waiting', async () => {
    const fixture = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    fixture.deps.checkScore = async () => {
      fixture.positions.official += 1
      return scoreResult('pass')
    }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.scoreCheck?.reason).toBe('measurement-stale')
    expect(fixture.seeks).toEqual([])
  })

  it('rechecks cancellation after awaiting score evidence', async () => {
    const gate = deferred()
    const entered = deferred()
    const fixture = makeDeps({ checkScore: async () => { entered.release(); await gate.promise; return scoreResult('pass') } },
      { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(fixture.deps)
    const pending = controller.run(applied)
    await entered.promise
    controller.cancel()
    gate.release()
    expect((await pending).failure?.kind).toBe('cancelled')
    expect(fixture.seeks).toEqual([])
  })
})

describe('AutoSyncController failed adjustment rollback', () => {
  it('restores both starting playheads and carried offsets when a seek partially fails', async () => {
    const initial = { official: 5, commentary: 1 }
    const published: AppliedRewind[] = []
    const fixture = makeDeps({ onAppliedRewind: value => published.push(value) }, { commentaryWallOffsetMs: 5_000 })
    let calls = 0
    fixture.deps.seek = async (role, target) => {
      fixture.seeks.push({ role, to: target })
      fixture.positions[role] = target
      calls += 1
      return calls > 1
    }
    const result = await new AutoSyncController(fixture.deps).run(initial)
    expect(result.failure?.kind).toBe('seek-failed')
    expect(result.rollback?.status).toBe('restored')
    expect(result.applied).toBe(false)
    expect(fixture.positions).toEqual({ official: 500, commentary: 500 })
    expect(result.appliedRewind).toEqual(initial)
    expect(published.at(-1)).toEqual(initial)
    expect(fixture.seeks).toEqual([{ role: 'official', to: 496 }, { role: 'official', to: 500 }])
  })

  it('restores both playheads and offsets after post-seek verification fails', async () => {
    const fixture = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const published: AppliedRewind[] = []
    fixture.deps.onAppliedRewind = value => published.push(value)
    fixture.deps.sleep = async () => { fixture.positions.commentary += 1 }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.failure?.kind).toBe('verify-failed')
    expect(result.rollback?.status).toBe('restored')
    expect(fixture.positions).toEqual({ official: 500, commentary: 500 })
    expect(result.appliedRewind).toEqual(applied)
    expect(published.at(-1)).toEqual(applied)
    expect(result.applied).toBe(false)
  })

  it('keeps natural playback progress when restoring a playing pair', async () => {
    let now = 1_000
    const fixture = makeDeps({
      now: () => now,
      playbackState: role => ({ paused: false, playbackRate: 1, source: role }),
    }, { commentaryWallOffsetMs: 5_000 })
    fixture.deps.sleep = async ms => {
      now += ms
      fixture.positions.official += ms / 1000
      fixture.positions.commentary += ms / 1000 + 1
    }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.rollback?.status).toBe('restored')
    expect(fixture.positions).toEqual({ official: 500.4, commentary: 500.4 })
    expect(result.appliedRewind).toEqual(applied)
  })

  it('freezes both sources at one restoration instant across slow recovery seeks', async () => {
    let now = 1_000
    const paused: Record<SourceRole, boolean> = { official: false, commentary: false }
    const pauseChanges: Array<{ role: SourceRole; paused: boolean }> = []
    const fixture = makeDeps({
      now: () => now,
      playbackState: role => ({ paused: paused[role], playbackRate: 1, source: role }),
      setPaused: async (role, value) => { paused[role] = value; pauseChanges.push({ role, paused: value }) },
    }, { commentaryWallOffsetMs: 5_000 })
    let calls = 0
    fixture.deps.seek = async (role, target) => {
      fixture.seeks.push({ role, to: target })
      fixture.positions[role] = target
      calls += 1
      if (calls === 1) {
        now += 3_000
        fixture.positions.commentary += 4
        return false
      }
      expect(paused).toEqual({ official: true, commentary: true })
      now += 4_000
      return true
    }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.rollback?.status).toBe('restored')
    expect(result.appliedRewind).toEqual(applied)
    expect(fixture.positions).toEqual({ official: 503, commentary: 503 })
    expect(fixture.seeks).toEqual([
      { role: 'official', to: 495 }, { role: 'official', to: 503 }, { role: 'commentary', to: 503 },
    ])
    expect(pauseChanges).toEqual([
      { role: 'official', paused: true }, { role: 'commentary', paused: true },
      { role: 'official', paused: false }, { role: 'commentary', paused: false },
    ])
    expect(paused).toEqual({ official: false, commentary: false })
  })

  it('reports a failed restore instead of claiming the error was withdrawn', async () => {
    const fixture = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    let calls = 0
    fixture.deps.seek = async (role, target) => {
      calls += 1
      if (calls === 1) fixture.positions[role] = target
      return calls === 1
    }
    fixture.deps.sleep = async () => { fixture.positions.commentary += 1 }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.rollback?.status).toBe('failed')
    expect(result.applied).toBe(true)
    expect(result.failure?.message).toContain('撤回未完成')
    expect(result.appliedRewind).toEqual({ official: 5, commentary: 0 })
  })

  it('does not seek a replacement source while unwinding a failed application', async () => {
    let source = 'original'
    const fixture = makeDeps({ playbackState: () => ({ paused: true, playbackRate: 1, source }) },
      { commentaryWallOffsetMs: 5_000 })
    fixture.deps.seek = async (role, target) => {
      fixture.seeks.push({ role, to: target })
      fixture.positions[role] = target
      source = 'replacement'
      return false
    }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.rollback?.status).toBe('skipped')
    expect(fixture.seeks).toHaveLength(1)
  })
})

describe('AutoSyncController seek playback freeze', () => {
  function freezeFixture() {
    let now = 1_000
    const paused: Record<SourceRole, boolean> = { official: false, commentary: false }
    const source: Record<SourceRole, string> = { official: 'official', commentary: 'commentary' }
    const pauseChanges: Array<{ role: SourceRole; paused: boolean }> = []
    const fixture = makeDeps({
      now: () => now,
      playbackState: role => ({ paused: paused[role], playbackRate: 1, source: source[role] }),
      setPaused: async (role, value) => { paused[role] = value; pauseChanges.push({ role, paused: value }) },
    }, { commentaryWallOffsetMs: 5_000 })
    const advance = (ms: number): void => {
      now += ms
      for (const role of ['official', 'commentary'] as const) {
        if (!paused[role]) fixture.positions[role] += ms / 1000
      }
    }
    fixture.deps.sleep = async ms => { advance(ms) }
    return { ...fixture, paused, source, pauseChanges, advance }
  }

  it('keeps the peer frozen while a slow official seek decodes, then resumes both', async () => {
    const fixture = freezeFixture()
    fixture.deps.seek = async (role, target) => {
      fixture.seeks.push({ role, to: target })
      expect(fixture.paused).toEqual({ official: true, commentary: true })
      fixture.advance(3_000)
      fixture.positions[role] = target
      return true
    }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.phase).toBe('done')
    expect(result.divergence).toBe(0)
    expect(result.appliedRewind).toEqual({ official: 5, commentary: 0 })
    expect(fixture.positions).toEqual({ official: 495.4, commentary: 500.4 })
    expect(fixture.paused).toEqual({ official: false, commentary: false })
    expect(fixture.pauseChanges).toEqual([
      { role: 'official', paused: true }, { role: 'commentary', paused: true },
      { role: 'official', paused: false }, { role: 'commentary', paused: false },
    ])
  })

  it('keeps a source that was already paused in its original state', async () => {
    const fixture = freezeFixture()
    fixture.paused.official = true
    fixture.paused.commentary = true
    fixture.deps.seek = async (role, target) => {
      fixture.seeks.push({ role, to: target })
      fixture.advance(3_000)
      fixture.positions[role] = target
      return true
    }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.phase).toBe('done')
    expect(fixture.paused).toEqual({ official: true, commentary: true })
    expect(fixture.pauseChanges).toEqual([])
  })

  it('releases owned pauses during cancel and does not overwrite the subsequent manual action', async () => {
    const gate = deferred()
    const entered = deferred()
    const fixture = freezeFixture()
    fixture.deps.seek = async () => { entered.release(); await gate.promise; return true }
    const controller = new AutoSyncController(fixture.deps)
    const pending = controller.run(applied)
    await entered.promise
    expect(fixture.paused).toEqual({ official: true, commentary: true })
    controller.cancel()
    expect(fixture.paused).toEqual({ official: false, commentary: false })
    fixture.paused.official = true
    gate.release()
    expect((await pending).failure?.kind).toBe('cancelled')
    expect(fixture.paused).toEqual({ official: true, commentary: false })
    expect(fixture.pauseChanges).toHaveLength(4)
  })

  it('never restores the playback state of a replacement source on cancel', async () => {
    const gate = deferred()
    const entered = deferred()
    const fixture = freezeFixture()
    fixture.deps.seek = async () => { entered.release(); await gate.promise; return true }
    const controller = new AutoSyncController(fixture.deps)
    const pending = controller.run(applied)
    await entered.promise
    fixture.source.official = 'replacement'
    fixture.paused.official = true
    controller.cancel()
    gate.release()
    expect((await pending).failure?.kind).toBe('cancelled')
    expect(fixture.paused).toEqual({ official: true, commentary: false })
    expect(fixture.pauseChanges).toEqual([
      { role: 'official', paused: true }, { role: 'commentary', paused: true },
      { role: 'commentary', paused: false },
    ])
  })

  it('releases the unaffected peer when rollback is skipped for a replacement source', async () => {
    const fixture = freezeFixture()
    fixture.deps.seek = async () => { fixture.source.official = 'replacement'; return false }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.rollback?.status).toBe('skipped')
    expect(fixture.paused).toEqual({ official: true, commentary: false })
    expect(fixture.pauseChanges).toEqual([
      { role: 'official', paused: true }, { role: 'commentary', paused: true },
      { role: 'commentary', paused: false },
    ])
  })

  it('does not freeze playback until the score guard has passed', async () => {
    const fixture = freezeFixture()
    fixture.deps.checkScore = async () => scoreResult('mismatch')
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.failure?.kind).toBe('score-mismatch')
    expect(fixture.pauseChanges).toEqual([])
    expect(fixture.seeks).toEqual([])
    expect(fixture.paused).toEqual({ official: false, commentary: false })
  })
})

describe('AutoSyncController', () => {
  it('estimates and applies a rewind when the commentary source lags', async () => {
    // Commentary jumps 5s later on the wall clock -> commentary is behind -> rewind official.
    const { deps, seeks, positions } = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.phase).toBe('done')
    expect(result.applied).toBe(true)
    expect(result.estimate?.direction).toBe('official')
    expect(result.estimate?.totalOffsetSeconds).toBeCloseTo(5, 2)
    expect(seeks).toEqual([{ role: 'official', to: 495 }])
    expect(positions.official).toBe(495)
    expect(result.divergence).toBe(0)
    expect(controller.phase).toBe('done')
  })

  it('rewinds the commentary source when it runs ahead', async () => {
    const { deps, seeks } = makeDeps({}, { officialWallOffsetMs: 4_000 })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.estimate?.direction).toBe('commentary')
    expect(result.estimate?.totalOffsetSeconds).toBeCloseTo(-4, 2)
    expect(seeks).toEqual([{ role: 'commentary', to: 496 }])
  })

  it('reports aligned sources without seeking', async () => {
    const { deps, seeks } = makeDeps()
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.phase).toBe('done')
    expect(result.estimate?.direction).toBe('none')
    expect(seeks).toEqual([])
    expect(result.applied).toBe(true)
  })

  it('measures without seeking in dry-run mode', async () => {
    const { deps, seeks } = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(deps)

    const result = await controller.dryRun(applied)

    expect(result.dryRun).toBe(true)
    expect(result.applied).toBe(false)
    expect(result.plan?.seeks).toHaveLength(1)
    expect(seeks).toEqual([])
  })

  it('refuses to start when a source is not ready', async () => {
    const { deps } = makeDeps({
      snapshot: (role) =>
        role === 'commentary'
          ? null
          : {
              role,
              currentTime: 10,
              timebase: { kind: 'vod', duration: 100 },
              ready: true,
            },
    })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.phase).toBe('failed')
    expect(result.failure).toMatchObject({ kind: 'not-ready', message: '解说源尚未就绪' })
  })

  it('fails with no-samples when the window produced no frames', async () => {
    const { deps } = makeDeps({ sample: async () => {} })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.failure?.kind).toBe('no-samples')
    expect(result.samples).toEqual({ official: 0, commentary: 0 })
  })

  it('surfaces the estimator rejection reason and its Chinese text', async () => {
    // Only the official source produces jumps.
    const { deps } = makeDeps({
      sample: async (_windowMs, onOutcome) => {
        countdown('official', [119, 118, 117], 0, onOutcome)
        onOutcome('commentary', { status: 'failed', reason: 'low-confidence' })
      },
    })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.failure).toMatchObject({
      kind: 'rejected',
      reason: 'no-commentary-jump',
      message: '解说源未捕获倒计时跳秒',
    })
    expect(result.samples.commentary).toBe(1)
    expect(result.jumps.official).toBeGreaterThan(0)
  })

  it('fails when a seek is not confirmed', async () => {
    const { deps } = makeDeps({ seek: async () => false }, { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.failure).toMatchObject({ kind: 'seek-failed', message: '官方源跳转未生效，已撤回调整' })
    expect(result.plan).not.toBeNull()
  })

  it('fails verification when the source lands outside tolerance', async () => {
    const { deps } = makeDeps({}, { commentaryWallOffsetMs: 5_000, seekShortfall: 1.2 })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.failure?.kind).toBe('verify-failed')
    expect(result.applied).toBe(true)
    expect(result.divergence).toBeCloseTo(1.2, 2)
  })

  it('accepts a landing inside the 0.35s gate of the sync design', async () => {
    const { deps } = makeDeps({}, { commentaryWallOffsetMs: 5_000, seekShortfall: 0.3 })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.phase).toBe('done')
    expect(result.divergence).toBeCloseTo(0.3, 2)
  })

  it('does not count the settle delay elapsing on playing sources as divergence', async () => {
    // Verification runs after a settle delay, so by then both elements have advanced.
    // Measured per source that reads as a ~0.5s error on each and fails the gate; the
    // sources are in fact exactly as far apart as the plan asked.
    const { deps, positions } = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const advancing: AutoSyncDeps = {
      ...deps,
      sleep: async () => {
        positions.official += 0.5
        positions.commentary += 0.5
      },
    }
    const controller = new AutoSyncController(advancing)

    const result = await controller.run(applied)

    expect(result.phase).toBe('done')
    expect(result.divergence).toBe(0)
    expect(positions).toEqual({ official: 495.5, commentary: 500.5 })
  })

  it('still catches a one-sided jump while both sources are playing', async () => {
    // Only the untouched side lurching counts: an ad break or a stall on the commentary
    // element moves it relative to the official one, which is exactly the failure the
    // gate exists to catch.
    const { deps, positions } = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const lurching: AutoSyncDeps = {
      ...deps,
      sleep: async () => {
        positions.official += 0.5
        positions.commentary += 1.4
      },
    }
    const controller = new AutoSyncController(lurching)

    const result = await controller.run(applied)

    expect(result.failure?.kind).toBe('verify-failed')
    expect(result.divergence).toBeCloseTo(0.9, 2)
  })

  it('cancels an in-flight run and revokes auto-apply authorization', async () => {
    const { promise: gate, release } = deferred()
    const { deps, seeks } = makeDeps(
      {
        sample: async (_windowMs, onOutcome) => {
          countdown('official', [119, 118, 117], 0, onOutcome)
          countdown('commentary', [119, 118, 117], 5_000, onOutcome)
          await gate
        },
      },
      { commentaryWallOffsetMs: 5_000 },
    )
    const controller = new AutoSyncController(deps)

    const pending = controller.run(applied)
    controller.cancel()
    release()
    const result = await pending

    expect(result.failure?.kind).toBe('cancelled')
    expect(seeks).toEqual([])
    expect(controller.autoApplyAuthorized).toBe(false)
  })

  it('blocks apply runs while authorization is revoked and allows dry runs', async () => {
    const { deps } = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(deps)
    controller.cancel()

    const blocked = await controller.run(applied)
    expect(blocked.failure).toMatchObject({
      kind: 'unauthorized',
      message: '手动调整后需要重新开启自动同步',
    })

    const measured = await controller.dryRun(applied)
    expect(measured.phase).toBe('done')

    controller.authorize()
    const allowed = await controller.run(applied)
    expect(allowed.phase).toBe('done')
  })

  it('rejects a second concurrent run', async () => {
    const { promise: gate, release } = deferred()
    const { deps } = makeDeps({
      sample: async (_windowMs, onOutcome) => {
        countdown('official', [119, 118, 117], 0, onOutcome)
        countdown('commentary', [119, 118, 117], 0, onOutcome)
        await gate
      },
    })
    const controller = new AutoSyncController(deps)

    const first = controller.run(applied)
    const second = await controller.run(applied)
    expect(second.failure).toMatchObject({ kind: 'cancelled', message: '已有一次自动同步在进行中' })
    expect(controller.isRunning).toBe(true)
    expect((await controller.run(applied)).failure?.kind).toBe('cancelled')

    release()
    expect((await first).phase).toBe('done')
  })

  it('carries the already-applied rewind into the estimate', async () => {
    // Official already rewound 5s and the streams now line up: total offset stays 5.
    const { deps, seeks } = makeDeps()
    const controller = new AutoSyncController(deps)

    const result = await controller.run({ official: 5, commentary: 0 })

    expect(result.estimate?.residualSeconds).toBeCloseTo(0, 2)
    expect(result.estimate?.totalOffsetSeconds).toBeCloseTo(5, 2)
    // Nothing to move: the rewind it should carry equals the rewind it carries.
    expect(seeks).toEqual([])
  })

  it('emits phase transitions in order', async () => {
    const { deps } = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(deps)
    const phases: string[] = []
    controller.onPhaseChange((phase) => phases.push(phase))

    await controller.run(applied)

    expect(phases).toEqual(['sampling', 'estimating', 'checking-content', 'applying', 'verifying', 'done'])
  })

  it('reports a failed phase to subscribers', async () => {
    const { deps } = makeDeps({ sample: async () => {} })
    const controller = new AutoSyncController(deps)
    const phases: string[] = []
    const unsubscribe = controller.onPhaseChange((phase) => phases.push(phase))

    await controller.run(applied)
    expect(phases).toEqual(['sampling', 'failed'])

    unsubscribe()
    await controller.run(applied)
    expect(phases).toEqual(['sampling', 'failed'])
  })

  it('turns a thrown dependency error into a failure result', async () => {
    const { deps } = makeDeps({
      sample: async () => {
        throw new Error('worker 已退出')
      },
    })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.failure).toMatchObject({ kind: 'seek-failed', message: 'worker 已退出' })
    expect(controller.isRunning).toBe(false)
  })

  it('runs the scheduler on its interval and skips while unauthorized', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps()
      const controller = new AutoSyncController(deps, { schedulerIntervalSeconds: 30 })
      const runs = vi.spyOn(controller, 'run')

      controller.startScheduler(() => applied)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(runs).toHaveBeenCalledTimes(1)

      controller.cancel()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runs).toHaveBeenCalledTimes(1)

      controller.authorize()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(runs).toHaveBeenCalledTimes(2)

      controller.stopScheduler()
      await vi.advanceTimersByTimeAsync(90_000)
      expect(runs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the scheduler and clears listeners on dispose', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps()
      const controller = new AutoSyncController(deps, { schedulerIntervalSeconds: 5 })
      const runs = vi.spyOn(controller, 'run')
      const seen: string[] = []
      controller.onPhaseChange((phase) => seen.push(phase))

      controller.startScheduler(() => applied)
      controller.dispose()
      await vi.advanceTimersByTimeAsync(20_000)

      expect(runs).not.toHaveBeenCalled()
      expect(seen).toEqual([])
      // dispose must not revoke authorization; it is not user intent.
      expect(controller.autoApplyAuthorized).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the last result available for the status panel', async () => {
    const { deps } = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(deps)
    expect(controller.result).toBeNull()

    await controller.run(applied)

    expect(controller.result?.phase).toBe('done')
    expect(controller.result?.finishedAt).toBe(1_000)
    expect(controller.result?.jumps.official).toBeGreaterThan(0)
  })
})

describe('AutoSyncController.configure', () => {
  it('applies a new detection window to the next run', async () => {
    const windows: number[] = []
    const { deps } = makeDeps({
      sample: async (windowMs, onOutcome) => {
        windows.push(windowMs)
        countdown('official', [119, 118, 117], 0, onOutcome)
        countdown('commentary', [119, 118, 117], 0, onOutcome)
      },
    })
    const controller = new AutoSyncController(deps, { detectWindowSeconds: 3 })

    await controller.run(applied)
    controller.configure({ detectWindowSeconds: 2 })
    await controller.run(applied)

    expect(windows).toEqual([3_000, 2_000])
  })

  it('merges the patch instead of replacing the whole option set', async () => {
    const windows: number[] = []
    const { deps } = makeDeps({
      sample: async (windowMs, onOutcome) => {
        windows.push(windowMs)
        countdown('official', [119, 118, 117], 0, onOutcome)
        countdown('commentary', [119, 118, 117], 0, onOutcome)
      },
    })
    const controller = new AutoSyncController(deps, {
      detectWindowSeconds: 2,
      maxDivergenceSeconds: 0.35,
    })

    // Touching only the interval must leave the window and the tolerance alone.
    controller.configure({ schedulerIntervalSeconds: 15 })
    const result = await controller.run(applied)

    expect(windows).toEqual([2_000])
    expect(result.phase).toBe('done')
  })

  it('rebuilds a running scheduler so the new interval takes effect at once', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps()
      const controller = new AutoSyncController(deps, { schedulerIntervalSeconds: 60 })
      const runs = vi.spyOn(controller, 'run')

      controller.startScheduler(() => applied)
      controller.configure({ schedulerIntervalSeconds: 15 }, () => applied)

      // `setInterval` captured 60s at creation; without the rebuild nothing fires here.
      await vi.advanceTimersByTimeAsync(15_000)
      expect(runs).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(15_000)
      expect(runs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the old interval in place when no applied getter is supplied', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps()
      const controller = new AutoSyncController(deps, { schedulerIntervalSeconds: 60 })
      const runs = vi.spyOn(controller, 'run')

      controller.startScheduler(() => applied)
      // The rebuild needs a rewind getter to hand the next run; without one the
      // controller keeps the timer it already has rather than dropping the schedule.
      controller.configure({ schedulerIntervalSeconds: 15 })

      await vi.advanceTimersByTimeAsync(15_000)
      expect(runs).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(45_000)
      expect(runs).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a stopped scheduler', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps()
      const controller = new AutoSyncController(deps, { schedulerIntervalSeconds: 15 })
      const runs = vi.spyOn(controller, 'run')

      // Automatic sync is off; a settings change must not switch it on behind the user.
      controller.configure({ schedulerIntervalSeconds: 15 }, () => applied)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(runs).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AutoSyncController profile guard', () => {
  it('refuses to spend a detection window without a taught profile', async () => {
    let sampled = false
    const { deps, seeks } = makeDeps(
      {
        hasProfile: () => false,
        sample: async (_windowMs, onOutcome) => {
          sampled = true
          countdown('official', [119, 118, 117], 0, onOutcome)
          countdown('commentary', [119, 118, 117], 5_000, onOutcome)
        },
      },
      { commentaryWallOffsetMs: 5_000 },
    )
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.phase).toBe('failed')
    expect(result.failure).toMatchObject({
      kind: 'not-ready',
      message: '还没有选择识别场景，先在侧栏选一个再识别倒计时',
    })
    // The point of the guard: no window spent, no seek issued, nothing blamed on the picture.
    expect(sampled).toBe(false)
    expect(seeks).toEqual([])
    expect(controller.isRunning).toBe(false)
  })

  it('blocks a dry run too, which would otherwise report an empty window', async () => {
    const { deps } = makeDeps({ hasProfile: () => false })
    const controller = new AutoSyncController(deps)

    const result = await controller.dryRun(applied)

    expect(result.failure?.kind).toBe('not-ready')
    expect(result.samples).toEqual({ official: 0, commentary: 0 })
  })

  it('runs normally once a profile is present', async () => {
    const { deps, seeks } = makeDeps({ hasProfile: () => true }, { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.phase).toBe('done')
    expect(seeks).toEqual([{ role: 'official', to: 495 }])
  })

  it('runs when the caller supplies no profile check at all', async () => {
    // `hasProfile` is optional; omitting it must not read as "no profile".
    const { deps, seeks } = makeDeps({}, { commentaryWallOffsetMs: 5_000 })
    const controller = new AutoSyncController(deps)

    const result = await controller.run(applied)

    expect(result.phase).toBe('done')
    expect(seeks).toEqual([{ role: 'official', to: 495 }])
  })
})

describe('AutoSyncController rate correction', () => {
  function rateDeps(residual: number): ReturnType<typeof makeDeps> & {
    rates: Positions
    changes: Array<{ role: SourceRole; rate: number }>
    rewinds: AppliedRewind[]
  } {
    const fixture = makeDeps({}, { commentaryWallOffsetMs: residual * 1000 })
    const rates: Positions = { official: 1, commentary: 1 }
    const changes: Array<{ role: SourceRole; rate: number }> = []
    const rewinds: AppliedRewind[] = []
    fixture.deps.setPlaybackRate = (role, rate) => {
      rates[role] = rate
      changes.push({ role, rate })
    }
    fixture.deps.onAppliedRewind = (rewind) => rewinds.push(rewind)
    fixture.deps.sleep = async (ms) => {
      fixture.positions.official += ms / 1000 * rates.official
      fixture.positions.commentary += ms / 1000 * rates.commentary
    }
    return { ...fixture, rates, changes, rewinds }
  }

  it.each([1.5, 0.5, -0.5])('converges from %s seconds using actual media progress without seeking', async (residual) => {
    const fixture = rateDeps(residual)
    const controller = new AutoSyncController(fixture.deps)
    const result = await controller.run(applied)

    expect(result.phase).toBe('done')
    expect(result.divergence).toBeLessThanOrEqual(0.1)
    expect(fixture.seeks).toEqual([])
    expect(fixture.rates).toEqual({ official: 1, commentary: 1 })
    expect(fixture.changes.some((change) => change.rate < 1)).toBe(true)
    expect(fixture.changes.every((change) => change.rate >= 0.95 && change.rate <= 1.05)).toBe(true)
    const rewind = result.appliedRewind!
    expect(rewind.official - rewind.commentary).toBeCloseTo(residual, 0)
    expect(fixture.rewinds.at(-1)).toEqual(rewind)
  })

  it('does not nudge a measured residual already inside the deadband', async () => {
    const fixture = rateDeps(0.09)
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.phase).toBe('done')
    expect(fixture.changes.every((change) => change.rate === 1)).toBe(true)
    expect(fixture.seeks).toEqual([])
    expect(result.appliedRewind).toEqual(applied)
  })

  it('seeks above the configured threshold and never starts a rate nudge', async () => {
    const fixture = rateDeps(0.6)
    const result = await new AutoSyncController(fixture.deps, { seekThresholdSeconds: 0.5 }).run(applied)
    expect(result.phase).toBe('done')
    expect(fixture.seeks).toEqual([{ role: 'official', to: 499.4 }])
    expect(fixture.changes.every((change) => change.rate === 1)).toBe(true)
  })

  it('keeps both carried rewinds when a small correction changes direction', async () => {
    const fixture = rateDeps(-0.5)
    const result = await new AutoSyncController(fixture.deps).run({ official: 5, commentary: 0 })
    expect(result.phase).toBe('done')
    expect(result.appliedRewind?.official).toBe(5)
    expect(result.appliedRewind?.commentary).toBeGreaterThanOrEqual(0.4)
    expect(fixture.seeks).toEqual([])
  })

  it('fails a stalled pair instead of inferring convergence from elapsed time', async () => {
    const fixture = rateDeps(0.5)
    fixture.deps.sleep = async () => {}
    const result = await new AutoSyncController(fixture.deps, { rateTimeoutSeconds: 0.2 }).run(applied)
    expect(result.failure?.kind).toBe('verify-failed')
    expect(result.divergence).toBe(0.5)
    expect(result.appliedRewind).toEqual(applied)
    expect(fixture.rates).toEqual({ official: 1, commentary: 1 })
    expect(fixture.seeks).toEqual([])
  })

  it.each(['cancel', 'dispose'] as const)('restores both rates immediately on %s and retains partial progress', async (action) => {
    const fixture = rateDeps(0.5)
    const gate = deferred()
    fixture.deps.sleep = async (ms) => {
      fixture.positions.official += ms / 1000 * fixture.rates.official
      fixture.positions.commentary += ms / 1000 * fixture.rates.commentary
      await gate.promise
    }
    const controller = new AutoSyncController(fixture.deps)
    const pending = controller.run(applied)
    // Sampling resolves asynchronously before the first nudge poll.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.rates.official).toBe(0.95)
    if (action === 'dispose') controller.dispose()
    else controller.cancel(false)
    expect(fixture.rates).toEqual({ official: 1, commentary: 1 })
    gate.release()
    const result = await pending
    expect(result.failure?.kind).toBe('cancelled')
    expect(result.appliedRewind?.official).toBeCloseTo(0.005, 3)
    expect(fixture.rewinds.at(-1)).toEqual(result.appliedRewind)
  })

  it('restores rates when a dependency fails while correcting', async () => {
    const fixture = rateDeps(0.5)
    fixture.deps.sleep = async () => { throw new Error('media disconnected') }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.failure?.message).toBe('media disconnected，已撤回调整')
    expect(fixture.rates).toEqual({ official: 1, commentary: 1 })
  })

  it('hands over to seek if actual source drift grows above the threshold', async () => {
    const fixture = rateDeps(0.5)
    let drifted = false
    fixture.deps.sleep = async (ms) => {
      fixture.positions.official += ms / 1000 * fixture.rates.official
      fixture.positions.commentary += ms / 1000 * fixture.rates.commentary
      if (!drifted) {
        fixture.positions.official += 2
        drifted = true
      }
    }
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.phase).toBe('done')
    expect(fixture.seeks.length).toBeGreaterThan(0)
    expect(fixture.rates).toEqual({ official: 1, commentary: 1 })
    expect(result.appliedRewind!.official - result.appliedRewind!.commentary).toBeCloseTo(0.5, 2)
  })

  it('fails explicitly rather than seeking when rate control is unavailable', async () => {
    const fixture = makeDeps({}, { commentaryWallOffsetMs: 500 })
    const result = await new AutoSyncController(fixture.deps).run(applied)
    expect(result.failure?.kind).toBe('rate-unavailable')
    expect(fixture.seeks).toEqual([])
  })
})

describe('AutoSyncController buffer limits', () => {
  it('derives the next seek from current media time after an earlier seek buffered', async () => {
    const fixture = makeDeps({}, { officialWallOffsetMs: 10_000 })
    fixture.deps.seek = async (role, target) => {
      fixture.seeks.push({ role, to: target })
      fixture.positions[role] = target
      fixture.positions.official += 0.5
      fixture.positions.commentary += 0.5
      return true
    }
    const result = await new AutoSyncController(fixture.deps).run({ official: 5, commentary: 0 })
    expect(result.phase).toBe('done')
    expect(result.divergence).toBe(0)
    expect(result.appliedRewind).toEqual({ official: 0, commentary: 5 })
    expect(fixture.seeks).toEqual([{ role: 'official', to: 505 }, { role: 'commentary', to: 495.5 }])
  })

  it('withdraws a partial clamped seek and restores the previous rewind', async () => {
    const fixture = makeDeps({}, { commentaryWallOffsetMs: 5_000, positions: { official: 2, commentary: 2 } })
    const rewinds: AppliedRewind[] = []
    fixture.deps.onAppliedRewind = (rewind) => rewinds.push(rewind)
    const result = await new AutoSyncController(fixture.deps).run(applied)

    expect(result.phase).toBe('failed')
    expect(result.failure?.kind).toBe('buffer-limit')
    expect(result.applied).toBe(false)
    expect(result.plan?.effectiveOffset).toBe(2)
    expect(result.appliedRewind).toEqual(applied)
    expect(result.rollback?.status).toBe('restored')
    expect(rewinds.at(-1)).toEqual(result.appliedRewind)
    expect(fixture.positions).toEqual({ official: 2, commentary: 2 })
  })
})
