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

import { captureRoi, isBasicClock, isHudPack, type ActiveProfile } from '../core/activeProfile'
import type { RecognitionProfile } from '../core/profileSchema'
import { ClockJumpDetector, parseCountdown } from '../core/clockJump'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import { MIN_SYNC_CONFIDENCE, SOURCE_ROLES } from '../core/types'
import { RecognitionClient, type WorkerLike } from './client'
import { FrameGrabber, startFrameLoop } from './frameGrabber'
import type { BasicClockDiagnostic, BasicClockProgress, BasicClockVisualFrame, ResultMessage } from './protocol'
import { RhythmSampler } from './rhythm'
import { HudReplaySession, hudSyncOutcome } from './hudResult'

export type OutcomeSink = (role: SourceRole, outcome: RecognitionOutcome) => void
export type { BasicClockProgress, BasicClockVisualFrame } from './protocol'

/** Resolved at sample time rather than held, so a source swap is picked up on the next run. */
export type VideoResolver = (role: SourceRole) => HTMLVideoElement | null

export interface SamplerOptions {
  createWorker: () => WorkerLike
  video: VideoResolver
  /** Active profile per role; null disables that role. */
  profile: (role: SourceRole) => ActiveProfile | null
  now?: () => number
  clock?: () => number
  /** Overridable for tests; defaults to the real frame loop. */
  frameLoop?: typeof startFrameLoop
  onError?: (role: SourceRole, message: string) => void
  wantBasicDebug?: () => boolean
  onBasicProgress?: (role: SourceRole, progress: BasicClockProgress) => void
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

function validBasicImage(image: { width: number; height: number; data: Uint8Array } | null | undefined): boolean {
  return !!image && Number.isInteger(image.width) && Number.isInteger(image.height)
    && image.width > 0 && image.height > 0 && image.data.length >= image.width * image.height
}

interface FrameAnchor {
  mediaTime: number
  wallTime: number
  playbackRate: number
}

interface PendingTickMoment {
  moment: NonNullable<ResultMessage['tickMoment']>
  wallTime: number
}

type SampleSignal = { aborted: boolean; readonly completed?: boolean }
interface RecentOutcome { outcome: RecognitionOutcome; receivedAt: number }

/** One role's private pipeline. Created lazily, kept for the sampler's lifetime. */
interface RoleChannel {
  client: RecognitionClient
  grabber: FrameGrabber
  /** The profile the worker is currently configured for, by identity. */
  configuredFor: ActiveProfile | null
  video: HTMLVideoElement | null
  source: string
  sourceObject: HTMLVideoElement['srcObject']
  width: number
  height: number
  stopObserving: (() => void) | null
  replay: HudReplaySession
  variantId: string | null | undefined
  rhythm: RhythmSampler
  jumps: ClockJumpDetector
  pendingMoment: PendingTickMoment | null
  lastSeconds: number | null
  frameAnchor: FrameAnchor | null
  frameAnchors: FrameAnchor[]
  lastPresentedTime: number | null
  /** Bumped on every invalidation; a readback started under an older value is stale. */
  epoch: number
  lastBasicDebugAt: number
  lastBasicProgressAt: number
  basicProgressStatus: string | null
  basicVisual: BasicClockVisualFrame | null
  basicSync: { readings: number; jumps: number; lastDrop?: string }
  basicError: string | null
  workerFailed: boolean
  basicLayoutRoi: BasicClockDiagnostic['roi'] | null
  recent: RecentOutcome[]
  pendingResults: Set<ReturnType<typeof setTimeout>>
}

/**
 * The same scene for sampling. A caller may rebuild the profile object on every read, so
 * equal settings count as the same. Glyph sets compare per sample, by the sample objects:
 * learning or editing a glyph always makes a new sample, and comparing bitmaps per frame
 * would be waste.
 */
function sameProfile(a: ActiveProfile | null, b: ActiveProfile): boolean {
  if (a === b) return true
  if (!a) return false
  if (isBasicClock(a) || isBasicClock(b)) return isBasicClock(a) && isBasicClock(b)
    && a.sampleFps === b.sampleFps && a.roiOrigin === b.roiOrigin && a.roi?.x === b.roi?.x && a.roi?.y === b.roi?.y
    && a.roi?.w === b.roi?.w && a.roi?.h === b.roi?.h
    && a.searchRoi?.x === b.searchRoi?.x && a.searchRoi?.y === b.searchRoi?.y
    && a.searchRoi?.w === b.searchRoi?.w && a.searchRoi?.h === b.searchRoi?.h
  if (isHudPack(a) || isHudPack(b)) return isHudPack(a) && isHudPack(b) && a.id === b.id && a.revision === b.revision && JSON.stringify(a) === JSON.stringify(b)
  return a.id === b.id && a.name === b.name && a.updatedAt === b.updatedAt
    && a.clockFormat === b.clockFormat && a.sampleFps === b.sampleFps && a.matchThreshold === b.matchThreshold
    && a.roi.x === b.roi.x && a.roi.y === b.roi.y && a.roi.w === b.roi.w && a.roi.h === b.roi.h
    && a.preprocess.scale === b.preprocess.scale && a.preprocess.threshold === b.preprocess.threshold
    && a.preprocess.invert === b.preprocess.invert && sameTemplates(a.templates, b.templates)
}

function sameTemplates(a: RecognitionProfile['templates'], b: RecognitionProfile['templates']): boolean {
  if (a === b) return true
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof RecognitionProfile['templates']>
  for (const key of keys) {
    const left = a[key] ?? []
    const right = b[key] ?? []
    if (left.length !== right.length || left.some((sample, index) => sample !== right[index])) return false
  }
  return true
}

/** Promotion to the exact verified crop changes policy, not the picture's layout. */
function compatibleBasicProfile(channel: RoleChannel, profile: ActiveProfile): boolean {
  const previous = channel.configuredFor
  if (!previous || !isBasicClock(previous) || !isBasicClock(profile)) return false
  const sameRoi = (a: BasicClockDiagnostic['roi'], b: BasicClockDiagnostic['roi']): boolean =>
    (!a && !b) || (!!a && !!b && ['x', 'y', 'w', 'h'].every(key =>
      Math.abs(a[key as keyof typeof a] - b[key as keyof typeof b]) < 1e-8))
  return previous.sampleFps === profile.sampleFps && sameRoi(previous.searchRoi, profile.searchRoi)
    && (sameRoi(previous.roi, profile.roi) || (!previous.roi && profile.roiOrigin === 'memory'
      && !!channel.basicLayoutRoi && sameRoi(channel.basicLayoutRoi, profile.roi)))
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
  private backgroundRoles = new Set<SourceRole>()
  private backgroundPaused = false
  private readonly backgroundStops = new Map<SourceRole, () => void>()
  private checkWindow: (() => void) | null = null
  private activeSignal: SampleSignal | null = null

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

  /** Pre-recognition uses the same per-source workers and never controls playback. */
  setBackgroundRoles(roles: readonly SourceRole[], paused = false): void {
    if (this.disposed) return
    this.backgroundRoles = new Set(roles)
    this.backgroundPaused = paused
    for (const role of this.backgroundStops.keys()) {
      if (!this.backgroundRoles.has(role) || paused || this.sampling) this.stopBackgroundRole(role)
    }
    if (paused || this.sampling) return
    for (const role of this.backgroundRoles) {
      if (this.backgroundStops.has(role)) continue
      const profile = this.options.profile(role)
      if (!profile || !isBasicClock(profile)) continue
      const self = this
      const stop = this.startRole(role, { get aborted() {
        return self.disposed || self.sampling || self.backgroundPaused || !self.backgroundRoles.has(role)
      } }, true)
      if (stop) this.backgroundStops.set(role, stop)
    }
  }

  /** Explicit stream/quality replacement invalidates only that source's parameters. */
  invalidate(role: SourceRole): void {
    this.stopBackgroundRole(role)
    const channel = this.channels.get(role)
    if (channel) this.invalidateSource(channel)
  }

  private stopBackgroundRole(role: SourceRole): void {
    const stop = this.backgroundStops.get(role)
    if (!stop) return
    this.backgroundStops.delete(role)
    stop()
    const channel = this.channels.get(role)
    if (channel) {
      channel.epoch += 1
      this.cancelPendingResults(channel)
      channel.client.cancel(!!channel.configuredFor && isBasicClock(channel.configuredFor))
    }
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
    signal: SampleSignal,
    reuseRecent = false,
  ): Promise<void> {
    if (this.disposed || this.sampling) return
    this.sampling = true
    for (const role of this.backgroundStops.keys()) this.stopBackgroundRole(role)
    this.sampleGeneration += 1
    this.stats = {
      grabbed: zeroPerRole(),
      submitted: zeroPerRole(),
      dropped: zeroPerRole(),
      grabFailures: zeroPerRole(),
    }
    this.sink = onOutcome
    this.activeSignal = signal

    const stops: Array<() => void> = []
    try {
      const recent: Array<RecentOutcome & { role: SourceRole }> = []
      for (const [role, channel] of this.channels) {
        const video = this.options.video(role), profile = this.options.profile(role)
        if (reuseRecent && video && profile && isBasicClock(profile) && this.sameSource(channel, video)
          && compatibleBasicProfile(channel, profile) && video.readyState >= 3
          && !video.paused && !video.seeking && !video.ended) {
          recent.push(...channel.recent.filter(item => this.now() - item.receivedAt >= 0 && this.now() - item.receivedAt <= 4000)
            .map(item => ({ ...item, role })))
        }
        channel.recent = []
      }
      for (const role of SOURCE_ROLES) {
        const stop = this.startRole(role, signal)
        if (stop) stops.push(stop)
      }
      if (stops.length === 0) return
      for (const item of recent.sort((a, b) => a.receivedAt - b.receivedAt)) {
        if (signal.aborted || this.disposed) break
        onOutcome(item.role, item.outcome)
      }
      await this.waitForWindow(windowMs, signal)
    } finally {
      for (const stop of stops) stop()
      this.sink = null
      this.activeSignal = null
      this.sampling = false
      this.sampleGeneration += 1
      // A frame still in flight would otherwise land during the next window and be
      // counted as one of its readings.
      for (const channel of this.channels.values()) {
        this.cancelPendingResults(channel)
        channel.grabber.cancel()
        const retainBasic = !this.disposed
          && channel.configuredFor !== null && isBasicClock(channel.configuredFor)
        channel.client.cancel(retainBasic, signal.aborted && retainBasic)
        if (signal.aborted) { this.resetTiming(channel); channel.recent = [] }
        if (!retainBasic) { channel.configuredFor = null; this.resetBasicProgress(channel) }
      }
      this.setBackgroundRoles([...this.backgroundRoles], this.backgroundPaused)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const stop of this.backgroundStops.values()) stop()
    this.backgroundStops.clear()
    this.checkWindow?.()
    this.sink = null
    for (const channel of this.channels.values()) {
      this.cancelPendingResults(channel)
      channel.stopObserving?.()
      channel.client.dispose()
      channel.grabber.dispose()
    }
    this.channels.clear()
  }

  /** Begin feeding one role's frames to its worker. Null when the role cannot sample. */
  private startRole(role: SourceRole, signal: SampleSignal, background = false): (() => void) | null {
    const video = this.options.video(role)
    const profile = this.options.profile(role)
    if (!video || !profile) return null

    const channel = this.channelFor(role)
    const fps = Math.max(1, Math.min(60, (isHudPack(profile) ? 30 : profile.sampleFps)))
    let activeLoop = true
    let lastBasicCapture = -Infinity
    let stableFrame: { mediaTime: number; epoch: number } | null = null
    this.observeSource(channel, video)
    // Sampling may pause while only the peer seeks. A verified layout needs a new
    // temporal baseline on both sides, not a synthetic long interval on the idle side.
    if (!background && channel.basicLayoutRoi && channel.configuredFor && isBasicClock(channel.configuredFor)) {
      channel.client.cancel(true, true)
    }
    // Each measurement needs fresh jumps, even when native ROI discovery is retained.
    this.resetTiming(channel)
    channel.basicSync = { readings: 0, jumps: 0 }
    channel.lastBasicProgressAt = -Infinity
    channel.basicProgressStatus = null
    channel.basicError = null
    if (channel.workerFailed) { channel.configuredFor = null; channel.workerFailed = false }

    const stop = this.frameLoop(video, fps, async (mediaTime, timing) => {
      // rVFC may run after the frame was displayed. Convert its clock delta into
      // this sampler's shared clock before configuration or asynchronous readback.
      const presentedWallTime = timing && Number.isFinite(timing.callbackTime) && Number.isFinite(timing.expectedDisplayTime)
        ? this.clock() + timing.expectedDisplayTime - timing.callbackTime : null
      if (!activeLoop || signal.aborted || this.disposed) return
      if (channel.workerFailed || !Number.isFinite(mediaTime)) return
      if (this.options.video(role) !== video) {
        this.invalidateSource(channel)
        return
      }
      const active = this.options.profile(role)
      if (!active) return
      this.observeSource(channel, video)
      // A live timeline may rewind without a DOM seeking event after a buffer or
      // decoder replacement. It cannot share an OCR/tick generation with old frames.
      if (channel.lastPresentedTime !== null && mediaTime < channel.lastPresentedTime - 1e-6) {
        this.invalidateTiming(channel)
        lastBasicCapture = -Infinity
      }
      if (background) {
        const previous = stableFrame
        stableFrame = { mediaTime, epoch: channel.epoch }
        if (video.paused || video.seeking || video.ended || video.readyState < 3
          || video.videoWidth <= 0 || video.videoHeight <= 0) {
          stableFrame = null
          return
        }
        // Two distinct presented frames establish progress, including for a lone source.
        if (!previous || previous.epoch !== channel.epoch || mediaTime <= previous.mediaTime
          || mediaTime - previous.mediaTime > 0.5) return
      }
      if (!sameProfile(channel.configuredFor, active)) {
        const preserveBasic = compatibleBasicProfile(channel, active)
        if (!preserveBasic) {
          this.resetTiming(channel)
          this.resetBasicProgress(channel)
          channel.recent = []
        }
        try {
          channel.client.configure(active, preserveBasic)
        } catch (error) { this.handleWorkerError(role, channel, String(error)); return }
        channel.configuredFor = active
        if (channel.workerFailed) return
      }
      channel.lastPresentedTime = mediaTime
      // rVFC fires at the video's native rate, independently of the fallback timer's fps.
      if (isBasicClock(active)) {
        const elapsed = mediaTime - lastBasicCapture
        if (elapsed >= 0 && elapsed < 1 / fps - 1e-6) return
      }
      if (!channel.rhythm.shouldSample(mediaTime)) return
      this.stats.grabbed[role] += 1
      if (channel.client.busy || channel.pendingResults.size > 0) {
        this.stats.dropped[role] += 1
        return
      }
      const sampleGeneration = this.sampleGeneration
      const epoch = channel.epoch
      const width = video.videoWidth
      const height = video.videoHeight
      // Bound GPU readback before transferring discovery frames from high-resolution sources.
      const result = isBasicClock(active)
        ? await channel.grabber.grabScaledAsync(video, captureRoi(active), 1920, mediaTime)
        : await channel.grabber.grabAsync(video, captureRoi(active), mediaTime)
      // A seek, a new source, new dimensions, another profile or a new window while
      // reading back all make this frame stale. Checked here as well as by the events,
      // because a source or size change has no event of its own until the next frame.
      if (!activeLoop || signal.aborted || this.disposed || this.sampleGeneration !== sampleGeneration
        || channel.epoch !== epoch || channel.video !== video
        || channel.source !== (video.currentSrc || video.src || '')
        || channel.sourceObject !== video.srcObject
        || video.videoWidth !== width || video.videoHeight !== height
        || !sameProfile(this.options.profile(role), active)) return
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
      const capturedFrame = presentedWallTime === null ? result.frame : { ...result.frame, wallTime: presentedWallTime }
      const previousAnchor = channel.frameAnchor
      const previousAnchors = channel.frameAnchors
      channel.frameAnchor = {
        mediaTime: capturedFrame.mediaTime,
        wallTime: capturedFrame.wallTime,
        playbackRate: Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1,
      }
      // Keep the actual capture clocks of both pixel-bracket endpoints. Later
      // stable OCR may arrive after scheduling delay or a buffer pause.
      channel.frameAnchors = [...previousAnchors.slice(-63), channel.frameAnchor]
      const wantsBasicDebug = isBasicClock(active) && this.options.wantBasicDebug?.() === true
      const submittedAt = this.now()
      if (!wantsBasicDebug) channel.lastBasicDebugAt = -Infinity
      const wantDebug = wantsBasicDebug && submittedAt - channel.lastBasicDebugAt >= 500
      if (channel.client.submit(role, capturedFrame, wantDebug)) {
        if (isBasicClock(active)) lastBasicCapture = mediaTime
        if (wantDebug) channel.lastBasicDebugAt = submittedAt
        this.stats.submitted[role] += 1
      } else {
        channel.frameAnchor = previousAnchor
        channel.frameAnchors = previousAnchors
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
      epoch: 0,
      video: null,
      source: '',
      sourceObject: null,
      width: 0,
      height: 0,
      stopObserving: null,
      replay: new HudReplaySession(),
      variantId: undefined,
      rhythm: new RhythmSampler(),
      jumps: new ClockJumpDetector(role),
      pendingMoment: null,
      lastSeconds: null,
      frameAnchor: null,
      frameAnchors: [],
      lastPresentedTime: null,
      lastBasicDebugAt: -Infinity,
      lastBasicProgressAt: -Infinity,
      basicProgressStatus: null,
      basicVisual: null,
      basicSync: { readings: 0, jumps: 0 },
      basicError: null,
      workerFailed: false,
      basicLayoutRoi: null,
      recent: [],
      pendingResults: new Set(),
      client: new RecognitionClient({
        createWorker: this.options.createWorker,
        now: this.now,
        onError: message => this.handleWorkerError(role, channel, message),
        onResult: (message) => {
          // rVFC may deliver the next displayed frame a few milliseconds early.
          // Publish at its real presentation time, instead of rejecting a valid
          // timestamp as permanently future or rewriting the measured clock.
          const lead = message.outcome.status === 'success' ? message.outcome.reading.wallTime - this.clock() : 0
          if (lead > 0 && lead <= 50) {
            const epoch = channel.epoch
            const timer = setTimeout(() => {
              channel.pendingResults.delete(timer)
              if (this.disposed || channel.epoch !== epoch || channel.client.generation !== message.generation) return
              this.publishResult(role, channel, message)
            }, Math.ceil(lead))
            channel.pendingResults.add(timer)
          } else this.publishResult(role, channel, message)
        },
      }),
    }
    this.channels.set(role, channel)
    return channel
  }

  private publishResult(role: SourceRole, channel: RoleChannel, message: ResultMessage): void {
    if (this.disposed || this.activeSignal?.aborted) return
    if (!this.sink && (!this.backgroundStops.has(role) || this.backgroundPaused)) return
    const video = channel.video
    if (!video || this.options.video(role) !== video || !this.sameSource(channel, video)) {
      this.invalidateSource(channel)
      return
    }
    const active = this.options.profile(role)
    if (!active || !channel.configuredFor || !sameProfile(active, channel.configuredFor)) {
      if (active && compatibleBasicProfile(channel, active)) this.invalidateTiming(channel)
      else this.invalidateSource(channel)
      return
    }
    if (message.hud && channel.variantId !== message.hud.variantId) {
      const anchor = channel.frameAnchor
      this.resetTiming(channel)
      channel.frameAnchor = anchor
      channel.frameAnchors = anchor ? [anchor] : []
      channel.variantId = message.hud.variantId
    }
    const hud = message.hud ? channel.replay.observe(message.hud) : undefined
    const current = hud ? { ...message, hud, outcome: hudSyncOutcome(hud, message.outcome) } : message
    const outcome = this.atTickMoment(channel, current)
    const result = channel.jumps.push(outcome)
    if (outcome.status === 'success') channel.basicSync.readings += 1
    if (result.event) channel.basicSync.jumps += 1
    if (result.dropped) channel.basicSync.lastDrop = result.dropped
    channel.basicError = outcome.status === 'failed' && outcome.reason === 'decode-failed' ? outcome.detail ?? '识别帧处理失败' : null
    if (result.event) channel.rhythm.confirmTick(result.event.mediaTime)
    if (result.dropped === 'not-decrement' || result.dropped === 'abnormal-interval') channel.rhythm.reset()
    if (outcome.status === 'failed') channel.rhythm.reset()
    if (isBasicClock(active)) {
      const receivedAt = this.now()
      channel.recent = [...channel.recent.filter(item => receivedAt - item.receivedAt <= 4000).slice(-239),
        { outcome, receivedAt }]
      if (message.basic?.status === 'locked' && message.basic.roi) channel.basicLayoutRoi = message.basic.roi
    }
    this.sink?.(role, outcome)
    if (isBasicClock(active)) {
      if (message.basic) this.reportBasicProgress(role, channel, message)
      else if (channel.basicError) this.reportBasicProgress(role, channel, { ...message,
        basic: this.basicDiagnostic(active) })
    }
    this.checkWindow?.()
  }

  private cancelPendingResults(channel: RoleChannel): void {
    for (const timer of channel.pendingResults) clearTimeout(timer)
    channel.pendingResults.clear()
  }

  private sameSource(channel: RoleChannel, video: HTMLVideoElement): boolean {
    return channel.video === video && channel.source === (video.currentSrc || video.src || '')
      && channel.sourceObject === video.srcObject && channel.width === video.videoWidth && channel.height === video.videoHeight
  }

  private invalidateSource(channel: RoleChannel): void {
    channel.epoch += 1
    this.cancelPendingResults(channel)
    channel.grabber.cancel()
    channel.client.cancel()
    channel.configuredFor = null
    channel.replay.reset()
    channel.variantId = undefined
    this.resetTiming(channel)
    this.resetBasicProgress(channel)
    channel.recent = []
    channel.workerFailed = false
  }

  private invalidateTiming(channel: RoleChannel): void {
    if (!channel.configuredFor || !isBasicClock(channel.configuredFor)) {
      this.invalidateSource(channel)
      return
    }
    channel.epoch += 1
    this.cancelPendingResults(channel)
    channel.grabber.cancel()
    channel.client.cancel(true, true)
    this.resetTiming(channel)
    channel.recent = []
    channel.basicSync = { readings: 0, jumps: 0 }
  }

  private observeSource(channel: RoleChannel, video: HTMLVideoElement): void {
    const changedVideo = channel.video !== video
    if (!this.sameSource(channel, video)) this.invalidateSource(channel)
    if (changedVideo) {
      channel.stopObserving?.()
      const invalidate = (): void => {
        if (this.sameSource(channel, video)) this.invalidateTiming(channel)
        else this.invalidateSource(channel)
      }
      const events = ['seeking', 'emptied', 'loadstart', 'resize', 'waiting', 'pause', 'ratechange']
      for (const event of events) video.addEventListener?.(event, invalidate)
      channel.stopObserving = () => {
        for (const event of events) video.removeEventListener?.(event, invalidate)
      }
    }
    channel.video = video
    channel.source = video.currentSrc || video.src || ''
    channel.sourceObject = video.srcObject
    channel.width = video.videoWidth
    channel.height = video.videoHeight
  }

  private resetTiming(channel: RoleChannel): void {
    channel.rhythm.reset()
    channel.jumps.reset()
    channel.pendingMoment = null
    channel.lastSeconds = null
    channel.frameAnchor = null
    channel.frameAnchors = []
    channel.lastPresentedTime = null
  }

  private resetBasicProgress(channel: RoleChannel): void {
    channel.lastBasicDebugAt = -Infinity
    channel.lastBasicProgressAt = -Infinity
    channel.basicProgressStatus = null
    channel.basicVisual = null
    channel.basicSync = { readings: 0, jumps: 0 }
    channel.basicError = null
    channel.basicLayoutRoi = null
  }

  private reportBasicProgress(role: SourceRole, channel: RoleChannel, message: ResultMessage): void {
    if (!message.basic || !this.options.onBasicProgress) return
    const receivedAt = this.now()
    const roi = message.basic.roi
    const status = `${message.basic.mode}:${message.basic.status}:${roi?.x},${roi?.y},${roi?.w},${roi?.h}`
    const changed = status !== channel.basicProgressStatus
    const due = receivedAt - channel.lastBasicProgressAt >= 500
    const detailed = message.debug !== null || message.basic.preview !== undefined
    if (validBasicImage(message.debug?.binary) || validBasicImage(message.basic.preview)) {
      channel.basicVisual = { diagnostic: message.basic, debug: message.debug, frameIndex: message.frameIndex, receivedAt }
    }
    // Readback time varies: never discard a requested image merely because it completed early.
    if (!changed && !due && !detailed) return
    channel.basicProgressStatus = status
    // Status changes are immediate and do not postpone the regular preview cadence.
    if (due || detailed) channel.lastBasicProgressAt = receivedAt
    this.options.onBasicProgress(role, { diagnostic: message.basic, debug: message.debug,
      frameIndex: message.frameIndex, receivedAt, ...(channel.basicVisual ? { visual: channel.basicVisual } : {}),
      sync: { ...channel.basicSync }, ...(channel.basicError ? { error: channel.basicError } : {}) })
  }

  private basicDiagnostic(profile: Extract<ActiveProfile, { kind: 'basic-clock' }>): BasicClockDiagnostic {
    return { status: 'searching', mode: profile.roi ? profile.roiOrigin === 'memory' ? 'memory' : 'manual' : 'auto',
      ...(profile.roi ? { roi: profile.roi } : {}), ...(profile.searchRoi ? { searchRoi: profile.searchRoi } : {}) }
  }

  private handleWorkerError(role: SourceRole, channel: RoleChannel, message: string): void {
    if (channel.workerFailed || this.disposed) return
    channel.workerFailed = true
    this.cancelPendingResults(channel)
    channel.basicError = message
    channel.basicVisual = null
    this.resetTiming(channel)
    channel.recent = []
    this.options.onError?.(role, message)
    this.sink?.(role, { status: 'failed', reason: 'decode-failed', detail: message })
    const profile = this.options.profile(role)
    if (profile && isBasicClock(profile)) this.options.onBasicProgress?.(role, {
      diagnostic: this.basicDiagnostic(profile), debug: null, frameIndex: 0, receivedAt: this.now(),
      sync: { ...channel.basicSync }, error: message,
    })
  }

  /** Associate image-change timing only with an actual recognised decrement. */
  private atTickMoment(channel: RoleChannel, message: ResultMessage): RecognitionOutcome {
    const moment = message.tickMoment
    if (moment && Number.isFinite(moment.lastUnchanged) && Number.isFinite(moment.firstChanged)
      && Number.isFinite(moment.midpoint) && moment.lastUnchanged < moment.firstChanged
      && moment.midpoint >= moment.lastUnchanged && moment.midpoint <= moment.firstChanged) {
      const wallTime = this.bracketWallTime(channel, moment)
      channel.pendingMoment = wallTime === null ? null : { moment, wallTime }
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
    // confirms its value, while its capture delay must not shift the earlier edge.
    const age = reading.mediaTime - pending.moment.firstChanged
    if (age < -1e-6 || age > 0.5) return outcome
    return {
      status: 'success',
      reading: {
        ...reading,
        mediaTime: pending.moment.midpoint,
        wallTime: pending.wallTime,
      },
    }
  }

  private bracketWallTime(channel: RoleChannel, moment: NonNullable<ResultMessage['tickMoment']>): number | null {
    const before = channel.frameAnchors.find(anchor => Math.abs(anchor.mediaTime - moment.lastUnchanged) < 1e-6)
    const after = channel.frameAnchors.find(anchor => Math.abs(anchor.mediaTime - moment.firstChanged) < 1e-6)
    if (!before || !after) return null
    const mediaGap = after.mediaTime - before.mediaTime
    const wallGap = after.wallTime - before.wallTime
    // A buffer pause between the endpoints leaves a wide, unknown transition.
    // Retain the real reading instead of presenting a precise but false midpoint.
    if (mediaGap <= 0 || mediaGap > 0.5 || !Number.isFinite(wallGap) || wallGap < 0
      || before.playbackRate !== after.playbackRate
      || wallGap > mediaGap * 1000 / before.playbackRate + 250) return null
    const fraction = (moment.midpoint - before.mediaTime) / mediaGap
    return before.wallTime + wallGap * fraction
  }

  /** A sufficient frame can close the window immediately; the timer is only a ceiling. */
  private waitForWindow(windowMs: number, signal: SampleSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const deadline = this.now() + windowMs
      let timer: ReturnType<typeof setTimeout> | null = null
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        if (timer !== null) clearTimeout(timer)
        this.checkWindow = null
        resolve()
      }
      const tick = (): void => {
        if (finished) return
        if (timer !== null) clearTimeout(timer)
        if (signal.aborted || this.disposed || signal.completed === true) {
          finish()
          return
        }
        const remaining = deadline - this.now()
        if (remaining <= 0) {
          finish()
          return
        }
        timer = setTimeout(tick, Math.min(50, remaining))
      }
      this.checkWindow = tick
      tick()
    })
  }
}
