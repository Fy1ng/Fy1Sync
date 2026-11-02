// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFrame, drawText } from '../test/glyphFont'
import * as wasm from './pkg/stream_syncer_wasm.js'

const { TickMomentDetector, initSync } = wasm
initSync({ module: readFileSync(join(process.cwd(), 'src/wasm/pkg/stream_syncer_wasm_bg.wasm')) })

function clock(seconds: number): Uint8Array {
  const frame = createFrame(320, 180)
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  drawText(frame, text, 74, 103, { scale: 2 })
  return Uint8Array.from({ length: frame.width * frame.height }, (_, i) => frame.data[i * 4]!)
}
function crop(data: Uint8Array): Uint8Array {
  return Uint8Array.from({ length: 54 * 22 }, (_, i) => data[(99 + Math.floor(i / 54)) * 320 + 70 + i % 54]!)
}

describe('manual-pack timing APIs in the generated WASM module', () => {
  it('does not expose automatic discovery or learning APIs', () => {
    expect(wasm).not.toHaveProperty('AutoClockSession')
    expect(wasm).not.toHaveProperty('recognize_auto')
  })

  it('reports pixel-change brackets within one 59.94fps frame of each tick', () => {
    const detector = new TickMomentDetector()
    const moments: { lastUnchanged: number; firstChanged: number; tickTime: number }[] = []
    const frameTime = 1001 / 60000
    try {
      for (let i = 0; i < 180; i++) {
        const time = i * frameTime
        const decrement = time < 0.431 ? 0 : 1 + Math.floor(time - 0.431)
        const value = JSON.parse(detector.push(crop(clock(65 - decrement)), 54, 22, time))
        if (value) moments.push(value)
      }
      expect(moments).toHaveLength(3)
      moments.forEach((moment, i) => {
        const truth = 0.431 + i
        expect(moment.lastUnchanged).toBeLessThanOrEqual(truth)
        expect(moment.firstChanged).toBeGreaterThanOrEqual(truth)
        expect(moment.firstChanged - moment.lastUnchanged).toBeLessThanOrEqual(frameTime + 1e-9)
        expect(Math.abs(moment.tickTime - truth)).toBeLessThan(frameTime)
      })
      detector.reset()
      expect(JSON.parse(detector.push(crop(clock(60)), 54, 22, 0))).toBeNull()
    } finally { detector.free() }
  })

  it('rejects invalid pixel frames and time ordering without learning a profile', () => {
    const detector = new TickMomentDetector()
    try {
      expect(JSON.parse(detector.push(crop(clock(65)), 54, 22, 0))).toBeNull()
      expect(() => detector.push(new Uint8Array(1), 54, 22, 1)).toThrow()
      expect(() => detector.push(crop(clock(65)), 54, 22, Number.NaN)).toThrow()
      expect(() => detector.push(crop(clock(65)), 54, 22, 0)).toThrow()
      detector.reset()
      expect(JSON.parse(detector.push(crop(clock(65)), 54, 22, 0))).toBeNull()
    } finally { detector.free() }
  })
})
