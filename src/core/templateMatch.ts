/**
 * Template matching over normalised 32x48 glyph masks.
 *
 * Score is intersection-over-union on ink pixels: naturally bounded to [0, 1],
 * symmetric, and it punishes both missing strokes and extra ink. A single
 * pixel-difference count would rate two nearly-blank masks as a great match,
 * which is exactly the failure mode that produces phantom clock readings.
 */

import { unpackBitmap } from './bitmapCodec'
import {
  binarize,
  cropBinary,
  inkRatio,
  normalizeGlyphCoverage,
  roiToPixels,
  thresholdCoverage,
  toGrayscale,
  type BinaryImage,
} from './imageOps'
import {
  CLOCK_CHARS,
  TEMPLATE_PIXELS,
  profileReadiness,
  type ClockChar,
  type RecognitionProfile,
} from './profileSchema'
import { segmentGlyphs, type GlyphBox, type SegmentOptions } from './segmentation'
import { parseCountdown } from './clockJump'
import type { RecognitionFailure, RecognitionOutcome } from './types'

export function scoreMasks(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0
  let union = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const inkA = (a[index] ?? 0) !== 0
    const inkB = (b[index] ?? 0) !== 0
    if (inkA && inkB) intersection += 1
    if (inkA || inkB) union += 1
  }
  return union === 0 ? 0 : intersection / union
}

/**
 * IoU generalised to partial ink: sum(min) / sum(max).
 *
 * For two binary masks this is identical to `scoreMasks` — min is set only where
 * both are inked, max only where either is — so stored templates keep matching
 * exactly as before. The difference appears when the live glyph carries coverage
 * fractions: a boundary pixel at 60% contributes 0.6 to the intersection instead
 * of an all-or-nothing 1 or 0.
 *
 * That is the whole reason this exists. The same digit resampled one row taller
 * between two frames used to lose ~0.19 of its score, enough to fall under a 0.82
 * threshold while the runner-up sat at 0.49 — the match was right and the gate was
 * measuring the resampling grid rather than the shape.
 */
export function scoreCoverage(coverage: Uint8Array, template: Uint8Array): number {
  let intersection = 0
  let union = 0
  const length = Math.min(coverage.length, template.length)
  for (let index = 0; index < length; index += 1) {
    const a = coverage[index] ?? 0
    const b = (template[index] ?? 0) !== 0 ? 255 : 0
    intersection += a < b ? a : b
    union += a > b ? a : b
  }
  return union === 0 ? 0 : intersection / union
}

export interface CompiledTemplates {
  chars: ClockChar[]
  masks: Map<ClockChar, Uint8Array[]>
}

/** Unpack once per profile change; matching a frame then touches no base64. */
export function compileTemplates(profile: RecognitionProfile): CompiledTemplates {
  const masks = new Map<ClockChar, Uint8Array[]>()
  const chars: ClockChar[] = []
  for (const char of CLOCK_CHARS) {
    const samples = profile.templates[char]
    if (!samples || samples.length === 0) continue
    const unpacked: Uint8Array[] = []
    for (const sample of samples) {
      try {
        unpacked.push(unpackBitmap(sample.data, TEMPLATE_PIXELS))
      } catch {
        // A corrupt sample must not take the whole profile down; skip it.
      }
    }
    if (unpacked.length > 0) {
      masks.set(char, unpacked)
      chars.push(char)
    }
  }
  return { chars, masks }
}

export interface GlyphMatch {
  char: ClockChar | null
  score: number
  /** Score of the best non-winning character, for ambiguity checks. */
  runnerUpScore: number
  sampleIndex: number
}

/**
 * `mask` may be binary or a coverage mask; `scoreCoverage` treats the two alike.
 */
export function matchGlyph(mask: Uint8Array, templates: CompiledTemplates): GlyphMatch {
  let best: GlyphMatch = { char: null, score: 0, runnerUpScore: 0, sampleIndex: -1 }
  let runnerUp = 0
  for (const char of templates.chars) {
    const samples = templates.masks.get(char)
    if (!samples) continue
    let charBest = 0
    let charBestIndex = -1
    for (let index = 0; index < samples.length; index += 1) {
      const score = scoreCoverage(mask, samples[index] as Uint8Array)
      if (score > charBest) {
        charBest = score
        charBestIndex = index
      }
    }
    if (charBest > best.score) {
      runnerUp = best.score
      best = { char, score: charBest, runnerUpScore: runnerUp, sampleIndex: charBestIndex }
    } else if (charBest > runnerUp) {
      runnerUp = charBest
    }
  }
  return { ...best, runnerUpScore: runnerUp }
}

export interface RecognizeOptions {
  /** Reject a frame whose ROI is essentially empty (scene change, ad break). */
  minInkRatio?: number
  /** Reject a frame whose ROI is almost fully inked (flash, white overlay). */
  maxInkRatio?: number
  /** Minimum gap between the best and second-best glyph score. */
  minMargin?: number
  segment?: SegmentOptions
}

export interface RecognizeDebug {
  roiPixels: { x: number; y: number; width: number; height: number }
  binary: BinaryImage
  boxes: GlyphBox[]
  projection: number[]
  inkRatio: number
  matches: GlyphMatch[]
  normalized: Uint8Array[]
}

export interface RecognizeResult {
  outcome: RecognitionOutcome
  debug: RecognizeDebug | null
}

const DEFAULT_OPTIONS: Required<Omit<RecognizeOptions, 'segment'>> = {
  minInkRatio: 0.004,
  maxInkRatio: 0.85,
  minMargin: 0.02,
}

/**
 * Full pipeline for one frame: ROI crop -> grayscale -> binarize -> segment ->
 * normalise -> match -> parse. `frame` is the whole video frame as RGBA.
 */
export function recognizeFrame(
  frame: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  profile: RecognitionProfile,
  templates: CompiledTemplates,
  meta: { mediaTime: number; wallTime: number; frameIndex: number },
  options: RecognizeOptions = {},
): RecognizeResult {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const readiness = profileReadiness(profile)
  if (!readiness.ready) {
    return { outcome: fail('insufficient-templates', `缺少字符模板：${readiness.missing.join(' ')}`), debug: null }
  }

  const roiPixels = roiToPixels(profile.roi, frame.width, frame.height)
  const gray = toGrayscale(frame.data, frame.width, frame.height)
  const roiGray = cropGray(gray, roiPixels)
  const binary = binarize(roiGray, profile.preprocess)
  const ratio = inkRatio(binary)

  const segmentResult = segmentGlyphs(binary, options.segment)
  const debug: RecognizeDebug = {
    roiPixels,
    binary,
    boxes: segmentResult.boxes,
    projection: segmentResult.projection,
    inkRatio: ratio,
    matches: [],
    normalized: [],
  }

  if (ratio < config.minInkRatio || ratio > config.maxInkRatio) {
    return { outcome: fail('blank-frame', `识别区域墨迹比例 ${(ratio * 100).toFixed(1)}%`), debug }
  }
  if (segmentResult.boxes.length === 0) {
    return { outcome: fail('no-candidates', '未切分出任何字符'), debug }
  }

  const scores: number[] = []
  let text = ''
  for (const box of segmentResult.boxes) {
    const glyph = cropBinary(binary, box)
    // Match on coverage, but report the thresholded mask: the editor draws
    // `normalized` next to the stored template, and those must be comparable.
    const coverage = normalizeGlyphCoverage(glyph)
    const match = matchGlyph(coverage, templates)
    debug.normalized.push(thresholdCoverage(coverage))
    debug.matches.push(match)
    if (!match.char) {
      return { outcome: fail('low-confidence', '存在无法匹配的字符'), debug }
    }
    scores.push(match.score)
    text += match.char
  }

  // Confidence is the weakest glyph: one bad digit makes the whole reading wrong.
  const confidence = scores.reduce((min, score) => Math.min(min, score), 1)
  if (confidence < profile.matchThreshold) {
    return {
      outcome: fail('low-confidence', `最低字符得分 ${confidence.toFixed(3)} 低于阈值 ${profile.matchThreshold}`),
      debug,
    }
  }
  const ambiguous = debug.matches.find((match) => match.score - match.runnerUpScore < config.minMargin)
  if (ambiguous) {
    return {
      outcome: fail('low-confidence', `字符 ${ambiguous.char} 与次优候选过于接近`),
      debug,
    }
  }

  const seconds = parseCountdown(text, profile.clockFormat)
  if (seconds === null) {
    return { outcome: fail('invalid-format', `识别结果 "${text}" 不符合 ${profile.clockFormat}`), debug }
  }

  return {
    outcome: {
      status: 'success',
      reading: {
        text,
        seconds,
        scores,
        confidence,
        mediaTime: meta.mediaTime,
        wallTime: meta.wallTime,
        frameIndex: meta.frameIndex,
      },
    },
    debug,
  }
}

function cropGray(
  gray: { data: Uint8Array; width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
): { data: Uint8Array; width: number; height: number } {
  // cropBinary works on raw bytes, so reuse it for grayscale too.
  return cropBinary({ data: gray.data, width: gray.width, height: gray.height }, rect)
}

function fail(reason: RecognitionFailure, detail?: string): RecognitionOutcome {
  return detail ? { status: 'failed', reason, detail } : { status: 'failed', reason }
}
