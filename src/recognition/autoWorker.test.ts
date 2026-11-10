import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHudPreprocess } from '../core/hudPreprocess'
import { createEmptyHudStylePack } from '../core/hudStylePack'
import { CLOCK_GLYPHS, createFrame, drawText, renderGlyphMask } from '../test/glyphFont'
import { BasicClockRecognizer, RecognitionEngine, TickMomentDetector, initSync, recognize_hud_frame } from '../wasm/pkg/stream_syncer_wasm.js'
import { WasmWorkerEngine } from './backend'
import type { BasicClockProgress, ResultMessage, WorkerResponse } from './protocol'
import { BASIC_CLOCK_PROFILE } from '../core/activeProfile'
import { normalizeGlyph } from '../core/imageOps'
import { packBitmap } from '../core/bitmapCodec'
import { ClockJumpDetector } from '../core/clockJump'
import { FrameGrabber } from './frameGrabber'
import { RecognitionSampler } from './sampler'
import type { WorkerLike } from './client'

initSync({ module: readFileSync(join(process.cwd(), 'src/wasm/pkg/stream_syncer_wasm_bg.wasm')) })

function frame(value: number, width = 320, height = 180) {
  const image = createFrame(width, height)
  drawText(image, `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`, 74, 103, { scale: 2 })
  return image
}

describe('manual HUD worker tick timing', () => {
  it('keeps real native manual-clock recognition producing sampler jumps while debug is toggled', async () => {
    vi.useFakeTimers()
    const priors = Object.fromEntries(CLOCK_GLYPHS.map(char => [char, [packBitmap(normalizeGlyph(renderGlyphMask(char, 6)))]]))
    const instances: BasicClockRecognizer[] = []
    const engine = new WasmWorkerEngine({ configure: () => '{}', recognize: () => '',
      createBasicClockRecognizer: templates => {
        const native = new BasicClockRecognizer(templates)
        instances.push(native)
        return { push: (...args) => native.push(...args), reset: () => native.reset(), free: () => native.free(),
          resetTiming: () => native.reset_timing(), setRoiPreservingCache: roi => native.set_roi_preserving_layout(roi),
          setRoi: roi => native.set_roi(roi), setSearchRoi: roi => native.set_search_roi(roi) }
      } }, () => Date.now(), () => priors)
    const video = { videoWidth: 320, videoHeight: 180, readyState: 4, currentTime: 0, playbackRate: 1 } as HTMLVideoElement
    const capture = vi.spyOn(FrameGrabber.prototype, 'grabScaledAsync').mockImplementation(async (_video, _roi, _width, mediaTime = 0) => {
      const image = frame(65 - Math.floor(mediaTime + 1e-9))
      return { ok: true, frame: { pixels: image.data, width: image.width, height: image.height,
        mediaTime, wallTime: 50_000 + mediaTime * 1000 } }
    })
    let tick: (time: number) => void = () => {}
    const listeners = new Set<(event: MessageEvent<WorkerResponse>) => void>()
    const worker: WorkerLike = {
      postMessage: request => { queueMicrotask(() => {
        const response = engine.handle(request)
        if (response) for (const listener of listeners) listener({ data: response } as MessageEvent<WorkerResponse>)
      }) },
      addEventListener: (type, listener) => { if (type === 'message') listeners.add(listener as (event: MessageEvent<WorkerResponse>) => void) },
      removeEventListener: (type, listener) => { if (type === 'message') listeners.delete(listener as (event: MessageEvent<WorkerResponse>) => void) },
      terminate: () => { listeners.clear() },
    }
    let debug = true
    const progress: BasicClockProgress[] = []
    const errors: string[] = []
    const detector = new ClockJumpDetector('official')
    const jumps: number[] = []
    const sampler = new RecognitionSampler({ createWorker: () => worker, video: role => role === 'official' ? video : null,
      profile: role => role === 'official' ? { ...BASIC_CLOCK_PROFILE, roi: { x: 70 / 320, y: 99 / 180, w: 54 / 320, h: 22 / 180 } } : null,
      frameLoop: (_video, _fps, onFrame) => { tick = onFrame; return () => { tick = () => {} } },
      wantBasicDebug: () => debug, onBasicProgress: (_role, value) => progress.push(value),
      onError: (_role, message) => errors.push(message) })
    const signal = { aborted: false }
    try {
      const run = sampler.sample(8000, (_role, outcome) => { const event = detector.push(outcome).event; if (event) jumps.push(event.toSeconds) }, signal)
      for (let index = 0; index <= 210; index++) {
        if (index === 120) debug = false
        tick(index / 30)
        for (let flush = 0; flush < 10; flush++) await Promise.resolve()
        await vi.advanceTimersByTimeAsync(1000 / 30)
      }
      expect(errors).toEqual([])
      expect(instances).toHaveLength(1)
      expect(jumps.length).toBeGreaterThanOrEqual(3)
      expect(progress.some(value => value.visual?.debug != null)).toBe(true)
      expect(progress.at(-1)!.sync?.jumps).toBeGreaterThanOrEqual(3)
      expect(progress.at(-1)!.sync?.readings).toBeGreaterThan(10)
      signal.aborted = true
      await vi.advanceTimersByTimeAsync(50)
      await run
    } finally { sampler.dispose(); capture.mockRestore(); for (const native of instances) native.free(); vi.useRealTimers() }
  })

  it('keeps per-source pixel brackets when matching fails and resets after seek, cancel and configuration change', () => {
    const recognition = new RecognitionEngine()
    const engine = new WasmWorkerEngine({
      configure: profile => recognition.configure(profile),
      recognize: (...args) => recognition.recognize(...args),
      recognizeHud: recognize_hud_frame,
      createTickDetector: () => new TickMomentDetector(),
    }, () => 0)
    const pack = createEmptyHudStylePack('manual/tick-test', '手动样式测试', { width: 320, height: 180 })
    const clock = pack.variants[0]!.fields.clock!
    clock.roi = { x: 70, y: 99, w: 54, h: 22 }
    clock.preprocess = createHudPreprocess({ scale: 1, threshold: 120, invert: false })
    const push = (role: 'official' | 'commentary', value: number, time: number, generation = 1, width = 320, height = 180) => {
      const image = frame(value, width, height)
      return engine.handle({ type: 'frame', generation, role, frameIndex: 1,
        width, height, mediaTime: time, wallTime: 50_000 + time * 1000,
        pixels: image.data.buffer as ArrayBuffer, wantDebug: false }) as ResultMessage
    }
    try {
      engine.handle({ type: 'configure', generation: 1, profile: pack })
      expect(push('official', 65, 100).tickMoment).toBeUndefined()
      expect(push('commentary', 65, 500).tickMoment).toBeUndefined()
      const changed = push('official', 64, 100.1)
      expect(changed.outcome).toMatchObject({ status: 'failed', reason: 'insufficient-templates' })
      expect(changed.tickMoment).toMatchObject({ lastUnchanged: 100, firstChanged: 100.1, midpoint: 100.05 })
      expect(push('commentary', 64, 500.2).tickMoment).toMatchObject({ midpoint: 500.1 })
      expect(push('official', 63, 10).tickMoment).toBeUndefined()

      engine.handle({ type: 'cancel', generation: 2 })
      expect(push('official', 62, 11, 2).tickMoment).toBeUndefined()
      expect(push('official', 61, 11.1, 2).tickMoment).toBeDefined()

      const resized = structuredClone(pack)
      resized.variants[0]!.nativeSize = { width: 640, height: 360 }
      engine.handle({ type: 'configure', generation: 3, profile: resized })
      expect(push('official', 60, 12, 3, 640, 360).tickMoment).toBeUndefined()
    } finally {
      engine.handle({ type: 'cancel', generation: 999 })
      recognition.free()
    }
  })
})
