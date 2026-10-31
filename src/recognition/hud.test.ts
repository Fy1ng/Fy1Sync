import { describe, expect, it, vi } from 'vitest'
import { packBitmap } from '../core/bitmapCodec'
import { normalizeGlyph } from '../core/imageOps'
import { CLOCK_CHARS } from '../core/profileSchema'
import { createEmptyHudStylePack, parseHudStylePack } from '../core/hudStylePack'
import { hudFrameFromJson, recognizeHudFrame } from '../core/hudWasm'
import { createFrame, drawText, renderGlyphMask } from '../test/glyphFont'
import { WasmRecognitionEngine } from '../wasm/test-helpers'
import { recognize_hud_frame } from '../wasm/pkg/stream_syncer_wasm.js'
import { createWorkerEngine, WasmWorkerEngine, type WasmEngine } from './backend'
import type { ActiveProfile } from '../core/activeProfile'
import { FrameGrabber, FULL_FRAME_ROI } from './frameGrabber'
import type { WorkerLike } from './client'
import type { FrameMessage, ResultMessage, WorkerRequest, WorkerResponse } from './protocol'
import { RecognitionSampler } from './sampler'

function fixture() {
  const frame = createFrame(640, 360)
  drawText(frame, '1:37', 280, 20, { scale: 6 })
  const pack = createEmptyHudStylePack('cs2/hud-test', '统一入口测试', { width: frame.width, height: frame.height })
  const variant = pack.variants[0]!
  const clock = variant.fields.clock!
  clock.roi = { x: 274, y: 14, w: 150, h: 54 }
  clock.preprocess = { scale: 1.6, threshold: 120, invert: false }
  for (const char of CLOCK_CHARS) {
    const id = `clock-${char === ':' ? 'colon' : char}`
    pack.bitmaps[id] = { width: 32, height: 48, data: packBitmap(normalizeGlyph(renderGlyphMask(char, 6))) }
    clock.glyphs[char] = [id]
  }
  pack.bitmaps.mark = { width: 3, height: 3, data: packBitmap(Uint8Array.of(255, 0, 255, 0, 255, 0, 255, 0, 255)) }
  const cue = { roi: { x: 0, y: 0, w: 3, h: 3 }, preprocess: { scale: 1, threshold: 150, invert: false }, templates: ['mark'], minScore: .8 }
  variant.cues.replay = cue
  variant.states.replay = [[{ kind: 'cue', cue: 'replay', present: true }]]
  variant.states.active = [[{ kind: 'field', field: 'clock', present: true }]]
  variant.organizer = cue
  const request: FrameMessage = {
    type: 'frame', generation: 2, role: 'official', frameIndex: 11,
    mediaTime: 12.5, wallTime: 2000, width: frame.width, height: frame.height,
    pixels: frame.data.slice().buffer as ArrayBuffer, wantDebug: true,
  }
  return { pack, variant, frame, request }
}

function realEngine() {
  const recognition = new WasmRecognitionEngine()
  const wasm: WasmEngine = {
    configure: json => recognition.configure(json),
    recognize: (...args) => recognition.recognize(...args),
    recognizeHud: recognize_hud_frame,
  }
  return { recognition, wasm, engine: new WasmWorkerEngine(wasm, () => 0) }
}

describe('HUD full-frame Rust/WASM recognition', () => {
  it('returns the same reading and complete debug data in the editor and player', async () => {
    const { pack, variant, frame, request } = fixture()
    expect(parseHudStylePack(pack).issues).toEqual([])
    const { recognition, wasm, engine } = realEngine()
    const recognizeHud = vi.spyOn(wasm, 'recognizeHud')
    const oldRecognition = vi.spyOn(wasm, 'recognize')
    try {
      expect(engine.handle({ type: 'configure', generation: 2, profile: pack }))
        .toMatchObject({ type: 'configured', ready: true, missing: [], sampleCount: 11 })
      const editor = await recognizeHudFrame({ pixels: frame.data, width: frame.width, height: frame.height }, pack, variant.id)
      const direct = hudFrameFromJson(recognize_hud_frame(new Uint8Array(request.pixels), frame.width, frame.height, JSON.stringify(pack), ''))
      expect(editor).toEqual(direct)
      expect(editor.fields.clock).toMatchObject({ status: 'read', reading: { text: '1:37', value: 97 } })
      const player = engine.handle(request) as ResultMessage
      expect(player.hud).toEqual(editor)
      expect(player.outcome).toMatchObject({ status: 'success', reading: { text: '1:37', seconds: 97, mediaTime: 12.5, wallTime: 2000, frameIndex: 11 } })
      expect(player.debug).toMatchObject(editor.fields.clock.debug!)
      expect(player.hud?.fields.clock.debug?.gray.data).toBeInstanceOf(Uint8Array)
      expect(player.hud?.fields.clock.debug?.binary.data).toBeInstanceOf(Uint8Array)
      expect(player.hud?.fields.clock.debug?.boxes).toHaveLength(4)
      expect(player.hud?.fields.clock.debug?.matches).toHaveLength(4)
      expect(player.hud?.fields.clock.debug?.normalized).toHaveLength(4)
      for (const field of ['scoreLeft', 'scoreRight', 'round'] as const) {
        expect(player.hud?.fields[field]).toEqual({ status: 'failed', reason: field === 'round' ? 'score-failed' : 'not-configured', debug: null })
      }
      expect(player.hud).toMatchObject({ content: 'live', phase: 'active',
        cues: { replay: { status: 'not-matched', score: 0 } },
        states: { replay: { status: 'not-matched' }, active: { status: 'matched' } },
        organizer: { status: 'not-matched', score: 0 } })
      expect(player.hud?.cues.replay?.debug?.binary.data).toBeInstanceOf(Uint8Array)
      expect(player.hud?.organizer.debug?.gray.data).toBeInstanceOf(Uint8Array)
      expect(recognizeHud).toHaveBeenCalledOnce()
      expect(recognizeHud).toHaveBeenCalledWith(new Uint8Array(request.pixels), 640, 360, JSON.stringify(pack), '')
      expect(oldRecognition).not.toHaveBeenCalled()
    } finally { recognition.free() }
  })

  it('reads both scores and derives the round while sync still consumes only the clock', async () => {
    const { pack, variant, frame, request } = fixture()
    for (const [fieldId, text, x] of [['scoreLeft', '18', 140], ['scoreRight', '7', 460]] as const) {
      drawText(frame, text, x, 20, { scale: 6 })
      variant.fields[fieldId] = { ...structuredClone(variant.fields.clock!),
        roi: { x: x - 6, y: 14, w: 100, h: 54 }, grammar: { kind: 'integer', min: 0, max: 99 },
        glyphs: Object.fromEntries(Object.entries(variant.fields.clock!.glyphs).filter(([char]) => char !== ':')) }
    }
    request.pixels = frame.data.slice().buffer as ArrayBuffer
    const { recognition, engine } = realEngine()
    try {
      engine.handle({ type: 'configure', generation: 2, profile: pack })
      const editor = await recognizeHudFrame({ pixels: frame.data, width: frame.width, height: frame.height }, pack, variant.id)
      expect(editor.fields.scoreLeft).toMatchObject({ status: 'read', reading: { value: 18, source: 'recognized' } })
      expect(editor.fields.scoreRight).toMatchObject({ status: 'read', reading: { value: 7, source: 'recognized' } })
      expect(editor.fields.round).toMatchObject({ status: 'read', reading: { text: '26', value: 26, source: 'derived' }, debug: null })
      const player = engine.handle(request) as ResultMessage
      expect(player.hud).toEqual(editor)
      expect(player.outcome).toMatchObject({ status: 'success', reading: { text: '1:37', seconds: 97 } })
    } finally { recognition.free() }
  })

  it('syncs a clock-only pack: no replay cue reads as live, no phase rules hold nothing back', async () => {
    const { pack, variant, frame, request } = fixture()
    // A pack as auto-learning or an unfinished editor saves it: the clock and nothing else.
    variant.cues = {}
    variant.states = {}
    variant.organizer = null
    const { recognition, engine } = realEngine()
    try {
      engine.handle({ type: 'configure', generation: 2, profile: pack })
      const editor = await recognizeHudFrame({ pixels: frame.data, width: frame.width, height: frame.height }, pack, variant.id)
      expect(editor).toMatchObject({ content: 'live', phase: 'unconfigured' })
      const player = engine.handle(request) as ResultMessage
      expect(player.outcome).toMatchObject({ status: 'success', reading: { text: '1:37', seconds: 97 } })
    } finally { recognition.free() }
  })

  it('selects a layout for every player frame through real WASM and excludes unresolved layouts from sync', async () => {
    const { pack, variant: top, request } = fixture()
    top.cues = {}
    top.states = {}
    top.organizer!.roi.x = 10
    const bottom = structuredClone(top)
    bottom.id = 'bottom'
    bottom.fields.clock!.roi.y = 214
    bottom.organizer!.roi.x = 20
    pack.variants.push(bottom)
    const makeFrame = (layout: 'top' | 'bottom' | 'both' | 'none') => {
      const frame = createFrame(640, 360)
      drawText(frame, layout === 'bottom' ? '1:36' : '1:37', 280, layout === 'bottom' ? 220 : 20, { scale: 6 })
      const marks = layout === 'both' ? [10, 20] : layout === 'top' ? [10] : layout === 'bottom' ? [20] : []
      for (const x of marks) for (let pixel = 0; pixel < 9; pixel++) {
        if (pixel % 2) continue
        const offset = (Math.floor(pixel / 3) * frame.width + x + pixel % 3) * 4
        frame.data.set([255, 255, 255, 255], offset)
      }
      return frame
    }
    expect(parseHudStylePack(pack).issues).toEqual([])
    const { recognition, wasm, engine } = realEngine()
    const recognize = vi.spyOn(wasm, 'recognizeHud')
    try {
      engine.handle({ type: 'configure', generation: 2, profile: pack })
      for (const [index, layout] of (['top', 'bottom', 'none', 'both', 'top'] as const).entries()) {
        const frame = makeFrame(layout)
        const pixels = frame.data.slice().buffer as ArrayBuffer
        const player = engine.handle({ ...request, frameIndex: index, mediaTime: index,
          pixels }) as ResultMessage
        const editor = await recognizeHudFrame({ pixels: frame.data, width: 640, height: 360 }, pack)
        expect(player.hud).toEqual(editor)
        if (layout === 'top' || layout === 'bottom') {
          expect(player.hud).toMatchObject({ variantId: layout === 'top' ? top.id : bottom.id,
            selectionReason: null, content: 'live', phase: 'unconfigured' })
          expect(player.outcome).toMatchObject({ status: 'success', reading: { seconds: layout === 'top' ? 97 : 96 } })
        } else {
          expect(player.hud).toMatchObject({ variantId: null,
            selectionReason: layout === 'both' ? 'multiple-matches' : 'no-match', content: 'indeterminate', phase: 'indeterminate' })
          expect(Object.values(player.hud!.fields).every(field => field.status === 'indeterminate')).toBe(true)
          expect(player.outcome.status).toBe('indeterminate')
        }
        expect(recognize.mock.lastCall?.[0].buffer).toBe(pixels)
        expect(recognize.mock.lastCall?.slice(1)).toEqual([640, 360, JSON.stringify(pack), ''])
      }
      expect(recognize).toHaveBeenCalledTimes(5)
    } finally { recognition.free() }
  })

  it('rejects legacy v2 at configure without treating it as a session clock', () => {
    const { pack } = fixture()
    const { recognition, engine } = realEngine()
    const legacy = { schemaVersion: 2, id: 'cs2/old', name: '旧配置', roi: { x: 0, y: 0, w: 1, h: 1 },
      preprocess: { scale: 1.4, threshold: 150, invert: false }, templates: {}, clockFormat: 'm:ss',
      detectWindowSeconds: 3, sampleFps: 30, matchThreshold: .82, updatedAt: 0 }
    try {
      engine.handle({ type: 'configure', generation: 2, profile: pack })
      expect(() => engine.handle({ type: 'configure', generation: 3, profile: legacy as unknown as ActiveProfile })).toThrow(/重新制作/)
      expect(() => recognition.configure(JSON.stringify(legacy))).toThrow(/重新制作/)
    } finally { recognition.free() }
  })

  it('reports unavailable WASM explicitly and produces no TypeScript clock reading', async () => {
    const { pack, request } = fixture()
    const engine = await createWorkerEngine({ load: async () => { throw new Error('WASM unavailable') }, now: () => 0 })
    expect(engine.handle({ type: 'configure', generation: 2, profile: pack }))
      .toMatchObject({ type: 'error', message: expect.stringMatching(/Rust\/WASM/) })
    expect(engine.handle(request)).toMatchObject({ type: 'error', message: expect.stringMatching(/Rust\/WASM/) })
  })

  it('fails explicitly when an older WASM lacks the HUD entry instead of invoking its clock entry', () => {
    const { pack, request } = fixture()
    const { recognition, wasm } = realEngine()
    const oldRecognition = vi.spyOn(wasm, 'recognize')
    const engine = new WasmWorkerEngine({ configure: wasm.configure, recognize: wasm.recognize }, () => 0)
    try {
      engine.handle({ type: 'configure', generation: 2, profile: pack })
      expect((engine.handle(request) as ResultMessage).outcome)
        .toMatchObject({ status: 'failed', detail: expect.stringMatching(/WASM.*样式包/) })
      expect(oldRecognition).not.toHaveBeenCalled()
    } finally { recognition.free() }
  })

  it('captures one complete frame per sampling tick for a style pack', async () => {
    const { pack, frame } = fixture()
    const { recognition, engine } = realEngine()
    const listeners = new Set<(event: MessageEvent<WorkerResponse>) => void>()
    const sent: WorkerRequest[] = []
    const worker: WorkerLike = {
      postMessage(request) {
        sent.push(request)
        const response = engine.handle(request)
        if (response) queueMicrotask(() => listeners.forEach(listener => listener({ data: response } as MessageEvent<WorkerResponse>)))
      },
      addEventListener(type, listener) { if (type === 'message') listeners.add(listener as (event: MessageEvent<WorkerResponse>) => void) },
      removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener as (event: MessageEvent<WorkerResponse>) => void) },
      terminate() { listeners.clear() },
    }
    const grab = vi.spyOn(FrameGrabber.prototype, 'grabAsync').mockImplementation(async (_video, _roi, mediaTime) => ({
      ok: true, frame: { pixels: frame.data, width: 640, height: 360, mediaTime: mediaTime ?? 0, wallTime: 2000 },
    }))
    const video = { videoWidth: 640, videoHeight: 360, readyState: 4, currentTime: 12.5, playbackRate: 1 } as HTMLVideoElement
    let onFrame: ((time: number) => void) | undefined
    const sampler = new RecognitionSampler({
      createWorker: () => worker, profile: role => role === 'official' ? pack : null,
      video: role => role === 'official' ? video : null,
      frameLoop: (_video, _fps, callback) => { onFrame = callback; return () => {} },
    })
    const outcomes: unknown[] = []
    try {
      const run = sampler.sample(20, (_role, outcome) => outcomes.push(outcome), { aborted: false })
      onFrame!(12.5)
      await run
      expect(grab).toHaveBeenCalledOnce()
      expect(grab).toHaveBeenCalledWith(video, FULL_FRAME_ROI, 12.5)
      const frames = sent.filter((request): request is FrameMessage => request.type === 'frame')
      expect(sent.find(request => request.type === 'configure')).not.toHaveProperty('variantId')
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ width: 640, height: 360 })
      expect(frames[0]!.pixels.byteLength).toBe(640 * 360 * 4)
      expect(outcomes).toEqual([expect.objectContaining({ status: 'success', reading: expect.objectContaining({ text: '1:37', seconds: 97 }) })])
    } finally { sampler.dispose(); grab.mockRestore(); recognition.free() }
  })
})
