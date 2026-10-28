/**
 * The sampling loop: video elements in, recognition outcomes out.
 *
 * `AutoSyncController` asks for "sample both sources for N ms". This is the piece that
 * answers, joining the four parts that each know only their own job:
 *
 *   startFrameLoop    → when a new frame exists
 *   FrameGrabber      → the ROI pixels of that frame
 *   RecognitionClient → one frame in flight, results tagged by generation
 *   (the caller)      → what to do with each outcome
 *
 * Each role gets its own client, and therefore its own worker. Sharing one would be
 * actively wrong on two counts: `configure` bumps the generation, so two roles with
 * different profiles would discard each other's in-flight results; and a single in-flight
 * slot means the roles compete for it, so a stall on the official source would starve
 * commentary sampling. Independent backpressure per source is the property that matters —
 * the duplicated cost is a few kilobytes of template masks.
 */

import type { RecognitionProfile } from '../core/profileSchema'
import { ClockJumpDetector, parseCountdown } from '../core/clockJump'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import { MIN_SYNC_CONFIDENCE, SOURCE_ROLES } from '../core/types'
import { RecognitionClient, type WorkerLike } from './client'
import { FrameGrabber, startFrameLoop } from './frameGrabber'
import type { ResultMessage } from './protocol'
import { RhythmSampler } from './rhythm'
import { ScoreHistory, type ScoreGuardRequest, type ScoreGuardResult, type ScoreReading } from './score'

export type OutcomeSink = (role: SourceRole, outcome: RecognitionOutcome) => void

/** Resolved at sample time rather than held, so a source swap is picked up on the next run. */
export type VideoResolver = (role: SourceRole) => HTMLVideoElement | null

export interface SamplerOptions {
  createWorker: () => WorkerLike
  video: VideoResolver
  /** Active profile per role; null disables that role. */
  profile: (role: SourceRole) => RecognitionProfile | null
  now?: () => number
  clock?: () => number
  /** Overridable for tests; defaults to the real frame loop. */
  frameLoop?: typeof startFrameLoop
  onError?: (role: SourceRole, message: string) => void
  /** Keep the existing scene monitor informed while reusing the same pixel readback. */
  onOutcome?: OutcomeSink
}

export interface SamplerStats {
  grabbed: Record<SourceRole, number>
  submitted: Record<SourceRole, number>
  dropped: Record<SourceRole, number>
  grabFailures: Record<SourceRole, number>
}

function zeroPerRole(): Record<SourceRole, number> {
  return { official: 0, commentary: 0 }
}

/** One role's private pipeline. Created lazily, kept for the sampler's lifetime. */
interface RoleChannel {
  client: RecognitionClient
  grabber: FrameGrabber
  /** The profile the worker is currently configured for, by identity. */
  configuredFor: RecognitionProfile | null
  video: HTMLVideoElement | null
  source: string
  rhythm: RhythmSampler
  jumps: ClockJumpDetector
  pendingMoment: ResultMessage['tickMoment'] | null
  lastSeconds: number | null
  frameAnchor: { mediaTime: number; wallTime: number; playbackRate: number } | null
  profileIdentity: RecognitionProfile | null
  width: number
  height: number
  segment: number
  blocked: boolean
  lastScoreTime: number
  scoreAnchor: { mediaTime: number; wallTime: number } | null
  monitorStop: (() => void) | null
  srcObject: HTMLVideoElement['srcObject'] | null
  profileSignature: string
  lifecycleStop: (() => void) | null
}

export class RecognitionSampler {
  private readonly channels = new Map<SourceRole, RoleChannel>()
  private readonly frameLoop: typeof startFrameLoop
  private readonly now: () => number
  private readonly clock: () => number
  private stats: SamplerStats = {
    grabbed: zeroPerRole(),
    submitted: zeroPerRole(),
    dropped: zeroPerRole(),
    grabFailures: zeroPerRole(),
  }
  private sink: OutcomeSink | null = null
  private sampling = false
  private sampleGeneration = 0
  private disposed = false
  private readonly scores = new ScoreHistory()

  constructor(private readonly options: SamplerOptions) {
    this.now = options.now ?? (() => Date.now())
    this.clock = options.clock ?? this.now
    this.frameLoop = options.frameLoop ?? startFrameLoop
  }

  getStats(): SamplerStats {
    return {
      grabbed: { ...this.stats.grabbed },
      submitted: { ...this.stats.submitted },
      dropped: { ...this.stats.dropped },
      grabFailures: { ...this.stats.grabFailures },
    }
  }

  /** Worker-side throughput per role, for the debug panel. */
  workerStats(role: SourceRole) {
    return this.channels.get(role)?.client.getStats() ?? null
  }

  /** Begin a shared, sparse scoreboard/scene monitor after a profile is accepted. */
  monitor(role: SourceRole): () => void {
    if (this.disposed) return () => {}
    const channel = this.channelFor(role)
    channel.monitorStop?.()
    const stop = this.startRole(role, { aborted: false })
    channel.monitorStop = stop
    return () => {
      stop?.()
      if (channel.monitorStop === stop) channel.monitorStop = null
    }
  }

  /** The token concerns media evidence, independent of worker request cancellation. */
  scoreGeneration(): string {
    for (const role of SOURCE_ROLES) this.reconcile(role)
    return SOURCE_ROLES.map(role => `${role}:${this.channelFor(role).segment}`).join('/')
  }

  scoreReadings(role: SourceRole): readonly ScoreReading[] { return this.scores.readings(role) }

  async checkScore(request: ScoreGuardRequest): Promise<ScoreGuardResult> {
    const generation = this.scoreGeneration()
    let result = this.scores.evaluate(request.residualSeconds, this.clock(), generation)
    if (request.signal.aborted || this.disposed) return { ...result, status: 'unknown', reason: 'cancelled' }
    if (result.status === 'pass' || result.status === 'mismatch') return result
    await this.sample(1500, () => {}, request.signal)
    const current = this.scoreGeneration()
    result = this.scores.evaluate(request.residualSeconds, this.clock(), current)
    if (request.signal.aborted || current !== generation) return { ...result, status: 'unknown', reason: 'stale-generation' }
    return result
  }

  /**
   * Sample every ready role for `windowMs`, reporting each outcome as it arrives.
   *
   * Resolves when the window closes, whether or not anything was recognised: an empty
   * window is a legitimate result (`no-samples`) for the caller to report, not an error.
   * Concurrent calls are refused — two overlapping windows would split the frame rate and
   * attribute each other's readings.
   */
  async sample(
    windowMs: number,
    onOutcome: OutcomeSink,
    signal: { aborted: boolean },
  ): Promise<void> {
    if (this.disposed || this.sampling) return
    this.sampling = true
    this.sampleGeneration += 1
    // A persistent monitor must not carry its previous frame into a new measurement.
    for (const channel of this.channels.values()) {
      channel.grabber.cancel()
      channel.client.cancel()
      channel.configuredFor = null
    }
    this.stats = {
      grabbed: zeroPerRole(),
      submitted: zeroPerRole(),
      dropped: zeroPerRole(),
      grabFailures: zeroPerRole(),
    }
    this.sink = onOutcome

    const stops: Array<() => void> = []
    try {
      for (const role of SOURCE_ROLES) {
        if (this.channelFor(role).monitorStop) continue
        const stop = this.startRole(role, signal)
        if (stop) stops.push(stop)
      }
      if (stops.length === 0 && ![...this.channels.values()].some(channel => channel.monitorStop)) return
      await this.waitForWindow(windowMs, signal)
    } finally {
      for (const stop of stops) stop()
      this.sink = null
      this.sampling = false
      this.sampleGeneration += 1
      // A frame still in flight would otherwise land during the next window and be
      // counted as one of its readings.
      for (const channel of this.channels.values()) {
        channel.grabber.cancel()
        channel.client.cancel()
        channel.configuredFor = null
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.sink = null
    for (const channel of this.channels.values()) {
      channel.monitorStop?.()
      channel.lifecycleStop?.()
      channel.client.dispose()
      channel.grabber.dispose()
    }
    this.channels.clear()
  }

  /** Begin feeding one role's frames to its worker. Null when the role cannot sample. */
  private startRole(role: SourceRole, signal: { aborted: boolean }): (() => void) | null {
    const video = this.options.video(role)
    const profile = this.options.profile(role)
    if (!video || !profile) return null

    const channel = this.channelFor(role)
    const fps = Math.max(1, Math.min(60, profile.sampleFps))
    let activeLoop = true
    const invalidate = (): void => {
      channel.grabber.cancel()
      channel.client.cancel()
      channel.configuredFor = null
      this.resetTiming(channel)
      this.invalidateScores(role, channel)
    }
    this.reconcile(role)
    // Buffering ('waiting', 'stalled') keeps the timeline continuous, so it only pauses
    // collection. The media/wall-time check on the next score frame still catches a gap.
    const events = ['seeking', 'emptied', 'loadstart', 'pause', 'ratechange', 'resize']
    channel.lifecycleStop?.()
    for (const event of events) video.addEventListener?.(event, invalidate)
    channel.lifecycleStop = () => {
      for (const event of events) video.removeEventListener?.(event, invalidate)
      channel.lifecycleStop = null
    }

    const stop = this.frameLoop(video, fps, async (mediaTime) => {
      if (!activeLoop || signal.aborted || this.disposed) return
      const active = this.options.profile(role)
      if (!active) return
      this.reconcile(role)
      if (channel.video !== video) return
      if (channel.configuredFor !== active) {
        this.resetTiming(channel)
        channel.client.configure(active, { automatic: active.id.startsWith('session/') })
        channel.configuredFor = active
      }
      const wantClock = this.sampling && channel.rhythm.shouldSample(mediaTime)
      const wantScore = !channel.blocked && (wantClock || !this.sampling)
        && mediaTime - channel.lastScoreTime >= 0.5 - 1e-6
      if (!wantScore && !wantClock) return
      this.stats.grabbed[role] += 1
      if (channel.client.busy) {
        this.stats.dropped[role] += 1
        return
      }
      const segment = channel.segment
      const sampleGeneration = this.sampleGeneration
      const result = await (wantScore ? channel.grabber.grabStripAsync(video, active.roi, mediaTime)
        : channel.grabber.grabAsync(video, active.roi, mediaTime))
      if (!activeLoop || signal.aborted || this.disposed || this.sampleGeneration !== sampleGeneration) return
      this.reconcile(role)
      if (channel.segment !== segment || channel.video !== video) return
      if (!result.ok) {
        if ('skipped' in result) {
          if (result.reason === 'backpressure') this.stats.dropped[role] += 1
          return
        }
        this.stats.grabFailures[role] += 1
        channel.rhythm.reset()
        this.sink?.(role, { status: 'failed', reason: result.reason, detail: result.detail })
        return
      }
      const previousAnchor = channel.frameAnchor
      if (wantScore) {
        const anchor = channel.scoreAnchor
        const wallTime = result.frame.wallTime
        if (anchor && (mediaTime <= anchor.mediaTime || wallTime - anchor.wallTime > 1500
          || Math.abs((mediaTime - anchor.mediaTime) * 1000 - (wallTime - anchor.wallTime)) > 500)) {
          this.invalidateScores(role, channel)
        }
        channel.lastScoreTime = mediaTime
        channel.scoreAnchor = { mediaTime, wallTime }
      }
      channel.frameAnchor = {
        mediaTime: result.frame.mediaTime,
        wallTime: result.frame.wallTime,
        playbackRate: Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1,
      }
      if (channel.client.submit(role, result.frame, false, wantScore ? {
        source: channel.source, generation: channel.segment, width: channel.width,
        height: channel.height, segment: channel.segment,
      } : undefined)) {
        this.stats.submitted[role] += 1
      } else {
        channel.frameAnchor = previousAnchor
        // Backpressure, not an error: the worker is still busy with the previous frame.
        this.stats.dropped[role] += 1
      }
    })
    return () => {
      activeLoop = false
      stop()
      channel.grabber.cancel()
    }
  }

  private channelFor(role: SourceRole): RoleChannel {
    const existing = this.channels.get(role)
    if (existing) return existing
    const channel: RoleChannel = {
      grabber: new FrameGrabber(this.clock),
      configuredFor: null,
      video: null,
      source: '',
      rhythm: new RhythmSampler(),
      jumps: new ClockJumpDetector(role),
      pendingMoment: null,
      lastSeconds: null,
      frameAnchor: null,
      profileIdentity: null, width: 0, height: 0, segment: 0, blocked: false,
      lastScoreTime: -Infinity, scoreAnchor: null, monitorStop: null,
      srcObject: null, profileSignature: '',
      lifecycleStop: null,
      client: new RecognitionClient({
        createWorker: this.options.createWorker,
        now: this.now,
        onError: (message) => this.options.onError?.(role, message),
        onResult: (message) => {
          const segment = channel.segment
          this.reconcile(role)
          if (channel.segment !== segment) return
          if (message.score && message.score.segment === channel.segment && !channel.blocked) {
            const previous = this.scores.readings(role).at(-1)
            if (previous?.left !== null && previous?.right !== null && message.score.left !== null && message.score.right !== null
              && previous && message.score.left + message.score.right < previous.left! + previous.right!) {
              // A replay/map reset cannot inherit the live segment's identity evidence.
              this.invalidateScores(role, channel)
            } else this.scores.push(role, message.score)
          }
          const outcome = this.atTickMoment(channel, message)
          const result = channel.jumps.push(outcome)
          if (result.event) channel.rhythm.confirmTick(result.event.mediaTime)
          if (result.dropped === 'not-decrement' || result.dropped === 'abnormal-interval') channel.rhythm.reset()
          if (outcome.status === 'failed') channel.rhythm.reset()
          this.sink?.(role, outcome)
          this.options.onOutcome?.(role, outcome)
        },
      }),
    }
    this.channels.set(role, channel)
    return channel
  }

  private invalidateScores(role: SourceRole, channel: RoleChannel): void {
    channel.segment += 1
    channel.lastScoreTime = -Infinity
    channel.scoreAnchor = null
    this.scores.clear(role)
  }

  private reconcile(role: SourceRole): void {
    const channel = this.channelFor(role)
    const video = this.options.video(role)
    const profile = this.options.profile(role)
    const source = video ? `${video.currentSrc || video.src || ''}` : ''
    const width = video?.videoWidth ?? 0
    const height = video?.videoHeight ?? 0
    const srcObject = video?.srcObject ?? null
    const profileSignature = profile ? `${profile.updatedAt}/${JSON.stringify(profile.roi)}` : ''
    const blocked = !video || video.paused === true || video.seeking === true
      || (Number.isFinite(video.playbackRate) && Math.abs(video.playbackRate - 1) > 1e-6)
    if (channel.video !== video || channel.source !== source || channel.width !== width || channel.height !== height
      || channel.profileIdentity !== profile || channel.profileSignature !== profileSignature
      || channel.srcObject !== srcObject || blocked !== channel.blocked) {
      this.invalidateScores(role, channel)
      channel.video = video
      channel.source = source
      channel.width = width
      channel.height = height
      channel.profileIdentity = profile
      channel.profileSignature = profileSignature
      channel.srcObject = srcObject
      channel.blocked = blocked
      channel.configuredFor = null
      channel.grabber.cancel()
      channel.client.cancel()
      this.resetTiming(channel)
    }
  }

  private resetTiming(channel: RoleChannel): void {
    channel.rhythm.reset()
    channel.jumps.reset()
    channel.pendingMoment = null
    channel.lastSeconds = null
    channel.frameAnchor = null
  }

  /** Associate image-change timing only with an actual recognised decrement. */
  private atTickMoment(channel: RoleChannel, message: ResultMessage): RecognitionOutcome {
    const moment = message.tickMoment
    if (moment && Number.isFinite(moment.lastUnchanged) && Number.isFinite(moment.firstChanged)
      && Number.isFinite(moment.midpoint) && moment.lastUnchanged < moment.firstChanged
      && moment.midpoint >= moment.lastUnchanged && moment.midpoint <= moment.firstChanged) {
      channel.pendingMoment = moment
    }
    const outcome = message.outcome
    if (outcome.status !== 'success' || outcome.reading.confidence < MIN_SYNC_CONFIDENCE) return outcome
    const reading = outcome.reading
    if (parseCountdown(reading.text) !== reading.seconds) return outcome
    const previousSeconds = channel.lastSeconds
    channel.lastSeconds = reading.seconds
    const pending = channel.pendingMoment
    if (!pending || previousSeconds === null || previousSeconds - reading.seconds !== 1) return outcome
    channel.pendingMoment = null
    // The changed frame may be unreadable during animation. The later real reading
    // supplies its own shared-clock anchor; no countdown value is fabricated.
    const age = reading.mediaTime - pending.firstChanged
    if (age < -1e-6 || age > 0.5) return outcome
    const anchor = channel.frameAnchor
    const rate = anchor?.playbackRate ?? 1
    const anchorMedia = anchor?.mediaTime ?? reading.mediaTime
    const anchorWall = anchor?.wallTime ?? reading.wallTime
    return {
      status: 'success',
      reading: {
        ...reading,
        mediaTime: pending.midpoint,
        wallTime: anchorWall + (pending.midpoint - anchorMedia) * 1000 / rate,
      },
    }
  }

  /** Wait out the window, polling often enough that cancellation feels immediate. */
  private waitForWindow(windowMs: number, signal: { aborted: boolean }): Promise<void> {
    return new Promise<void>((resolve) => {
      const deadline = this.now() + windowMs
      const tick = (): void => {
        if (signal.aborted || this.disposed) {
          resolve()
          return
        }
        const remaining = deadline - this.now()
        if (remaining <= 0) {
          resolve()
          return
        }
        setTimeout(tick, Math.min(50, remaining))
      }
      tick()
    })
  }
}
