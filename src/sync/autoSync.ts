/**
 * Automatic sync run coordinator.
 *
 * One run is: open a detection window on both sources -> collect countdown jumps ->
 * estimate the offset -> plan an adjustment -> apply it -> verify the sources actually
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
import { rateNudgeAction } from './rateNudge'
import type { ScoreGuardRequest, ScoreGuardResult } from '../recognition/score'

export type AutoSyncPhase =
  | 'idle'
  | 'sampling'
  | 'estimating'
  | 'checking-content'
  | 'applying'
  | 'verifying'
  | 'rolling-back'
  | 'done'
  | 'failed'

export type AutoSyncFailure =
  | { kind: 'rejected'; reason: OffsetRejection; message: string }
  | { kind: 'no-samples'; message: string }
  | { kind: 'not-ready'; message: string }
  | { kind: 'seek-failed'; message: string }
  | { kind: 'verify-failed'; message: string; divergence: number }
  | { kind: 'buffer-limit'; message: string }
  | { kind: 'rate-unavailable'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'score-mismatch' | 'score-unknown' | 'score-transition'; message: string }

export interface AutoSyncRollback {
  status: 'restored' | 'failed' | 'skipped'
  positions: Partial<Record<SourceRole, { target: number; actual: number | null; restored: boolean }>>
  reason?: string
  playbackRestored?: boolean
}

export interface AutoSyncPlaybackState {
  paused: boolean
  playbackRate: number
  /** Source identity, used to avoid seeking a replacement source during rollback. */
  source: string
}

export interface AutoSyncRunResult {
  phase: 'done' | 'failed'
  /** True when the run only measured and did not seek. */
  dryRun: boolean
  estimate: OffsetEstimate | null
  plan: OffsetPlan | null
  applied: boolean
  /** Actual rewind carried after any full or partial application. */
  appliedRewind?: AppliedRewind
  scoreCheck?: ScoreGuardResult
  rollback?: AutoSyncRollback
  failure: AutoSyncFailure | null
  /** Divergence measured after applying, in seconds. */
  divergence: number | null
  samples: Record<SourceRole, number>
  jumps: Record<SourceRole, number>
  startedAt: number
  finishedAt: number
}

interface RunFailureExtra {
  samples?: Record<SourceRole, number>
  jumps?: Record<SourceRole, ClockJumpEvent[]>
  estimate?: OffsetEstimate
  plan?: OffsetPlan
  applied?: boolean
  appliedRewind?: AppliedRewind
  divergence?: number
  scoreCheck?: ScoreGuardResult
  rollback?: AutoSyncRollback
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
  /** Apply a bounded playback-rate correction to the real media element. */
  setPlaybackRate?: (role: SourceRole, rate: number) => void
  /** Keep session bookkeeping current even for scheduled or interrupted runs. */
  onAppliedRewind?: (rewind: AppliedRewind) => void
  checkScore?: (request: ScoreGuardRequest) => Promise<ScoreGuardResult>
  scoreGeneration?: () => string
  playbackState?: (role: SourceRole) => AutoSyncPlaybackState | null
  /** Freeze both sources while a failed adjustment is restored, then resume their old state. */
  setPaused?: (role: SourceRole, paused: boolean) => void | Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  estimateOptions?: EstimateOptions
}

export interface AutoSyncOptions {
  detectWindowSeconds?: number
  /** Verification tolerance; the sync design sets 0.35 s. */
  maxDivergenceSeconds?: number
  /** Seconds to settle before measuring the applied result. */
  settleSeconds?: number
  schedulerIntervalSeconds?: number
  /** Seek only above this absolute residual; smaller errors use playback rate. */
  seekThresholdSeconds?: number
  rateDeadbandSeconds?: number
  /** A stalled/paused pair must fail rather than claim elapsed time corrected it. */
  rateTimeoutSeconds?: number
  /** A finite budget for score stability/history; defaults to the residual plus margin. */
  scoreWaitSeconds?: number
  jumpOptions?: ClockJumpOptions
}

const DEFAULTS = {
  detectWindowSeconds: 3,
  maxDivergenceSeconds: 0.35,
  settleSeconds: 0.4,
  schedulerIntervalSeconds: 30,
  seekThresholdSeconds: 1.5,
  rateDeadbandSeconds: 0.1,
  rateTimeoutSeconds: 45,
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
  private captureRateProgress: (() => void) | null = null
  private readonly alteredRates = new Map<SourceRole, number>()
  private readonly ownedPauses = new Map<SourceRole, AutoSyncPlaybackState>()

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
    try {
      this.captureRateProgress?.()
    } finally {
      this.aborted = true
      this.runToken += 1
      if (revokeAuthorization) this.authorized = false
      this.restorePlaybackRates()
      // Release only our own pauses immediately. A caller's manual playback action
      // runs after cancel() returns and must keep the final say over playback.
      void this.restorePausedPlayback()
      if (this.running) this.setPhase('idle')
    }
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
      // A refused caller owns no run state and must not unlock the active run.
      return {
        phase: 'failed', dryRun, estimate: null, plan: null, applied: false,
        failure: { kind: 'cancelled', message: '已有一次自动同步在进行中' },
        divergence: null, samples: { official: 0, commentary: 0 },
        jumps: { official: 0, commentary: 0 }, startedAt, finishedAt: this.now(),
      }
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
    let estimateValue: OffsetEstimate | undefined
    let planValue: OffsetPlan | undefined
    let appliedValue: AppliedRewind | undefined
    let applicationStarted = false
    let scoreCheck: ScoreGuardResult | undefined
    let initialSnapshots: Partial<Record<SourceRole, MediaSnapshot>> = {}
    const initialStates: Partial<Record<SourceRole, AutoSyncPlaybackState>> = {}
    const fail = async (
      _startedAt: number,
      _dryRun: boolean,
      failure: AutoSyncFailure,
      extra: RunFailureExtra = {},
    ): Promise<AutoSyncRunResult> => {
      if (applicationStarted && !this.stale(token) && failure.kind !== 'cancelled') {
        // Keep pause ownership until rollback finishes. If a source is replaced,
        // cleanup must still release our pause on the unaffected peer.
        const ratesRestored = this.restorePlaybackRates()
        const restored = await this.rollback(initialSnapshots, initialStates, startedAt, applied, token)
        if (!ratesRestored && restored.rollback.status === 'restored') {
          restored.rollback.status = 'failed'
          restored.rollback.reason = 'rate-restore-failed'
        }
        extra.rollback = restored.rollback
        if (restored.rewind) {
          appliedValue = restored.rewind
          extra.appliedRewind = restored.rewind
          try {
            this.deps.onAppliedRewind?.({ ...restored.rewind })
          } catch {
            restored.rollback.status = 'failed'
            restored.rollback.reason = 'bookkeeping-failed'
          }
        }
        if (restored.rollback.status === 'restored') {
          extra.applied = false
          failure = { ...failure, message: `${failure.message}，已撤回调整` }
        } else {
          failure = { ...failure, message: `${failure.message}，撤回未完成，请手动对齐` }
        }
      }
      if (!this.stale(token)) await this.restorePausedPlayback()
      return this.fail(startedAt, dryRun, failure, { ...extra, ...(scoreCheck ? { scoreCheck } : {}) })
    }

    try {
      initialSnapshots = this.collectSnapshots()
      for (const role of SOURCE_ROLES) {
        const snapshot = initialSnapshots[role]
        if (snapshot) initialSnapshots[role] = { ...snapshot, timebase: { ...snapshot.timebase } }
        const state = this.deps.playbackState?.(role)
        if (state) initialStates[role] = { ...state }
      }
      if (this.deps.hasProfile && !this.deps.hasProfile()) {
        return await fail(startedAt, dryRun, {
          kind: 'not-ready',
          message: '还没有选择识别场景，先在侧栏选一个再识别倒计时',
        })
      }

      // Both sources must be loaded before spending a detection window on them.
      for (const role of SOURCE_ROLES) {
        const snapshot = this.deps.snapshot(role)
        if (!snapshot?.ready) {
          return await fail(startedAt, dryRun, {
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
        return await fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
          samples,
          jumps,
        })
      }

      if (samples.official === 0 || samples.commentary === 0) {
        return await fail(
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
        return await fail(
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
      estimateValue = estimate

      let snapshots = this.collectSnapshots()
      let plan = planOffsetChange({
        nextOffset: estimate.totalOffsetSeconds,
        applied,
        snapshots,
      })
      planValue = plan

      this.setPhase('checking-content')
      scoreCheck = await this.checkContent(estimate.residualSeconds, token, abortView)
      if (this.stale(token)) {
        return await fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
          samples, jumps, estimate, plan,
        })
      }
      if (scoreCheck.status !== 'pass') {
        return await fail(startedAt, dryRun, scoreFailure(scoreCheck), { samples, jumps, estimate, plan })
      }
      // Waiting for the lagging source can take seconds. Only the current playheads
      // may determine the targets of the adjustment that follows.
      snapshots = this.collectSnapshots()
      plan = planOffsetChange({ nextOffset: estimate.totalOffsetSeconds, applied, snapshots })
      planValue = plan

      if (dryRun) {
        return this.finish({
          phase: 'done',
          dryRun,
          estimate,
          plan,
          applied: false,
          scoreCheck,
          failure: null,
          divergence: null,
          samples,
          jumps: countJumps(jumps),
          startedAt,
          finishedAt: this.now(),
        })
      }

      this.setPhase('applying')
      if (this.stale(token) || (this.deps.scoreGeneration && this.deps.scoreGeneration() !== scoreCheck.generation)) {
        return await fail(startedAt, dryRun, { kind: 'cancelled', message: '画面已变化，请重新对齐' }, {
          samples, jumps, estimate, plan,
        })
      }
      appliedValue = { ...applied }
      const publishRewind = (rewind: AppliedRewind): void => {
        appliedValue = rewind
        this.deps.onAppliedRewind?.({ ...rewind })
      }
      const residual = estimate.residualSeconds
      const threshold = this.options.seekThresholdSeconds ?? DEFAULTS.seekThresholdSeconds
      const deadband = this.options.rateDeadbandSeconds ?? DEFAULTS.rateDeadbandSeconds
      let needsSeek = Math.abs(residual) > threshold
      if (!needsSeek && Math.abs(residual) > deadband) {
        if (!this.deps.setPlaybackRate) {
          return await fail(startedAt, dryRun, {
            kind: 'rate-unavailable',
            message: '播放器暂不支持小幅速率校正',
          }, { samples, jumps, estimate, plan })
        }
        applicationStarted = true
        const nudge = await this.applyRateNudge(residual, snapshots, applied, token, publishRewind)
        if (this.stale(token)) {
          return await fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
            samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue,
          })
        }
        if (nudge.kind === 'failed') {
          return await fail(startedAt, dryRun, {
            kind: 'verify-failed',
            message: '播放进度未能收敛, 请检查暂停或缓冲状态',
            divergence: Math.abs(nudge.error),
          }, { samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue, divergence: Math.abs(nudge.error) })
        }
        needsSeek = nudge.kind === 'seek'
        if (needsSeek) {
          // Drift can grow while nudging. Re-plan from the observed media positions
          // and actual rewind, so handing over to seek never re-applies old work.
          snapshots = this.collectSnapshots()
          plan = planOffsetChange({ nextOffset: estimate.totalOffsetSeconds, applied: appliedValue, snapshots })
          planValue = plan
        }
      }
      if (needsSeek && this.deps.setPaused && this.deps.playbackState) {
        const states = this.playbackStates()
        if (SOURCE_ROLES.every(role => states[role])) {
          for (const role of SOURCE_ROLES) {
            const state = states[role]!
            if (this.stale(token) || SOURCE_ROLES.some(entry => this.deps.playbackState?.(entry)?.source !== states[entry]?.source)) {
              return await fail(startedAt, dryRun, { kind: 'cancelled', message: '画面已变化，请重新对齐' }, {
                samples, jumps, estimate, plan, applied: applicationStarted, appliedRewind: appliedValue,
              })
            }
            if (!state.paused) {
              this.ownedPauses.set(role, state)
              await this.deps.setPaused(role, true)
            }
          }
          if (this.stale(token) || SOURCE_ROLES.some(role => this.deps.playbackState?.(role)?.source !== states[role]?.source)) {
            return await fail(startedAt, dryRun, { kind: 'cancelled', message: '画面已变化，请重新对齐' }, {
              samples, jumps, estimate, plan, applied: applicationStarted, appliedRewind: appliedValue,
            })
          }
          // A 4K seek can spend seconds decoding. Freeze both sources first so the
          // untouched peer does not advance while the moved source waits for a frame.
          snapshots = this.collectSnapshots()
          plan = planOffsetChange({ nextOffset: estimate.totalOffsetSeconds, applied: appliedValue, snapshots })
          planValue = plan
        }
      }
      for (const seek of needsSeek ? plan.seeks : []) {
        const beforeSeek = this.collectSnapshots()
        // The previous role may have spent seconds buffering its seek. Derive
        // each next target from current media time, not that stale playhead.
        const currentPlan = planOffsetChange({
          nextOffset: estimate.totalOffsetSeconds,
          applied: appliedValue,
          snapshots: beforeSeek,
        })
        const currentSeek = currentPlan.seeks.find((entry) => entry.role === seek.role)
        if (!currentSeek) continue
        if (currentPlan.limited) {
          plan.limited = true
          plan.limitReason = currentPlan.limitReason
        }
        applicationStarted = true
        const confirmed = await this.deps.seek(seek.role, currentSeek.to)
        if (this.stale(token)) {
          return await fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
            samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue,
          })
        }
        const afterSeek = this.collectSnapshots()
        const peer: SourceRole = seek.role === 'official' ? 'commentary' : 'official'
        const from = beforeSeek[seek.role]?.currentTime
        const to = afterSeek[seek.role]?.currentTime
        const peerBefore = beforeSeek[peer]?.currentTime
        const peerAfter = afterSeek[peer]?.currentTime
        if (from !== undefined && to !== undefined) {
          const peerAdvance = peerBefore !== undefined && peerAfter !== undefined ? peerAfter - peerBefore : 0
          publishRewind({
            ...appliedValue,
            [seek.role]: round(Math.max(0, appliedValue[seek.role] + from - to + peerAdvance)),
          })
        }
        if (!confirmed) {
          return await fail(
            startedAt,
            dryRun,
            {
              kind: 'seek-failed',
              message: seek.role === 'official' ? '官方源跳转未生效' : '解说源跳转未生效',
            },
            { samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue },
          )
        }
      }
      // A confirmed clamped seek only proves that the reachable part was applied.
      // It must not pass verification against that shortened target as success.
      if (needsSeek && plan.limited) {
        return await fail(startedAt, dryRun, {
          kind: plan.limitReason === 'buffer-limit' ? 'buffer-limit' : 'not-ready',
          message: plan.limitReason === 'buffer-limit' ? '缓存长度不足, 偏移未完全应用' : '有源尚未就绪, 偏移未完全应用',
        }, { samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue })
      }

      if (!this.restorePlaybackRates()) {
        return await fail(startedAt, dryRun, {
          kind: 'verify-failed', message: '播放速率未能恢复', divergence: Number.POSITIVE_INFINITY,
        }, { samples, jumps, estimate, plan, applied: applicationStarted, appliedRewind: appliedValue })
      }
      const playbackRestored = await this.restorePausedPlayback()
      if (this.stale(token)) {
        return await fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
          samples, jumps, estimate, plan, applied: applicationStarted, appliedRewind: appliedValue,
        })
      }
      if (!playbackRestored) {
        return await fail(startedAt, dryRun, {
          kind: 'verify-failed', message: '播放状态未能恢复', divergence: Number.POSITIVE_INFINITY,
        }, { samples, jumps, estimate, plan, applied: applicationStarted, appliedRewind: appliedValue })
      }
      this.setPhase('verifying')
      await this.sleep((this.options.settleSeconds ?? DEFAULTS.settleSeconds) * 1000)
      if (this.stale(token)) {
        return await fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
          samples,
          jumps,
          estimate,
          plan,
          applied: true,
          appliedRewind: appliedValue,
        })
      }

      const divergence = needsSeek
        ? this.measureDivergence(plan, snapshots)
        : this.measureRateDivergence(residual, snapshots)
      const tolerance = this.options.maxDivergenceSeconds ?? DEFAULTS.maxDivergenceSeconds
      if (divergence > tolerance) {
        return await fail(
          startedAt,
          dryRun,
          {
            kind: 'verify-failed',
            message: `跳转后偏差 ${divergence.toFixed(2)} 秒，超出允许范围`,
            divergence,
          },
          { samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue, divergence },
        )
      }

      return this.finish({
        phase: 'done',
        dryRun,
        estimate,
        plan,
        applied: true,
        appliedRewind: appliedValue,
        scoreCheck,
        failure: null,
        divergence,
        samples,
        jumps: countJumps(jumps),
        startedAt,
        finishedAt: this.now(),
      })
    } catch (error) {
      return await fail(
        startedAt,
        dryRun,
        {
          kind: 'seek-failed',
          message: error instanceof Error ? error.message : String(error),
        },
        { samples, jumps, estimate: estimateValue, plan: planValue, applied: applicationStarted, appliedRewind: appliedValue },
      )
    } finally {
      this.restorePlaybackRates()
      if (!this.stale(token)) await this.restorePausedPlayback()
      this.alteredRates.clear()
      this.running = false
    }
  }

  private playbackStates(): Partial<Record<SourceRole, AutoSyncPlaybackState>> {
    const states: Partial<Record<SourceRole, AutoSyncPlaybackState>> = {}
    for (const role of SOURCE_ROLES) {
      const state = this.deps.playbackState?.(role)
      if (state) states[role] = { ...state }
    }
    return states
  }

  private async restorePausedPlayback(): Promise<boolean> {
    const pending: Array<Promise<unknown>> = []
    let restored = true
    // Invoke every release before awaiting any play() promise. Cancellation callers
    // can then immediately apply a new manual pause without a delayed second write.
    for (const [role, state] of this.ownedPauses) {
      this.ownedPauses.delete(role)
      const current = this.deps.playbackState?.(role)
      if (!current || current.source !== state.source || current.paused === state.paused) continue
      try {
        pending.push(Promise.resolve(this.deps.setPaused?.(role, state.paused)))
      } catch {
        restored = false
      }
    }
    const results = await Promise.allSettled(pending)
    return restored && results.every(result => result.status === 'fulfilled')
  }

  private async checkContent(
    residualSeconds: number,
    token: number,
    signal: { aborted: boolean },
  ): Promise<ScoreGuardResult> {
    const generation = this.deps.scoreGeneration?.() ?? ''
    const unknown = (reason: string): ScoreGuardResult => ({
      status: 'unknown', reason, checkedAt: this.now(), generation,
    })
    if (!this.deps.checkScore) return unknown('unsupported')
    const before = this.collectSnapshots()
    const startedAt = this.now()
    const budgetMs = Math.max(0, this.options.scoreWaitSeconds ?? Math.min(65, Math.max(8, Math.abs(residualSeconds) + 5))) * 1000
    const retryMs = 250
    const maxAttempts = Math.max(1, Math.ceil(budgetMs / retryMs) + 1)
    let result = unknown('history-insufficient')
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      result = await this.deps.checkScore({ residualSeconds, signal })
      if (this.stale(token)) return unknown('cancelled')
      if (this.deps.scoreGeneration && (this.deps.scoreGeneration() !== generation || result.generation !== generation)) {
        return unknown('generation-changed')
      }
      const after = this.collectSnapshots()
      if (!before.official || !before.commentary || !after.official?.ready || !after.commentary?.ready) {
        return unknown('not-ready')
      }
      const drift = (after.official.currentTime - before.official.currentTime) -
        (after.commentary.currentTime - before.commentary.currentTime)
      if (Math.abs(drift) > (this.options.maxDivergenceSeconds ?? DEFAULTS.maxDivergenceSeconds)) {
        return unknown('measurement-stale')
      }
      if (result.status === 'pass' || result.status === 'mismatch') return result
      const canWait = result.status === 'transition' || result.reason === 'history-insufficient'
      if (!canWait || this.now() - startedAt >= budgetMs || attempt === maxAttempts - 1) return result
      await this.sleep(Math.min(retryMs, Math.max(0, budgetMs - (this.now() - startedAt))))
      if (this.stale(token)) return unknown('cancelled')
    }
    return result
  }

  private async rollback(
    initial: Partial<Record<SourceRole, MediaSnapshot>>,
    states: Partial<Record<SourceRole, AutoSyncPlaybackState>>,
    startedAt: number,
    applied: AppliedRewind,
    token: number,
  ): Promise<{ rollback: AutoSyncRollback; rewind?: AppliedRewind }> {
    const positions: AutoSyncRollback['positions'] = {}
    for (const role of SOURCE_ROLES) {
      const state = states[role]
      if (this.stale(token) || (state && this.deps.playbackState?.(role)?.source !== state.source)) {
        return { rollback: { status: 'skipped', positions, reason: 'source-changed-or-cancelled' } }
      }
    }
    this.setPhase('rolling-back')
    const pausedRoles: SourceRole[] = []
    const restoreAt = this.now()
    let completion: AutoSyncRollback | undefined
    try {
      if (this.deps.setPaused && SOURCE_ROLES.every(role => states[role])) {
        for (const role of SOURCE_ROLES) {
          if (this.stale(token) || this.deps.playbackState?.(role)?.source !== states[role]?.source) {
            return { rollback: { status: 'skipped', positions, reason: 'source-changed-or-cancelled' } }
          }
          // Remember the role before invoking a dependency that may pause and throw.
          pausedRoles.push(role)
          if (!this.deps.playbackState?.(role)?.paused) await this.deps.setPaused(role, true)
        }
      }
      for (const role of SOURCE_ROLES) {
        if (this.stale(token)) return { rollback: { status: 'skipped', positions, reason: 'cancelled' } }
        const anchor = initial[role]
        const state = states[role]
        const snapshot = this.deps.snapshot(role)
        if (!anchor || !snapshot?.ready || (state && this.deps.playbackState?.(role)?.source !== state.source)) {
          positions[role] = { target: anchor?.currentTime ?? 0, actual: snapshot?.currentTime ?? null, restored: false }
          continue
        }
        // Both sources share one frozen restoration instant. A slow first seek must
        // not leave the peer playing and create a second, unintended adjustment.
        const targetAt = pausedRoles.length === SOURCE_ROLES.length ? restoreAt : this.now()
        const elapsed = state && !state.paused ? Math.max(0, targetAt - startedAt) / 1000 * state.playbackRate : 0
        const target = round(anchor.currentTime + elapsed)
        let confirmed = Math.abs(snapshot.currentTime - target) <= 0.05
        if (!confirmed) {
          try {
            confirmed = await this.deps.seek(role, target)
          } catch {
            confirmed = false
          }
        }
        if (this.stale(token) || (state && this.deps.playbackState?.(role)?.source !== state.source)) {
          return { rollback: { status: 'skipped', positions, reason: 'source-changed-or-cancelled' } }
        }
        const actual = this.deps.snapshot(role)?.currentTime ?? null
        positions[role] = { target, actual, restored: confirmed && actual !== null && Math.abs(actual - target) <= 0.05 }
      }
      if (pausedRoles.length === SOURCE_ROLES.length) {
        for (const role of SOURCE_ROLES) {
          const position = positions[role]
          if (!position) continue
          position.actual = this.deps.snapshot(role)?.currentTime ?? null
          position.restored = position.restored && position.actual !== null && Math.abs(position.actual - position.target) <= 0.05
        }
      }
      const restored = SOURCE_ROLES.every(role => positions[role]?.restored)
      const rewind = { ...applied }
      if (!restored) {
        for (const role of SOURCE_ROLES) {
          const position = positions[role]
          if (position?.actual !== null && position?.actual !== undefined) {
            rewind[role] = round(Math.max(0, applied[role] + position.target - position.actual))
          }
        }
      }
      completion = { status: restored ? 'restored' : 'failed', positions, playbackRestored: true }
      return { rollback: completion, rewind }
    } catch {
      return { rollback: { status: 'failed', positions, reason: 'pause-failed' } }
    } finally {
      for (const role of pausedRoles) {
        const state = states[role]
        if (state && !this.stale(token) && this.deps.playbackState?.(role)?.source === state.source) {
          try {
            await this.deps.setPaused?.(role, state.paused)
          } catch {
            if (completion) {
              completion.playbackRestored = false
              completion.reason = 'playback-resume-failed'
            }
          }
        }
      }
    }
  }

  private restorePlaybackRates(): boolean {
    let restored = true
    for (const [role, rate] of this.alteredRates) {
      try {
        this.deps.setPlaybackRate?.(role, rate)
        this.alteredRates.delete(role)
      } catch {
        // A removed media element must not prevent restoring the other source.
        restored = false
      }
    }
    return restored
  }

  private async applyRateNudge(
    residual: number,
    before: Partial<Record<SourceRole, MediaSnapshot>>,
    applied: AppliedRewind,
    token: number,
    publish: (rewind: AppliedRewind) => void,
  ): Promise<{ kind: 'aligned' | 'seek' | 'failed'; error: number }> {
    const role: SourceRole = residual > 0 ? 'official' : 'commentary'
    const initialOfficial = before.official?.currentTime
    const initialCommentary = before.commentary?.currentTime
    if (initialOfficial === undefined || initialCommentary === undefined) return { kind: 'failed', error: residual }
    const pollMs = 100
    const maxPolls = Math.max(1, Math.ceil((this.options.rateTimeoutSeconds ?? DEFAULTS.rateTimeoutSeconds) * 1000 / pollMs))
    let error = residual
    const capture = (): boolean => {
      const official = this.deps.snapshot('official')
      const commentary = this.deps.snapshot('commentary')
      if (!official?.ready || !commentary?.ready || !Number.isFinite(official.currentTime) || !Number.isFinite(commentary.currentTime)) {
        return false
      }
      // Equal natural progress cancels. Waiting while paused or stalled changes
      // no media time and therefore can never be mistaken for convergence.
      const corrected = commentary.currentTime - initialCommentary - (official.currentTime - initialOfficial)
      error = residual - corrected
      const roleCorrection = role === 'official' ? corrected : -corrected
      const peer: SourceRole = role === 'official' ? 'commentary' : 'official'
      const rewind = applied[role] + roleCorrection
      publish({
        ...applied,
        [role]: round(Math.max(0, rewind)),
        [peer]: round(applied[peer] + Math.max(0, -rewind)),
      })
      return true
    }
    this.captureRateProgress = () => { capture() }
    try {
      for (let poll = 0; poll <= maxPolls; poll += 1) {
        if (this.stale(token)) return { kind: 'failed', error }
        if (!capture()) return { kind: 'failed', error }
        const action = rateNudgeAction(error, role, {
          seekThresholdSeconds: this.options.seekThresholdSeconds,
          deadbandSeconds: this.options.rateDeadbandSeconds,
        })
        if (action.kind !== 'rate') return { kind: action.kind, error }
        if (poll === maxPolls) return { kind: 'failed', error }
        if (!this.alteredRates.has(action.role)) {
          this.alteredRates.set(action.role, this.deps.playbackState?.(action.role)?.playbackRate ?? 1)
        }
        this.deps.setPlaybackRate?.(action.role, action.rate)
        await this.sleep(pollMs)
      }
      return { kind: 'failed', error }
    } finally {
      try {
        if (!this.stale(token)) capture()
      } finally {
        this.captureRateProgress = null
        this.restorePlaybackRates()
      }
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

  private measureRateDivergence(
    residual: number,
    before: Partial<Record<SourceRole, MediaSnapshot>>,
  ): number {
    const after = this.collectSnapshots()
    if (!after.official || !after.commentary || !before.official || !before.commentary) {
      return Number.POSITIVE_INFINITY
    }
    const corrected = after.commentary.currentTime - before.commentary.currentTime -
      (after.official.currentTime - before.official.currentTime)
    return round(Math.abs(residual - corrected))
  }

  /**
   * How far the two sources ended up from the gap the plan asked for — the "两路差值"
   * of the sync design, not each source's distance from its own target.
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
    extra: RunFailureExtra = {},
  ): AutoSyncRunResult {
    return this.finish({
      phase: 'failed',
      dryRun,
      estimate: extra.estimate ?? null,
      plan: extra.plan ?? null,
      applied: extra.applied ?? false,
      ...(extra.appliedRewind ? { appliedRewind: extra.appliedRewind } : {}),
      ...(extra.scoreCheck ? { scoreCheck: extra.scoreCheck } : {}),
      ...(extra.rollback ? { rollback: extra.rollback } : {}),
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

function scoreFailure(result: ScoreGuardResult): AutoSyncFailure {
  if (result.status === 'mismatch') {
    const pair = (reading: ScoreGuardResult['official']): string => `${reading?.left ?? '?'}:${reading?.right ?? '?'}`
    return {
      kind: 'score-mismatch',
      message: `两路比分不同（官方 ${pair(result.official)}，解说 ${pair(result.commentary)}），未调整`,
    }
  }
  if (result.status === 'transition') return { kind: 'score-transition', message: '正处在回合交界，稍后再试' }
  return { kind: 'score-unknown', message: '没读到比分，未调整，请手动对齐' }
}

export const AUTO_SYNC_PHASE_TEXT: Record<AutoSyncPhase, string> = {
  idle: '待机',
  sampling: '正在读取双方倒计时',
  estimating: '正在计算延迟差',
  'checking-content': '正在核对两路比分',
  applying: '正在调整播放位置',
  verifying: '正在校验结果',
  'rolling-back': '正在撤回调整',
  done: '已完成',
  failed: '未完成',
}
