import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { roiToPixels } from '../core/imageOps'
import type { RoiRect } from '../core/profileSchema'
import type { SourceRole } from '../core/types'
import {
  AutoClockSession, RecognitionEngine, TickMomentDetector, initSync, recognize_auto,
} from '../wasm/pkg/stream_syncer_wasm.js'
import { WasmWorkerEngine } from './backend'
import { FULL_FRAME_ROI } from './frameGrabber'
import type { WindowFrame } from './protocol'

const directory = join(process.cwd(), 'public', 'test-sources')
const ffmpeg = process.env.STREAM_SYNC_FFMPEG?.trim() || 'ffmpeg'
const NATIVE_WIDTH = 1280
const NATIVE_HEIGHT = 720
const DISCOVERY_WIDTH = 960
const DISCOVERY_HEIGHT = 540

function fixturesReady(): boolean {
  if (!['official', 'commentary'].every(role => existsSync(join(directory, `${role}.mp4`)))) return false
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}

initSync({ module: readFileSync(join(process.cwd(), 'src/wasm/pkg/stream_syncer_wasm_bg.wasm')) })

/** A 30 fps presentation sampled no sooner than 125 ms selects every fourth frame. */
function discoveryFrames(role: SourceRole): WindowFrame[] {
  const bytesPerFrame = DISCOVERY_WIDTH * DISCOVERY_HEIGHT * 4
  const bytes = execFileSync(ffmpeg, [
    '-loglevel', 'error', '-i', join(directory, `${role}.mp4`), '-t', '12',
    '-vf', `select=not(mod(n\\,4)),scale=${DISCOVERY_WIDTH}:${DISCOVERY_HEIGHT}:flags=bilinear`,
    '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], { maxBuffer: 256 * 1024 * 1024 })
  if (bytes.length % bytesPerFrame !== 0) throw new Error('Incomplete discovery frame')
  return Array.from({ length: bytes.length / bytesPerFrame }, (_, index) => {
    const offset = index * bytesPerFrame
    const pixels = new Uint8Array(bytes.subarray(offset, offset + bytesPerFrame)).buffer
    return { pixels, width: DISCOVERY_WIDTH, height: DISCOVERY_HEIGHT,
      mediaTime: index * 4 / 30, wallTime: index * 4 / 30 * 1000 }
  })
}

/** Crop the learned fractional ROI from a native decoded frame, as FrameGrabber does. */
function nativeRoiFrame(role: SourceRole, time: number, roi: RoiRect): WindowFrame {
  const bytes = execFileSync(ffmpeg, [
    '-loglevel', 'error', '-i', join(directory, `${role}.mp4`), '-ss', String(time),
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], { maxBuffer: 8 * 1024 * 1024 })
  expect(bytes.length).toBe(NATIVE_WIDTH * NATIVE_HEIGHT * 4)
  const rect = roiToPixels(roi, NATIVE_WIDTH, NATIVE_HEIGHT)
  const rgba = new Uint8Array(rect.width * rect.height * 4)
  for (let row = 0; row < rect.height; row++) {
    const start = ((rect.y + row) * NATIVE_WIDTH + rect.x) * 4
    rgba.set(bytes.subarray(start, start + rect.width * 4), row * rect.width * 4)
  }
  return { pixels: rgba.buffer, width: rect.width, height: rect.height, mediaTime: time, wallTime: time * 1000 }
}

describe.skipIf(!fixturesReady())('automatic profiles from decoded fixture media', () => {
  it.each<SourceRole>(['official', 'commentary'])(
    'locates, learns and reads later native-resolution ROI frames for %s without a preset', (role) => {
      const recognition = new RecognitionEngine()
      const worker = new WasmWorkerEngine({
        configure: profile => recognition.configure(profile),
        recognize: (...args) => recognition.recognize(...args),
        recognizeAuto: (...args) => recognize_auto(...args),
        createAutoSession: () => new AutoClockSession(),
        createTickDetector: () => new TickMomentDetector(),
      }, () => 0)
      try {
        const frames = discoveryFrames(role)
        expect(frames.length).toBe(90)
        const located = worker.handle({ type: 'locate', generation: 1, requestId: 1, frames, retainForLearning: true })
        expect(located?.type).toBe('located')
        if (located?.type !== 'located' || located.result.status !== 'success') throw new Error(JSON.stringify(located))
        expect(located.result.backend).toBe('wasm')
        const candidate = located.result.candidates[0]
        expect(candidate).toBeDefined()
        if (!candidate) throw new Error('Fixture clock was not found')
        expect(candidate.score).toBeGreaterThanOrEqual(0.82)
        expect(located.result.windowId).toBeDefined()
        const learned = worker.handle({ type: 'learn', generation: 1, requestId: 2, frames: [], roi: candidate.roi, windowId: located.result.windowId })
        if (learned?.type !== 'learned' || learned.result.status !== 'success') throw new Error(JSON.stringify(learned))
        expect(learned.result.backend).toBe('wasm')
        expect(learned.result.report.confidence).toBeGreaterThanOrEqual(0.82)
        expect(learned.result.report.reason).toBeNull()
        const profile = learned.result.profile
        expect(profile).not.toBeNull()
        if (!profile) throw new Error('No automatic profile')
        worker.handle({ type: 'configure', generation: 2, automatic: true,
          profile: { ...profile, roi: { ...FULL_FRAME_ROI } } })
        for (const [index, time] of [12.2, 13.2, 14.2, 15.2, 16.2, 17.2, 18.2].entries()) {
          const result = worker.handle({ type: 'frame', generation: 2, role, frameIndex: index + 1,
            wantDebug: false, ...nativeRoiFrame(role, time, profile.roi) })
          if (result?.type !== 'result') throw new Error(JSON.stringify(result))
          const delay = role === 'commentary' ? 5 : 0
          const seconds = Math.max(0, 20 - Math.floor(time - delay))
          expect(result.backend).toBe('wasm')
          expect(result.outcome, `${role} @${time}`).toMatchObject({ status: 'success',
            reading: { text: `0:${String(seconds).padStart(2, '0')}`, seconds } })
          if (result.outcome.status === 'success') expect(result.outcome.reading.confidence, `${role} @${time}`).toBeGreaterThanOrEqual(0.82)
        }
      } finally {
        worker.handle({ type: 'cancel', generation: 3 })
        recognition.free()
      }
    }, 30_000,
  )
})
