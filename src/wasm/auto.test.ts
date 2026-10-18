// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFrame, drawText } from '../test/glyphFont'
import { validateProfile } from '../core/profileSchema'
import { AutoClockSession, RecognitionEngine, TickMomentDetector, initSync } from './pkg/stream_syncer_wasm.js'

initSync({ module: readFileSync(join(process.cwd(), 'src/wasm/pkg/stream_syncer_wasm_bg.wasm')) })
const roi = { x: 70 / 320, y: 99 / 180, w: 54 / 320, h: 22 / 180 }

function clock(seconds: number): Uint8Array {
  const frame = createFrame(320, 180)
  drawText(frame, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, 74, 103, { scale: 2 })
  return Uint8Array.from({ length: frame.width * frame.height }, (_, i) => frame.data[i * 4]!)
}
function crop(data: Uint8Array): Uint8Array {
  return Uint8Array.from({ length: 54 * 22 }, (_, i) => data[(99 + Math.floor(i / 54)) * 320 + 70 + i % 54]!)
}

describe('automatic clock APIs in the generated WASM module', () => {
  it('localises a clock away from the scoreboard position and learns a valid candidate profile', () => {
    const session = new AutoClockSession()
    try {
      for (let i = 0; i < 18 * 8; i++) session.push(clock(82 - Math.floor(i / 8)), 320, 180, i / 8)
      const candidates = JSON.parse(session.locate()) as { roi: typeof roi; period: number; eventTimes: number[] }[]
      expect(candidates.length).toBeGreaterThan(0)
      const top = candidates[0]!
      expect(top.roi.x).toBeLessThan(0.24)
      expect(top.roi.y).toBeGreaterThan(0.5)
      expect(top.roi.x + top.roi.w).toBeGreaterThan(0.37)
      expect(top.period).toBeCloseTo(1, 1)
      expect(top.eventTimes.length).toBeGreaterThanOrEqual(8)
      const learned = JSON.parse(session.learn(JSON.stringify(top.roi)))
      expect(learned.profile).not.toBeNull()
      expect(learned.learnedChars.slice().sort()).toEqual('0123456789:'.split(''))
      expect(learned.missingChars).toEqual([])
      expect(validateProfile(learned.profile).profile).not.toBeNull()
      const engine = new RecognitionEngine()
      try {
        engine.configure(JSON.stringify(learned.profile))
        for (let second = 0; second < 18; second++) {
          const gray = clock(82 - second)
          const rgba = Uint8Array.from({ length: gray.length * 4 }, (_, i) => i % 4 === 3 ? 255 : gray[Math.floor(i / 4)]!)
          const result = JSON.parse(engine.recognize(rgba, 320, 180, second, second * 1000, second, false))
          expect(result.outcome.status).toBe('success')
          expect(result.outcome.reading.seconds).toBe(82 - second)
        }
      } finally { engine.free() }
      session.reset()
      expect(JSON.parse(session.locate())).toEqual([])
    } finally { session.free() }
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

  it('rejects absent and frozen clocks and validates its input boundary', () => {
    const session = new AutoClockSession()
    try {
      for (let i = 0; i < 64; i++) session.push(clock(65), 320, 180, i / 8)
      expect(JSON.parse(session.locate())).toEqual([])
      expect(JSON.parse(session.learn(JSON.stringify(roi))).profile).toBeNull()
      expect(() => session.push(new Uint8Array(1), 320, 180, 9)).toThrow()
      expect(() => session.push(clock(65), 320, 180, 1)).toThrow()
      expect(() => session.learn('{"x":1,"y":0,"w":1,"h":1}')).toThrow()
      session.reset()
      for (let i = 0; i < 64; i++) session.push(new Uint8Array(320 * 180), 320, 180, i / 8)
      expect(JSON.parse(session.locate())).toEqual([])
      expect(JSON.parse(session.learn(JSON.stringify(roi))).profile).toBeNull()
    } finally { session.free() }
  })
})
