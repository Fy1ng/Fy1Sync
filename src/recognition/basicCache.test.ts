import { describe, expect, it, vi } from 'vitest'
import { BASIC_CLOCK_PROFILE, type BasicClockProfile } from '../core/activeProfile'
import { WasmWorkerEngine } from './backend'
import type { FrameMessage, ResultMessage } from './protocol'

const roi = { x: .4, y: .05, w: .15, h: .07 }
const searchRoi = { x: .1, y: 0, w: .8, h: .3 }
const frame: FrameMessage = { type: 'frame', generation: 1, role: 'official', frameIndex: 1,
  width: 2, height: 2, pixels: new ArrayBuffer(16), mediaTime: 10, wallTime: 10000, wantDebug: false }

function cacheEngine(profile: BasicClockProfile = { ...BASIC_CLOCK_PROFILE, searchRoi }) {
  const templates = vi.fn(() => Object.fromEntries([...'0123456789:'].map(char => [char, ['AA==']])))
  const instances: ReturnType<typeof createRecognizer>[] = []
  function createRecognizer() {
    return { reset: vi.fn(), resetTiming: vi.fn(), free: vi.fn(), setRoi: vi.fn(), setSearchRoi: vi.fn(),
      setRoiPreservingCache: vi.fn(), push: vi.fn(() => JSON.stringify({
        outcome: { status: 'success', reading: { text: '1:23', seconds: 83, confidence: 1, scores: [1, 1, 1, 1],
          mediaTime: 10, wallTime: 10000, frameIndex: 1 } },
        basic: { status: 'locked', mode: 'auto', roi, text: '1:23' }, debug: null,
      })) }
  }
  const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '',
    createBasicClockRecognizer: () => { const recognizer = createRecognizer(); instances.push(recognizer); return recognizer } }, () => 0, templates)
  engine.handle({ type: 'configure', generation: 1, profile })
  engine.handle(frame)
  return { engine, instances, templates }
}

describe('verified basic layout cache boundaries', () => {
  it('uses timing reset for a playback interruption and preserves ordinary window history', () => {
    const bench = cacheEngine()
    bench.engine.handle({ type: 'cancel', generation: 2, preserveBasic: true, resetTiming: true })
    expect(bench.instances[0]!.resetTiming).toHaveBeenCalledTimes(1)
    expect(bench.instances[0]!.reset).not.toHaveBeenCalled()
    expect(bench.engine.handle(frame)).toBeNull()
    bench.engine.handle({ ...frame, generation: 2, mediaTime: 40 })
    expect(bench.instances[0]!.resetTiming).toHaveBeenCalledTimes(1)
    bench.engine.handle({ type: 'cancel', generation: 3, preserveBasic: true })
    bench.engine.handle({ ...frame, generation: 3, mediaTime: 40.1 })
    expect(bench.instances).toHaveLength(1)
    expect(bench.instances[0]!.resetTiming).toHaveBeenCalledTimes(1)
    expect(bench.instances[0]!.free).not.toHaveBeenCalled()
    bench.engine.handle({ type: 'cancel', generation: 4, resetTiming: true })
    expect(bench.instances[0]!.reset).toHaveBeenCalledTimes(1)
  })

  it('keeps native recognizers and glyph priors when the exact discovered ROI becomes memory', () => {
    const bench = cacheEngine()
    const configured = bench.engine.handle({ type: 'configure', generation: 2, preserveBasic: true,
      profile: { ...BASIC_CLOCK_PROFILE, searchRoi, roi: { ...roi }, roiOrigin: 'memory' } })
    expect(configured).toMatchObject({ type: 'configured', ready: true, sampleCount: 11 })
    const result = bench.engine.handle({ ...frame, generation: 2, mediaTime: 10.1 }) as ResultMessage
    expect(result.basic?.mode).toBe('memory')
    expect(bench.instances).toHaveLength(1)
    expect(bench.templates).toHaveBeenCalledTimes(1)
    expect(bench.instances[0]!.setRoiPreservingCache).toHaveBeenCalledExactlyOnceWith(JSON.stringify(roi))
    expect(bench.instances[0]!.setRoi).toHaveBeenCalledExactlyOnceWith('null')
    expect(bench.instances[0]!.resetTiming).not.toHaveBeenCalled()
    expect(bench.instances[0]!.reset).not.toHaveBeenCalled()
    expect(bench.instances[0]!.free).not.toHaveBeenCalled()
  })

  it.each([
    { ...BASIC_CLOCK_PROFILE, searchRoi, roi, roiOrigin: 'manual' as const },
    { ...BASIC_CLOCK_PROFILE, searchRoi, roi: { ...roi, y: .1 }, roiOrigin: 'memory' as const },
    { ...BASIC_CLOCK_PROFILE, searchRoi: { ...searchRoi, w: .7 }, roi, roiOrigin: 'memory' as const },
  ])('rebuilds incompatible selection even when preservation is requested: %j', profile => {
    const bench = cacheEngine()
    bench.engine.handle({ type: 'configure', generation: 2, preserveBasic: true, profile })
    bench.engine.handle({ ...frame, generation: 2 })
    expect(bench.instances).toHaveLength(2)
    expect(bench.instances[0]!.free).toHaveBeenCalledTimes(1)
    expect(bench.instances[0]!.setRoiPreservingCache).not.toHaveBeenCalled()
    expect(bench.templates).toHaveBeenCalledTimes(2)
  })

  it('does not treat an unconfirmed candidate as a reusable memory layout', () => {
    const bench = cacheEngine()
    bench.engine.handle({ type: 'cancel', generation: 2 })
    bench.instances[0]!.push.mockReturnValue(JSON.stringify({ outcome: { status: 'indeterminate', reason: 'basic-clock-confirming' },
      basic: { status: 'confirming', mode: 'auto', roi }, debug: null }))
    bench.engine.handle({ ...frame, generation: 2 })
    bench.engine.handle({ type: 'configure', generation: 3, preserveBasic: true,
      profile: { ...BASIC_CLOCK_PROFILE, searchRoi, roi, roiOrigin: 'memory' } })
    bench.engine.handle({ ...frame, generation: 3 })
    expect(bench.instances).toHaveLength(2)
    expect(bench.instances[0]!.setRoiPreservingCache).not.toHaveBeenCalled()
  })

  it('rebuilds safely when native layout validation rejects a stale memory promotion', () => {
    const bench = cacheEngine()
    bench.instances[0]!.setRoiPreservingCache.mockImplementation(() => { throw new Error('stale ROI') })
    bench.engine.handle({ type: 'configure', generation: 2, preserveBasic: true,
      profile: { ...BASIC_CLOCK_PROFILE, searchRoi, roi, roiOrigin: 'memory' } })
    bench.engine.handle({ ...frame, generation: 2 })
    expect(bench.instances).toHaveLength(2)
    expect(bench.instances[0]!.free).toHaveBeenCalledTimes(1)
    expect(bench.instances[1]!.setRoi).toHaveBeenCalledExactlyOnceWith(JSON.stringify(roi))
  })

  it('keeps layout for same-sized seeks and gaps but resets it after source dimensions change', () => {
    const bench = cacheEngine()
    bench.engine.handle({ ...frame, mediaTime: 9 })
    bench.engine.handle({ ...frame, mediaTime: 20 })
    expect(bench.instances[0]!.resetTiming).toHaveBeenCalledTimes(2)
    expect(bench.instances[0]!.reset).not.toHaveBeenCalled()
    bench.engine.handle({ ...frame, width: 3, pixels: new ArrayBuffer(24), mediaTime: 20.1 })
    expect(bench.instances[0]!.reset).toHaveBeenCalledTimes(1)
    bench.instances[0]!.push.mockReturnValue(JSON.stringify({ outcome: { status: 'failed', reason: 'no-candidates' },
      basic: { status: 'searching', mode: 'auto' }, debug: null }))
    bench.engine.handle({ ...frame, width: 3, pixels: new ArrayBuffer(24), mediaTime: 20.2 })
    bench.engine.handle({ type: 'configure', generation: 2, preserveBasic: true,
      profile: { ...BASIC_CLOCK_PROFILE, searchRoi, roi: { ...roi, x: .3 }, roiOrigin: 'memory' } })
    expect(bench.instances[0]!.free).toHaveBeenCalledTimes(1)
  })
})
