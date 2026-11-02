/** Test-only Rust dispatch adapter for existing recognition vectors. */
import { wasmCall } from '../wasm/test-helpers'
import { manualPackFixture } from './profileFixture'
import { parseHudStylePack, type HudPackIssue } from '../core/hudStylePack'
import type { ClockChar, RecognitionProfile } from '../core/profileSchema'
import type { GlyphBox, SegmentOptions } from '../core/segmentation'
import type { RecognitionOutcome } from '../core/types'

export { scoreMasks, scoreCoverage } from '../core/templateMatch'
interface RgbaFrame { data: Uint8Array | Uint8ClampedArray; width: number; height: number }
export interface CompiledTemplates { chars: ClockChar[]; masks: Map<ClockChar, Uint8Array[]> }
export interface GlyphMatch { char: ClockChar | null; score: number; runnerUpScore: number; sampleIndex: number }
export interface RecognizeDebug {
  roiPixels: { x: number; y: number; width: number; height: number }
  binary: { data: Uint8Array; width: number; height: number }
  boxes: GlyphBox[]
  projection: number[]
  inkRatio: number
  matches: GlyphMatch[]
  normalized: Uint8Array[]
}
export interface RecognizeResult { outcome: RecognitionOutcome; debug: RecognizeDebug | null }
export interface RecognizeOptions { minInkRatio?: number; maxInkRatio?: number; minMargin?: number; segment?: SegmentOptions }

export function compileTemplates(profile: RecognitionProfile): CompiledTemplates {
  const raw = wasmCall('compileTemplates', [profile]) as { chars: ClockChar[]; masks: [ClockChar, number[][]][] }
  return { chars: raw.chars, masks: new Map(raw.masks.map(([char, masks]) => [char, masks.map(mask => Uint8Array.from(mask))])) }
}
export function matchGlyph(mask: Uint8Array, templates: CompiledTemplates): GlyphMatch {
  return wasmCall('matchGlyph', [mask, templates]) as GlyphMatch
}
export function recognizeFrame(frame: RgbaFrame, profile: RecognitionProfile, templates: CompiledTemplates,
  meta: { mediaTime: number; wallTime: number; frameIndex: number }, options: RecognizeOptions = {}): RecognizeResult {
  const result = wasmCall('recognizeFrame', [frame, profile, templates, meta, options]) as RecognizeResult
  if (result.debug) {
    result.debug.binary.data = Uint8Array.from(result.debug.binary.data)
    result.debug.normalized = result.debug.normalized.map(mask => Uint8Array.from(mask))
  }
  return result
}

/** Validate trusted fixture learning output against the persisted asset constraints. */
export function validateLearnedProfile(profile: RecognitionProfile): { profile: RecognitionProfile | null; issues: HudPackIssue[] } {
  const result = parseHudStylePack(manualPackFixture(profile, { width: 1920, height: 1080 }))
  return { profile: result.pack ? profile : null, issues: result.issues }
}
