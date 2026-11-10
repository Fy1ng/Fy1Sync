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

import { ClockJumpDetector, parseCountdown, type ClockJumpOptions } from '../core/clockJump'
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
import { MIN_SYNC_CONFIDENCE, SOURCE_ROLES } from '../core/types'
import { rateNudgeAction, rateNudgeSeekThreshold } from './rateNudge'

export type AutoSyncMode = 'manual' | 'silent'

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
  | { kind: 'buffer-limit'; message: string }
  | { kind: 'rate-unavailable'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'unauthorized'; message: string }

export interface AutoSyncRunResult {
  phase: 'done' | 'failed'
  /** True when the run only measured and did not seek. */
  dryRun: boolean
  estimate: OffsetEstimate | null
  plan: OffsetPlan | null
  applied: boolean
  /** Actual rewind carried after any full or partial application. */
  appliedRewind?: AppliedRewind
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
    signal: { aborted: boolean; readonly completed?: boolean },
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
  /** Manual seeks may hold the pair so decoder wait cannot consume the correction. */
  seekManual?: (role: SourceRole, target: number) => Promise<boolean>
  /** Apply a bounded playback-rate correction to the real media element. */
  setPlaybackRate?: (role: SourceRole, rate: number) => void
  /** Read live playback health, independently of metadata/seek completion. */
  playbackState?: (role: SourceRole) => {
    paused: boolean; seeking: boolean; ended: boolean; readyState: number
    busy: boolean; observationRevision: number; discontinuities: number
  }
  /** Keep session bookkeeping current even for scheduled or interrupted runs. */
  onAppliedRewind?: (rewind: AppliedRewind) => void
  now?: () => number
  /** Clock sharing RecognitionOutcome.reading.wallTime's epoch; defaults to now. */
  readingClock?: () => number
  sleep?: (ms: number) => Promise<void>
  estimateOptions?: EstimateOptions
}

export interface AutoSyncOptions {
  detectWindowSeconds?: number
  /** Maximum accepted error from fresh visual evidence; defaults to 0.15 s. */
  maxDivergenceSeconds?: number
  /** Seconds to settle before measuring the applied result. */
  settleSeconds?: number
  /** Fresh countdown evidence after each adjustment. Never reuse pre-seek jumps. */
  verificationWindowSeconds?: number
  /** Bound recovery when a live seek or buffer stall changes the relative delay. */
  maxCorrectionPasses?: number
  schedulerIntervalSeconds?: number
  /** Optional stricter silent seek boundary. Never permits rates at or above 2 s. */
  seekThresholdSeconds?: number
  rateDeadbandSeconds?: number
  /** A stalled/paused pair must fail rather than claim elapsed time corrected it. */
  rateTimeoutSeconds?: number
  jumpOptions?: ClockJumpOptions
}

const DEFAULTS = {
  detectWindowSeconds: 3,
  maxDivergenceSeconds: 0.15,
  settleSeconds: 0.4,
  verificationWindowSeconds: 4,
  maxCorrectionPasses: 2,
  schedulerIntervalSeconds: 30,
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
    return this.execute(applied, true, 'manual')
  }

  /** Manual runs seek; only a silent scheduled run may adjust playback speed. */
  run(applied: AppliedRewind, mode: AutoSyncMode = 'manual'): Promise<AutoSyncRunResult> {
    return this.execute(applied, false, mode)
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
      void this.run(applied(), 'silent')
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

  private async execute(applied: AppliedRewind, dryRun: boolean, mode: AutoSyncMode): Promise<AutoSyncRunResult> {
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
    const jumps: Record<SourceRole, ClockJumpEvent[]> = { official: [], commentary: [] }
    const samples: Record<SourceRole, number> = { official: 0, commentary: 0 }
    let estimateValue: OffsetEstimate | undefined
    let planValue: OffsetPlan | undefined
    let appliedValue: AppliedRewind | undefined
    let applicationStarted = false

    try {
      if (this.deps.hasProfile && !this.deps.hasProfile()) {
        return this.fail(startedAt, dryRun, {
          kind: 'not-ready',
          message: '样式包模式需要先选择手动提供的样式包, 再识别倒计时和自动对齐',
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
      const evidence = await this.sampleClockEvidence(token, windowMs, samples, jumps, {
        ...this.deps.estimateOptions,
        appliedOffsetSeconds: offsetFromRewind(applied),
      })
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

      if (evidence.interrupted) {
        return this.fail(startedAt, dryRun, {
          kind: 'not-ready', message: '识别期间播放发生暂停, 缓冲或跳转, 请稳定播放后重试',
        }, { samples, jumps })
      }

      this.setPhase('estimating')
      const estimate = estimateOffset(evidence.fresh.official, evidence.fresh.commentary, {
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
      if (!evidence.readingsFresh || (evidence.endedEarly && !evidence.ready)) {
        return this.fail(startedAt, dryRun, {
          kind: 'not-ready', message: '识别证据已过期或连续跳秒不足, 请重试',
        }, { samples, jumps })
      }
      estimateValue = estimate

      let snapshots = this.collectSnapshots()
      let plan = planOffsetChange({
        nextOffset: estimate.totalOffsetSeconds,
        applied,
        snapshots,
      })
      planValue = plan

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
      applicationStarted = true
      appliedValue = { ...applied }
      const publishRewind = (rewind: AppliedRewind): void => {
        appliedValue = rewind
        this.deps.onAppliedRewind?.({ ...rewind })
      }
      const residual = estimate.residualSeconds
      const threshold = rateNudgeSeekThreshold(this.options.seekThresholdSeconds)
      const deadband = this.options.rateDeadbandSeconds ?? DEFAULTS.rateDeadbandSeconds
      const aligned = Math.abs(residual) <= (mode === 'manual'
        ? this.options.maxDivergenceSeconds ?? DEFAULTS.maxDivergenceSeconds : deadband)
      let needsSeek = !aligned && (mode === 'manual' || Math.abs(residual) >= threshold || !this.deps.setPlaybackRate)
      if (!aligned && !needsSeek) {
        const nudge = await this.applyRateNudge(residual, snapshots, applied, token, publishRewind)
        if (this.stale(token)) {
          return this.fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
            samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue,
          })
        }
        if (nudge.kind === 'failed') {
          return this.fail(startedAt, dryRun, {
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
        const confirmed = await this.seek(seek.role, currentSeek.to, mode)
        if (this.stale(token)) {
          return this.fail(startedAt, dryRun, { kind: 'cancelled', message: '自动同步已取消' }, {
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
        // A live decoder can land at a nearby keyframe. This is not success:
        // only fresh visual verification below may accept or correct that landing.
        const movedLive = beforeSeek[seek.role]?.timebase.kind === 'live' && this.deps.playbackState
          && from !== undefined && to !== undefined && Math.abs(to - from) > 0.05
        if (!confirmed && !movedLive) {
          return this.fail(
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
        return this.fail(startedAt, dryRun, {
          kind: plan.limitReason === 'buffer-limit' ? 'buffer-limit' : 'not-ready',
          message: plan.limitReason === 'buffer-limit' ? '缓存长度不足, 偏移未完全应用' : '有源尚未就绪, 偏移未完全应用',
        }, { samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue })
      }

      this.setPhase('verifying')
      const verification = await this.verifyAndCorrect(token, appliedValue, publishRewind, samples, jumps, mode)
      const divergence = verification.divergence
      if (verification.failure) {
        return this.fail(startedAt, dryRun, verification.failure, {
          samples, jumps, estimate, plan, applied: true, appliedRewind: appliedValue,
          ...(divergence !== null ? { divergence } : {}),
        })
      }

      return this.finish({
        phase: 'done',
        dryRun,
        estimate,
        plan,
        applied: true,
        appliedRewind: appliedValue,
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
        { samples, jumps, estimate: estimateValue, plan: planValue, applied: applicationStarted, appliedRewind: appliedValue },
      )
    } finally {
      this.restorePlaybackRates()
      this.running = false
    }
  }

  private restorePlaybackRates(): void {
    for (const role of SOURCE_ROLES) {
      try {
        this.deps.setPlaybackRate?.(role, 1)
      } catch {
        // A removed media element must not prevent restoring the other source.
      }
    }
  }

  private playable(): boolean {
    return SOURCE_ROLES.every(role => {
      const snapshot = this.deps.snapshot(role)
      const state = this.deps.playbackState?.(role)
      return snapshot?.ready && Number.isFinite(snapshot.currentTime)
        && (!state || (!state.paused && !state.seeking && !state.ended && !state.busy && state.readyState >= 3))
    })
  }

  /** Require observed progress, not just seeked or elapsed wall time. */
  private async settlePlayback(token: number): Promise<boolean> {
    const settleMs = Math.max(200, (this.options.settleSeconds ?? DEFAULTS.settleSeconds) * 1000)
    if (!this.deps.playbackState) {
      await this.sleep(settleMs)
      return !this.stale(token) && this.playable()
    }
    let previous = this.collectSnapshots()
    let stableMs = 0
    for (let elapsed = 0; elapsed < 8000; elapsed += 100) {
      if (this.stale(token)) return false
      await this.sleep(100)
      if (this.stale(token)) return false
      const current = this.collectSnapshots()
      const advancing = this.playable() && SOURCE_ROLES.every(role => {
        const delta = (current[role]?.currentTime ?? NaN) - (previous[role]?.currentTime ?? NaN)
        return delta >= 0.025 && delta <= 0.25
      })
      stableMs = advancing ? stableMs + 100 : 0
      if (stableMs >= settleMs) return true
      previous = current
    }
    return false
  }

  /** Account for one-sided buffering as well as intentional correction. */
  private progressRewind(applied: AppliedRewind, before: Partial<Record<SourceRole, MediaSnapshot>>): AppliedRewind {
    const after = this.collectSnapshots()
    if (!before.official || !before.commentary || !after.official || !after.commentary) return applied
    const correction = (after.commentary.currentTime - before.commentary.currentTime)
      - (after.official.currentTime - before.official.currentTime)
    if (!Number.isFinite(correction)) return applied
    const common = Math.min(applied.official, applied.commentary)
    const offset = offsetFromRewind(applied) + correction
    return { official: round(common + Math.max(0, offset)), commentary: round(common + Math.max(0, -offset)) }
  }

  /** A normal early finish uses the same evidence gate as the final measurement. */
  private async sampleClockEvidence(
    token: number,
    windowMs: number,
    samples: Record<SourceRole, number>,
    allJumps: Record<SourceRole, ClockJumpEvent[]>,
    estimateOptions: EstimateOptions,
  ): Promise<{ fresh: Record<SourceRole, ClockJumpEvent[]>; interrupted: boolean; ready: boolean; endedEarly: boolean; readingsFresh: boolean }> {
    const detectors = { official: new ClockJumpDetector('official', this.options.jumpOptions),
      commentary: new ClockJumpDetector('commentary', this.options.jumpOptions) }
    const fresh: Record<SourceRole, ClockJumpEvent[]> = { official: [], commentary: [] }
    const revisions = SOURCE_ROLES.map(role => this.deps.playbackState?.(role))
    const lastReadingAt: Record<SourceRole, number> = { official: -Infinity, commentary: -Infinity }
    const lastSeconds: Record<SourceRole, number | null> = { official: null, commentary: null }
    const lastMediaTime: Record<SourceRole, number | null> = { official: null, commentary: null }
    const minConfidence = Math.max(MIN_SYNC_CONFIDENCE,
      this.options.jumpOptions?.minConfidence ?? MIN_SYNC_CONFIDENCE,
      estimateOptions.minConfidence ?? MIN_SYNC_CONFIDENCE)
    let interrupted = false, endedEarly = false
    const inspectPlayback = (): void => {
      interrupted ||= !this.playable() || SOURCE_ROLES.some((role, index) => {
        const current = this.deps.playbackState?.(role), before = revisions[index]
        return !!before && !!current && (before.observationRevision !== current.observationRevision
          || before.discontinuities !== current.discontinuities)
      })
    }
    const readingsFresh = (): boolean => SOURCE_ROLES.every(role => {
      const age = this.now() - lastReadingAt[role]
      return Number.isFinite(age) && age >= 0 && age <= 600
    })
    const ready = (): boolean => {
      inspectPlayback()
      return !this.stale(token) && !interrupted && readingsFresh()
        && fresh.official.length >= 2 && fresh.commentary.length >= 2
        && estimateOffset(fresh.official, fresh.commentary, { ...estimateOptions, minConfidence }).status === 'ok'
    }
    const resetEvidence = (): void => {
      // A reset, reverse tick or skipped interval starts a new common observation
      // epoch. Neither role may lend old jumps to a new countdown sequence.
      for (const role of SOURCE_ROLES) {
        fresh[role].length = 0
        detectors[role].reset()
        lastSeconds[role] = null
        lastMediaTime[role] = null
        lastReadingAt[role] = -Infinity
      }
    }
    const self = this
    await this.deps.sample(windowMs, (role, outcome) => {
      samples[role]++
      inspectPlayback()
      lastReadingAt[role] = -Infinity
      if (outcome.status === 'success' && outcome.reading.confidence >= minConfidence
        && parseCountdown(outcome.reading.text, this.options.jumpOptions?.format) === outcome.reading.seconds) {
        const value = outcome.reading.seconds, mediaTime = outcome.reading.mediaTime
        const previous = lastSeconds[role], previousMedia = lastMediaTime[role]
        // Invalidate on the first contrary frame, before the detector waits for
        // confirmation. Otherwise a peer callback could finish on the old chain.
        if ((previous !== null && (value > previous || previous - value > 1))
          || (previousMedia !== null && (mediaTime < previousMedia
            || mediaTime - previousMedia > (this.options.jumpOptions?.jumpIntervalRange?.[1] ?? 2.5)))) resetEvidence()
        lastSeconds[role] = value
        lastMediaTime[role] = mediaTime
        const receivedAt = this.now()
        const capturedAge = (this.deps.readingClock?.() ?? receivedAt) - outcome.reading.wallTime
        // Capture age is measured in the frame clock's epoch, then translated
        // onto the run clock. Time since arrival must still age the evidence.
        if (Number.isFinite(capturedAge) && capturedAge >= 0) lastReadingAt[role] = receivedAt - capturedAge
      }
      const pushed = detectors[role].push(outcome)
      if (pushed.dropped === 'not-decrement' || pushed.dropped === 'abnormal-interval') {
        resetEvidence()
        detectors[role].push(outcome)
      }
      if (pushed.event) { fresh[role].push(pushed.event); allJumps[role].push(pushed.event) }
    }, {
      get aborted() { return self.stale(token) },
      get completed() {
        const completed = ready()
        endedEarly ||= completed
        return completed
      },
    })
    const evidenceReady = ready()
    // A late callback or media interruption invalidates an earlier completion.
    return { fresh, interrupted, ready: evidenceReady, endedEarly, readingsFresh: readingsFresh() }
  }

  private async verifyAndCorrect(
    token: number,
    initialApplied: AppliedRewind,
    publish: (rewind: AppliedRewind) => void,
    samples: Record<SourceRole, number>,
    allJumps: Record<SourceRole, ClockJumpEvent[]>,
    mode: AutoSyncMode,
  ): Promise<{ divergence: number | null; failure: AutoSyncFailure | null }> {
    let carried = initialApplied
    let divergence: number | null = null
    const update = (rewind: AppliedRewind): void => { carried = rewind; publish(rewind) }
    const cancelled = (): AutoSyncFailure => ({ kind: 'cancelled', message: '自动同步已取消' })
    const failed = (message: string): AutoSyncFailure => ({ kind: 'verify-failed', message, divergence: divergence ?? Infinity })
    const tolerance = this.options.maxDivergenceSeconds ?? DEFAULTS.maxDivergenceSeconds
    const passes = Math.max(0, Math.min(3, this.options.maxCorrectionPasses ?? DEFAULTS.maxCorrectionPasses))
    for (let pass = 0; pass <= passes; pass++) {
      this.setPhase('verifying')
      const beforeSettle = this.collectSnapshots()
      const stable = await this.settlePlayback(token)
      if (this.stale(token)) return { divergence, failure: cancelled() }
      update(this.progressRewind(carried, beforeSettle))
      if (!stable) return { divergence, failure: failed('复核时播放仍在暂停或缓冲, 尚未确认对齐') }

      const beforeSample = this.collectSnapshots()
      const estimateOptions = {
        ...this.deps.estimateOptions,
        appliedOffsetSeconds: offsetFromRewind(carried),
        maxAnchorSpreadSeconds: Math.min(0.2, this.deps.estimateOptions?.maxAnchorSpreadSeconds ?? 0.2),
      }
      const evidence = await this.sampleClockEvidence(token,
        Math.max(3, this.options.verificationWindowSeconds ?? DEFAULTS.verificationWindowSeconds) * 1000,
        samples, allJumps, estimateOptions)
      if (this.stale(token)) return { divergence, failure: cancelled() }
      update(this.progressRewind(carried, beforeSample))
      if (evidence.interrupted || !evidence.readingsFresh || (evidence.endedEarly && !evidence.ready)) {
        if (pass < passes) continue
        return { divergence, failure: failed('复核期间播放发生缓冲或跳转, 尚未确认对齐') }
      }
      const fresh = evidence.fresh
      const measured = estimateOffset(fresh.official, fresh.commentary, {
        ...estimateOptions, appliedOffsetSeconds: offsetFromRewind(carried),
      })
      if (measured.status === 'rejected' || fresh.official.length < 2 || fresh.commentary.length < 2) {
        if (pass < passes) continue
        const reason = measured.status === 'rejected' ? OFFSET_REJECTION_TEXT[measured.reason] : '连续跳秒证据不足'
        return { divergence, failure: failed(`复核未通过: ${reason}`) }
      }
      divergence = Math.abs(measured.residualSeconds)
      if (divergence <= tolerance) return { divergence, failure: null }
      if (pass === passes) return { divergence, failure: failed(`复核偏差 ${divergence.toFixed(2)} 秒, 尚未收敛`) }

      this.setPhase('applying')
      const snapshots = this.collectSnapshots()
      const threshold = rateNudgeSeekThreshold(this.options.seekThresholdSeconds)
      if (mode === 'silent' && divergence < threshold && this.deps.setPlaybackRate) {
        const correction = await this.applyRateNudge(measured.residualSeconds, snapshots, carried, token, update)
        if (this.stale(token)) return { divergence, failure: cancelled() }
        if (correction.kind === 'failed') return { divergence: Math.abs(correction.error),
          failure: failed('复核校正时播放进度未能收敛') }
        // Re-measure if a new stall changed the required correction during a nudge.
        continue
      }

      const targetOffset = measured.totalOffsetSeconds
      const plan = planOffsetChange({ nextOffset: targetOffset, applied: carried, snapshots })
      for (const planned of plan.seeks) {
        const before = this.collectSnapshots()
        const currentPlan = planOffsetChange({ nextOffset: targetOffset, applied: carried, snapshots: before })
        if (currentPlan.limited) return { divergence, failure: { kind: 'buffer-limit', message: '缓存长度不足, 无法完成复核校正' } }
        const seek = currentPlan.seeks.find(item => item.role === planned.role)
        if (!seek) continue
        const confirmed = await this.seek(seek.role, seek.to, mode)
        if (this.stale(token)) return { divergence, failure: cancelled() }
        update(this.progressRewind(carried, before))
        const after = this.deps.snapshot(seek.role)
        const movedLive = before[seek.role]?.timebase.kind === 'live' && this.deps.playbackState
          && after && Math.abs(after.currentTime - seek.from) > 0.05
        if (!confirmed && !movedLive) return { divergence, failure: { kind: 'seek-failed', message: '复核校正跳转未生效' } }
      }
    }
    return { divergence, failure: failed('复核未完成') }
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

  private seek(role: SourceRole, target: number, mode: AutoSyncMode): Promise<boolean> {
    return mode === 'manual' && this.deps.seekManual ? this.deps.seekManual(role, target) : this.deps.seek(role, target)
  }

  private collectSnapshots(): Partial<Record<SourceRole, MediaSnapshot>> {
    const snapshots: Partial<Record<SourceRole, MediaSnapshot>> = {}
    for (const role of SOURCE_ROLES) {
      const snapshot = this.deps.snapshot(role)
      if (snapshot) snapshots[role] = snapshot
    }
    return snapshots
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
      appliedRewind?: AppliedRewind
      divergence?: number
    } = {},
  ): AutoSyncRunResult {
    return this.finish({
      phase: 'failed',
      dryRun,
      estimate: extra.estimate ?? null,
      plan: extra.plan ?? null,
      applied: extra.applied ?? false,
      ...(extra.appliedRewind ? { appliedRewind: extra.appliedRewind } : {}),
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
