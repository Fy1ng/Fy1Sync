import { describe, expect, it, vi } from 'vitest'
import { AutoSyncController, type AutoSyncDeps } from './autoSync'
import type { AppliedRewind, MediaSnapshot, RecognitionOutcome, SourceRole } from '../core/types'
import { NO_REWIND } from '../core/types'

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
    ...overrides,
  }
  return { deps, positions, seeks }
}

const applied: AppliedRewind = { ...NO_REWIND }

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

    expect(result.failure).toMatchObject({ kind: 'seek-failed', message: '官方源跳转未生效' })
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

  it('accepts a landing inside the 0.35s gate from docs/sync-design.md', async () => {
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

    expect(phases).toEqual(['sampling', 'estimating', 'applying', 'verifying', 'done'])
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
