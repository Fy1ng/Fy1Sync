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
import type { RecognitionOutcome, SourceRole } from '../core/types'
import { SOURCE_ROLES } from '../core/types'
import { RecognitionClient, type WorkerLike } from './client'
import { FrameGrabber, startFrameLoop } from './frameGrabber'

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
  private disposed = false

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
        const stop = this.startRole(role, signal)
        if (stop) stops.push(stop)
      }
      if (stops.length === 0) return
      await this.waitForWindow(windowMs, signal)
    } finally {
      for (const stop of stops) stop()
      this.sink = null
      this.sampling = false
      // A frame still in flight would otherwise land during the next window and be
      // counted as one of its readings.
      for (const channel of this.channels.values()) {
        channel.client.cancel()
        channel.configuredFor = null
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.sink = null
    for (const channel of this.channels.values()) {
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

    return this.frameLoop(video, fps, (mediaTime) => {
      if (signal.aborted || this.disposed) return
      const active = this.options.profile(role)
      if (!active) return
      if (channel.configuredFor !== active) {
        channel.client.configure(active)
        channel.configuredFor = active
      }
      this.stats.grabbed[role] += 1
      const result = channel.grabber.grab(video, active.roi, mediaTime)
      if (!result.ok) {
        this.stats.grabFailures[role] += 1
        this.sink?.(role, { status: 'failed', reason: result.reason, detail: result.detail })
        return
      }
      if (channel.client.submit(role, result.frame)) {
        this.stats.submitted[role] += 1
      } else {
        // Backpressure, not an error: the worker is still busy with the previous frame.
        this.stats.dropped[role] += 1
      }
    })
  }

  private channelFor(role: SourceRole): RoleChannel {
    const existing = this.channels.get(role)
    if (existing) return existing
    const channel: RoleChannel = {
      grabber: new FrameGrabber(this.clock),
      configuredFor: null,
      client: new RecognitionClient({
        createWorker: this.options.createWorker,
        now: this.now,
        onError: (message) => this.options.onError?.(role, message),
        onResult: (message) => {
          this.sink?.(role, message.outcome)
        },
      }),
    }
    this.channels.set(role, channel)
    return channel
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
