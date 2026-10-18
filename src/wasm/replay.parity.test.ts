// @vitest-environment jsdom
import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Reuse the existing suites verbatim. Every exported core call they make is run
// against WASM as well, so new oracle vectors automatically join the parity suite.
// jsdom is needed only by the existing RecognitionClient/FrameGrabber test cases;
// the WASM itself is synchronously instantiated from bytes by Node.
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
  return wrapModule(actual, ['scoreMasks', 'scoreCoverage', 'compileTemplates', 'matchGlyph', 'recognizeFrame'])
})
vi.mock('../core/bitmapCodec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/bitmapCodec')>()
  const { wrapModule } = await import('./test-helpers')
  return wrapModule(actual, ['packBitmap', 'unpackBitmap', 'countInk'])
})
vi.mock('../core/profileSchema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/profileSchema')>()
  const { wrapModule } = await import('./test-helpers')
  // v1 disk migration remains in TS and is outside the Rust recognition contract.
  return wrapModule(actual, ['validateProfile', 'profileReadiness'])
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

// The parity bridge serialises every argument as JSON, so each full 1280x720 frame costs
// about 1.5 s per call here. Production recognition passes the Uint8Array directly; only
// this oracle run needs the longer budget.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

describe('original vectors through both implementations', () => {
  it('requires decoded-frame fixture prerequisites instead of silently skipping parity', () => {
    for (const name of ['official.mp4', 'commentary.mp4']) {
      expect(existsSync(join(process.cwd(), 'public/test-sources', name)), name).toBe(true)
    }
    expect(() => execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })).not.toThrow()
  })
  it('exercises each required algorithm family', () => {
    for (const operation of ['recognizeFrame', 'segmentGlyphs', 'matchGlyph', 'clockJump.push',
      'estimateOffset', 'planOffsetChange', 'packBitmap', 'validateProfile', 'profileReadiness']) {
      expect(parityCounts[operation], operation).toBeGreaterThan(0)
    }
  })
})

afterAll(() => assertParityIntegrity('Original-vector parity'))
