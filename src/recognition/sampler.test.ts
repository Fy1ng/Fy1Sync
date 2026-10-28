/**
 * Sampler tests.
 *
 * The worker and the video element are both faked. What is being checked is the wiring:
 * that each role is isolated, that frames stop when the window closes, that a grab failure
 * is reported rather than swallowed, and that cancellation is prompt.
 */

import { describe, expect, it } from 'vitest'
import { createEmptyProfile, type RecognitionProfile } from '../core/profileSchema'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import type { WorkerLike } from './client'
import { FrameGrabber } from './frameGrabber'
import type { ResultMessage, WorkerRequest, WorkerResponse } from './protocol'
import { RecognitionSampler } from './sampler'

function profileFor(overrides: Partial<RecognitionProfile> = {}): RecognitionProfile {
  return { ...createEmptyProfile('cs2/iem', 'IEM'), sampleFps: 30, ...overrides }
}

/**
 * A worker that answers every frame with a fixed reading, on a microtask rather than
 * synchronously — a real worker's reply always arrives in a later task, and code that
 * accidentally depends on a synchronous answer must fail here.
 */
function fakeWorker(
  reply: (frame: Extract<WorkerRequest, { type: 'frame' }>) => RecognitionOutcome,
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
      queueMicrotask(() =>
        emit({
          type: 'result',
          generation: frame.generation,
          role: frame.role,
          frameIndex: frame.frameIndex,
          outcome: reply(frame),
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
  const roles: Array<{ video: HTMLVideoElement; onFrame: (mediaTime: number) => void; stopped: boolean }> = []
  const frameLoop = (
    video: HTMLVideoElement,
    _fps: number,
    onFrame: (mediaTime: number) => void,
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
    async tick(mediaTime: number) {
      for (const entry of roles) {
        if (!entry.stopped) entry.onFrame(mediaTime)
      }
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

/**
 * A `grab` that returns fixed pixels. jsdom has no canvas implementation, so the real
 * grabber cannot run here; the prototype is patched because the sampler builds its own
 * `FrameGrabber` instances internally.
 */
function stubGrabber(): () => void {
  const original = FrameGrabber.prototype.grab
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
  return () => {
    FrameGrabber.prototype.grab = original
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
  profile?: (role: SourceRole) => RecognitionProfile | null
  video?: (role: SourceRole) => HTMLVideoElement | null
  reply?: (frame: Extract<WorkerRequest, { type: 'frame' }>) => RecognitionOutcome
  metadata?: (frame: Extract<WorkerRequest, { type: 'frame' }>) => Partial<ResultMessage>
} = {}): Harness {
  const restore = stubGrabber()
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
  })

  return { sampler, outcomes, loop, workers, restore }
}

describe('RecognitionSampler', () => {
  it.each(['pause', 'seek', 'rate', 'source', 'dimensions'] as const)('invalidates numeric score evidence after %s', async kind => {
    const video = fakeVideo()
    const bench = harness({ video: role => role === 'official' ? video : null,
      metadata: frame => frame.score ? { score: {
        ...frame.score, left: 9, right: 8, leftQuality: .95, rightQuality: .95, reason: null,
        mediaTime: frame.mediaTime, wallTime: frame.wallTime, frameIndex: frame.frameIndex,
      } } : {},
    })
    try {
      const run = bench.sampler.sample(20, () => {}, { aborted: false })
      await bench.loop.tick(10)
      await run
      expect(bench.sampler.scoreReadings('official')).toHaveLength(1)
      const before = bench.sampler.scoreGeneration()
      if (kind === 'pause') Object.assign(video, { paused: true })
      if (kind === 'seek') Object.assign(video, { seeking: true })
      if (kind === 'rate') video.playbackRate = 1.03
      if (kind === 'source') video.src = 'replacement.mp4'
      if (kind === 'dimensions') Object.assign(video, { videoWidth: 3840, videoHeight: 2160 })
      expect(bench.sampler.scoreGeneration()).not.toBe(before)
      expect(bench.sampler.scoreReadings('official')).toHaveLength(0)
    } finally { bench.sampler.dispose(); bench.restore() }
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
    let current = profileFor({ name: 'first' })
    const video = fakeVideo()
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
      expect(changed.reading.wallTime).toBeCloseTo(1000 + (10.045 - 10.09) * 1000 / 1.05)
      expect(bench.outcomes.filter((entry) => entry.outcome.status === 'failed')).toHaveLength(1)
    } finally {
      bench.sampler.dispose()
      bench.restore()
    }
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
    const listeners = new Set<(event: MessageEvent<WorkerResponse>) => void>()
    const video = fakeVideo()
    const profile = profileFor()
    const sampler = new RecognitionSampler({
      createWorker: () => ({
        postMessage(message) {
          if (message.type === 'frame') {
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
      }),
      video: (role) => (role === 'official' ? video : null),
      profile: (role) => (role === 'official' ? profile : null),
      frameLoop: loop.frameLoop as never,
      onError: (role, message) => errors.push({ role, message }),
    })
    try {
      const run = sampler.sample(30, () => {}, { aborted: false })
      await loop.tick(10)
      await run
      expect(errors).toEqual([{ role: 'official', message: '模板缺失' }])
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
