import { describe, expect, it, vi } from 'vitest'
import { createEmptyHudStylePack } from '../core/hudStylePack'
import { createEmptyProfile } from '../core/profileSchema'
import { createWorkerEngine, WasmWorkerEngine } from './backend'
import { RecognitionEngine } from './engine'
import type { FrameMessage, ResultMessage, WorkerRequest } from './protocol'

const profile = createEmptyHudStylePack(undefined, undefined, { width: 2, height: 2 })
const failedHud = (debug: unknown = null) => ({ variantId: profile.variants[0]!.id, selectionReason: null, content: 'indeterminate', phase: 'indeterminate',
  fields: Object.fromEntries(['clock','scoreLeft','scoreRight','round'].map(id => [id,{status:'failed',reason:'blank-frame',debug: id === 'clock' ? debug : null}])),
  cues: {}, states: {}, organizer: { status: 'failed', reason: 'not-configured', score: null, debug: null } })
const frame: FrameMessage = { type: 'frame', generation: 2, role: 'official', frameIndex: 7,
  width: 2, height: 2, pixels: new ArrayBuffer(16), mediaTime: 1, wallTime: 2000, wantDebug: true }

describe('Worker backend selection', () => {
  it('rejects a legacy learned profile even when an old sender requests automatic recognition', () => {
    const configure = vi.fn(() => '{}')
    const recognizeHud = vi.fn(() => JSON.stringify(failedHud()))
    const engine = new WasmWorkerEngine({ configure, recognize: () => '', recognizeHud }, () => 0)
    engine.handle({ type: 'configure', generation: 2, profile })
    const legacy = { type: 'configure', generation: 3, profile: createEmptyProfile('session/official'), automatic: true }
    expect(() => engine.handle(legacy as WorkerRequest)).toThrow(/重新制作样式包/)
    expect(configure).toHaveBeenCalledTimes(1)
    expect(engine.handle(frame)).toMatchObject({ type: 'error' })
    expect(recognizeHud).not.toHaveBeenCalled()
  })

  it.each(['locate', 'learn'])('ignores a removed %s request without affecting the configured manual HUD', type => {
    const recognizeHud = vi.fn(() => JSON.stringify(failedHud()))
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '', recognizeHud }, () => 0)
    engine.handle({ type: 'configure', generation: 2, profile })
    const obsolete = { type, generation: 5, requestId: 1, frames: [] } as unknown as WorkerRequest
    expect(engine.handle(obsolete)).toBeNull()
    expect(new RecognitionEngine().handle(obsolete)).toBeNull()
    expect(engine.handle(frame)).toMatchObject({ type: 'result', generation: 2 })
    expect(recognizeHud).toHaveBeenCalledTimes(1)
  })

  it('reports a missing WASM capability after instantiation fails', async () => {
    const report = vi.fn()
    const engine = await createWorkerEngine({ load: async () => { throw new Error('CSP denied') }, now: () => 0, report })
    expect(engine.backend).toBe('typescript')
    expect(report).toHaveBeenCalledWith('typescript', 'CSP denied')
    const reference = new RecognitionEngine(() => 0, '样式包需要 Rust/WASM, 无法加载: CSP denied')
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
      recognize: vi.fn(() => ''), recognizeHud: vi.fn(() => JSON.stringify(failedHud())) }
    const engine = await createWorkerEngine({ load: async () => wasm, now: () => now += 3 })
    expect(engine.backend).toBe('wasm')
    expect(engine.handle(frame)).toBeNull()
    engine.handle({ type: 'configure', generation: 2, profile })
    const result = engine.handle(frame) as ResultMessage
    expect(result.elapsedMs).toBe(3)
    expect(wasm.recognizeHud).toHaveBeenCalledWith(new Uint8Array(16), 2, 2, JSON.stringify(profile), '')
    engine.handle({ type: 'cancel', generation: 3 })
    expect(engine.handle(frame)).toBeNull()
    expect(wasm.recognizeHud).toHaveBeenCalledTimes(1)
  })
  it('restores structured-cloneable typed arrays and labels the debug backend', () => {
    const debug = { gray: {data:[0,255,0,0],width:2,height:2}, roiPixels: { x: 0, y: 0, width: 2, height: 2 }, binary: { data: [0,255,0,0], width: 2, height: 2 },
      boxes: [], projection: [0,1], inkRatio: .25, matches: [], normalized: [[0,255]] }
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '', recognizeHud: () => JSON.stringify(failedHud(debug)) }, () => 0)
    engine.handle({ type: 'configure', generation: 2, profile })
    const result = engine.handle(frame) as ResultMessage
    expect(result.backend).toBe('wasm')
    expect(result.hud?.fields.clock.debug).toEqual(result.debug)
    expect(result.debug?.binary.data).toEqual(Uint8Array.of(0,255,0,0))
    expect(result.debug?.normalized).toEqual([Uint8Array.of(0,255)])
    expect((engine.handle({ ...frame, wantDebug: false }) as ResultMessage).debug).toBeNull()
  })
  it('rejects truncated buffers and catches WASM runtime errors without wedging the queue', () => {
    const recognize = vi.fn(() => { throw new Error('bad frame') })
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '', recognizeHud: recognize }, () => 0)
    expect(engine.handle({ ...frame, generation: -1 })).toMatchObject({ type: 'error' })
    engine.handle({ type: 'configure', generation: 2, profile })
    expect((engine.handle({ ...frame, pixels: new ArrayBuffer(1) }) as ResultMessage).outcome)
      .toEqual({ status: 'failed', reason: 'decode-failed', detail: '帧数据长度不足' })
    expect(recognize).not.toHaveBeenCalled()
    expect((engine.handle(frame) as ResultMessage).outcome).toEqual({ status: 'failed', reason: 'decode-failed', detail: 'bad frame' })
  })

  it('resets image-change timing between equal-sized layouts and across unresolved frames', () => {
    const debug = { gray: { data: [0, 255, 0, 0], width: 2, height: 2 },
      binary: { data: [0, 255, 0, 0], width: 2, height: 2 }, roiPixels: { x: 0, y: 0, width: 2, height: 2 },
      boxes: [], projection: [], inkRatio: .25, matches: [], normalized: [] }
    let layout: string | null = 'top'
    let fresh = true
    const detector = {
      push: vi.fn((_gray: Uint8Array, _width: number, _height: number, time: number) => {
        const result = fresh ? null : { lastUnchanged: time - .1, firstChanged: time, tickTime: time - .05, change: .5, noiseFloor: 0 }
        fresh = false
        return JSON.stringify(result)
      }),
      reset: vi.fn(() => { fresh = true }), free: vi.fn(),
    }
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '',
      recognizeHud: () => JSON.stringify({ ...failedHud(layout === null ? null : debug), variantId: layout }),
      createTickDetector: () => detector }, () => 0)
    engine.handle({ type: 'configure', generation: 2, profile })
    const push = (id: string | null, time: number) => {
      layout = id
      return engine.handle({ ...frame, mediaTime: time }) as ResultMessage
    }
    expect(push('top', 1).tickMoment).toBeUndefined()
    expect(push('top', 2).tickMoment).toBeDefined()
    expect(push('bottom', 3).tickMoment).toBeUndefined()
    expect(push(null, 4).tickMoment).toBeUndefined()
    expect(push('bottom', 5).tickMoment).toBeUndefined()
    expect(push('bottom', 6).tickMoment).toBeDefined()
    expect(detector.reset).toHaveBeenCalledTimes(3)
  })

  it('resets tick timing after a crop resize or backwards media time and frees it on cancellation', () => {
    let width = 2
    let fresh = true
    const detector = {
      push: vi.fn((_gray: Uint8Array, _width: number, _height: number, time: number) => {
        const result = fresh ? null : { lastUnchanged: time - .1, firstChanged: time, tickTime: time - .05, change: .5, noiseFloor: 0 }
        fresh = false
        return JSON.stringify(result)
      }),
      reset: vi.fn(() => { fresh = true }), free: vi.fn(),
    }
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '',
      recognizeHud: () => JSON.stringify(failedHud({
        gray: { data: Array(width * 2).fill(255), width, height: 2 },
        binary: { data: Array(width * 2).fill(255), width, height: 2 },
        roiPixels: { x: 0, y: 0, width, height: 2 },
        boxes: [], projection: [], inkRatio: 1, matches: [], normalized: [],
      })), createTickDetector: () => detector }, () => 0)
    engine.handle({ type: 'configure', generation: 2, profile })
    const push = (time: number) => engine.handle({ ...frame, mediaTime: time }) as ResultMessage
    expect(push(10).tickMoment).toBeUndefined()
    expect(push(10.1).tickMoment).toBeDefined()
    width = 3
    expect(push(10.2).tickMoment).toBeUndefined()
    expect(push(10.3).tickMoment).toBeDefined()
    expect(push(9).tickMoment).toBeUndefined()
    expect(detector.reset).toHaveBeenCalledTimes(2)
    engine.handle({ type: 'cancel', generation: 3 })
    expect(detector.free).toHaveBeenCalledTimes(1)
    expect(engine.handle(frame)).toBeNull()
  })
})
