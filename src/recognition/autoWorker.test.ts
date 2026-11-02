import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHudPreprocess } from '../core/hudPreprocess'
import { createEmptyHudStylePack } from '../core/hudStylePack'
import { createFrame, drawText } from '../test/glyphFont'
import { RecognitionEngine, TickMomentDetector, initSync, recognize_hud_frame } from '../wasm/pkg/stream_syncer_wasm.js'
import { WasmWorkerEngine } from './backend'
import type { ResultMessage } from './protocol'

initSync({ module: readFileSync(join(process.cwd(), 'src/wasm/pkg/stream_syncer_wasm_bg.wasm')) })

function frame(value: number, width = 320, height = 180) {
  const image = createFrame(width, height)
  drawText(image, `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`, 74, 103, { scale: 2 })
  return image
}

describe('manual HUD worker tick timing', () => {
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
