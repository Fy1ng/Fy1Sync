/**
 * Automatic sync run coordinator.
 *
 * One run is: open a detection window on both sources -> collect countdown jumps ->
 * estimate the offset -> plan a seek -> apply it -> verify the sources actually
 * landed where the plan said. Nothing is applied without a verification step,
 * because a silently clamped or refused seek would leave the UI claiming an
 * alignment that does not exist.
 *
 * The controller owns no timers of its own beyond the optional scheduler, and takes
 * its clock and sleep injected, so tests drive it deterministically.
 */

import { ClockJumpDetector, type ClockJumpOptions } from '../core/clockJump'
import {
  estimateOffset,
  OFFSET_REJECTION_TEXT,
  type EstimateOptions,
  type OffsetEstimate,
  type OffsetRejection,
} from '../core/offsetEstimator'
import { offsetFromRewind, planOffsetChange, type OffsetPlan } from '../core/syncPlan'
import type {
  AppliedRewind,
  ClockJumpEvent,
  MediaSnapshot,
  RecognitionOutcome,
  SourceRole,
} from '../core/types'
import { SOURCE_ROLES } from '../core/types'

export type AutoSyncPhase =
  | 'idle'
  | 'sampling'
  | 'estimating'
  | 'applying'
  | 'verifying'
  | 'done'
  | 'failed'

export type AutoSyncFailure =
  | { kind: 'rejected'; reason: OffsetRejection; message: string }
  | { kind: 'no-samples'; message: string }
  | { kind: 'not-ready'; message: string }
  | { kind: 'seek-failed'; message: string }
  | { kind: 'verify-failed'; message: string; divergence: number }
  | { kind: 'cancelled'; message: string }
  | { kind: 'unauthorized'; message: string }

export interface AutoSyncRunResult {
  phase: 'done' | 'failed'
  /** True when the run only measured and did not seek. */
  dryRun: boolean
  estimate: OffsetEstimate | null
  plan: OffsetPlan | null
  applied: boolean
  failure: AutoSyncFailure | null
  /** Divergence measured after applying, in seconds. */
  divergence: number | null
  samples: Record<SourceRole, number>
  jumps: Record<SourceRole, number>
  startedAt: number
  finishedAt: number
}

export interface AutoSyncDeps {
  /** Sample both sources for `windowMs`, feeding outcomes to the callback. */
  sample: (
    windowMs: number,
    onOutcome: (role: SourceRole, outcome: RecognitionOutcome) => void,
    signal: { aborted: boolean },
  ) => Promise<void>
  snapshot: (role: SourceRole) => MediaSnapshot | null
  /**
   * Whether any role has a recognition profile.
   *
   * Without one the sampler yields nothing, which is indistinguishable from a black
   * screen — the run would spend a detection window and then blame the picture. Optional
   * so callers that always have a profile need not supply it.
   */
  hasProfile?: () => boolean
  /** Perform one seek. Resolves true when the element confirmed the new position. */
  seek: (role: SourceRole, target: number) => Promise<boolean>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  estimateOptions?: EstimateOptions
}

export interface AutoSyncOptions {
  detectWindowSeconds?: number
  /** Verification tolerance; docs/sync-design.md sets 0.35 s. */
  maxDivergenceSeconds?: number
  /** Seconds to settle before measuring the applied result. */
  settleSeconds?: number
  schedulerIntervalSeconds?: number
  jumpOptions?: ClockJumpOptions
}

const DEFAULTS = {
  detectWindowSeconds: 3,
  maxDivergenceSeconds: 0.35,
  settleSeconds: 0.4,
  schedulerIntervalSeconds: 30,
} as const

export class AutoSyncController {
  private phaseValue: AutoSyncPhase = 'idle'
  private runToken = 0
  private aborted = false
  private running = false
  private schedulerTimer: ReturnType<typeof setInterval> | null = null
  /** Auto-apply must be re-authorized after any manual input. */
  private authorized = true
  private lastResult: AutoSyncRunResult | null = null
  private readonly listeners = new Set<(phase: AutoSyncPhase) => void>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly deps: AutoSyncDeps,
    private readonly options: AutoSyncOptions = {},
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  get phase(): AutoSyncPhase {
    return this.phaseValue
  }

  get isRunning(): boolean {
    return this.running
  }

  get autoApplyAuthorized(): boolean {
    return this.authorized
  }

  get result(): AutoSyncRunResult | null {
    return this.lastResult
  }

  onPhaseChange(listener: (phase: AutoSyncPhase) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Measure without seeking. Always allowed, even when auto-apply is revoked. */
  dryRun(applied: AppliedRewind): Promise<AutoSyncRunResult> {
    return this.execute(applied, true)
  }

  /** Measure and apply. */
  run(applied: AppliedRewind): Promise<AutoSyncRunResult> {
    return this.execute(applied, false)
  }

  /**
   * Cancel the current run. Called on manual sync input, which also revokes
   * auto-apply: after a human moves the sliders, the scheduler must not quietly
   * overwrite that choice.
   */
  cancel(revokeAuthorization = true): void {
    this.aborted = true
    this.runToken += 1
    if (revokeAuthorization) this.authorized = false
    if (this.running) this.setPhase('idle')
  }

  /** Re-arm auto-apply after the user explicitly asks for automatic sync again. */
  authorize(): void {
    this.authorized = true
  }

  /**
   * Change tuning while the controller is alive.
   *
   * The detection window and scheduler interval are both user-visible settings, so they
   * can move between runs. A running scheduler is rebuilt on the spot, because
   * `setInterval` captures its period at creation and would otherwise keep the old one
   * until the next stop/start cycle.
   */
  configure(patch: Partial<AutoSyncOptions>, applied?: () => AppliedRewind): void {
    Object.assign(this.options, patch)
    if (this.schedulerTimer !== null && applied) this.startScheduler(applied)
  }

  /** Default-off scheduler; the caller starts it from the settings toggle. */
  startScheduler(applied: () => AppliedRewind): void {
    this.stopScheduler()
    const intervalMs =
      (this.options.schedulerIntervalSeconds ?? DEFAULTS.schedulerIntervalSeconds) * 1000
    this.schedulerTimer = setInterval(() => {
      if (this.running || !this.authorized) return
      void this.run(applied())
    }, intervalMs)
  }

  stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer)
      this.schedulerTimer = null
    }
  }

  dispose(): void {
    this.stopScheduler()
    this.cancel(false)
    this.listeners.clear()
  }

  private setPhase(phase: AutoSyncPhase): void {
    if (this.phaseValue === phase) return
    this.phaseValue = phase
    for (const listener of this.listeners) listener(phase)
  }

  private async execute(applied: AppliedRewind, dryRun: boolean): Promise<AutoSyncRunResult> {
    const startedAt = this.now()
    if (this.running) {
      return this.fail(startedAt, dryRun, {
        kind: 'cancelled',
        message: '已有一次自动同步在进行中',
      })
    }
    if (!dryRun && !this.authorized) {
      return this.fail(startedAt, dryRun, {
        kind: 'unauthorized',
        message: '手动调整后需要重新开启自动同步',
      })
    }

    this.running = true
    this.aborted = false
    const token = ++this.runToken
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- read by the abort view below
    const self = this
    const detectors: Record<SourceRole, ClockJumpDetector> = {
      official: new ClockJumpDetector('official', this.options.jumpOptions),
      commentary: new ClockJumpDetector('commentary', this.options.jumpOptions),
    }
    const jumps: Record<SourceRole, ClockJumpEvent[]> = { official: [], commentary: [] }
    const samples: Record<SourceRole, number> = { official: 0, commentary: 0 }

    try {
      if (this.deps.hasProfile && !this.deps.hasProfile()) {
        return this.fail(startedAt, dryRun, {
          kind: 'not-ready',
          message: '还没有选择识别场景，先在侧栏选一个再识别倒计时',
        })
      }

      // Both sources must be loaded before spending a detection window on them.
      for (const role of SOURCE_ROLES) {
        const snapshot = this.deps.snapshot(role)
        if (!snapshot?.ready) {
          return this.fail(startedAt, dryRun, {
            kind: 'not-ready',
            message: role === 'official' ? '官方源尚未就绪' : '解说源尚未就绪',
          })
        }
      }

      this.setPhase('sampling')
      const windowMs =
        (this.options.detectWindowSeconds ?? DEFAULTS.detectWindowSeconds) * 1000
      const abortView = {
        get aborted() {
          return self.stale(token)
        },
      }
      await this.deps.sample(
        windowMs,
        (role, outcome) => {
          samples[role] += 1
          const push = detectors[role].push(outcome)
          if (push.event) jumps[role].push(push.event)
        },
        abortView,
      )
      if (this.stale(token)) {
        return this.fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
          samples,
          jumps,
        })
      }

      if (samples.official === 0 || samples.commentary === 0) {
        return this.fail(
          startedAt,
          dryRun,
          { kind: 'no-samples', message: '识别窗口内没有取到画面' },
          { samples, jumps },
        )
      }

      this.setPhase('estimating')
      const estimate = estimateOffset(jumps.official, jumps.commentary, {
        ...this.deps.estimateOptions,
        appliedOffsetSeconds: offsetFromRewind(applied),
      })
      if (estimate.status === 'rejected') {
        return this.fail(
          startedAt,
          dryRun,
          {
            kind: 'rejected',
            reason: estimate.reason,
            message: OFFSET_REJECTION_TEXT[estimate.reason],
          },
          { samples, jumps },
        )
      }

      const snapshots = this.collectSnapshots()
      const plan = planOffsetChange({
        nextOffset: estimate.totalOffsetSeconds,
        applied,
        snapshots,
      })

      if (dryRun) {
        return this.finish({
          phase: 'done',
          dryRun,
          estimate,
          plan,
          applied: false,
          failure: null,
          divergence: null,
          samples,
          jumps: countJumps(jumps),
          startedAt,
          finishedAt: this.now(),
        })
      }

      this.setPhase('applying')
      for (const seek of plan.seeks) {
        const confirmed = await this.deps.seek(seek.role, seek.to)
        if (this.stale(token)) {
          return this.fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
            samples,
            jumps,
          })
        }
        if (!confirmed) {
          return this.fail(
            startedAt,
            dryRun,
            {
              kind: 'seek-failed',
              message: seek.role === 'official' ? '官方源跳转未生效' : '解说源跳转未生效',
            },
            { samples, jumps, estimate, plan },
          )
        }
      }

      this.setPhase('verifying')
      await this.sleep((this.options.settleSeconds ?? DEFAULTS.settleSeconds) * 1000)
      if (this.stale(token)) {
        return this.fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
          samples,
          jumps,
          estimate,
          plan,
        })
      }

      const divergence = this.measureDivergence(plan, snapshots)
      const tolerance = this.options.maxDivergenceSeconds ?? DEFAULTS.maxDivergenceSeconds
      if (divergence > tolerance) {
        return this.fail(
          startedAt,
          dryRun,
          {
            kind: 'verify-failed',
            message: `跳转后偏差 ${divergence.toFixed(2)} 秒，超出允许范围`,
            divergence,
          },
          { samples, jumps, estimate, plan, applied: true, divergence },
        )
      }

      return this.finish({
        phase: 'done',
        dryRun,
        estimate,
        plan,
        applied: true,
        failure: null,
        divergence,
        samples,
        jumps: countJumps(jumps),
        startedAt,
        finishedAt: this.now(),
      })
    } catch (error) {
      return this.fail(
        startedAt,
        dryRun,
        {
          kind: 'seek-failed',
          message: error instanceof Error ? error.message : String(error),
        },
        { samples, jumps },
      )
    } finally {
      this.running = false
    }
  }

  private collectSnapshots(): Partial<Record<SourceRole, MediaSnapshot>> {
    const snapshots: Partial<Record<SourceRole, MediaSnapshot>> = {}
    for (const role of SOURCE_ROLES) {
      const snapshot = this.deps.snapshot(role)
      if (snapshot) snapshots[role] = snapshot
    }
    return snapshots
  }

  /**
   * How far the two sources ended up from the gap the plan asked for — the "两路差值"
   * of docs/sync-design.md, not each source's distance from its own target.
   *
   * The difference matters because verification happens after a settle delay, and
   * during it playing sources keep advancing. Measured per source, both would read
   * a settle-length error and every run on a playing pair would fail the 0.35 s
   * gate; measured as a gap, equal advance on both sides cancels and only real
   * misalignment is left. A seek the element quietly refused still shows up, since
   * only one side then fails to move.
   */
  private measureDivergence(
    plan: OffsetPlan,
    before: Partial<Record<SourceRole, MediaSnapshot>>,
  ): number {
    let officialDrift = 0
    let commentaryDrift = 0
    for (const role of SOURCE_ROLES) {
      const after = this.deps.snapshot(role)
      if (!after) return Number.POSITIVE_INFINITY
      const seek = plan.seeks.find((entry) => entry.role === role)
      // A role the plan left alone should still be where it was, modulo playback.
      const target = seek ? seek.to : before[role]?.currentTime
      if (target === undefined) return Number.POSITIVE_INFINITY
      const drift = after.currentTime - target
      if (role === 'official') officialDrift = drift
      else commentaryDrift = drift
    }
    // Drift shared by both sides is the settle delay elapsing, not misalignment.
    return round(Math.abs(commentaryDrift - officialDrift))
  }

  private stale(token: number): boolean {
    return this.aborted || token !== this.runToken
  }

  private fail(
    startedAt: number,
    dryRun: boolean,
    failure: AutoSyncFailure,
    extra: {
      samples?: Record<SourceRole, number>
      jumps?: Record<SourceRole, ClockJumpEvent[]>
      estimate?: OffsetEstimate
      plan?: OffsetPlan
      applied?: boolean
      divergence?: number
    } = {},
  ): AutoSyncRunResult {
    return this.finish({
      phase: 'failed',
      dryRun,
      estimate: extra.estimate ?? null,
      plan: extra.plan ?? null,
      applied: extra.applied ?? false,
      failure,
      divergence: extra.divergence ?? null,
      samples: extra.samples ?? { official: 0, commentary: 0 },
      jumps: extra.jumps ? countJumps(extra.jumps) : { official: 0, commentary: 0 },
      startedAt,
      finishedAt: this.now(),
    })
  }

  private finish(result: AutoSyncRunResult): AutoSyncRunResult {
    this.lastResult = result
    this.setPhase(result.phase)
    this.running = false
    return result
  }
}

function countJumps(jumps: Record<SourceRole, ClockJumpEvent[]>): Record<SourceRole, number> {
  return { official: jumps.official.length, commentary: jumps.commentary.length }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

export const AUTO_SYNC_PHASE_TEXT: Record<AutoSyncPhase, string> = {
  idle: '待机',
  sampling: '正在读取双方倒计时',
  estimating: '正在计算延迟差',
  applying: '正在调整播放位置',
  verifying: '正在校验结果',
  done: '已完成',
  failed: '未完成',
}
