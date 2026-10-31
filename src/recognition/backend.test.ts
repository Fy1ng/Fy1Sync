import { describe, expect, it, vi } from 'vitest'
import { createEmptyHudStylePack } from '../core/hudStylePack'
import { createWorkerEngine, WasmWorkerEngine } from './backend'
import { RecognitionEngine } from './engine'
import type { FrameMessage, ResultMessage } from './protocol'

const profile = createEmptyHudStylePack(undefined, undefined, { width: 2, height: 2 })
const failedHud = (debug: unknown = null) => ({ variantId: profile.variants[0]!.id, fields: Object.fromEntries(['clock','scoreLeft','scoreRight','round'].map(id => [id,{status:'failed',reason:'blank-frame',debug: id === 'clock' ? debug : null}])) })
const frame: FrameMessage = { type: 'frame', generation: 2, role: 'official', frameIndex: 7,
  width: 2, height: 2, pixels: new ArrayBuffer(16), mediaTime: 1, wallTime: 2000, wantDebug: true }

describe('Worker backend selection', () => {
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
    expect(wasm.recognizeHud).toHaveBeenCalledWith(new Uint8Array(16), 2, 2, JSON.stringify(profile), profile.variants[0]!.id)
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
})
