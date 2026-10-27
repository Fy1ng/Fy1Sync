// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFrame, drawText } from '../test/glyphFont'
import { validateProfile } from '../core/profileSchema'
import { MIN_SYNC_CONFIDENCE } from '../core/types'
import { AutoClockSession, TickMomentDetector, initSync, recognize_auto } from './pkg/stream_syncer_wasm.js'

initSync({ module: readFileSync(join(process.cwd(), 'src/wasm/pkg/stream_syncer_wasm_bg.wasm')) })
const roi = { x: 70 / 320, y: 99 / 180, w: 54 / 320, h: 22 / 180 }

function clock(seconds: number, format: 'm:ss' | 'mm:ss' | 'ss' = 'm:ss'): Uint8Array {
  const frame = createFrame(320, 180)
  const minutes = String(Math.floor(seconds / 60)).padStart(format === 'mm:ss' ? 2 : 1, '0')
  const text = format === 'ss' ? String(seconds).padStart(2, '0') : `${minutes}:${String(seconds % 60).padStart(2, '0')}`
  drawText(frame, text, 74, 103, { scale: 2 })
  return Uint8Array.from({ length: frame.width * frame.height }, (_, i) => frame.data[i * 4]!)
}
function crop(data: Uint8Array): Uint8Array {
  return Uint8Array.from({ length: 54 * 22 }, (_, i) => data[(99 + Math.floor(i / 54)) * 320 + 70 + i % 54]!)
}

describe('automatic clock APIs in the generated WASM module', () => {
  it.each([[100, 'm:ss'], [600, 'mm:ss'], [5, 'm:ss'], [25, 'ss']] as const)(
    'localises all glyph positions for %i with %s', (start, format) => {
      const session = new AutoClockSession()
      try {
        for (let i = 0; i < 40; i++) session.push(clock(start - Math.floor(i / 8), format), 320, 180, i / 8)
        const candidates = JSON.parse(session.locate())
        expect(candidates.length).toBeGreaterThan(0)
        expect(candidates[0].roi.x * 320).toBeLessThan(76)
        expect(candidates[0].roi.x * 320).toBeGreaterThan(69)
        expect(candidates[0].persistence).toBeGreaterThan(0.9)
      } finally { session.free() }
    },
  )

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
      expect(learned.profile.matchThreshold).toBe(MIN_SYNC_CONFIDENCE)
      expect(learned.learnedChars.slice().sort()).toEqual('0123456789:'.split(''))
      expect(learned.missingChars).toEqual([])
      expect(validateProfile(learned.profile).profile).not.toBeNull()
      // Automatic profiles use the same glyph normalization for learning and reading.
      // The manual RecognitionEngine has a different preprocessing contract.
      for (let second = 0; second < 18; second++) {
        const result = JSON.parse(recognize_auto(clock(82 - second), 320, 180, JSON.stringify(learned.profile)))
        expect(result.reason).toBeNull()
        expect(result.value).toBe(82 - second)
        expect(result.confidence).toBeGreaterThanOrEqual(MIN_SYNC_CONFIDENCE)
      }
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
