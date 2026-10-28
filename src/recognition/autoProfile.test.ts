import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProfile, type RoiRect } from '../core/profileSchema'
import { MIN_SYNC_CONFIDENCE, type RecognitionOutcome, type SourceRole } from '../core/types'
import { FrameGrabber, FULL_FRAME_ROI, type AsyncGrabResult, type GrabbedFrame } from './frameGrabber'
import { AutoProfileController, AUTO_PROFILE_MAX_FRAMES, AUTO_PROFILE_NATIVE_BYTES, AUTO_PROFILE_WINDOW_MS, CLOCK_LOST_MS, OnlineAutoProfiles } from './autoProfile'
import type { WorkerLike } from './client'
import type { LearnResult, LocateResult, WorkerRequest, WorkerResponse } from './protocol'

const profile = createEmptyProfile('saved/example', '原预设')
const candidate = { roi: profile.roi, score: 0.96, eventTimes: [1, 2, 3], period: 1, jitter: 0, persistence: 1, glyphScore: 1 }
const located: LocateResult = { status: 'success', backend: 'wasm', candidates: [candidate], windowId: 1 }
const learned: LearnResult = { status: 'success', backend: 'wasm', profile, report: {
  profile, confidence: 0.95, learnedChars: ['0', '1', ':'], missingChars: ['2'],
  reason: null, observations: 12, consistentOffsets: 1,
} }
const failed: RecognitionOutcome = { status: 'failed', reason: 'no-candidates' }

function frame(time: number): GrabbedFrame {
  return { pixels: new Uint8ClampedArray([255, 255, 255, 255]), width: 1, height: 1, mediaTime: time, wallTime: time * 1000 }
}
function harness() {
  let now = 0
  const clients = {
    official: { locate: vi.fn(async (_frames: GrabbedFrame[]): Promise<LocateResult> => located), learn: vi.fn(async (_frames: GrabbedFrame[], _roi: RoiRect): Promise<LearnResult> => learned), cancel: vi.fn(), dispose: vi.fn() },
    commentary: { locate: vi.fn(async (_frames: GrabbedFrame[]): Promise<LocateResult> => located), learn: vi.fn(async (_frames: GrabbedFrame[], _roi: RoiRect): Promise<LearnResult> => learned), cancel: vi.fn(), dispose: vi.fn() },
  }
  const capture = vi.fn(async (_role: SourceRole, _signal: { aborted: boolean }, roi?: RoiRect) => Array.from({ length: 30 }, (_, i) => frame((roi ? 12 : 0) + i / 8)))
  const current = vi.fn(() => true)
  const use = vi.fn()
  const controller = new AutoProfileController({ client: role => clients[role], capture, current, use, now: () => now })
  return { controller, clients, capture, current, use, time: (value: number) => { now = value } }
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('source-local automatic profiles', () => {
  it('waits for explicit acceptance and keeps two independent candidates without modifying a saved profile', async () => {
    const h = harness()
    const before = structuredClone(profile)
    const official = h.controller.acquire('official')
    const commentary = h.controller.acquire('commentary')
    await settle()
    expect(h.controller.state('official').phase).toBe('ready')
    expect(h.use).not.toHaveBeenCalled()
    h.controller.accept('official')
    expect(await official).toBe(true)
    expect(h.controller.state('commentary').accepted).toBe(false)
    h.controller.accept('commentary')
    expect(await commentary).toBe(true)
    expect(h.use.mock.calls.map(call => [call[0], call[1].id])).toEqual([
      ['official', 'session/official'], ['commentary', 'session/commentary'],
    ])
    expect(profile).toEqual(before)
  })

  it('learns a fresh native crop and maps its full-frame profile back to the source ROI', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle()
    expect(h.clients.official.locate).toHaveBeenCalledWith(expect.any(Array))
    expect(h.capture.mock.calls[0]).toHaveLength(2)
    expect(h.capture.mock.calls[1]?.[2]).toEqual(candidate.roi)
    expect(h.clients.official.learn).toHaveBeenCalledWith(expect.any(Array), FULL_FRAME_ROI)
    const nativeFrames = h.clients.official.learn.mock.calls[0]?.[0] as GrabbedFrame[] | undefined
    expect(nativeFrames?.[0]?.mediaTime).toBe(12)
    expect(h.controller.state('official').candidate).toMatchObject({ roi: candidate.roi, matchThreshold: MIN_SYNC_CONFIDENCE })
    h.controller.cancel('official')
    expect(await run).toBe(false)
  })

  it('cancels during capture and ignores a late window', async () => {
    const h = harness()
    let finish!: (frames: GrabbedFrame[]) => void
    h.capture.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const run = h.controller.acquire('official')
    h.controller.cancel('official')
    expect(await run).toBe(false)
    finish(Array.from({ length: 30 }, (_, i) => frame(i)))
    await settle()
    expect(h.clients.official.locate).not.toHaveBeenCalled()
    expect(h.controller.state('official').phase).toBe('cancelled')
    expect(h.use).not.toHaveBeenCalled()
  })

  it('ignores an obsolete result after reset and a fresh acquisition', async () => {
    const h = harness()
    let finish!: (value: LocateResult) => void
    h.clients.official.locate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = h.controller.acquire('official')
    await settle()
    h.controller.reset('official')
    expect(await old).toBe(false)
    const fresh = h.controller.acquire('official')
    await settle()
    finish({ status: 'failed', reason: 'old failure' })
    await settle()
    expect(h.controller.state('official').phase).toBe('ready')
    h.controller.accept('official')
    expect(await fresh).toBe(true)
  })

  it('exposes TypeScript unsupported and leaves the manual flow available', async () => {
    const h = harness()
    h.clients.official.locate.mockResolvedValue({ status: 'unsupported', backend: 'typescript', reason: '自动定位不可用, 请使用手动预设' })
    expect(await h.controller.acquire('official')).toBe(false)
    expect(h.controller.state('official')).toMatchObject({ phase: 'unsupported', accepted: false })
    expect(h.clients.official.learn).not.toHaveBeenCalled()
    expect(h.use).not.toHaveBeenCalled()
  })

  it('reports an unsupported learn instead of accepting a profile', async () => {
    const h = harness()
    h.clients.official.learn.mockResolvedValue({ status: 'unsupported', backend: 'typescript', reason: '不支持自动学习' })
    expect(await h.controller.acquire('official')).toBe(false)
    expect(h.controller.state('official').phase).toBe('unsupported')
    expect(h.use).not.toHaveBeenCalled()
  })

  it.each([{ candidates: [] }, { candidates: [candidate, { ...candidate, score: 0.94 }] }])('rejects missing or ambiguous clocks', async ({ candidates }) => {
    const h = harness()
    h.clients.official.locate.mockResolvedValue({ status: 'success', backend: 'wasm', candidates })
    expect(await h.controller.acquire('official')).toBe(false)
    expect(h.controller.state('official').phase).toBe('not-found')
    expect(h.clients.official.learn).not.toHaveBeenCalled()
  })

  it('reports a learning refusal', async () => {
    const h = harness()
    h.clients.official.learn.mockResolvedValue({ ...learned, profile: null, report: { ...learned.report, reason: 'ambiguous-labels' } })
    expect(await h.controller.acquire('official')).toBe(false)
    expect(h.controller.state('official')).toMatchObject({ phase: 'not-found', reason: '字形标签存在歧义, 请重新识别或手动编辑' })
  })

  it('re-acquires accepted candidates after continuous loss and reuses session consent', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle(); h.controller.accept('official'); await run
    h.controller.observe('official', failed)
    h.time(CLOCK_LOST_MS - 1); h.controller.observe('official', failed)
    expect(h.capture).toHaveBeenCalledTimes(2)
    h.time(CLOCK_LOST_MS); h.controller.observe('official', failed)
    await settle()
    expect(h.capture).toHaveBeenCalledTimes(4)
    expect(h.use).toHaveBeenCalledTimes(2)
    expect(h.controller.state('official')).toMatchObject({ phase: 'ready', accepted: true })
    expect(h.clients.commentary.locate).not.toHaveBeenCalled()
  })

  it('requires fresh consent after a source replacement and suppresses cancelled retries', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle(); h.controller.accept('official'); await run
    h.controller.reset('official')
    expect(h.controller.state('official').accepted).toBe(false)
    h.controller.cancel('official')
    h.controller.observe('official', failed)
    h.time(100_000); h.controller.observe('official', failed)
    await settle()
    expect(h.capture).toHaveBeenCalledTimes(2)
  })

  it('does not let low-confidence readings hide a continuously lost clock', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle(); h.controller.accept('official'); await run
    const low: RecognitionOutcome = { status: 'success', reading: {
      text: '0:20', seconds: 20, scores: [0.7], confidence: 0.7, mediaTime: 1, wallTime: 1000, frameIndex: 1,
    } }
    h.controller.observe('official', low)
    h.time(CLOCK_LOST_MS); h.controller.observe('official', low)
    await settle()
    expect(h.capture).toHaveBeenCalledTimes(4)
    expect(h.use).toHaveBeenCalledTimes(2)
  })

  it('resolves all pending consent on disposal', async () => {
    const h = harness()
    const a = h.controller.acquire('official')
    const b = h.controller.acquire('commentary')
    await settle()
    h.controller.dispose()
    expect(await a).toBe(false)
    expect(await b).toBe(false)
    expect(await h.controller.acquire('official')).toBe(false)
  })

  it('discards a late native capture after cancellation', async () => {
    const h = harness()
    let finish!: (frames: GrabbedFrame[]) => void
    h.capture.mockImplementationOnce(async () => Array.from({ length: 30 }, (_, i) => frame(i / 8)))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const run = h.controller.acquire('official')
    await settle()
    expect(h.controller.state('official').phase).toBe('learning')
    h.controller.cancel('official')
    finish(Array.from({ length: 30 }, (_, i) => frame(12 + i / 8)))
    await settle()
    expect(await run).toBe(false)
    expect(h.clients.official.learn).not.toHaveBeenCalled()
    expect(h.use).not.toHaveBeenCalled()
  })

  it('discards a late learned profile if the captured source stopped or changed', async () => {
    const h = harness()
    let finish!: (result: LearnResult) => void
    h.clients.official.learn.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const run = h.controller.acquire('official')
    await settle()
    h.current.mockReturnValue(false)
    finish(learned)
    await settle()
    expect(await run).toBe(false)
    expect(h.controller.state('official').phase).toBe('cancelled')
    expect(h.use).not.toHaveBeenCalled()
  })

  it('does not accept a ready candidate from a stopped or changed source', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle()
    h.current.mockReturnValue(false)
    h.controller.accept('official')
    expect(await run).toBe(false)
    expect(h.use).not.toHaveBeenCalled()
  })
})

afterEach(() => vi.useRealTimers())

function onlineHarness(roi = { x: .48, y: .03, w: .03, h: .025 }, monitoring = false) {
  vi.useFakeTimers()
  const video = document.createElement('video')
  video.src = 'https://example.test/first'
  let paused = false
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 2560 }, videoHeight: { configurable: true, value: 1440 },
    readyState: { value: 4 }, paused: { get: () => paused }, seeking: { value: false },
    currentTime: { get: () => performance.now() / 1000 }, currentSrc: { get: () => video.src },
  })
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage,
    // Worker transport is stubbed; verify dimensions without retaining full fake video buffers.
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  } as unknown as CanvasRenderingContext2D)
  const messages: WorkerRequest[] = []
  const listeners = new Set<(event: MessageEvent<WorkerResponse>) => void>()
  const worker: WorkerLike = {
    postMessage: message => {
      messages.push(message)
      const reply: WorkerResponse | null = message.type === 'locate'
        ? { type: 'located', generation: message.generation, requestId: message.requestId,
          result: { status: 'success', backend: 'wasm', candidates: [{ ...candidate, roi }] } }
        : message.type === 'learn' ? { type: 'learned', generation: message.generation, requestId: message.requestId, result: learned } : null
      if (reply) for (const listener of listeners) listener({ data: reply } as MessageEvent<WorkerResponse>)
    },
    terminate: vi.fn(),
    addEventListener: (type, listener) => { if (type === 'message') listeners.add(listener as (event: MessageEvent<WorkerResponse>) => void) },
    removeEventListener: (type, listener) => { if (type === 'message') listeners.delete(listener as (event: MessageEvent<WorkerResponse>) => void) },
  }
  const use = vi.fn()
  const online = new OnlineAutoProfiles({ createWorker: () => worker, video: () => video, profile: () => monitoring ? profile : null, use, changed: vi.fn() })
  return { online, video, drawImage, messages, use, pause: () => { paused = true } }
}

describe('bounded native learning acquisition', () => {
  it('keeps discovery at 960 and learns only a bounded crop at native 1440p resolution', async () => {
    const h = onlineHarness()
    const run = h.online.controller.acquire('official')
    await vi.advanceTimersByTimeAsync(AUTO_PROFILE_WINDOW_MS)
    expect(h.online.controller.state('official').phase).toBe('learning')
    const locate = h.messages.find(m => m.type === 'locate')
    expect(locate).not.toHaveProperty('retainForLearning')
    expect(locate?.frames[0]).toMatchObject({ width: 960, height: 540 })
    await vi.advanceTimersByTimeAsync(AUTO_PROFILE_WINDOW_MS)
    const learn = h.messages.find(m => m.type === 'learn')
    expect(learn?.roi).toEqual(FULL_FRAME_ROI)
    expect(learn?.frames[0]).toMatchObject({ width: 77, height: 36 })
    expect(learn?.frames.length).toBeLessThanOrEqual(AUTO_PROFILE_MAX_FRAMES)
    expect((learn?.frames.length ?? 0) * 77 * 36 * 4).toBeLessThan(AUTO_PROFILE_NATIVE_BYTES)
    expect(learn?.frames[0]?.mediaTime).toBeGreaterThan(locate?.frames.at(-1)?.mediaTime ?? Infinity)
    expect(h.drawImage).toHaveBeenCalledWith(h.video, 1229, 43, 77, 36, 0, 0, 77, 36)
    h.online.controller.accept('official')
    expect(await run).toBe(true)
    expect(h.use).toHaveBeenCalledWith('official', expect.objectContaining({ roi: { x: .48, y: .03, w: .03, h: .025 } }))
    h.online.dispose()
  })

  it('rejects oversized native windows before allocating their pixel buffers', async () => {
    const h = onlineHarness(FULL_FRAME_ROI)
    const run = h.online.controller.acquire('official')
    await vi.advanceTimersByTimeAsync(AUTO_PROFILE_WINDOW_MS)
    expect(await run).toBe(false)
    expect(h.messages.some(m => m.type === 'learn')).toBe(false)
    expect(h.drawImage.mock.calls.every(call => call[7] === 960 && call[8] === 540)).toBe(true)
    h.online.dispose()
  })

  it.each(['source', 'dimensions', 'pause', 'suspend'] as const)('aborts a native window after %s changes', async kind => {
    const h = onlineHarness()
    const run = h.online.controller.acquire('official')
    await vi.advanceTimersByTimeAsync(AUTO_PROFILE_WINDOW_MS)
    if (kind === 'source') h.video.src = 'https://example.test/second'
    if (kind === 'dimensions') Object.defineProperty(h.video, 'videoWidth', { value: 1920 })
    if (kind === 'pause') h.pause()
    if (kind === 'suspend') h.online.suspend()
    await vi.advanceTimersByTimeAsync(50)
    expect(await run).toBe(false)
    expect(h.messages.some(m => m.type === 'learn')).toBe(false)
    expect(h.use).not.toHaveBeenCalled()
    expect(h.online.controller.state('official').phase).toBe('cancelled')
    h.online.dispose()
  })
})

function presentationLoop(video: HTMLVideoElement) {
  let callback: VideoFrameRequestCallback | undefined
  let handle = 0
  const cancel = vi.fn()
  Object.assign(video, {
    requestVideoFrameCallback: (next: VideoFrameRequestCallback) => { callback = next; return ++handle },
    cancelVideoFrameCallback: cancel,
  })
  return {
    cancel,
    present: (mediaTime: number) => callback?.(performance.now(), { mediaTime } as VideoFrameCallbackMetadata),
  }
}

describe('asynchronous automatic-profile capture', () => {
  it('keeps the actionable Chinese canvas-tainted error from an asynchronous readback', async () => {
    const h = onlineHarness()
    const loop = presentationLoop(h.video)
    const detail = '画布被跨域视频污染，无法读取像素。请通过本地代理加载该源。'
    vi.spyOn(FrameGrabber.prototype, 'grabScaledAsync').mockResolvedValue({ ok: false, reason: 'canvas-tainted', detail })
    const run = h.online.controller.acquire('official')
    loop.present(10)
    await settle()
    expect(await run).toBe(false)
    expect(h.online.controller.state('official')).toMatchObject({ phase: 'not-found', reason: detail })
    expect(h.messages.some(message => message.type === 'locate')).toBe(false)
    h.online.dispose()
  })

  it('preserves rVFC mediaTime, the sample wall clock, and the 125 ms discovery cadence', async () => {
    const h = onlineHarness()
    const loop = presentationLoop(h.video)
    const samples: Array<{ time: number; sampledAt: number }> = []
    const grab = vi.spyOn(FrameGrabber.prototype, 'grabScaledAsync').mockImplementation(async (_video, _roi, _maxWidth, mediaTime) => {
      const sampledAt = performance.now()
      samples.push({ time: mediaTime!, sampledAt })
      await Promise.resolve()
      return { ok: true, frame: { ...frame(mediaTime!), width: 960, height: 540, wallTime: sampledAt } }
    })
    const run = h.online.controller.acquire('official')
    for (const mediaTime of [10, 10.05, 10.124, 10.125, 10.20, 10.25]) {
      loop.present(mediaTime)
      await settle()
    }
    expect(grab.mock.calls.map(call => call[3])).toEqual([10, 10.125, 10.25])
    // Finish enough samples for locate, without relying on the video's currentTime.
    for (let index = 3; index < 30; index++) { loop.present(10 + index * .125); await settle() }
    await vi.advanceTimersByTimeAsync(AUTO_PROFILE_WINDOW_MS)
    const locate = h.messages.find(message => message.type === 'locate')
    expect(locate?.frames.map(value => value.mediaTime)).toEqual(samples.map(sample => sample.time))
    expect(locate?.frames.map(value => value.wallTime)).toEqual(samples.map(sample => sample.sampledAt))
    expect(locate?.frames[0]?.mediaTime).toBe(10)
    h.online.controller.cancel('official')
    expect(await run).toBe(false)
    h.online.dispose()
  })

  it.each(['cancel', 'seek', 'source', 'window', 'dispose'] as const)(
    'does not append an in-flight frame after %s ends or invalidates discovery', async kind => {
      const h = onlineHarness()
      const loop = presentationLoop(h.video)
      let finish!: (value: AsyncGrabResult) => void
      const grab = vi.spyOn(FrameGrabber.prototype, 'grabScaledAsync')
        .mockImplementation((_video, _roi, _maxWidth, mediaTime) => {
          if (mediaTime === 13.75) return new Promise(resolve => { finish = resolve })
          return Promise.resolve({ ok: true, frame: { ...frame(mediaTime!), width: 960, height: 540 } })
        })
      const run = h.online.controller.acquire('official')
      for (let index = 0; index <= 30; index++) { loop.present(10 + index * .125); await settle() }
      expect(grab).toHaveBeenCalledTimes(31)
      if (kind === 'cancel') h.online.controller.cancel('official')
      if (kind === 'seek') h.video.dispatchEvent(new Event('seeking'))
      if (kind === 'source') h.video.src = 'https://example.test/replacement'
      if (kind === 'window') await vi.advanceTimersByTimeAsync(AUTO_PROFILE_WINDOW_MS)
      if (kind === 'dispose') h.online.dispose()
      finish({ ok: true, frame: { ...frame(13.75), width: 960, height: 540 } })
      await settle()
      await vi.advanceTimersByTimeAsync(50)
      const locate = h.messages.find(message => message.type === 'locate')
      if (kind === 'window') {
        expect(locate?.frames).toHaveLength(30)
        expect(locate?.frames.some(value => value.mediaTime === 13.75)).toBe(false)
        h.online.controller.cancel('official')
      } else {
        expect(locate).toBeUndefined()
      }
      expect(await run).toBe(false)
      expect(h.use).not.toHaveBeenCalled()
      h.online.dispose()
    },
  )

  it('excludes backpressure skips from discovery and only transfers completed frames', async () => {
    const h = onlineHarness()
    const loop = presentationLoop(h.video)
    let finish!: (result: AsyncGrabResult) => void
    let busy = false
    const grab = vi.spyOn(FrameGrabber.prototype, 'grabScaledAsync').mockImplementation((_video, _roi, _maxWidth, mediaTime) => {
      if (busy) return Promise.resolve({ ok: false, skipped: true, reason: 'backpressure' })
      if (mediaTime === 10) {
        busy = true
        return new Promise(resolve => { finish = value => { busy = false; resolve(value) } })
      }
      return Promise.resolve({ ok: true, frame: { ...frame(mediaTime!), width: 960, height: 540 } })
    })
    const run = h.online.controller.acquire('official')
    loop.present(10); await settle()
    loop.present(10.125); await settle()
    loop.present(10.25); await settle()
    finish({ ok: true, frame: { ...frame(10), width: 960, height: 540 } })
    await settle()
    for (let index = 3; index < 32; index++) { loop.present(10 + index * .125); await settle() }
    await vi.advanceTimersByTimeAsync(AUTO_PROFILE_WINDOW_MS)
    const locate = h.messages.find(message => message.type === 'locate')
    expect(grab).toHaveBeenCalledTimes(32)
    expect(locate?.frames).toHaveLength(30)
    expect(locate?.frames.slice(0, 2).map(value => value.mediaTime)).toEqual([10, 10.375])
    h.online.controller.cancel('official')
    expect(await run).toBe(false)
    h.online.dispose()
  })

  it.each(['seek', 'source', 'reset', 'suspend'] as const)('discards a sparse-monitor readback after %s', async kind => {
    const h = onlineHarness(undefined, true)
    const loop = presentationLoop(h.video)
    let finish!: (value: AsyncGrabResult) => void
    vi.spyOn(FrameGrabber.prototype, 'grabAsync').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    h.online.monitor('official')
    loop.present(10)
    await settle()
    if (kind === 'seek') h.video.dispatchEvent(new Event('seeking'))
    if (kind === 'source') h.video.src = 'https://example.test/replacement'
    if (kind === 'reset') h.online.reset('official')
    if (kind === 'suspend') h.online.suspend()
    finish({ ok: true, frame: frame(10) })
    await settle()
    expect(h.messages.some(message => message.type === 'frame')).toBe(false)
    h.online.dispose()
  })
})
