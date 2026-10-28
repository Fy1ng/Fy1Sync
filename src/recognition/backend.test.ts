import { describe, expect, it, vi } from 'vitest'
import { createEmptyProfile } from '../core/profileSchema'
import { createWorkerEngine, WasmWorkerEngine } from './backend'
import { RecognitionEngine } from './engine'
import type { FrameMessage, ResultMessage } from './protocol'

const profile = createEmptyProfile()
const frame: FrameMessage = { type: 'frame', generation: 2, role: 'official', frameIndex: 7,
  width: 2, height: 2, pixels: new ArrayBuffer(16), mediaTime: 1, wallTime: 2000, wantDebug: true }

describe('Worker backend selection', () => {
  it('reads one strip and restores the exact native clock pixels before recognition', () => {
    const pixels = Uint8Array.from({ length: 10 * 6 * 4 }, (_, index) => index % 255)
    const recognize = vi.fn(() => JSON.stringify({ outcome: { status: 'failed', reason: 'blank-frame' }, debug: null }))
    const recognizeScore = vi.fn(() => JSON.stringify({ left: 9, right: 10, leftQuality: .96, rightQuality: .94, reason: null }))
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize, recognizeScore }, () => 0)
    engine.handle({ type: 'configure', generation: 2, profile })
    const result = engine.handle({ ...frame, width: 10, height: 6, pixels: pixels.buffer,
      score: { clockRect: { x: 4, y: 2, width: 2, height: 2 }, source: 'local',
        generation: 17, width: 3840, height: 2160, segment: 4 } }) as ResultMessage
    const nativeClock = new Uint8Array([...pixels.slice(96, 104), ...pixels.slice(136, 144)])
    expect(recognize).toHaveBeenCalledWith(nativeClock, 2, 2, 1, 2000, 7, true)
    expect(recognizeScore).toHaveBeenCalledWith(pixels, 10, 6, JSON.stringify({ x: .4, y: 1 / 3, w: .2, h: 1 / 3 }))
    expect(result.score).toMatchObject({ left: 9, right: 10, mediaTime: 1, wallTime: 2000,
      source: 'local', generation: 17, width: 3840, height: 2160, segment: 4, frameIndex: 7 })
  })
  it('marks scores unsupported on a fallback backend while preserving clock recognition', () => {
    const engine = new RecognitionEngine(() => 0)
    engine.handle({ type: 'configure', generation: 2, profile })
    const result = engine.handle({ ...frame, score: { clockRect: { x: 0, y: 0, width: 2, height: 2 },
      source: 'local', generation: 1, width: 2, height: 2, segment: 1 } }) as ResultMessage
    expect(result.score).toMatchObject({ left: null, right: null, reason: 'score-unsupported' })
    expect(result.outcome.status).toBe('failed')
  })
  it('exercises the real TS recognition path after WASM instantiation fails', async () => {
    const report = vi.fn()
    const engine = await createWorkerEngine({ load: async () => { throw new Error('CSP denied') }, now: () => 0, report })
    expect(engine.backend).toBe('typescript')
    expect(report).toHaveBeenCalledWith('typescript', 'CSP denied')
    const reference = new RecognitionEngine(() => 0)
    const configure = { type: 'configure', generation: 2, profile } as const
    expect(engine.handle(configure)).toEqual(reference.handle(configure))
    expect(engine.handle(frame)).toEqual(reference.handle(frame))
  })
  it('honors the explicit TypeScript switch without loading WASM', async () => {
    const load = vi.fn()
    const engine = await createWorkerEngine({ preferred: 'typescript', load })
    expect(engine.backend).toBe('typescript')
    expect(load).not.toHaveBeenCalled()
  })
  it('prefers WASM and keeps generation cancellation and elapsedMs', async () => {
    let now = 0
    const wasm = { configure: vi.fn(() => JSON.stringify({ ready: true, missing: [], sampleCount: 11 })),
      recognize: vi.fn(() => JSON.stringify({ outcome: { status: 'failed', reason: 'blank-frame' }, debug: null })) }
    const engine = await createWorkerEngine({ load: async () => wasm, now: () => now += 3 })
    expect(engine.backend).toBe('wasm')
    expect(engine.handle(frame)).toBeNull()
    engine.handle({ type: 'configure', generation: 2, profile })
    const result = engine.handle(frame) as ResultMessage
    expect(result.elapsedMs).toBe(3)
    expect(wasm.recognize).toHaveBeenCalledWith(new Uint8Array(16), 2, 2, 1, 2000, 7, true)
    engine.handle({ type: 'cancel', generation: 3 })
    expect(engine.handle(frame)).toBeNull()
    expect(wasm.recognize).toHaveBeenCalledTimes(1)
  })
  it('restores structured-cloneable typed arrays and labels the debug backend', () => {
    const debug = { roiPixels: { x: 0, y: 0, width: 2, height: 2 }, binary: { data: [0,255,0,0], width: 2, height: 2 },
      boxes: [], projection: [0,1], inkRatio: .25, matches: [], normalized: [[0,255]] }
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => JSON.stringify({ outcome: { status: 'failed', reason: 'blank-frame' }, debug }) }, () => 0)
    engine.handle({ type: 'configure', generation: 2, profile })
    const result = engine.handle(frame) as ResultMessage
    expect(result.debug).toMatchObject({ backend: 'wasm' })
    expect(result.debug?.binary.data).toEqual(Uint8Array.of(0,255,0,0))
    expect(result.debug?.normalized).toEqual([Uint8Array.of(0,255)])
    expect((engine.handle({ ...frame, wantDebug: false }) as ResultMessage).debug).toBeNull()
  })
  it('rejects truncated buffers and catches WASM runtime errors without wedging the queue', () => {
    const recognize = vi.fn(() => { throw new Error('bad frame') })
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize }, () => 0)
    expect(engine.handle({ ...frame, generation: -1 })).toMatchObject({ type: 'error' })
    engine.handle({ type: 'configure', generation: 2, profile })
    expect((engine.handle({ ...frame, pixels: new ArrayBuffer(1) }) as ResultMessage).outcome)
      .toEqual({ status: 'failed', reason: 'decode-failed', detail: '帧数据长度不足' })
    expect(recognize).not.toHaveBeenCalled()
    expect((engine.handle(frame) as ResultMessage).outcome).toEqual({ status: 'failed', reason: 'decode-failed', detail: 'bad frame' })
  })
})
