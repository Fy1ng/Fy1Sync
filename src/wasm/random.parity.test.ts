// @vitest-environment jsdom
import { afterAll, describe, expect, it } from 'vitest'
import * as bitmap from '../core/bitmapCodec'
import { ClockJumpDetector, parseCountdown, type ClockJumpOptions, type CountdownFormat } from '../core/clockJump'
import * as image from '../core/imageOps'
import { clockAnchorMs, estimateOffset, median } from '../core/offsetEstimator'
import { CLOCK_CHARS, createEmptyProfile, profileReadiness, validateProfile, type RecognitionProfile } from '../core/profileSchema'
import * as segmentation from '../core/segmentation'
import * as sync from '../core/syncPlan'
import * as template from '../core/templateMatch'
import type { ClockJumpEvent, MediaSnapshot, RecognitionOutcome, SourceRole } from '../core/types'
import { RecognitionEngine } from '../recognition/engine'
import type { ResultMessage } from '../recognition/protocol'
import { createFrame, drawText, renderGlyphMask } from '../test/glyphFont'
import { assertExact, assertParityIntegrity, checkParity, parseWasmJson, WasmRecognitionEngine, wasmCall } from './test-helpers'

const SEED = 0x51c0f17e
const cases = (count: number) => Array.from({ length: count }, (_, index) => index)
function randomFor(index: number): () => number {
  let state = (SEED ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}
function integer(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1))
}
function parity<F extends (...args: never[]) => unknown>(operation: string, fn: F, ...args: Parameters<F>): ReturnType<F> {
  return checkParity(operation, fn, args) as ReturnType<F>
}
function profileAt(scale: number): RecognitionProfile {
  const profile = createEmptyProfile('test/parity', 'Parity')
  profile.roi = { x: 0, y: 0, w: 1, h: 1 }
  for (const char of CLOCK_CHARS) {
    profile.templates[char] = [{ id: char + '-0', createdAt: 0,
      data: bitmap.packBitmap(image.normalizeGlyph(renderGlyphMask(char, scale))) }]
  }
  return profile
}
function rendered(index: number, random: () => number) {
  const scale = integer(random, 1, 9)
  const seconds = integer(random, 0, 59)
  const text = index % 4 === 0 ? String(seconds).padStart(2, '0')
    : String(integer(random, 0, 9)) + ':' + String(seconds).padStart(2, '0')
  const frame = createFrame(text.length * 6 * scale + 24, 7 * scale + 24)
  drawText(frame, text, 12, 12, { scale, tracking: 1 })
  return { frame, text, scale }
}

describe('fixed-seed image, ROI, threshold and editor parity', () => {
  it.each(cases(96))('image vector %i', (index) => {
    const random = randomFor(index)
    const { frame } = rendered(index, random)
    const gray = parity('toGrayscale', image.toGrayscale, frame.data, frame.width, frame.height)
    const binary = parity('binarize', image.binarize, gray, {
      scale: random() * 3 + 0.1, threshold: random() * 255, invert: random() < 0.3,
    })
    parity('inkRatio', image.inkRatio, binary)
    parity('boundingBox', image.boundingBox, binary)
    const roi = parity('normalizeRoi', image.normalizeRoi, {
      x: random() * 2 - 0.5, y: random() * 2 - 0.5, w: random() * 2 - 1, h: random() * 2 - 1,
    })
    const rect = parity('roiToPixels', image.roiToPixels, roi, frame.width, frame.height)
    const crop = parity('cropBinary', image.cropBinary, binary, rect)
    const coverage = parity('normalizeGlyphCoverage', image.normalizeGlyphCoverage, crop)
    const mask = parity('normalizeGlyph', image.normalizeGlyph, crop)
    parity('thresholdCoverage', image.thresholdCoverage, coverage)
    parity('scoreCoverage', template.scoreCoverage, coverage, mask)
    parity('scoreMasks', template.scoreMasks, mask, image.normalizeGlyph(renderGlyphMask('8', index % 9 + 1)))
    parity('columnProjection', segmentation.columnProjection, binary)
    const segments = parity('segmentGlyphs', segmentation.segmentGlyphs, binary, {
      minColumnInk: integer(random, 0, 3), minGlyphWidth: integer(random, 1, 5),
      minGapWidth: integer(random, 1, 5), minInkRatio: random() * 0.4,
    })
    const boxes = segments.boxes.length ? segments.boxes : [{ x: 1, y: 1, width: 5, height: 7, ink: 17 }]
    const selected = integer(random, -1, boxes.length)
    parity('mergeGlyphBoxes', segmentation.mergeGlyphBoxes, boxes, selected, integer(random, -1, boxes.length))
    parity('splitGlyphBox', segmentation.splitGlyphBox, boxes, selected, random() * frame.width - 0.5)
    parity('excludeGlyphBox', segmentation.excludeGlyphBox, boxes, selected)
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      parity('adjustGlyphBox', segmentation.adjustGlyphBox, boxes, selected, edge, random() * 40 - 20, frame)
    }
    const content = parity('contentRect', image.contentRect, frame.width, frame.height,
      integer(random, 1, 2000), integer(random, 1, 2000))
    parity('pointToFraction', image.pointToFraction, { x: random() * 2500, y: random() * 2500 }, content)
  })
})

describe('fixed-seed templates and recognition parity', () => {
  it.each(cases(64))('recognition vector %i', (index) => {
    const random = randomFor(index + 1000)
    const { frame } = rendered(index, random)
    const profile = profileAt(integer(random, 1, 9))
    profile.clockFormat = (['m:ss', 'ss', 'auto', 'mm:ss'] as const)[index % 4]!
    profile.matchThreshold = random()
    profile.preprocess = { scale: 0.2 + random() * 3, threshold: random() * 255, invert: index % 11 === 0 }
    if (index % 9 === 0) delete profile.templates['0']
    if (index % 13 === 0) profile.templates['4']?.unshift({ id: 'corrupt', data: '!!!!', createdAt: 0 })
    parity('profileReadiness', profileReadiness, profile)
    parity('validateProfile', validateProfile, profile)
    const compiled = parity('compileTemplates', template.compileTemplates, profile)
    const glyph = image.normalizeGlyphCoverage(renderGlyphMask(CLOCK_CHARS[index % CLOCK_CHARS.length]!, integer(random, 1, 9)))
    parity('matchGlyph', template.matchGlyph, glyph, compiled)
    parity('recognizeFrame', template.recognizeFrame, frame, profile, compiled,
      { mediaTime: random() * 1200, wallTime: random() * 1_000_000, frameIndex: index },
      { minInkRatio: random() * 0.1, maxInkRatio: 0.5 + random() * 0.5,
        minMargin: random() * 0.1, segment: { minGapWidth: integer(random, 1, 3) } })
  })

  it('keeps character and sample ties in insertion order', () => {
    const mask = image.normalizeGlyph(renderGlyphMask('8', 4))
    const compiled: template.CompiledTemplates = {
      chars: ['9', '8', '7'], masks: new Map([
        ['9', [mask, mask]], ['8', [mask]], ['7', [mask]],
      ]),
    }
    const matched = parity('matchGlyph', template.matchGlyph, mask, compiled)
    expect(matched).toEqual({ char: '9', score: 1, runnerUpScore: 1, sampleIndex: 0 })
  })
})

describe('fixed-seed byte-identical bitmap codec', () => {
  it.each(cases(128))('bitmap vector %i', (index) => {
    const random = randomFor(index + 2000)
    const length = index < 20 ? index : integer(random, 0, 4097)
    const mask = Uint8Array.from({ length }, () => random() < 0.6 ? 0 : integer(random, 1, 255))
    const encoded = parity('packBitmap', bitmap.packBitmap, mask)
    const decoded = parity('unpackBitmap', bitmap.unpackBitmap, encoded, length)
    parity('unpackBitmap', bitmap.unpackBitmap, encoded + ' =' + String.fromCharCode(10, 9), length)
    parity('countInk', bitmap.countInk, encoded, length)
    expect(Array.from(decoded)).toStrictEqual(Array.from(mask, (value) => value === 0 ? 0 : 255))
    expect(wasmCall('packBitmap', [decoded])).toBe(encoded)
  })
})

function clockText(seconds: number, format: CountdownFormat): string {
  if (format === 'ss') return String(seconds % 60).padStart(2, '0')
  const minutes = String(Math.floor(seconds / 60))
  return (format === 'mm:ss' ? minutes.padStart(2, '0') : minutes) + ':' + String(seconds % 60).padStart(2, '0')
}

describe('fixed-seed reading sequences and detector resets', () => {
  it.each(cases(96))('clock sequence %i', (index) => {
    const random = randomFor(index + 3000)
    const source: SourceRole = index % 2 ? 'official' : 'commentary'
    const format: CountdownFormat = (['m:ss', 'mm:ss', 'ss', 'auto'] as const)[index % 4]!
    const options: ClockJumpOptions = { format, stableFrames: integer(random, 1, 4),
      minConfidence: 0.5 + random() * 0.4, jumpIntervalRange: [0.1, 3] }
    const detector = new ClockJumpDetector(source, options)
    const operations: unknown[] = []
    const expected: unknown[] = []
    let seconds = 58
    let mediaTime = 0
    for (let frameIndex = 0; frameIndex < 96; frameIndex += 1) {
      if (frameIndex === 48 && index % 3 === 0) {
        detector.reset(); operations.push({ type: 'reset' })
      }
      if (random() < 0.2) seconds = Math.max(0, seconds - integer(random, 0, 3))
      if (random() < 0.04) seconds = integer(random, 20, 59)
      mediaTime += random() < 0.03 ? 4 : 1 / 30
      const text = random() < 0.04 ? 'invalid' : clockText(seconds, format)
      parity('parseCountdown', parseCountdown, text, format)
      const outcome: RecognitionOutcome = random() < 0.06 ? { status: 'failed', reason: 'blank-frame' }
        : { status: 'success', reading: {
          text, seconds: random() < 0.03 ? seconds + 1 : seconds,
          confidence: random() < 0.2 ? 0.3 : 0.9 + random() * 0.1,
          scores: [0.95, 0.96], mediaTime, wallTime: 1000 + mediaTime * 1000, frameIndex,
        } }
      operations.push({ type: 'push', outcome }); expected.push(detector.push(outcome))
    }
    assertExact('clockJump.sequence', wasmCall('clockJump', [{ source, options, operations }]), expected)
  })
})

function jump(source: SourceRole, seconds: number, at: number, confidence: number): ClockJumpEvent {
  return { source, from: clockText(seconds + 1, 'auto'), to: clockText(seconds, 'auto'),
    toSeconds: seconds, mediaTime: at, wallTime: at * 1000, confidence, frameIndex: Math.round(at * 30) }
}
function snapshot(random: () => number, role: SourceRole): MediaSnapshot {
  return { role, currentTime: random() * 1000, ready: random() >= 0.1,
    timebase: random() < 0.5 ? { kind: 'vod', duration: random() * 1300 }
      : { kind: 'live', seekableStart: random() * 800 - 10, seekableEnd: random() * 1200 } }
}

describe('fixed-seed offsets and seek snapshots', () => {
  it.each(cases(192))('sync vector %i', (index) => {
    const random = randomFor(index + 4000)
    const offset = random() * 160 - 80
    parity('clampOffset', sync.clampOffset, offset)
    const rewind = parity('rewindForOffset', sync.rewindForOffset, offset)
    parity('offsetFromRewind', sync.offsetFromRewind, rewind)
    parity('isAligned', sync.isAligned, offset, random() * 10)
    parity('describeOffset', sync.describeOffset, offset)
    parity('snapOffset', sync.snapOffset, offset, [0.05, 0.5, 0.001, -1, 0][index % 5]!)
    const official = snapshot(random, 'official')
    const commentary = snapshot(random, 'commentary')
    parity('seekableRange', sync.seekableRange, official.timebase)
    parity('availableRewind', sync.availableRewind, official)
    const plan = parity('planOffsetChange', sync.planOffsetChange, {
      nextOffset: offset, applied: { official: random() * 40, commentary: random() * 40 },
      snapshots: { ...(index % 7 ? { official } : {}), ...(index % 11 ? { commentary } : {}) },
      epsilon: index % 3 ? 0.001 : 0.1,
    })
    parity('planIsComplete', sync.planIsComplete, plan, random() * 0.2)
    const at = random() * 500
    const base = integer(random, 10, 50)
    const delay = random() * 140 - 70
    const makeEvents = (role: SourceRole, extra: number) => Array.from({ length: integer(random, 0, 5) }, (_, i) =>
      jump(role, base - i, at + i + extra + random() * (index % 4 ? 0.1 : 2), 0.7 + random() * 0.3))
    const a = makeEvents('official', 0)
    const b = makeEvents('commentary', delay)
    for (const event of [...a, ...b]) parity('clockAnchorMs', clockAnchorMs, event)
    parity('median', median, a.map(clockAnchorMs))
    parity('estimateOffset', estimateOffset, a, b, { appliedOffsetSeconds: random() * 30 - 15,
      minConfidence: 0.7 + random() * 0.2, maxAnchorSpreadSeconds: 0.35,
      deadbandSeconds: 0.1, maxOffsetSeconds: 60 })
  })

  it('preserves half-up negatives, negative zero and non-finite helper inputs', () => {
    for (const value of [-Infinity, Infinity, NaN, -0, -0.0005, -1.2345, 1.2345, -0.025, 0.025, -60.0005, 60.0005]) {
      parity('clampOffset', sync.clampOffset, value)
      parity('snapOffset', sync.snapOffset, value, 0.05)
      if (Number.isFinite(value)) parity('offsetFromRewind', sync.offsetFromRewind, { official: value, commentary: 0 })
    }
    parity('median', median, [])
    parity('seekableRange', sync.seekableRange, { kind: 'vod', duration: Infinity })
    parity('seekableRange', sync.seekableRange, { kind: 'vod', duration: NaN })
  })
})

describe('stateful WASM engine parity', () => {
  it.each([
    { frameIndex: 2 ** 32 + 17, mediaTime: 1, wallTime: 2 },
    { frameIndex: -1, mediaTime: 1, wallTime: 2 },
    { frameIndex: 1.5, mediaTime: 1, wallTime: 2 },
    { frameIndex: -0, mediaTime: -0, wallTime: -0 },
  ])('preserves numeric frame metadata $frameIndex', (meta) => {
    const { frame, scale } = rendered(1, randomFor(6000))
    const profile = profileAt(scale)
    profile.clockFormat = 'auto'
    const oracle = new RecognitionEngine(() => 0)
    const engine = new WasmRecognitionEngine()
    try {
      oracle.handle({ type: 'configure', generation: 1, profile })
      engine.configure(JSON.stringify(profile))
      const expected = oracle.handle({ type: 'frame', generation: 1, role: 'official',
        pixels: frame.data.slice().buffer as ArrayBuffer, width: frame.width, height: frame.height,
        ...meta, wantDebug: true }) as ResultMessage
      expect(expected.outcome.status).toBe('success')
      assertExact('engine.metadata', parseWasmJson(engine.recognize(new Uint8Array(frame.data),
        frame.width, frame.height, meta.mediaTime, meta.wallTime, meta.frameIndex, true)),
        { outcome: expected.outcome, debug: expected.debug })
    } finally { engine.free() }
  })
  it.each(cases(32))('engine vector %i', (index) => {
    const random = randomFor(index + 5000)
    const { frame } = rendered(index, random)
    const profile = profileAt(integer(random, 2, 7))
    profile.clockFormat = 'auto'
    profile.matchThreshold = 0.7
    if (index % 8 === 0) delete profile.templates['5']
    const oracle = new RecognitionEngine(() => 0)
    const engine = new WasmRecognitionEngine()
    try {
      const configured = oracle.handle({ type: 'configure', generation: 1, profile })
      if (configured?.type !== 'configured') throw new Error('Unexpected TS configuration response')
      assertExact('engine.configure', parseWasmJson(engine.configure(JSON.stringify(profile))), {
        ready: configured.ready, missing: configured.missing, sampleCount: configured.sampleCount,
      })
      for (const wantDebug of [false, true]) {
        const mediaTime = random() * 1000
        const wallTime = random() * 100_000
        const expected = oracle.handle({ type: 'frame', generation: 1, role: 'official',
          pixels: frame.data.slice().buffer as ArrayBuffer, width: frame.width, height: frame.height,
          mediaTime, wallTime, frameIndex: index, wantDebug }) as ResultMessage
        assertExact('engine.recognize', parseWasmJson(engine.recognize(new Uint8Array(frame.data),
          frame.width, frame.height, mediaTime, wallTime, index, wantDebug)),
          { outcome: expected.outcome, debug: expected.debug })
      }
    } finally { engine.free() }
  })
})

afterAll(() => assertParityIntegrity('Fixed-seed parity seed=' + SEED))
