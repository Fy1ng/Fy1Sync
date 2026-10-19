import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toGrayscale } from '../core/imageOps'
import { createEmptyProfile } from '../core/profileSchema'
import { createFrame, drawText } from '../test/glyphFont'
import { AutoClockSession, RecognitionEngine as WasmRecognitionEngine, TickMomentDetector, initSync, recognize_auto } from '../wasm/pkg/stream_syncer_wasm.js'
import { WasmWorkerEngine, createWorkerEngine, type WorkerEngine } from './backend'
import { RecognitionClient, type WorkerLike } from './client'
import type { GrabbedFrame } from './frameGrabber'
import type { LearnResultMessage, LocateResultMessage, ResultMessage, WorkerRequest, WorkerResponse } from './protocol'

initSync({ module: readFileSync(join(process.cwd(), 'src/wasm/pkg/stream_syncer_wasm_bg.wasm')) })

function frame(value: number, mediaTime: number, cropped = false): GrabbedFrame {
  const image = createFrame(cropped ? 54 : 320, cropped ? 22 : 180)
  drawText(image, `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`,
    cropped ? 4 : 74, cropped ? 4 : 103, { scale: 2 })
  return { pixels: image.data, width: image.width, height: image.height, mediaTime, wallTime: 50_000 + mediaTime * 1000 }
}

function window(): GrabbedFrame[] {
  return Array.from({ length: 18 * 8 }, (_, i) => frame(82 - Math.floor(i / 8), 100 + i / 8))
}

function actualEngine(): { engine: WasmWorkerEngine; free: () => void } {
  const recognition = new WasmRecognitionEngine()
  const engine = new WasmWorkerEngine({
    configure: (profile) => recognition.configure(profile),
    recognize: (...args) => recognition.recognize(...args),
    recognizeAuto: recognize_auto,
    createAutoSession: () => new AutoClockSession(),
    createTickDetector: () => new TickMomentDetector(),
  }, () => 0)
  return { engine, free: () => { engine.handle({ type: 'cancel', generation: 999 }); recognition.free() } }
}

function trackedEngine() {
  const sessions: { push: ReturnType<typeof vi.fn>; locate: ReturnType<typeof vi.fn>; learn: ReturnType<typeof vi.fn>; free: ReturnType<typeof vi.fn> }[] = []
  const report = { profile: null, confidence: 0.9, learnedChars: ['0', '1'], missingChars: ['2'], reason: null, observations: 20, consistentOffsets: 1 }
  const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '{}', createAutoSession: () => {
    const session = { push: vi.fn(), locate: vi.fn(() => '[]'), learn: vi.fn(() => JSON.stringify(report)), free: vi.fn() }
    sessions.push(session)
    return session
  } }, () => 0)
  return { engine, sessions }
}

class WindowWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = []
  readonly transfers: Transferable[][] = []
  terminated = false
  private listeners = new Set<(event: MessageEvent<WorkerResponse>) => void>()
  constructor(private readonly engine?: WorkerEngine) {}
  postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.sent.push(message)
    this.transfers.push(transfer)
    const request = structuredClone(message, { transfer })
    const response = this.engine?.handle(request)
    if (response) this.emit(response)
  }
  emit(message: WorkerResponse): void {
    for (const listener of this.listeners) listener({ data: message } as MessageEvent<WorkerResponse>)
  }
  terminate(): void { this.terminated = true }
  addEventListener(type: 'message' | 'error', listener: ((event: MessageEvent<WorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.listeners.add(listener as (event: MessageEvent<WorkerResponse>) => void)
  }
  removeEventListener(type: 'message' | 'error', listener: ((event: MessageEvent<WorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.listeners.delete(listener as (event: MessageEvent<WorkerResponse>) => void)
  }
}

afterEach(() => vi.useRealTimers())

describe('automatic-profile worker protocol', () => {
  it('locates and learns an independent full-frame window through the real generated WASM', async () => {
    const actual = actualEngine()
    const worker = new WindowWorker(actual.engine)
    const client = new RecognitionClient({ createWorker: () => worker })
    try {
      const frames = window()
      const located = await client.locate(frames)
      expect(located.status).toBe('success')
      expect(frames.every((f) => f.pixels.byteLength === 0)).toBe(true)
      expect(worker.transfers[0]).toHaveLength(144)
      if (located.status !== 'success') return
      const top = located.candidates[0]!
      expect(top.roi.y).toBeGreaterThan(0.5)
      expect(top.period).toBeCloseTo(1, 1)
      const learned = await client.learn(window(), top.roi)
      expect(learned).toMatchObject({ status: 'success', backend: 'wasm', report: { missingChars: [] } })
      if (learned.status !== 'success') return
      expect(learned.profile).not.toBeNull()
      expect(learned.report.learnedChars.slice().sort()).toEqual('0123456789:'.split(''))
      expect(client.activeProfile).toBeNull()
    } finally { client.dispose(); actual.free() }
  })

  it('returns structured unsupported results when WASM initialization fails', async () => {
    const engine = await createWorkerEngine({ load: async () => { throw new Error('WASM unavailable') } })
    const client = new RecognitionClient({ createWorker: () => new WindowWorker(engine) })
    expect(await client.locate([frame(65, 1)])).toMatchObject({ status: 'unsupported', backend: 'typescript' })
    expect(await client.learn([frame(65, 1)], { x: 0, y: 0, w: 1, h: 1 })).toMatchObject({ status: 'unsupported', backend: 'typescript' })
    expect(await client.locate([frame(65, 2)], { retainForLearning: true })).toMatchObject({ status: 'unsupported', backend: 'typescript' })
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: 1 })).toMatchObject({ status: 'unsupported', backend: 'typescript' })
    client.dispose()
  })

  it('reuses the real retained WASM window without transferring or copying RGBA again', async () => {
    const actual = actualEngine()
    const worker = new WindowWorker(actual.engine)
    const client = new RecognitionClient({ createWorker: () => worker })
    try {
      const frames = window()
      const located = await client.locate(frames, { retainForLearning: true })
      expect(located.status).toBe('success')
      if (located.status !== 'success') return
      expect(located.windowId).toBeGreaterThan(0)
      expect(frames.every(sample => sample.pixels.byteLength === 0)).toBe(true)
      const learned = await client.learn([], located.candidates[0]!.roi, { windowId: located.windowId })
      expect(learned).toMatchObject({ status: 'success', report: { missingChars: [] } })
      expect(learned.status === 'success' && learned.profile).toBeTruthy()
      expect(worker.sent[1]).toMatchObject({ type: 'learn', frames: [], windowId: located.windowId })
      expect(worker.transfers[1]).toEqual([])
      expect(await client.learn([], located.candidates[0]!.roi, { windowId: located.windowId })).toMatchObject({ status: 'failed', reason: 'window-unavailable' })
    } finally { client.dispose(); actual.free() }
  })

  it.each(['learn', 'cancel', 'configure', 'locate'] as const)('frees a retained session exactly once after %s', async action => {
    const { engine, sessions } = trackedEngine()
    const worker = new WindowWorker(engine)
    const client = new RecognitionClient({ createWorker: () => worker })
    const located = await client.locate([frame(65, 1)], { retainForLearning: true })
    expect(located.status).toBe('success')
    if (located.status !== 'success') return
    expect(sessions[0]!.free).not.toHaveBeenCalled()
    if (action === 'learn') {
      expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: located.windowId })).toMatchObject({ status: 'success' })
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.push).toHaveBeenCalledOnce()
      expect(sessions[0]!.learn).toHaveBeenCalledOnce()
      expect(worker.transfers[1]).toEqual([])
    } else if (action === 'configure') client.configure(createEmptyProfile())
    else if (action === 'cancel') client.cancel()
    else await client.locate([frame(64, 2)])
    expect(sessions[0]!.free).toHaveBeenCalledOnce()
    client.cancel()
    expect(sessions.every(session => session.free.mock.calls.length === 1)).toBe(true)
    client.dispose()
  })

  it('rejects incorrect, consumed, replaced and stale window ids without reusing their sessions', async () => {
    const { engine, sessions } = trackedEngine()
    const worker = new WindowWorker(engine)
    const client = new RecognitionClient({ createWorker: () => worker })
    const first = await client.locate([frame(65, 1)], { retainForLearning: true })
    if (first.status !== 'success') throw new Error('Expected successful locate')
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: first.windowId! + 1 })).toMatchObject({ status: 'failed', reason: 'invalid-window-id' })
    expect(sessions[0]!.free).not.toHaveBeenCalled()
    expect(sessions[0]!.learn).not.toHaveBeenCalled()
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: first.windowId })).toMatchObject({ status: 'success' })
    expect(sessions[0]!.free).toHaveBeenCalledOnce()
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: first.windowId })).toMatchObject({ status: 'failed', reason: 'window-unavailable' })
    const second = await client.locate([frame(64, 2)], { retainForLearning: true })
    if (second.status !== 'success') throw new Error('Expected successful locate')
    expect(second.windowId).not.toBe(first.windowId)
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: first.windowId })).toMatchObject({ status: 'failed', reason: 'invalid-window-id' })
    expect(sessions[1]!.free).not.toHaveBeenCalled()
    expect(sessions[1]!.learn).not.toHaveBeenCalled()
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: second.windowId })).toMatchObject({ status: 'success' })
    expect(sessions[1]!.free).toHaveBeenCalledOnce()
    const third = await client.locate([frame(63, 3)], { retainForLearning: true })
    if (third.status !== 'success') throw new Error('Expected successful locate')
    const generation = client.generation
    client.cancel()
    expect((engine.handle({ type: 'learn', generation, requestId: 100, frames: [], roi: { x: 0, y: 0, w: 1, h: 1 }, windowId: third.windowId }) as LearnResultMessage).result).toMatchObject({ status: 'failed', reason: 'stale-window' })
    expect(sessions[2]!.free).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('frees a retained session even when learning throws', async () => {
    const { engine, sessions } = trackedEngine()
    const client = new RecognitionClient({ createWorker: () => new WindowWorker(engine) })
    const located = await client.locate([frame(65, 1)], { retainForLearning: true })
    if (located.status !== 'success') throw new Error('Expected successful locate')
    sessions[0]!.learn.mockImplementation(() => { throw new Error('learning failed') })
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: located.windowId })).toMatchObject({ status: 'failed', reason: 'invalid-window' })
    expect(sessions[0]!.free).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('keeps only the newest retained window and does not let an old id consume it', async () => {
    const { engine, sessions } = trackedEngine()
    const client = new RecognitionClient({ createWorker: () => new WindowWorker(engine) })
    const first = await client.locate([frame(65, 1)], { retainForLearning: true })
    const second = await client.locate([frame(64, 2)], { retainForLearning: true })
    if (first.status !== 'success' || second.status !== 'success') throw new Error('Expected successful locate')
    expect(second.windowId).not.toBe(first.windowId)
    expect(sessions[0]!.free).toHaveBeenCalledOnce()
    expect(sessions[1]!.free).not.toHaveBeenCalled()
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: first.windowId })).toMatchObject({ status: 'failed', reason: 'invalid-window-id' })
    expect(sessions[1]!.free).not.toHaveBeenCalled()
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: second.windowId })).toMatchObject({ status: 'success' })
    expect(sessions[1]!.free).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('invalidates retained sessions on timeout and ignores late locate replies', async () => {
    vi.useFakeTimers()
    const { engine, sessions } = trackedEngine()
    const worker = new WindowWorker(engine)
    const emit = vi.spyOn(worker, 'emit').mockImplementation(() => {})
    const client = new RecognitionClient({ createWorker: () => worker, autoTimeoutMs: 500 })
    const located = client.locate([frame(65, 1)], { retainForLearning: true })
    const generation = client.generation
    expect(sessions[0]!.free).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(await located).toMatchObject({ status: 'failed', reason: 'worker-timeout' })
    expect(client.generation).toBe(generation + 1)
    expect(sessions[0]!.free).toHaveBeenCalledOnce()
    emit.mockRestore()
    worker.emit({ type: 'located', generation, requestId: 1, result: { status: 'success', backend: 'wasm', candidates: [], windowId: 1 } })
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: 1 })).toMatchObject({ status: 'failed', reason: 'window-unavailable' })
    expect(sessions[0]!.learn).not.toHaveBeenCalled()
    client.dispose()
  })

  it('invalidates an idle retained window after a worker error', async () => {
    const { engine, sessions } = trackedEngine()
    const worker = new WindowWorker(engine)
    const client = new RecognitionClient({ createWorker: () => worker })
    const located = await client.locate([frame(65, 1)], { retainForLearning: true })
    if (located.status !== 'success') throw new Error('Expected successful locate')
    const generation = client.generation
    worker.emit({ type: 'error', generation, message: 'worker failed after locating' })
    expect(client.generation).toBe(generation + 1)
    expect(sessions[0]!.free).toHaveBeenCalledOnce()
    expect(await client.learn([], { x: 0, y: 0, w: 1, h: 1 }, { windowId: located.windowId })).toMatchObject({ status: 'failed', reason: 'window-unavailable' })
    expect(sessions[0]!.learn).not.toHaveBeenCalled()
    client.dispose()
  })

  it.each(['cancel', 'configure', 'dispose'] as const)('settles pending requests and ignores stale replies after %s', async (action) => {
    const worker = new WindowWorker()
    const client = new RecognitionClient({ createWorker: () => worker })
    const generation = client.generation
    const locate = client.locate([frame(65, 1)])
    const learn = client.learn([frame(65, 1)], { x: 0, y: 0, w: 1, h: 1 })
    if (action === 'configure') client.configure(createEmptyProfile())
    else client[action]()
    expect(await locate).toMatchObject({ status: 'cancelled' })
    expect(await learn).toMatchObject({ status: 'cancelled' })
    worker.emit({ type: 'located', generation, requestId: 1, result: { status: 'success', backend: 'wasm', candidates: [] } })
    client.dispose()
  })

  it('routes concurrent replies by operation and request id without consuming a wrong reply', async () => {
    const worker = new WindowWorker()
    const client = new RecognitionClient({ createWorker: () => worker })
    const located = client.locate([frame(65, 1)])
    const learned = client.learn([frame(65, 1)], { x: 0, y: 0, w: 1, h: 1 })
    const result = { status: 'unsupported', backend: 'typescript', reason: 'auto-profile-unsupported' } as const
    worker.emit({ type: 'learned', generation: 0, requestId: 1, result })
    worker.emit({ type: 'located', generation: 0, requestId: 1, result })
    worker.emit({ type: 'learned', generation: 0, requestId: 2, result })
    expect(await located).toEqual(result)
    expect(await learned).toEqual(result)
    client.dispose()
  })

  it('returns failed on timeout and worker error without leaving unresolved requests', async () => {
    vi.useFakeTimers()
    const worker = new WindowWorker()
    const client = new RecognitionClient({ createWorker: () => worker, autoTimeoutMs: 500 })
    const timed = client.locate([frame(65, 1)])
    await vi.advanceTimersByTimeAsync(500)
    expect(await timed).toMatchObject({ status: 'failed', reason: 'worker-timeout' })
    const failed = client.locate([frame(65, 1)])
    worker.emit({ type: 'error', generation: client.generation, message: 'worker crashed' })
    expect(await failed).toMatchObject({ status: 'failed', reason: 'worker-error' })
    client.dispose()
  })

  it('rejects invalid windows and releases the bounded WASM session', () => {
    const free = vi.fn()
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '{}',
      createAutoSession: () => ({ push: () => { throw new Error('non-increasing timestamp') }, locate: () => '[]', learn: () => '{}', free }),
    }, () => 0)
    const sample = frame(65, 1)
    const result = engine.handle({ type: 'learn', generation: 0, requestId: 1,
      frames: [{ ...sample, pixels: sample.pixels.buffer as ArrayBuffer }], roi: { x: 0, y: 0, w: 1, h: 1 } }) as LearnResultMessage
    expect(result.result).toMatchObject({ status: 'failed', reason: 'invalid-window' })
    expect(free).toHaveBeenCalledOnce()
    engine.handle({ type: 'cancel', generation: 1 })
    expect(engine.handle({ type: 'locate', generation: 0, requestId: 2, frames: [] })).toBeNull()
    expect((engine.handle({ type: 'locate', generation: 1, requestId: 3, frames: [] }) as LocateResultMessage).result).toMatchObject({ status: 'failed' })
  })

  it('uses P4a partial profiles only in the explicit automatic path and retains P3 readiness', () => {
    const actual = actualEngine()
    try {
      const session = new AutoClockSession()
      let profile
      try {
        for (const sample of window()) session.push(toGrayscale(sample.pixels, sample.width, sample.height).data, sample.width, sample.height, sample.mediaTime)
        const top = JSON.parse(session.locate())[0]
        profile = JSON.parse(session.learn(JSON.stringify(top.roi))).profile
      } finally { session.free() }
      delete profile.templates['9']
      const sample = frame(82, 123)
      const request = { type: 'frame', generation: 1, role: 'official', frameIndex: 1, ...sample,
        pixels: sample.pixels.buffer as ArrayBuffer, wantDebug: false } as const
      expect(actual.engine.handle({ type: 'configure', generation: 1, profile })).toMatchObject({ ready: false })
      expect((actual.engine.handle(request) as ResultMessage).outcome).toMatchObject({ status: 'failed', reason: 'insufficient-templates' })
      actual.engine.handle({ type: 'configure', generation: 2, profile, automatic: true })
      expect((actual.engine.handle({ ...request, generation: 2 }) as ResultMessage).outcome).toMatchObject({ status: 'success', reading: { seconds: 82, mediaTime: 123 } })
    } finally { actual.free() }
  })

  it('reports per-source pixel brackets even when matching fails and resets after cancel/seek/dimension change', () => {
    const actual = actualEngine()
    try {
      actual.engine.handle({ type: 'configure', generation: 1, profile: createEmptyProfile() })
      const push = (role: 'official' | 'commentary', value: number, time: number, generation = 1, cropped = true) => {
        const sample = frame(value, time, cropped)
        return actual.engine.handle({ type: 'frame', generation, role, frameIndex: 1, ...sample,
          pixels: sample.pixels.buffer as ArrayBuffer, wantDebug: false }) as ResultMessage
      }
      expect(push('official', 65, 100).tickMoment).toBeUndefined()
      expect(push('commentary', 65, 500).tickMoment).toBeUndefined()
      const changed = push('official', 64, 100.1)
      expect(changed.outcome.status).toBe('failed')
      expect(changed.tickMoment).toMatchObject({ lastUnchanged: 100, firstChanged: 100.1, midpoint: 100.05 })
      expect(push('commentary', 64, 500.2).tickMoment).toMatchObject({ midpoint: 500.1 })
      expect(push('official', 63, 10).tickMoment).toBeUndefined()
      expect(push('official', 62, 10.1, 1, false).tickMoment).toBeUndefined()
      actual.engine.handle({ type: 'cancel', generation: 2 })
      expect(push('official', 61, 11, 2).tickMoment).toBeUndefined()
    } finally { actual.free() }
  })
})
