/**
 * Sampler tests.
 *
 * The worker and the video element are both faked. What is being checked is the wiring:
 * that each role is isolated, that frames stop when the window closes, that a grab failure
 * is reported rather than swallowed, and that cancellation is prompt.
 */

import { describe, expect, it, vi } from 'vitest'
import { createEmptyProfile, type RecognitionProfile } from '../core/profileSchema'
import { createEmptyHudStylePack } from '../core/hudStylePack'
import { BASIC_CLOCK_PROFILE, type ActiveProfile } from '../core/activeProfile'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import type { WorkerLike } from './client'
import { FrameGrabber, type AsyncGrabResult, type FramePresentationTiming } from './frameGrabber'
import type { BasicClockProgress, ResultMessage, WorkerRequest, WorkerResponse } from './protocol'
import { RecognitionSampler } from './sampler'
import type { HudFrameResult } from '../core/hudWasm'
import { ClockJumpDetector } from '../core/clockJump'

function profileFor(overrides: Partial<RecognitionProfile> = {}): RecognitionProfile {
  return { ...createEmptyProfile('cs2/iem', 'IEM'), sampleFps: 30, ...overrides }
}

/**
 * A worker that answers every frame with a fixed reading, on a microtask rather than
 * synchronously — a real worker's reply always arrives in a later task, and code that
 * accidentally depends on a synchronous answer must fail here.
 */
function fakeWorker(
  /** null leaves the frame unanswered, like a worker that never replies. */
  reply: (frame: Extract<WorkerRequest, { type: 'frame' }>) => RecognitionOutcome | null,
  metadata?: (frame: Extract<WorkerRequest, { type: 'frame' }>) => Partial<ResultMessage>,
) {
  const listeners = new Set<(event: MessageEvent<WorkerResponse>) => void>()
  const sent: WorkerRequest[] = []
  let generation = 0
  let terminated = false

  const emit = (message: WorkerResponse) => {
    for (const listener of listeners) listener({ data: message } as MessageEvent<WorkerResponse>)
  }

  const worker: WorkerLike = {
    postMessage(message) {
      if (terminated) return
      sent.push(message)
      if (message.type === 'configure') {
        generation = message.generation
        queueMicrotask(() =>
          emit({ type: 'configured', generation, ready: true, missing: [], sampleCount: 10 }),
        )
        return
      }
      if (message.type === 'cancel') {
        generation = message.generation
        return
      }
      if (message.type !== 'frame') return
      const frame = message
      const outcome = reply(frame)
      if (outcome === null) return
      queueMicrotask(() =>
        emit({
          type: 'result',
          generation: frame.generation,
          role: frame.role,
          frameIndex: frame.frameIndex,
          outcome,
          debug: null,
          elapsedMs: 1,
          ...metadata?.(frame),
        }),
      )
    },
    terminate() {
      terminated = true
      listeners.clear()
    },
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener as (event: MessageEvent<WorkerResponse>) => void)
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener as (event: MessageEvent<WorkerResponse>) => void)
    },
  }

  return {
    worker,
    sent,
    get terminated() {
      return terminated
    },
    frames: () => sent.filter((message): message is Extract<WorkerRequest, { type: 'frame' }> => message.type === 'frame'),
    configures: () => sent.filter((message) => message.type === 'configure'),
  }
}

const success = (seconds: number, mediaTime: number, wallTime: number): RecognitionOutcome => ({
  status: 'success',
  reading: {
    text: `0:${String(seconds).padStart(2, '0')}`,
    seconds,
    confidence: 0.95,
    scores: [0.95, 0.95, 0.95],
    mediaTime,
    wallTime,
    frameIndex: 0,
  },
})

/** A video element with just enough surface for FrameGrabber and startFrameLoop. */
function fakeVideo(): HTMLVideoElement {
  return { videoWidth: 640, videoHeight: 360, readyState: 4, currentTime: 12 } as HTMLVideoElement
}

/** A frame loop driven by hand, so a test decides exactly how many frames exist. */
function manualLoop() {
  const roles: Array<{ video: HTMLVideoElement; onFrame: (mediaTime: number, timing?: FramePresentationTiming) => void; stopped: boolean }> = []
  const frameLoop = (
    video: HTMLVideoElement,
    _fps: number,
    onFrame: (mediaTime: number, timing?: FramePresentationTiming) => void,
  ): (() => void) => {
    const entry = { video, onFrame, stopped: false }
    roles.push(entry)
    return () => {
      entry.stopped = true
    }
  }
  return {
    frameLoop: frameLoop as never,
    roles,
    /** Deliver one frame to every live loop, then let the worker replies land. */
    async tick(mediaTime: number, timing?: FramePresentationTiming) {
      for (const entry of roles) {
        if (!entry.stopped) entry.onFrame(mediaTime, timing)
      }
      for (let i = 0; i < 8; i++) await Promise.resolve()
    },
  }
}

/**
 * A `grab` that returns fixed pixels. jsdom has no canvas implementation, so the real
 * grabber cannot run here; the prototype is patched because the sampler builds its own
 * `FrameGrabber` instances internally.
 */
function stubGrabber(capture?: FrameGrabber['grabAsync']): () => void {
  const original = FrameGrabber.prototype.grab
  const originalAsync = FrameGrabber.prototype.grabAsync
  const originalScaledAsync = FrameGrabber.prototype.grabScaledAsync
  FrameGrabber.prototype.grab = function grab(video, _roi, mediaTime) {
    if (video.readyState < 2) {
      return { ok: false, reason: 'no-video-frame', detail: '视频尚未解码出画面' }
    }
    return {
      ok: true,
      frame: {
        pixels: new Uint8ClampedArray(4 * 8 * 8),
        width: 8,
        height: 8,
        mediaTime: mediaTime ?? video.currentTime,
        wallTime: 1000,
      },
    }
  }
  FrameGrabber.prototype.grabAsync = capture ?? async function grabAsync(this: FrameGrabber, video, roi, mediaTime) {
    return this.grab(video, roi, mediaTime)
  }
  FrameGrabber.prototype.grabScaledAsync = function grabScaledAsync(video, roi, _maxWidth, mediaTime) {
    return this.grabAsync(video, roi, mediaTime)
  }
  return () => {
    FrameGrabber.prototype.grab = original
    FrameGrabber.prototype.grabAsync = originalAsync
    FrameGrabber.prototype.grabScaledAsync = originalScaledAsync
  }
}

interface Harness {
  sampler: RecognitionSampler
  outcomes: Array<{ role: SourceRole; outcome: RecognitionOutcome }>
  loop: ReturnType<typeof manualLoop>
  workers: Array<ReturnType<typeof fakeWorker>>
  restore: () => void
}

function harness(options: {
  profile?: (role: SourceRole) => ActiveProfile | null
  video?: (role: SourceRole) => HTMLVideoElement | null
  reply?: (frame: Extract<WorkerRequest, { type: 'frame' }>) => RecognitionOutcome | null
  metadata?: (frame: Extract<WorkerRequest, { type: 'frame' }>) => Partial<ResultMessage>
  capture?: FrameGrabber['grabAsync']
  wantBasicDebug?: () => boolean
  onBasicProgress?: (role: SourceRole, progress: BasicClockProgress) => void
} = {}): Harness {
  const restore = stubGrabber(options.capture)
  const loop = manualLoop()
  const workers: Array<ReturnType<typeof fakeWorker>> = []
  const shared = profileFor()
  const videos = { official: fakeVideo(), commentary: fakeVideo() }
  const outcomes: Array<{ role: SourceRole; outcome: RecognitionOutcome }> = []

  const sampler = new RecognitionSampler({
    createWorker: () => {
      const created = fakeWorker(
        options.reply ?? ((frame) => success(30, frame.mediaTime, frame.wallTime)),
        options.metadata,
      )
      workers.push(created)
      return created.worker
    },
    video: options.video ?? (role => videos[role]),
    profile: options.profile ?? (() => shared),
    frameLoop: loop.frameLoop,
    now: () => Date.now(),
    wantBasicDebug: options.wantBasicDebug,
    onBasicProgress: options.onBasicProgress,
  })

  return { sampler, outcomes, loop, workers, restore }
}

describe('RecognitionSampler', () => {
  it('publishes an expanded verified envelope immediately instead of waiting for the preview throttle', async () => {
    vi.useFakeTimers()
    const region = { x: .4, y: .02, w: .2, h: .1 }
    const progress = vi.fn()
    const video = eventfulVideo()
    const bench = harness({ video: role => role === 'official' ? video : null, profile: () => BASIC_CLOCK_PROFILE,
      metadata: frame => ({ basic: { mode: 'auto', status: 'locked', roi: frame.frameIndex === 1 ? region : { ...region, w: .202 } } }),
      onBasicProgress: progress })
    try {
      const run = bench.sampler.sample(200, () => {}, { aborted: false })
      await bench.loop.tick(10)
      await vi.advanceTimersByTimeAsync(70)
      await bench.loop.tick(10.1)
      expect(progress).toHaveBeenCalledTimes(2)
      expect(progress.mock.calls[1]![1].diagnostic.roi.w).toBe(.202)
      await vi.advanceTimersByTimeAsync(130)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('publishes an early rVFC result only at its presentation time without changing its timestamp', async () => {
    vi.useFakeTimers()
    const bench = harness({ profile: () => BASIC_CLOCK_PROFILE,
      reply: frame => success(30, frame.mediaTime, Date.now() + 8) })
    const received: RecognitionOutcome[] = []
    const startedAt = Date.now()
    try {
      const run = bench.sampler.sample(6000, (_role, outcome) => received.push(outcome), {
        aborted: false, get completed() { return received.length === 2 },
      })
      await bench.loop.tick(10)
      expect(received).toEqual([])
      await vi.advanceTimersByTimeAsync(7)
      expect(received).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await run
      expect(received).toHaveLength(2)
      expect(Date.now() - startedAt).toBe(8)
      for (const outcome of received) expect(outcome).toMatchObject({ status: 'success', reading: { wallTime: startedAt + 8 } })
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it.each(['seek', 'cancel', 'source'] as const)('drops a presentation-delayed result across %s', async kind => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    const bench = harness({ video: role => role === 'official' ? video : null, profile: () => BASIC_CLOCK_PROFILE,
      reply: frame => success(30, frame.mediaTime, Date.now() + 8) })
    const received: RecognitionOutcome[] = []
    const signal = { aborted: false }
    try {
      const run = bench.sampler.sample(100, (_role, outcome) => received.push(outcome), signal)
      await bench.loop.tick(10)
      if (kind === 'seek') video.dispatchEvent(new Event('seeking'))
      if (kind === 'source') video.src = 'new-source.mp4'
      if (kind === 'cancel') signal.aborted = true
      await vi.advanceTimersByTimeAsync(100)
      await run
      expect(received).toEqual([])
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('pre-recognizes one moving source without a sync request and promotes its exact layout without dropping the cache', async () => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    const roi = { x: .4, y: .02, w: .2, h: .1 }
    let active: ActiveProfile = BASIC_CLOCK_PROFILE
    const progress: BasicClockProgress[] = []
    const bench = harness({ video: role => role === 'official' ? video : null, profile: () => active,
      metadata: () => ({ basic: { mode: 'auto', status: 'locked', roi, text: '0:30' } }),
      onBasicProgress: (_role, value) => { progress.push(value); active = { ...BASIC_CLOCK_PROFILE, roi, roiOrigin: 'memory' } } })
    try {
      bench.sampler.setBackgroundRoles(['official'])
      await bench.loop.tick(10)
      expect(bench.workers).toHaveLength(0)
      await bench.loop.tick(10.1)
      expect(bench.workers).toHaveLength(1)
      expect(progress[0]?.diagnostic.status).toBe('locked')
      await bench.loop.tick(10.2)
      expect(bench.workers[0]!.configures()).toHaveLength(2)
      expect(bench.workers[0]!.configures()[1]).toMatchObject({ preserveBasic: true, profile: { roiOrigin: 'memory', roi } })
      expect(bench.workers[0]!.frames().every(frame => frame.role === 'official')).toBe(true)
      bench.sampler.setBackgroundRoles([])
      const submitted = bench.workers[0]!.frames().length
      await bench.loop.tick(10.3)
      expect(bench.workers[0]!.frames()).toHaveLength(submitted)
      expect(bench.workers[0]!.terminated).toBe(false)
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('reuses recent background readings only on request and immediately ends on sufficient evidence', async () => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    const bench = harness({ video: role => role === 'official' ? video : null, profile: () => BASIC_CLOCK_PROFILE,
      reply: frame => success(50 - Math.floor(frame.mediaTime), frame.mediaTime, Date.now()) })
    try {
      bench.sampler.setBackgroundRoles(['official'])
      for (let index = 0; index <= 30; index++) {
        await bench.loop.tick(10 + index / 10)
        await vi.advanceTimersByTimeAsync(100)
      }
      bench.sampler.setBackgroundRoles(['official'], true)
      const readings: RecognitionOutcome[] = []
      const before = Date.now()
      await bench.sampler.sample(6000, (_role, outcome) => readings.push(outcome), {
        aborted: false, get completed() { return readings.length >= 3 },
      }, true)
      expect(readings.length).toBeGreaterThan(10)
      expect(Date.now()).toBe(before)
      expect(bench.workers[0]!.configures()).toHaveLength(1)

      const fresh: RecognitionOutcome[] = []
      const verify = bench.sampler.sample(4000, (_role, outcome) => fresh.push(outcome), {
        aborted: false, get completed() { return fresh.length >= 1 },
      })
      expect(fresh).toEqual([])
      await bench.loop.tick(13.2)
      await verify
      expect(fresh).toHaveLength(1)
      expect(Date.now()).toBe(before)
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('discards pre-seek background evidence while retaining the verified layout for fresh frames', async () => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    const bench = harness({ video: role => role === 'official' ? video : null, profile: () => BASIC_CLOCK_PROFILE })
    try {
      bench.sampler.setBackgroundRoles(['official'])
      await bench.loop.tick(10)
      await bench.loop.tick(10.1)
      video.dispatchEvent(new Event('seeking'))
      bench.sampler.setBackgroundRoles(['official'], true)
      const readings: RecognitionOutcome[] = []
      const run = bench.sampler.sample(100, (_role, outcome) => readings.push(outcome), { aborted: false }, true)
      expect(readings).toEqual([])
      await bench.loop.tick(8)
      await vi.advanceTimersByTimeAsync(100)
      await run
      expect(readings).toHaveLength(1)
      expect(bench.workers[0]!.configures()).toHaveLength(1)
      expect(bench.workers[0]!.sent).toContainEqual(expect.objectContaining({ type: 'cancel', preserveBasic: true, resetTiming: true }))
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('resets native timing on both verified sources for a new window even when only the peer sought', async () => {
    vi.useFakeTimers()
    const bench = harness({ profile: () => BASIC_CLOCK_PROFILE,
      metadata: () => ({ basic: { mode: 'auto', status: 'locked', roi: { x: .4, y: .02, w: .2, h: .1 } } }) })
    try {
      const first = bench.sampler.sample(100, () => {}, { aborted: false })
      await bench.loop.tick(10)
      await vi.advanceTimersByTimeAsync(100)
      await first
      const second = bench.sampler.sample(100, () => {}, { aborted: false })
      for (const worker of bench.workers) expect(worker.sent.at(-1)).toMatchObject({ type: 'cancel', preserveBasic: true, resetTiming: true })
      await bench.loop.tick(10.9)
      await vi.advanceTimersByTimeAsync(100)
      await second
      for (const worker of bench.workers) expect(worker.configures()).toHaveLength(1)
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('preserves the complete visual frame when a later state update has no image', async () => {
    vi.useFakeTimers()
    const progress: BasicClockProgress[] = []
    const video = fakeVideo()
    const bench = harness({ profile: () => ({ ...BASIC_CLOCK_PROFILE, roi: { x: .2, y: .1, w: .3, h: .2 } }),
      video: role => role === 'official' ? video : null, wantBasicDebug: () => true,
      onBasicProgress: (_role, value) => progress.push(value),
      metadata: frame => ({ basic: { mode: 'manual', status: frame.frameIndex === 1 ? 'locked' : 'searching',
        text: frame.frameIndex === 1 ? '0:30' : '0:29', mediaTime: frame.mediaTime,
        ...(frame.frameIndex === 1 ? { preview: { width: 1, height: 1, data: Uint8Array.of(100) } } : {}) },
        ...(frame.frameIndex === 1 ? { debug: { binary: { width: 1, height: 1, data: Uint8Array.of(255) },
          roiPixels: { x: 0, y: 0, width: 1, height: 1 }, boxes: [], projection: [], inkRatio: 1, matches: [], normalized: [] } } : {}) }) })
    const signal = { aborted: false }
    try {
      const run = bench.sampler.sample(1000, () => {}, signal)
      await bench.loop.tick(0)
      await vi.advanceTimersByTimeAsync(100)
      await bench.loop.tick(.1)
      expect(progress).toHaveLength(2)
      expect(progress[1]!.diagnostic).toMatchObject({ status: 'searching', text: '0:29', mediaTime: .1 })
      expect(progress[1]!.debug).toBeNull()
      expect(progress[1]!.visual).toBe(progress[0]!.visual)
      expect(progress[1]!.visual).toMatchObject({ frameIndex: 1, diagnostic: { text: '0:30', mediaTime: 0 },
        debug: { binary: { data: Uint8Array.of(255) } } })
      expect(bench.workers[0]!.configures()).toHaveLength(1)
      signal.aborted = true
      await vi.advanceTimersByTimeAsync(50)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it.each(['source', 'dimensions', 'profile'] as const)('clears a saved visual frame after %s invalidation', async kind => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    let active: ActiveProfile = BASIC_CLOCK_PROFILE
    const progress: BasicClockProgress[] = []
    const bench = harness({ profile: () => active, video: role => role === 'official' ? video : null,
      onBasicProgress: (_role, value) => progress.push(value),
      metadata: frame => ({ basic: { mode: 'auto', status: 'searching', mediaTime: frame.mediaTime,
        ...(frame.frameIndex === 1 ? { preview: { width: 1, height: 1, data: Uint8Array.of(100) } } : {}) } }) })
    const signal = { aborted: false }
    try {
      const run = bench.sampler.sample(1000, () => {}, signal)
      await bench.loop.tick(0)
      expect(progress[0]!.visual).toBeDefined()
      if (kind === 'source') video.src = 'replacement.mp4'
      if (kind === 'dimensions') Object.defineProperty(video, 'videoWidth', { value: 1280 })
      if (kind === 'profile') active = { ...BASIC_CLOCK_PROFILE, searchRoi: { x: .1, y: .05, w: .8, h: .2 } }
      await bench.loop.tick(.1)
      expect(progress.at(-1)!.visual).toBeUndefined()
      expect(progress.at(-1)!.diagnostic.mediaTime).toBe(.1)
      signal.aborted = true
      await vi.advanceTimersByTimeAsync(50)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('retains the old visual across a completed window with its own frame time and resets jump counts', async () => {
    vi.useFakeTimers()
    const video = fakeVideo()
    const progress: BasicClockProgress[] = []
    const bench = harness({ profile: () => BASIC_CLOCK_PROFILE, video: role => role === 'official' ? video : null,
      onBasicProgress: (_role, value) => progress.push(value),
      metadata: frame => ({ basic: { mode: 'auto', status: 'locked', mediaTime: frame.mediaTime,
        ...(frame.frameIndex === 1 ? { preview: { width: 1, height: 1, data: Uint8Array.of(100) } } : {}) } }) })
    const sample = async (time: number) => {
      const run = bench.sampler.sample(100, () => {}, { aborted: false })
      await bench.loop.tick(time)
      await vi.advanceTimersByTimeAsync(100)
      await run
    }
    try {
      await sample(0)
      await sample(.1)
      expect(progress.at(-1)!.visual).toBe(progress[0]!.visual)
      expect(progress.at(-1)!.visual!.diagnostic.mediaTime).toBe(0)
      expect(progress.at(-1)!.frameIndex).toBe(2)
      expect(progress.at(-1)!.sync).toEqual({ readings: 1, jumps: 0 })
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it.each([false, true])('produces confirmed jumps from a stable manual configuration with debug=%s', async debug => {
    vi.useFakeTimers()
    let enabled = debug
    const detector = new ClockJumpDetector('official')
    const events: number[] = []
    const progress: BasicClockProgress[] = []
    const video = fakeVideo()
    const bench = harness({ profile: () => ({ ...BASIC_CLOCK_PROFILE, roi: { x: .2, y: .1, w: .3, h: .2 } }),
      video: role => role === 'official' ? video : null,
      capture: async (_video, _roi, mediaTime = 0) => ({ ok: true, frame: { width: 8, height: 8,
        pixels: new Uint8ClampedArray(8 * 8 * 4), mediaTime, wallTime: 50_000 + mediaTime * 1000 } }),
      wantBasicDebug: () => enabled, onBasicProgress: (_role, value) => progress.push(value),
      reply: frame => success(30 - Math.floor(frame.mediaTime + 1e-9), frame.mediaTime, frame.wallTime),
      metadata: frame => ({ basic: { status: 'locked', mode: 'manual', text: `0:${30 - Math.floor(frame.mediaTime + 1e-9)}`,
        mediaTime: frame.mediaTime, ...(frame.wantDebug ? { preview: { width: 1, height: 1, data: Uint8Array.of(100) } } : {}) },
        ...(frame.mediaTime > 0 && Math.abs(frame.mediaTime - Math.round(frame.mediaTime)) < 1e-6 ? {
          tickMoment: { lastUnchanged: frame.mediaTime - 1 / 15, firstChanged: frame.mediaTime,
            midpoint: frame.mediaTime - 1 / 30, change: .2, noiseFloor: .01 },
        } : {}) }) })
    const signal = { aborted: false }
    try {
      const run = bench.sampler.sample(7000, (_role, outcome) => {
        const event = detector.push(outcome).event
        if (event) events.push(event.toSeconds)
      }, signal)
      for (let index = 0; index <= 180; index++) {
        if (index === 90) enabled = !enabled
        await bench.loop.tick(index / 30)
        await vi.advanceTimersByTimeAsync(1000 / 30)
      }
      expect(bench.workers[0]!.configures()).toHaveLength(1)
      expect(events.length).toBeGreaterThanOrEqual(5)
      expect(progress.at(-1)!.sync?.jumps).toBeGreaterThanOrEqual(5)
      expect(progress.at(-1)!.sync?.readings).toBeGreaterThan(20)
      const latest = progress.at(-1)!
      expect(latest.sync!.readings).toBeGreaterThanOrEqual(latest.frameIndex - 1)
      const detailed = bench.workers[0]!.frames().filter(frame => frame.wantDebug)
      expect(detailed.length).toBeGreaterThan(0)
      for (let index = 1; index < detailed.length; index++) expect(detailed[index]!.wallTime - detailed[index - 1]!.wallTime).toBeGreaterThanOrEqual(490)
      signal.aborted = true
      await vi.advanceTimersByTimeAsync(50)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('does not count candidate text as successful readings or confirmed jumps', async () => {
    vi.useFakeTimers()
    const progress: BasicClockProgress[] = []
    const bench = harness({ profile: () => BASIC_CLOCK_PROFILE,
      reply: () => ({ status: 'indeterminate', reason: 'basic-clock-confirming' }),
      metadata: frame => ({ basic: { status: 'confirming', mode: 'auto', text: `0:${30 - frame.frameIndex}` } }),
      onBasicProgress: (_role, value) => progress.push(value) })
    try {
      const run = bench.sampler.sample(100, () => {}, { aborted: false })
      await bench.loop.tick(0)
      await vi.advanceTimersByTimeAsync(100)
      await run
      expect(progress[0]!.sync).toEqual({ readings: 0, jumps: 0 })
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('keeps a requested preview whose readback completes sooner than the previous one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const progress: BasicClockProgress[] = []
    const video = fakeVideo()
    const bench = harness({ profile: () => BASIC_CLOCK_PROFILE, video: role => role === 'official' ? video : null,
      wantBasicDebug: () => true, onBasicProgress: (_role, value) => progress.push(value),
      metadata: frame => {
        vi.setSystemTime(frame.frameIndex === 1 ? 100 : 550)
        return { basic: { mode: 'auto', status: 'searching', preview: { width: 1, height: 1, data: Uint8Array.of(frame.frameIndex) } } }
      } })
    const signal = { aborted: false }
    try {
      const run = bench.sampler.sample(2000, () => {}, signal)
      await bench.loop.tick(0)
      vi.setSystemTime(500)
      await bench.loop.tick(.5)
      expect(progress.map(value => value.diagnostic.preview?.data[0])).toEqual([1, 2])
      expect(progress.map(value => value.receivedAt)).toEqual([100, 550])
      signal.aborted = true
      await vi.advanceTimersByTimeAsync(50)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('requests basic preview at two fps only while enabled and publishes status changes immediately', async () => {
    vi.useFakeTimers()
    let enabled = true
    const progress: Array<{ role: SourceRole; value: BasicClockProgress }> = []
    const bench = harness({ profile: () => BASIC_CLOCK_PROFILE, wantBasicDebug: () => enabled,
      onBasicProgress: (role, value) => progress.push({ role, value }),
      metadata: frame => ({ basic: { mode: 'auto',
        status: frame.frameIndex < 3 ? 'searching' : frame.frameIndex === 3 ? 'confirming' : 'locked',
        ...(frame.wantDebug ? { preview: { width: 1, height: 1, data: Uint8Array.of(140) } } : {}) },
        debug: null }) })
    const signal = { aborted: false }
    try {
      const run = bench.sampler.sample(3000, () => {}, signal)
      for (let index = 0; index < 10; index++) {
        await bench.loop.tick(index / 10)
        await vi.advanceTimersByTimeAsync(100)
      }
      enabled = false
      for (let index = 10; index < 15; index++) {
        await bench.loop.tick(index / 10)
        await vi.advanceTimersByTimeAsync(100)
      }
      for (const worker of bench.workers) {
        expect(worker.frames().filter(frame => frame.wantDebug).map(frame => frame.mediaTime)).toEqual([0, .5])
        expect(worker.frames().filter(frame => frame.mediaTime >= 1).every(frame => !frame.wantDebug)).toBe(true)
      }
      const official = progress.filter(entry => entry.role === 'official').map(entry => entry.value)
      expect(official.map(entry => entry.diagnostic.status)).toEqual(['searching', 'confirming', 'locked', 'locked', 'locked'])
      expect(official.filter(entry => entry.diagnostic.preview)).toHaveLength(2)
      expect(official[0]!.frameIndex).toBe(1)
      expect(official[1]!.receivedAt - official[0]!.receivedAt).toBe(200)
      signal.aborted = true
      await vi.advanceTimersByTimeAsync(50)
      await run
      const count = progress.length
      const sent = bench.workers.map(worker => worker.frames().length)
      await bench.loop.tick(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(progress).toHaveLength(count)
      expect(bench.workers.map(worker => worker.frames().length)).toEqual(sent)
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it.each(['seek', 'source', 'dimensions', 'roi', 'origin', 'search'] as const)('does not publish a basic preview received after %s changes', async kind => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    let active: ActiveProfile = { ...BASIC_CLOCK_PROFILE, roi: { x: .2, y: .1, w: .3, h: .2 } }
    const progress = vi.fn()
    let first = true
    const bench = harness({ profile: () => active, video: role => role === 'official' ? video : null,
      wantBasicDebug: () => true, onBasicProgress: progress,
      metadata: () => {
        if (first) {
          first = false
          if (kind === 'seek') video.dispatchEvent(new Event('seeking'))
          if (kind === 'source') video.src = 'replacement.mp4'
          if (kind === 'dimensions') Object.defineProperty(video, 'videoWidth', { value: 1280 })
          if (kind === 'roi') active = { ...BASIC_CLOCK_PROFILE, roi: { x: .3, y: .1, w: .3, h: .2 } }
          if (kind === 'origin') active = { ...BASIC_CLOCK_PROFILE, roi: { x: .2, y: .1, w: .3, h: .2 }, roiOrigin: 'memory' }
          if (kind === 'search') active = { ...BASIC_CLOCK_PROFILE, roi: { x: .2, y: .1, w: .3, h: .2 }, searchRoi: { x: .1, y: .05, w: .8, h: .3 } }
        }
        return { basic: { mode: 'manual', status: 'confirming', preview: { width: 1, height: 1, data: Uint8Array.of(140) } } }
      } })
    try {
      const run = bench.sampler.sample(100, () => {}, { aborted: false })
      await bench.loop.tick(10)
      expect(progress).not.toHaveBeenCalled()
      await bench.loop.tick(10.1)
      expect(progress).toHaveBeenCalledTimes(1)
      expect(bench.workers[0]!.configures()).toHaveLength(kind === 'seek' ? 1 : 2)
      await vi.advanceTimersByTimeAsync(100)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('bounds basic readback to its configured fps even when rVFC supplies 60fps', async () => {
    const bench = harness({ profile: () => BASIC_CLOCK_PROFILE })
    const scaled = vi.spyOn(FrameGrabber.prototype, 'grabScaledAsync')
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(10_000, () => {}, signal)
      for (let index = 0; index < 60; index++) await bench.loop.tick(index / 60)
      for (const worker of bench.workers) expect(worker.frames().length).toBeLessThanOrEqual(15)
      expect(scaled.mock.calls.every(call => call[2] === 1920)).toBe(true)
      signal.aborted = true
      await run
    } finally { scaled.mockRestore(); bench.sampler.dispose(); bench.restore() }
  })
  it.each(['seek', 'source', 'dimensions', 'profile'] as const)('preserves layout only for same-source playback interruptions: %s', async kind => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    let active: ActiveProfile = BASIC_CLOCK_PROFILE
    const bench = harness({ profile: () => active, video: role => role === 'official' ? video : null })
    const sample = async (time: number) => {
      const pending = bench.sampler.sample(100, () => {}, { aborted: false })
      await bench.loop.tick(time)
      await vi.advanceTimersByTimeAsync(100)
      await pending
    }
    try {
      await sample(10)
      if (kind === 'seek') video.dispatchEvent(new Event('seeking'))
      if (kind === 'source') video.src = 'replacement.mp4'
      if (kind === 'dimensions') Object.defineProperty(video, 'videoWidth', { value: 1280 })
      if (kind === 'profile') active = createEmptyHudStylePack('manual/replacement', '手动样式')
      await sample(11)
      const worker = bench.workers[0]!
      expect(worker.configures()).toHaveLength(kind === 'seek' ? 1 : 2)
      if (kind === 'seek') expect(worker.sent).toContainEqual(expect.objectContaining({ type: 'cancel', preserveBasic: true, resetTiming: true }))
      else if (kind !== 'profile') expect(worker.sent.filter(message => message.type === 'cancel'
        && !message.preserveBasic).length).toBeGreaterThan(0)
      else expect(worker.configures()[1]).toMatchObject({ profile: active })
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('retains layout across completed and cancelled windows while cancellation clears timing', async () => {
    const rois: unknown[] = []
    const bench = harness({ profile: () => BASIC_CLOCK_PROFILE,
      capture: async (_video, roi, mediaTime) => {
        rois.push(roi)
        return { ok: true, frame: { pixels: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8,
          mediaTime: mediaTime ?? 0, wallTime: 1000 } }
      } })
    try {
      const first = bench.sampler.sample(20, () => {}, { aborted: false })
      await bench.loop.tick(10)
      await first
      const second = bench.sampler.sample(20, () => {}, { aborted: false })
      await bench.loop.tick(10.5)
      await second
      expect(rois).toEqual(Array(4).fill({ x: 0, y: 0, w: 1, h: 1 }))
      for (const worker of bench.workers) {
        expect(worker.configures()).toHaveLength(1)
        expect(worker.sent.filter(message => message.type === 'cancel')).toMatchObject([
          { preserveBasic: true }, { preserveBasic: true },
        ])
        expect(worker.frames()[1]!.generation).toBeGreaterThan(worker.frames()[0]!.generation)
      }
      const signal = { aborted: false }
      const cancelled = bench.sampler.sample(50, () => {}, signal)
      await bench.loop.tick(11)
      signal.aborted = true
      await cancelled
      for (const worker of bench.workers) expect(worker.sent.at(-1)).toMatchObject({ type: 'cancel' })
      for (const worker of bench.workers) expect(worker.sent.at(-1)).toMatchObject({ preserveBasic: true, resetTiming: true })
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('gives each role its own worker, so neither invalidates the other', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(50, (role, outcome) => bench.outcomes.push({ role, outcome }), signal)
      await bench.loop.tick(10)
      await bench.loop.tick(11)
      await run

      expect(bench.workers).toHaveLength(2)
      // Two frames each, and every frame answered — a shared worker would have dropped
      // half of them to backpressure.
      for (const worker of bench.workers) {
        expect(worker.frames()).toHaveLength(2)
      }
      expect(bench.outcomes.filter((entry) => entry.role === 'official')).toHaveLength(2)
      expect(bench.outcomes.filter((entry) => entry.role === 'commentary')).toHaveLength(2)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('configures once for an unchanged profile', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(50, () => {}, signal)
      await bench.loop.tick(10)
      await bench.loop.tick(11)
      await bench.loop.tick(12)
      await run
      for (const worker of bench.workers) {
        expect(worker.configures()).toHaveLength(1)
      }
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('reconfigures when the profile is swapped mid-window', async () => {
    const restore = stubGrabber()
    const loop = manualLoop()
    const workers: Array<ReturnType<typeof fakeWorker>> = []
    const video = fakeVideo()
    let current = profileFor({ name: 'first' })
    const sampler = new RecognitionSampler({
      createWorker: () => {
        const created = fakeWorker((frame) => success(30, frame.mediaTime, frame.wallTime))
        workers.push(created)
        return created.worker
      },
      video: (role) => (role === 'official' ? video : null),
      profile: (role) => (role === 'official' ? current : null),
      frameLoop: loop.frameLoop as never,
    })
    try {
      const signal = { aborted: false }
      const run = sampler.sample(50, () => {}, signal)
      await loop.tick(10)
      current = profileFor({ name: 'second' })
      await loop.tick(11)
      await run
      expect(workers[0]!.configures()).toHaveLength(2)
    } finally {
      sampler.dispose()
      restore()
    }
  })

  it('samples only the roles that have both a video and a profile', async () => {
    const video = fakeVideo()
    const bench = harness({
      video: (role) => (role === 'commentary' ? video : null),
    })
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(50, (role, outcome) => bench.outcomes.push({ role, outcome }), signal)
      await bench.loop.tick(10)
      await run
      expect(bench.workers).toHaveLength(1)
      expect(bench.outcomes.every((entry) => entry.role === 'commentary')).toBe(true)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('returns immediately when no role can sample', async () => {
    const bench = harness({ profile: () => null })
    try {
      await bench.sampler.sample(10_000, () => {}, { aborted: false })
      expect(bench.workers).toHaveLength(0)
      expect(bench.loop.roles).toHaveLength(0)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('stops the frame loops when the window closes', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(20, () => {}, signal)
      await bench.loop.tick(10)
      await run
      expect(bench.loop.roles.every((entry) => entry.stopped)).toBe(true)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('ignores frames delivered after the window and drops in-flight work', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(20, (role, outcome) => bench.outcomes.push({ role, outcome }), signal)
      await bench.loop.tick(10)
      await run
      const afterWindow = bench.outcomes.length

      // A stopped loop should not fire, but a real rVFC callback can be in flight when
      // cancel lands, so the result must not reach a sink from a finished run.
      for (const entry of bench.loop.roles) entry.onFrame(99)
      await Promise.resolve()
      await Promise.resolve()
      expect(bench.outcomes).toHaveLength(afterWindow)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('reports a grab failure as a structured outcome', async () => {
    const notDecoded = { videoWidth: 0, videoHeight: 0, readyState: 0, currentTime: 0 } as HTMLVideoElement
    const bench = harness({ video: (role) => (role === 'official' ? notDecoded : null) })
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(30, (role, outcome) => bench.outcomes.push({ role, outcome }), signal)
      await bench.loop.tick(10)
      await run
      expect(bench.outcomes).toHaveLength(1)
      expect(bench.outcomes[0]!.outcome).toMatchObject({ status: 'failed', reason: 'no-video-frame' })
      expect(bench.sampler.getStats().grabFailures.official).toBe(1)
      // Nothing was submitted, so the worker must not have been handed a frame.
      expect(bench.workers[0]!.frames()).toHaveLength(0)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('counts grabbed, submitted and dropped frames per role', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(50, () => {}, signal)
      await bench.loop.tick(10)
      await bench.loop.tick(11)
      await run
      const stats = bench.sampler.getStats()
      expect(stats.grabbed).toEqual({ official: 2, commentary: 2 })
      expect(stats.submitted).toEqual({ official: 2, commentary: 2 })
      expect(stats.dropped).toEqual({ official: 0, commentary: 0 })
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('drops a frame rather than queueing it while the worker is busy', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(50, () => {}, signal)
      // Two frames in the same task: the reply for the first cannot have landed yet, so
      // the second has nowhere to go.
      for (const entry of bench.loop.roles) {
        entry.onFrame(10)
        entry.onFrame(11)
      }
      await Promise.resolve()
      await Promise.resolve()
      await run
      const stats = bench.sampler.getStats()
      expect(stats.grabbed.official).toBe(2)
      expect(stats.submitted.official).toBe(1)
      expect(stats.dropped.official).toBe(1)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('carries the frame media time through to the reading', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const run = bench.sampler.sample(50, (role, outcome) => bench.outcomes.push({ role, outcome }), signal)
      await bench.loop.tick(42.5)
      await run
      const reading = bench.outcomes.find((entry) => entry.outcome.status === 'success')
      expect(reading?.outcome).toMatchObject({ status: 'success' })
      if (reading?.outcome.status === 'success') {
        expect(reading.outcome.reading.mediaTime).toBe(42.5)
      }
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('anchors a real decrement at the image-change midpoint even if the changed frame was unreadable', async () => {
    const video = fakeVideo()
    video.playbackRate = 1.05
    const bench = harness({
      video: (role) => role === 'official' ? video : null,
      capture: async (_video, _roi, mediaTime = 0) => captured(mediaTime, 1000 + (mediaTime - 10) * 1000 / 1.05),
      reply: (frame) => frame.mediaTime === 10.06
        ? { status: 'failed', reason: 'low-confidence' }
        : success(frame.mediaTime < 10.06 ? 30 : 29, frame.mediaTime, frame.wallTime),
      metadata: (frame) => frame.mediaTime === 10.06 ? {
        backend: 'wasm',
        tickMoment: { lastUnchanged: 10.03, firstChanged: 10.06, midpoint: 10.045, change: 0.2, noiseFloor: 0.01 },
      } : {},
    })
    try {
      const run = bench.sampler.sample(30, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      for (const time of [10, 10.03, 10.06, 10.09, 10.12]) await bench.loop.tick(time)
      await run
      const changed = bench.outcomes.find((entry) => entry.outcome.status === 'success' && entry.outcome.reading.seconds === 29)?.outcome
      expect(changed?.status).toBe('success')
      if (changed?.status !== 'success') return
      expect(changed.reading.mediaTime).toBeCloseTo(10.045)
      expect(changed.reading.wallTime).toBeCloseTo(1000 + .045 * 1000 / 1.05)
      expect(bench.outcomes.filter((entry) => entry.outcome.status === 'failed')).toHaveLength(1)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('anchors tick wall time to the actual image bracket despite delayed later OCR', async () => {
    const video = fakeVideo()
    video.playbackRate = 1.05
    const bench = harness({
      video: role => role === 'official' ? video : null,
      capture: async (_video, _roi, mediaTime = 0) => captured(mediaTime,
        1000 + (mediaTime - 10) * 1000 / 1.05 + (mediaTime >= 10.09 ? 120 : 0)),
      reply: frame => frame.mediaTime === 10.06 ? { status: 'failed', reason: 'low-confidence' }
        : success(frame.mediaTime < 10.06 ? 30 : 29, frame.mediaTime, frame.wallTime),
      metadata: frame => frame.mediaTime === 10.06 ? {
        tickMoment: { lastUnchanged: 10.03, firstChanged: 10.06, midpoint: 10.045, change: .2, noiseFloor: .01 },
      } : {},
    })
    try {
      const run = bench.sampler.sample(30, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      for (const time of [10, 10.03, 10.06, 10.09]) await bench.loop.tick(time)
      await run
      const changed = bench.outcomes.at(-1)!.outcome
      expect(changed).toMatchObject({ status: 'success', reading: { mediaTime: 10.045 } })
      if (changed.status === 'success') expect(changed.reading.wallTime).toBeCloseTo(1000 + .045 * 1000 / 1.05)
    } finally { bench.sampler.dispose(); bench.restore() }
  })

  it.each(['waiting', 'pause', 'ratechange'] as const)('cancels a pre-%s GPU readback and starts fresh timing', async event => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    let finish!: (result: AsyncGrabResult) => void
    let held = true
    const bench = harness({
      video: role => role === 'official' ? video : null,
      profile: () => BASIC_CLOCK_PROFILE,
      capture: (_video, _roi, mediaTime) => held ? new Promise(resolve => { finish = resolve }) : Promise.resolve(captured(mediaTime)),
    })
    try {
      const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      await bench.loop.tick(10)
      video.dispatchEvent(new Event(event))
      finish(captured(10))
      for (let index = 0; index < 8; index++) await Promise.resolve()
      expect(bench.workers[0]!.frames()).toHaveLength(0)
      expect(bench.outcomes).toHaveLength(0)
      held = false
      await bench.loop.tick(10.1)
      expect(bench.workers[0]!.configures()).toHaveLength(1)
      expect(bench.workers[0]!.sent).toContainEqual(expect.objectContaining({ type: 'cancel', preserveBasic: true, resetTiming: true }))
      expect(bench.workers[0]!.frames()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(100)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('does not assign a precise midpoint across an unreported buffer pause', async () => {
    const video = fakeVideo()
    const bench = harness({
      video: role => role === 'official' ? video : null,
      capture: async (_video, _roi, mediaTime = 0) => captured(mediaTime,
        1000 + (mediaTime - 10) * 1000 + (mediaTime >= 10.06 ? 2000 : 0)),
      reply: frame => frame.mediaTime === 10.06 ? { status: 'failed', reason: 'low-confidence' }
        : success(frame.mediaTime < 10.06 ? 30 : 29, frame.mediaTime, frame.wallTime),
      metadata: frame => frame.mediaTime === 10.06 ? {
        tickMoment: { lastUnchanged: 10.03, firstChanged: 10.06, midpoint: 10.045, change: .2, noiseFloor: .01 },
      } : {},
    })
    try {
      const run = bench.sampler.sample(30, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      for (const time of [10, 10.03, 10.06, 10.09]) await bench.loop.tick(time)
      await run
      expect(bench.outcomes.at(-1)!.outcome).toMatchObject({ status: 'success', reading: { mediaTime: 10.09, wallTime: 3090 } })
    } finally { bench.sampler.dispose(); bench.restore() }
  })

  it('discards a GPU readback across a live timestamp rewind without a seeking event', async () => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    let finish!: (result: AsyncGrabResult) => void
    let held = true
    const bench = harness({
      video: role => role === 'official' ? video : null,
      profile: () => BASIC_CLOCK_PROFILE,
      capture: (_video, _roi, mediaTime) => held ? new Promise(resolve => { finish = resolve }) : Promise.resolve(captured(mediaTime)),
    })
    try {
      const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      await bench.loop.tick(10)
      held = false
      await bench.loop.tick(9.9)
      finish(captured(10))
      for (let index = 0; index < 8; index++) await Promise.resolve()
      expect(bench.workers[0]!.configures()).toHaveLength(1)
      expect(bench.workers[0]!.sent).toContainEqual(expect.objectContaining({ type: 'cancel', preserveBasic: true, resetTiming: true }))
      expect(bench.workers[0]!.frames().map(frame => frame.mediaTime)).toEqual([9.9])
      expect(bench.outcomes).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(100)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('keeps a sparse one-second pixel bracket as an observation rather than a precise tick', async () => {
    const video = fakeVideo()
    const bench = harness({
      video: role => role === 'official' ? video : null,
      capture: async (_video, _roi, mediaTime = 0) => captured(mediaTime, mediaTime * 1000),
      reply: frame => success(frame.mediaTime < 11 ? 30 : 29, frame.mediaTime, frame.wallTime),
      metadata: frame => frame.mediaTime === 11 ? {
        tickMoment: { lastUnchanged: 10, firstChanged: 11, midpoint: 10.5, change: .2, noiseFloor: .01 },
      } : {},
    })
    try {
      const run = bench.sampler.sample(30, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      for (const time of [10, 11]) await bench.loop.tick(time)
      await run
      expect(bench.outcomes.at(-1)!.outcome).toMatchObject({ status: 'success', reading: { mediaTime: 11, wallTime: 11000 } })
    } finally { bench.sampler.dispose(); bench.restore() }
  })

  it('does not invent a decrement or move unchanged readings for image changes', async () => {
    const bench = harness({
      metadata: (frame) => frame.mediaTime === 10.06 ? {
        backend: 'wasm',
        tickMoment: { lastUnchanged: 10.03, firstChanged: 10.06, midpoint: 10.045, change: 0.2, noiseFloor: 0.01 },
      } : {},
    })
    try {
      const run = bench.sampler.sample(30, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      for (const time of [10, 10.03, 10.06, 10.09]) await bench.loop.tick(time)
      await run
      const readings = bench.outcomes.filter((entry) => entry.outcome.status === 'success')
      expect(readings).toHaveLength(8)
      expect(readings.every((entry) => entry.outcome.status === 'success' && entry.outcome.reading.seconds === 30)).toBe(true)
      expect(readings.at(-1)?.outcome).toMatchObject({ reading: { mediaTime: 10.09, wallTime: 1000 } })
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('discards a pending image-change midpoint when the HUD layout changes', async () => {
    const video = fakeVideo()
    const bench = harness({
      video: role => role === 'official' ? video : null,
      reply: frame => frame.mediaTime === 10.06 ? { status: 'failed', reason: 'low-confidence' }
        : success(frame.mediaTime < 10.06 ? 30 : 29, frame.mediaTime, frame.wallTime),
      metadata: frame => ({ hud: { ...replayHud('live'), variantId: frame.mediaTime < 10.09 ? 'top' : 'bottom' },
        ...(frame.mediaTime === 10.06 ? {
          tickMoment: { lastUnchanged: 10.03, firstChanged: 10.06, midpoint: 10.045, change: .2, noiseFloor: .01 },
        } : {}) }),
    })
    try {
      const run = bench.sampler.sample(30, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      for (const time of [10, 10.03, 10.06, 10.09]) await bench.loop.tick(time)
      await run
      expect(bench.outcomes.at(-1)?.outcome).toMatchObject({ status: 'success', reading: { seconds: 29, mediaTime: 10.09, wallTime: 1000 } })
    } finally { bench.sampler.dispose(); bench.restore() }
  })

  it('reduces recognition work between predicted ticks after two confirmed decrements', async () => {
    const bench = harness({
      reply: (frame) => success(30 - Math.floor(frame.mediaTime + 1e-9), frame.mediaTime, frame.wallTime),
    })
    try {
      const run = bench.sampler.sample(50, () => {}, { aborted: false })
      for (let frame = 0; frame <= 93; frame += 1) await bench.loop.tick(frame / 30)
      await run
      const frames = bench.workers[0]!.frames()
      expect(frames.filter((frame) => frame.mediaTime >= 2.2 && frame.mediaTime < 2.85).length).toBeLessThanOrEqual(3)
      // Once the third decrement is confirmed, its window can close early.
      expect(frames.filter((frame) => frame.mediaTime >= 2.85 && frame.mediaTime <= 3.1).length).toBeGreaterThanOrEqual(6)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('ends the window promptly when the signal aborts', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const started = Date.now()
      const run = bench.sampler.sample(10_000, () => {}, signal)
      await bench.loop.tick(10)
      signal.aborted = true
      await run
      expect(Date.now() - started).toBeLessThan(1000)
      expect(bench.loop.roles.every((entry) => entry.stopped)).toBe(true)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('refuses a concurrent window instead of splitting the frame rate', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const first = bench.sampler.sample(30, () => {}, signal)
      await bench.sampler.sample(30, () => {}, signal)
      // The second call returned without registering another pair of loops.
      expect(bench.loop.roles).toHaveLength(2)
      await first
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('reuses the same worker across windows', async () => {
    const bench = harness()
    try {
      const signal = { aborted: false }
      const first = bench.sampler.sample(20, () => {}, signal)
      await bench.loop.tick(10)
      await first
      const second = bench.sampler.sample(20, () => {}, signal)
      await bench.loop.tick(11)
      await second
      // Spinning up a worker per window would cost a module load each time.
      expect(bench.workers).toHaveLength(2)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('surfaces a worker error with the role that produced it', async () => {
    const restore = stubGrabber()
    const loop = manualLoop()
    const errors: Array<{ role: SourceRole; message: string }> = []
    const progress: BasicClockProgress[] = []
    let frames = 0
    let workers = 0
    const listeners = new Set<(event: MessageEvent<WorkerResponse>) => void>()
    const video = fakeVideo()
    const sampler = new RecognitionSampler({
      createWorker: () => { workers += 1; return {
        postMessage(message) {
          if (message.type === 'frame') {
            frames += 1
            queueMicrotask(() => {
              for (const listener of listeners) {
                listener({
                  data: { type: 'error', generation: message.generation, message: '模板缺失' },
                } as MessageEvent<WorkerResponse>)
              }
            })
          }
        },
        terminate() {},
        addEventListener(type, listener) {
          if (type === 'message') listeners.add(listener as (event: MessageEvent<WorkerResponse>) => void)
        },
        removeEventListener(type, listener) {
          if (type === 'message') listeners.delete(listener as (event: MessageEvent<WorkerResponse>) => void)
        },
      } },
      video: (role) => (role === 'official' ? video : null),
      profile: (role) => (role === 'official' ? BASIC_CLOCK_PROFILE : null),
      frameLoop: loop.frameLoop as never,
      onError: (role, message) => errors.push({ role, message }),
      onBasicProgress: (_role, value) => progress.push(value),
    })
    try {
      const run = sampler.sample(30, () => {}, { aborted: false })
      await loop.tick(10)
      await loop.tick(10.1)
      await loop.tick(10.2)
      await run
      expect(errors).toEqual([{ role: 'official', message: '模板缺失' }])
      expect(frames).toBe(1)
      expect(progress.at(-1)).toMatchObject({ error: '模板缺失', debug: null, sync: { readings: 0, jumps: 0 } })
      expect(progress.at(-1)!.visual).toBeUndefined()
      const retry = sampler.sample(30, () => {}, { aborted: false })
      await loop.tick(11)
      await retry
      expect(workers).toBe(2)
      expect(frames).toBe(2)
      expect(errors).toHaveLength(2)
    } finally {
      sampler.dispose()
      restore()
    }
  })

  it('passes a style pack to the recognizer when its reference size differs from the video', async () => {
    const restore = stubGrabber()
    const loop = manualLoop()
    const errors: Array<{ role: SourceRole; message: string }> = []
    const posted: WorkerRequest['type'][] = []
    const video = fakeVideo()
    const sampler = new RecognitionSampler({
      createWorker: () => ({
        postMessage(message) { posted.push(message.type) },
        terminate() {},
        addEventListener() {},
        removeEventListener() {},
      }),
      video: (role) => (role === 'official' ? video : null),
      profile: (role) => (role === 'official' ? createEmptyHudStylePack('custom/hd', 'HD', { width: 1920, height: 1080 }) : null),
      frameLoop: loop.frameLoop as never,
      onError: (role, message) => errors.push({ role, message }),
    })
    try {
      const run = sampler.sample(30, () => {}, { aborted: false })
      await loop.tick(3)
      await run
      expect(errors).toEqual([])
      expect(posted).toContain('configure')
      expect(posted).toContain('frame')
    } finally {
      sampler.dispose()
      restore()
    }
  })

  it('terminates every worker on dispose', async () => {
    const bench = harness()
    const signal = { aborted: false }
    const run = bench.sampler.sample(20, () => {}, signal)
    await bench.loop.tick(10)
    await run
    bench.sampler.dispose()
    try {
      expect(bench.workers).toHaveLength(2)
      expect(bench.workers.every((worker) => worker.terminated)).toBe(true)
    } finally {
      bench.restore()
    }
  })

  it('does nothing after dispose', async () => {
    const bench = harness()
    bench.sampler.dispose()
    try {
      await bench.sampler.sample(10_000, () => {}, { aborted: false })
      expect(bench.loop.roles).toHaveLength(0)
    } finally {
      bench.restore()
    }
  })

  it('clamps an absurd sampleFps into a sane frame loop rate', async () => {
    const rates: number[] = []
    const restore = stubGrabber()
    const sampler = new RecognitionSampler({
      createWorker: () => fakeWorker((frame) => success(30, frame.mediaTime, frame.wallTime)).worker,
      video: (role) => (role === 'official' ? fakeVideo() : null),
      profile: (role) => (role === 'official' ? profileFor({ sampleFps: 5000 }) : null),
      frameLoop: ((_video: HTMLVideoElement, fps: number) => {
        rates.push(fps)
        return () => {}
      }) as never,
    })
    try {
      await sampler.sample(1, () => {}, { aborted: false })
      expect(rates).toEqual([60])
    } finally {
      sampler.dispose()
      restore()
    }
  })
})

describe('RecognitionSampler as AutoSyncDeps.sample', () => {
  it('has the shape the controller expects', () => {
    const bench = harness()
    try {
      const sample: (
        windowMs: number,
        onOutcome: (role: SourceRole, outcome: RecognitionOutcome) => void,
        signal: { aborted: boolean },
      ) => Promise<void> = bench.sampler.sample.bind(bench.sampler)
      expect(typeof sample).toBe('function')
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
  })

  it('feeds a full countdown window the controller can estimate from', async () => {
    // Both sources show the same countdown, commentary running 2 s behind: the reading
    // stream a real run would see.
    const restore = stubGrabber()
    const loop = manualLoop()
    const shared = profileFor()
    const videos = { official: fakeVideo(), commentary: fakeVideo() }
    const sampler = new RecognitionSampler({
      createWorker: () =>
        fakeWorker((frame) => {
          const offset = frame.role === 'commentary' ? 2 : 0
          const seconds = Math.max(0, 30 - Math.floor(frame.mediaTime - offset))
          return success(seconds, frame.mediaTime, frame.wallTime)
        }).worker,
      video: role => videos[role],
      profile: () => shared,
      frameLoop: loop.frameLoop as never,
    })
    const outcomes: Array<{ role: SourceRole; outcome: RecognitionOutcome }> = []
    try {
      const run = sampler.sample(200, (role, outcome) => outcomes.push({ role, outcome }), {
        aborted: false,
      })
      for (let frame = 0; frame < 6; frame += 1) {
        await loop.tick(frame * 0.5)
      }
      await run

      const official = outcomes.filter((entry) => entry.role === 'official')
      const commentary = outcomes.filter((entry) => entry.role === 'commentary')
      expect(official.length).toBeGreaterThanOrEqual(5)
      expect(commentary.length).toBeGreaterThanOrEqual(5)
      // The two roles disagree by the injected delay, which is what the estimator reads.
      const lastOfficial = official.at(-1)!.outcome
      const lastCommentary = commentary.at(-1)!.outcome
      expect(lastOfficial.status).toBe('success')
      expect(lastCommentary.status).toBe('success')
      if (lastOfficial.status === 'success' && lastCommentary.status === 'success') {
        expect(lastCommentary.reading.seconds).toBeGreaterThan(lastOfficial.reading.seconds)
      }
    } finally {
      sampler.dispose()
      restore()
    }
  })
})

/** A real event target catches seeks that finish before the readback promise settles. */
function eventfulVideo(): HTMLVideoElement {
  const video = document.createElement('video')
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 640 }, videoHeight: { configurable: true, value: 360 },
    readyState: { value: 4 }, paused: { value: false }, seeking: { value: false },
    currentTime: { writable: true, value: 10 },
  })
  return video
}

function captured(mediaTime = 10, wallTime = 1000): AsyncGrabResult {
  return { ok: true, frame: { pixels: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8,
    mediaTime, wallTime } }
}

function replayHud(content: HudFrameResult['content'], round = 17): HudFrameResult {
  const read = (value: number) => ({ status: 'read' as const,
    reading: { value, text: String(value), confidence: 1, scores: [1], source: 'derived' as const }, debug: null })
  return { variantId: 'test', selectionReason: null, content, phase: 'active', fields: {
    clock: read(30), scoreLeft: read(8), scoreRight: read(8), round: read(round),
  }, cues: {}, states: {}, organizer: { status: 'not-matched', score: 0, debug: null } }
}

describe('HUD replay session wiring', () => {
  it('retains replay across sampling windows and layout changes, releasing it after the round changes', async () => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    const bench = harness({ video: role => role === 'official' ? video : null,
      metadata: frame => ({ hud: { ...replayHud(frame.mediaTime === 10 ? 'replay' : 'live', frame.mediaTime === 13 ? 18 : 17),
        variantId: frame.mediaTime < 12 ? 'top' : 'bottom' } }) })
    const sample = async (time: number) => {
      const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      await bench.loop.tick(time)
      await vi.advanceTimersByTimeAsync(100)
      await run
    }
    try {
      await sample(10)
      await sample(11)
      await sample(12)
      await sample(13)
      expect(bench.outcomes.map(entry => entry.outcome.status)).toEqual(['indeterminate', 'indeterminate', 'indeterminate', 'success'])
      expect(bench.outcomes[1]!.outcome).toEqual({ status: 'indeterminate', reason: 'hud-replay' })
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it.each(['seek', 'source', 'stream', 'dimensions', 'video'] as const)(
    'returns to cold start after %s changes between windows', async kind => {
      vi.useFakeTimers()
      let video = eventfulVideo()
      const bench = harness({ video: role => role === 'official' ? video : null,
        metadata: frame => ({ hud: replayHud(frame.mediaTime === 10 ? 'replay' : 'live') }) })
      const sample = async (time: number) => {
        const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
        await bench.loop.tick(time)
        await vi.advanceTimersByTimeAsync(100)
        await run
      }
      try {
        await sample(10)
        if (kind === 'seek') video.dispatchEvent(new Event('seeking'))
        if (kind === 'source') video.src = 'replacement.mp4'
        if (kind === 'stream') video.srcObject = {} as MediaStream
        if (kind === 'dimensions') Object.defineProperty(video, 'videoWidth', { value: 1280 })
        if (kind === 'video') video = eventfulVideo()
        await sample(11)
        expect(bench.outcomes.map(entry => entry.outcome.status)).toEqual(['indeterminate', 'success'])
      } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
    },
  )

  it.each(['seek', 'source', 'dimensions'] as const)('drops a replay worker reply after %s changes', async kind => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    let first = true
    const bench = harness({ video: role => role === 'official' ? video : null,
      metadata: () => {
        if (!first) return { hud: replayHud('live') }
        first = false
        if (kind === 'seek') video.dispatchEvent(new Event('seeking'))
        if (kind === 'source') video.src = 'replacement.mp4'
        if (kind === 'dimensions') Object.defineProperty(video, 'videoWidth', { value: 1280 })
        return { hud: replayHud('replay') }
      } })
    try {
      const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      await bench.loop.tick(10)
      expect(bench.outcomes).toEqual([])
      await bench.loop.tick(11)
      expect(bench.outcomes).toEqual([{ role: 'official', outcome: expect.objectContaining({ status: 'success' }) }])
      await vi.advanceTimersByTimeAsync(100)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })
})

describe('asynchronous sampling acquisition', () => {
  it('drops a readback still in flight when its measurement window closes', async () => {
    vi.useFakeTimers()
    let finish!: (result: AsyncGrabResult) => void
    const video = eventfulVideo()
    const bench = harness({ video: role => role === 'official' ? video : null,
      capture: () => new Promise(resolve => { finish = resolve }) })
    try {
      const first = bench.sampler.sample(100, () => {}, { aborted: false })
      await bench.loop.tick(10)
      await vi.advanceTimersByTimeAsync(100)
      await first
      // The first window's frame answers only after the next window has opened.
      const next = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      finish(captured(10))
      for (let i = 0; i < 8; i++) await Promise.resolve()
      expect(bench.workers[0]!.frames()).toHaveLength(0)
      expect(bench.outcomes).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(100)
      await next
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('counts a busy readback as a dropped frame while the other role continues', async () => {
    vi.useFakeTimers()
    const official = eventfulVideo()
    const commentary = eventfulVideo()
    let finish!: (result: AsyncGrabResult) => void
    let pending = false
    let officialRequests = 0
    const bench = harness({
      video: role => role === 'official' ? official : commentary,
      capture: (video, _roi, mediaTime) => {
        if (video === commentary) return Promise.resolve(captured(mediaTime))
        officialRequests++
        if (pending) return Promise.resolve({ ok: false, skipped: true, reason: 'backpressure' })
        pending = true
        return new Promise(resolve => { finish = resolve })
      },
    })
    try {
      const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      await bench.loop.tick(10)
      await bench.loop.tick(11)
      expect(bench.outcomes.filter(entry => entry.role === 'commentary')).toHaveLength(2)
      expect(bench.outcomes.filter(entry => entry.role === 'official')).toHaveLength(0)
      expect(bench.sampler.getStats().dropped.official).toBe(1)
      expect(bench.sampler.getStats().grabFailures.official).toBe(0)
      expect(officialRequests).toBeLessThanOrEqual(2)
      finish(captured(10))
      for (let i = 0; i < 8; i++) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(100)
      await run
      expect(bench.workers[0]!.frames()).toHaveLength(1)
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it.each(['seek', 'source', 'dimensions', 'profile', 'window', 'abort'] as const)(
    'discards late successful and failed readbacks after %s invalidates the sample', async kind => {
      vi.useFakeTimers()
      try {
        for (const result of [captured(), { ok: false, reason: 'canvas-tainted', detail: '迟到错误' } as const]) {
          const video = eventfulVideo()
          let current = profileFor()
          let finish!: (result: AsyncGrabResult) => void
          const signal = { aborted: false }
          const bench = harness({ video: role => role === 'official' ? video : null,
            profile: () => current, capture: () => new Promise(resolve => { finish = resolve }) })
          try {
            const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), signal)
            await bench.loop.tick(10)
            if (kind === 'seek') video.dispatchEvent(new Event('seeking'))
            if (kind === 'source') video.src = 'replacement.mp4'
            if (kind === 'dimensions') Object.defineProperty(video, 'videoWidth', { value: 1280 })
            if (kind === 'profile') current = profileFor({ name: 'replacement' })
            if (kind === 'abort') signal.aborted = true
            if (kind === 'window') await vi.advanceTimersByTimeAsync(100)
            finish(result)
            for (let i = 0; i < 8; i++) await Promise.resolve()
            expect(bench.workers[0]!.frames()).toHaveLength(0)
            expect(bench.outcomes).toHaveLength(0)
            expect(bench.sampler.getStats().grabFailures.official).toBe(0)
            await vi.advanceTimersByTimeAsync(100)
            await run
          } finally { bench.sampler.dispose(); bench.restore() }
        }
      } finally { vi.useRealTimers() }
    },
  )

  it('does not attribute an old readback to a new sampling window', async () => {
    vi.useFakeTimers()
    let finish!: (result: AsyncGrabResult) => void
    const video = fakeVideo()
    const bench = harness({ video: role => role === 'official' ? video : null,
      capture: () => new Promise(resolve => { finish = resolve }) })
    try {
      const first = bench.sampler.sample(100, () => {}, { aborted: false })
      await bench.loop.tick(10)
      await vi.advanceTimersByTimeAsync(100)
      await first
      const fresh = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      finish(captured(10))
      for (let i = 0; i < 8; i++) await Promise.resolve()
      expect(bench.workers[0]!.frames()).toHaveLength(0)
      expect(bench.outcomes).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(100)
      await fresh
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('preserves the rVFC presentation clock through delayed GPU readback', async () => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    const sampledAt = Date.now()
    let finish!: (result: AsyncGrabResult) => void
    const bench = harness({ video: role => role === 'official' ? video : null,
      capture: () => new Promise(resolve => { finish = resolve }) })
    try {
      const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      await bench.loop.tick(42.5, { callbackTime: 500, expectedDisplayTime: 480 })
      await vi.advanceTimersByTimeAsync(25)
      finish(captured(42.5, sampledAt))
      for (let index = 0; index < 8; index++) await Promise.resolve()
      expect(bench.workers[0]!.frames()[0]).toMatchObject({ mediaTime: 42.5, wallTime: sampledAt - 20 })
      expect(bench.outcomes[0]?.outcome).toMatchObject({ status: 'success', reading: { mediaTime: 42.5, wallTime: sampledAt - 20 } })
      await vi.advanceTimersByTimeAsync(75)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('submits the triggering frame timestamp and sample wall clock after a delayed readback', async () => {
    vi.useFakeTimers()
    const video = eventfulVideo()
    let sampledTime: number | undefined
    let finish!: (result: AsyncGrabResult) => void
    const bench = harness({ video: role => role === 'official' ? video : null,
      capture: (_video, _roi, mediaTime) => { sampledTime = mediaTime; return new Promise(resolve => { finish = resolve }) } })
    try {
      const run = bench.sampler.sample(100, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      await bench.loop.tick(42.5)
      video.currentTime = 999
      await vi.advanceTimersByTimeAsync(25)
      finish(captured(sampledTime, 1234))
      for (let i = 0; i < 8; i++) await Promise.resolve()
      expect(bench.workers[0]!.frames()[0]).toMatchObject({ mediaTime: 42.5, wallTime: 1234 })
      expect(bench.outcomes[0]?.outcome).toMatchObject({ status: 'success', reading: { mediaTime: 42.5, wallTime: 1234 } })
      await vi.advanceTimersByTimeAsync(75)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })

  it('resumes sampling after the worker leaves a frame unanswered', async () => {
    vi.useFakeTimers()
    // The first frame goes unanswered; every later one is answered as usual.
    let answered = false
    const video = fakeVideo()
    const bench = harness({ video: role => role === 'official' ? video : null,
      reply: frame => { if (!answered) { answered = true; return null } return success(30, frame.mediaTime, frame.wallTime) } })
    try {
      const run = bench.sampler.sample(10_000, (role, outcome) => bench.outcomes.push({ role, outcome }), { aborted: false })
      await bench.loop.tick(10)
      expect(bench.workers[0]!.frames()).toHaveLength(1)
      // Within the stall timeout the next frame is dropped as backpressure.
      await vi.advanceTimersByTimeAsync(1_000)
      await bench.loop.tick(10.5)
      expect(bench.outcomes).toHaveLength(0)
      // Past it, sampling goes on through the same busy gate, with no submit to unstick it.
      await vi.advanceTimersByTimeAsync(1_500)
      await bench.loop.tick(11)
      await bench.loop.tick(11.5)
      expect(bench.workers[0]!.frames().length).toBeGreaterThanOrEqual(2)
      expect(bench.outcomes.length).toBeGreaterThanOrEqual(1)
      await vi.advanceTimersByTimeAsync(10_000)
      await run
    } finally { bench.sampler.dispose(); bench.restore(); vi.useRealTimers() }
  })
})
