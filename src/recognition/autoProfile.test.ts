import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProfile, type RoiRect } from '../core/profileSchema'
import { MIN_SYNC_CONFIDENCE, type RecognitionOutcome, type SourceRole } from '../core/types'
import { FULL_FRAME_ROI, type GrabbedFrame } from './frameGrabber'
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

function onlineHarness(roi = { x: .48, y: .03, w: .03, h: .025 }) {
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
  const online = new OnlineAutoProfiles({ createWorker: () => worker, video: () => video, profile: () => null, use, changed: vi.fn() })
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
