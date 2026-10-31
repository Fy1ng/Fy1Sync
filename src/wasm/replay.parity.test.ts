// @vitest-environment jsdom
import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Existing image, segmentation and sync vectors retain independent TS/Rust parity.
// Recognition scenarios assert Rust output through the test-only adapter; there is no
// second TS recognizer. jsdom supports RecognitionClient/FrameGrabber test cases.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const executable = process.env.STREAM_SYNC_FFMPEG
  if (!executable) return actual
  return { ...actual, execFileSync: new Proxy(actual.execFileSync, {
    apply(target, thisArg, args: unknown[]) {
      return Reflect.apply(target, thisArg, [args[0] === 'ffmpeg' ? executable : args[0], ...args.slice(1)])
    },
  }) }
})
vi.mock('../core/imageOps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/imageOps')>()
  const { wrapModule } = await import('./test-helpers')
  return wrapModule(actual, ['contentRect', 'pointToFraction', 'roiToPixels', 'normalizeRoi',
    'toGrayscale', 'binarize', 'inkRatio', 'boundingBox', 'cropBinary',
    'normalizeGlyphCoverage', 'normalizeGlyph', 'thresholdCoverage'])
})
vi.mock('../core/segmentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/segmentation')>()
  const { wrapModule } = await import('./test-helpers')
  return wrapModule(actual, ['columnProjection', 'segmentGlyphs', 'mergeGlyphBoxes',
    'splitGlyphBox', 'excludeGlyphBox', 'adjustGlyphBox'])
})
vi.mock('../core/templateMatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/templateMatch')>()
  const { wrapModule } = await import('./test-helpers')
  return wrapModule(actual, ['scoreMasks', 'scoreCoverage'])
})
vi.mock('../core/bitmapCodec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/bitmapCodec')>()
  const { wrapModule } = await import('./test-helpers')
  return wrapModule(actual, ['packBitmap', 'unpackBitmap', 'countInk'])
})
vi.mock('../core/profileSchema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/profileSchema')>()
  const { wrapModule } = await import('./test-helpers')
  return wrapModule(actual, ['profileReadiness'])
})
vi.mock('../core/clockJump', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/clockJump')>()
  const { assertExact, wasmCall, wrapModule } = await import('./test-helpers')
  class ParityClockJumpDetector extends actual.ClockJumpDetector {
    private readonly parityArgs: ConstructorParameters<typeof actual.ClockJumpDetector>
    private readonly parityOperations: unknown[] = []
    constructor(...args: ConstructorParameters<typeof actual.ClockJumpDetector>) {
      super(...args)
      this.parityArgs = args
    }
    override reset(): void {
      super.reset()
      this.parityOperations.push({ type: 'reset' })
    }
    override push(outcome: Parameters<typeof actual.ClockJumpDetector.prototype.push>[0]) {
      const expected = super.push(outcome)
      this.parityOperations.push({ type: 'push', outcome })
      const results = wasmCall('clockJump', [{ source: this.parityArgs[0],
        options: this.parityArgs[1] ?? {}, operations: this.parityOperations }]) as unknown[]
      assertExact('clockJump.push', results[results.length - 1], expected)
      return expected
    }
  }
  return { ...wrapModule(actual, ['parseCountdown']), ClockJumpDetector: ParityClockJumpDetector }
})
vi.mock('../core/offsetEstimator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/offsetEstimator')>()
  const { wrapModule } = await import('./test-helpers')
  return wrapModule(actual, ['clockAnchorMs', 'median', 'estimateOffset'])
})
vi.mock('../core/syncPlan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/syncPlan')>()
  const { wrapModule } = await import('./test-helpers')
  return wrapModule(actual, ['clampOffset', 'rewindForOffset', 'offsetFromRewind', 'seekableRange',
    'availableRewind', 'planOffsetChange', 'planIsComplete', 'isAligned', 'describeOffset', 'snapOffset'])
})

import '../core/recognition.test'
import '../core/clockJump.test'
import '../core/offsetEstimator.test'
import '../core/syncPlan.test'
import '../core/profileSchema.test'
import '../recognition/recognition.test'
import '../recognition/fixtureFrames.test'
import { assertParityIntegrity, parityCounts } from './test-helpers'

// The Rust-vector bridge serializes full fixture frames as JSON. Production recognition
// passes RGBA bytes directly; decoded fixture scenarios need the larger test budget.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

describe('original TS/Rust primitive parity and Rust recognition vectors', () => {
  it('requires decoded-frame fixture prerequisites instead of silently skipping parity', () => {
    for (const name of ['official.mp4', 'commentary.mp4']) {
      expect(existsSync(join(process.cwd(), 'public/test-sources', name)), name).toBe(true)
    }
    expect(() => execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })).not.toThrow()
  })
  it('exercises each required algorithm family', () => {
    for (const operation of ['scoreMasks', 'scoreCoverage', 'segmentGlyphs', 'clockJump.push',
      'estimateOffset', 'planOffsetChange', 'packBitmap', 'profileReadiness']) {
      expect(parityCounts[operation], operation).toBeGreaterThan(0)
    }
  })
})

afterAll(() => assertParityIntegrity('Original image/sync parity with Rust recognition vectors'))
