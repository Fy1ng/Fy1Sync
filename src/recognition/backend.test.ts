import { describe, expect, it, vi } from 'vitest'
import { BASIC_CLOCK_PROFILE, type BasicClockProfile } from '../core/activeProfile'
import { createWorkerEngine, WasmWorkerEngine } from './backend'
import { RecognitionEngine } from './engine'
import type { FrameMessage, ResultMessage, WorkerRequest } from './protocol'
const configure: WorkerRequest = { type: 'configure', generation: 2, profile: BASIC_CLOCK_PROFILE }
const frame: FrameMessage = { type: 'frame', generation: 2, role: 'official', frameIndex: 7,
  width: 2, height: 2, pixels: new ArrayBuffer(16), mediaTime: 1, wallTime: 2000, wantDebug: true }

describe('Worker backend selection', () => {

  it.each(['locate', 'learn'])('ignores a removed %s request', type => {
    const engine = new WasmWorkerEngine({ }, () => 0)
    const obsolete = { type, generation: 5, requestId: 1, frames: [] } as unknown as WorkerRequest
    expect(engine.handle(obsolete)).toBeNull()
    expect(new RecognitionEngine().handle(obsolete)).toBeNull()
  })

  it('reports a missing WASM capability after instantiation fails', async () => {
    const report = vi.fn()
    const engine = await createWorkerEngine({ load: async () => { throw new Error('CSP denied') }, now: () => 0, report })
    expect(engine.backend).toBe('typescript')
    expect(report).toHaveBeenCalledWith('typescript', 'CSP denied')
    const reference = new RecognitionEngine(() => 0, '倒计时识别需要 Rust/WASM，无法加载：CSP denied')
    expect(engine.handle(configure)).toEqual(reference.handle(configure))
    expect(engine.handle(frame)).toEqual(reference.handle(frame))
  })
  it('honors the explicit TypeScript switch without loading WASM', async () => {
    const load = vi.fn()
    const engine = await createWorkerEngine({ preferred: 'typescript', load })
    expect(engine.backend).toBe('typescript')
    expect(load).not.toHaveBeenCalled()
  })
})

describe('basic countdown worker', () => {
  const templates = () => Object.fromEntries([... '0123456789:'].map(char => [char, ['AA==']]))
  const nativeResult = { outcome: { status: 'indeterminate', reason: 'basic-clock-confirming' }, debug: null,
    basic: { status: 'confirming', mode: 'auto', roi: { x: .4, y: .05, w: .15, h: .07 }, text: '1:23' } }

  function basicEngine(active: BasicClockProfile = BASIC_CLOCK_PROFILE) {
    const instances: Array<{ push: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; resetTiming: ReturnType<typeof vi.fn>; free: ReturnType<typeof vi.fn>; setRoi: ReturnType<typeof vi.fn>; setSearchRoi: ReturnType<typeof vi.fn>; setRoiPreservingCache: ReturnType<typeof vi.fn> }> = []
    const createBasicClockRecognizer = vi.fn(() => {
      const instance = { push: vi.fn(() => JSON.stringify(nativeResult)), reset: vi.fn(), resetTiming: vi.fn(), free: vi.fn(), setRoi: vi.fn(), setSearchRoi: vi.fn(), setRoiPreservingCache: vi.fn() }
      instances.push(instance)
      return instance
    })
    const engine = new WasmWorkerEngine({ createBasicClockRecognizer }, () => 0, templates)
    engine.handle({ type: 'configure', generation: 2, profile: active })
    return { engine, instances, createBasicClockRecognizer }
  }

  it('uses independent automatic recognizers without HUD configuration or content gates', () => {
    const bench = basicEngine()
    expect(bench.engine.handle(frame)).toMatchObject({ type: 'result', generation: 2, outcome: nativeResult.outcome,
      basic: nativeResult.basic, backend: 'wasm' })
    bench.engine.handle({ ...frame, role: 'commentary' })
    expect(bench.instances).toHaveLength(2)
    for (const instance of bench.instances) expect(instance.setRoi).toHaveBeenCalledWith('null')
    for (const instance of bench.instances) expect(instance.setSearchRoi).toHaveBeenCalledWith('null')
    expect(bench.createBasicClockRecognizer).toHaveBeenCalledWith(JSON.stringify(templates()))
  })

  it('bounds automatic discovery with the selected search ROI and exposes its actual configuration', () => {
    const searchRoi = { x: .15, y: .05, w: .7, h: .25 }
    const bench = basicEngine({ ...BASIC_CLOCK_PROFILE, searchRoi })
    const result = bench.engine.handle(frame) as ResultMessage
    expect(bench.instances[0]!.setSearchRoi).toHaveBeenCalledExactlyOnceWith(JSON.stringify(searchRoi))
    expect(bench.instances[0]!.setRoi).toHaveBeenCalledWith('null')
    expect(result.basic).toMatchObject({ mode: 'auto', searchRoi })
  })

  it('does not silently search the full frame when bounded discovery is unsupported', () => {
    const recognizer = { push: vi.fn(() => JSON.stringify(nativeResult)), reset: vi.fn(), free: vi.fn() }
    const engine = new WasmWorkerEngine({
      createBasicClockRecognizer: () => recognizer }, () => 0, templates)
    engine.handle({ type: 'configure', generation: 2,
      profile: { ...BASIC_CLOCK_PROFILE, searchRoi: { x: .1, y: .1, w: .8, h: .3 } } })
    expect(engine.handle(frame)).toMatchObject({ outcome: { status: 'failed', detail: expect.stringContaining('不支持倒计时搜索范围') } })
    expect(recognizer.push).not.toHaveBeenCalled()
    expect(recognizer.free).toHaveBeenCalledTimes(1)
  })

  it('does not reset native countdown history for a duplicate media timestamp', () => {
    const bench = basicEngine()
    bench.engine.handle(frame)
    bench.engine.handle({ ...frame, frameIndex: 8 })
    expect(bench.instances[0]!.reset).not.toHaveBeenCalled()
    expect(bench.instances[0]!.push).toHaveBeenCalledTimes(2)
  })

  it('turns a WASM trap into one explicit worker failure rather than retrying frame recognition', () => {
    const bench = basicEngine()
    bench.engine.handle(frame)
    bench.instances[0]!.push.mockImplementation(() => { throw new WebAssembly.RuntimeError('unreachable') })
    expect(bench.engine.handle({ ...frame, mediaTime: 1.1 })).toMatchObject({ type: 'error', message: '识别计算失败：unreachable' })
  })

  it('installs the selected manual ROI on each source and clears it when auto mode is selected', () => {
    const roi = { x: .2, y: .1, w: .3, h: .2 }
    const bench = basicEngine({ ...BASIC_CLOCK_PROFILE, roi })
    bench.engine.handle(frame)
    bench.engine.handle({ ...frame, role: 'commentary' })
    for (const instance of bench.instances) expect(instance.setRoi).toHaveBeenCalledWith(JSON.stringify(roi))
    bench.engine.handle({ type: 'cancel', generation: 3 })
    expect(bench.instances[0]!.setRoi).toHaveBeenCalledTimes(1)
    bench.engine.handle({ type: 'configure', generation: 4, profile: BASIC_CLOCK_PROFILE })
    bench.engine.handle({ ...frame, generation: 4 })
    expect(bench.instances[2]!.setRoi).toHaveBeenCalledWith('null')
  })

  it('reads a remembered ROI through the fixed native region and keeps its origin through resets', () => {
    const roi = { x: .2, y: .1, w: .3, h: .2 }
    const bench = basicEngine({ ...BASIC_CLOCK_PROFILE, roi, roiOrigin: 'memory' })
    const result = bench.engine.handle(frame) as ResultMessage
    expect(bench.instances[0]!.setRoi).toHaveBeenCalledExactlyOnceWith(JSON.stringify(roi))
    expect(result.basic).toMatchObject({ mode: 'memory', status: nativeResult.basic.status, roi: nativeResult.basic.roi })
    expect(result.outcome).toEqual(nativeResult.outcome)
    bench.engine.handle({ type: 'cancel', generation: 3 })
    expect((bench.engine.handle({ ...frame, generation: 3, mediaTime: 2 }) as ResultMessage).basic?.mode).toBe('memory')
    expect(bench.instances[0]!.setRoi).toHaveBeenCalledTimes(1)
    expect(bench.instances[0]!.reset).toHaveBeenCalledTimes(1)
  })

  it('does not label an automatic search as memory when no remembered ROI is supplied', () => {
    const bench = basicEngine({ ...BASIC_CLOCK_PROFILE, roiOrigin: 'memory' })
    expect((bench.engine.handle(frame) as ResultMessage).basic?.mode).toBe('auto')
    expect(bench.instances[0]!.setRoi).toHaveBeenCalledWith('null')
  })

  it.each(['manual', 'memory'] as const)('reports unsupported %s selection rather than falling back to automatic detection', roiOrigin => {
    const recognizer = { push: vi.fn(() => JSON.stringify(nativeResult)), reset: vi.fn(), free: vi.fn() }
    const engine = new WasmWorkerEngine({
      createBasicClockRecognizer: () => recognizer }, () => 0, templates)
    engine.handle({ type: 'configure', generation: 2,
      profile: { ...BASIC_CLOCK_PROFILE, roiOrigin, roi: { x: .2, y: .1, w: .3, h: .2 } } })
    expect(engine.handle(frame)).toMatchObject({ outcome: { status: 'failed', detail: expect.stringContaining(roiOrigin === 'memory' ? '不支持记忆倒计时区域' : '不支持手动倒计时区域') } })
    expect(recognizer.push).not.toHaveBeenCalled()
    expect(recognizer.free).toHaveBeenCalledTimes(1)
  })

  it('retains confirmed state only for a completed sampling window and rejects old responses', () => {
    const bench = basicEngine()
    bench.engine.handle(frame)
    bench.engine.handle({ type: 'cancel', generation: 3, preserveBasic: true })
    expect(bench.engine.handle(frame)).toBeNull()
    bench.engine.handle({ ...frame, generation: 3, mediaTime: 1.5 })
    expect(bench.instances).toHaveLength(1)
    expect(bench.instances[0]!.reset).not.toHaveBeenCalled()
    bench.engine.handle({ type: 'cancel', generation: 4 })
    expect(bench.instances[0]!.reset).toHaveBeenCalledTimes(1)
    bench.engine.handle({ ...frame, generation: 4, mediaTime: 1.6 })
    expect(bench.instances[0]!.push).toHaveBeenCalledTimes(3)
  })

  it('restores byte arrays in requested basic debug output without sending them during normal sampling', () => {
    const bench = basicEngine()
    bench.engine.handle(frame)
    bench.instances[0]!.push.mockReturnValue(JSON.stringify({ ...nativeResult,
      basic: { ...nativeResult.basic, preview: { width: 2, height: 1, data: [12, 224] },
        candidates: [{ x: .4, y: .05, w: .15, h: .07 }], threshold: 160 }, debug: {
      binary: { data: [0, 255], width: 2, height: 1 }, normalized: [[255, 0]],
      roiPixels: { x: 0, y: 0, width: 2, height: 1 }, boxes: [], projection: [], inkRatio: .5, matches: [],
    } }))
    const result = bench.engine.handle({ ...frame, mediaTime: 1.1 }) as ResultMessage
    expect(result.debug?.binary.data).toEqual(Uint8Array.of(0, 255))
    expect(result.debug?.normalized).toEqual([Uint8Array.of(255, 0)])
    expect(result.basic?.preview?.data).toEqual(Uint8Array.of(12, 224))
    expect(result.basic).toMatchObject({ mediaTime: 1.1, inputSize: { width: 2, height: 2 }, threshold: 160 })
    const normal = bench.engine.handle({ ...frame, mediaTime: 1.2, wantDebug: false }) as ResultMessage
    expect(normal.debug).toBeNull()
    expect(normal.basic?.preview).toBeUndefined()
  })

  it('reconfirms after a long gap, backwards time or size change, and frees state on a mode change', () => {
    const bench = basicEngine()
    bench.engine.handle(frame)
    bench.engine.handle({ ...frame, mediaTime: 4 })
    bench.engine.handle({ ...frame, mediaTime: 3 })
    bench.engine.handle({ ...frame, mediaTime: 3.1, width: 3, pixels: new ArrayBuffer(24) })
    expect(bench.instances[0]!.resetTiming).toHaveBeenCalledTimes(2)
    expect(bench.instances[0]!.reset).toHaveBeenCalledTimes(1)
    bench.engine.handle({ type: 'configure', generation: 3, profile: { ...BASIC_CLOCK_PROFILE, roi: { x: 0, y: 0, w: 1, h: 1 } } })
    expect(bench.instances[0]!.free).toHaveBeenCalledTimes(1)
  })

  it('reports missing basic WASM capability and missing digit templates explicitly', () => {
    const wasm = { }
    const engine = new WasmWorkerEngine(wasm, () => 0, templates)
    expect(() => engine.handle({ type: 'configure', generation: 2, profile: BASIC_CLOCK_PROFILE })).toThrow('不支持基础倒计时识别')
    const incomplete = new WasmWorkerEngine({ ...wasm, createBasicClockRecognizer: () => { throw new Error('unused') } }, () => 0, () => ({}))
    expect(() => incomplete.handle({ type: 'configure', generation: 2, profile: BASIC_CLOCK_PROFILE })).toThrow('数字字形不可用')
    expect(new RecognitionEngine().handle({ type: 'configure', generation: 2, profile: BASIC_CLOCK_PROFILE }))
      .toMatchObject({ type: 'error', message: expect.stringContaining('Rust/WASM') })
  })
})
