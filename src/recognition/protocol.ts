/**
 * Worker protocol for clock recognition.
 *
 * Every message carries a `generation`. The generation is bumped whenever the
 * profile, the ROI or the sampled source changes; results from an older
 * generation are stale by definition and get dropped instead of being applied to
 * the new configuration. That single field replaces a pile of "is this still
 * relevant?" checks scattered around the caller.
 */

import type { RecognitionProfile, RoiRect } from '../core/profileSchema'
import type { GlyphBox } from '../core/segmentation'
import type { GlyphMatch } from '../core/templateMatch'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import type { Rect } from '../core/imageOps'
import type { ScoreReading } from './score'

export interface ConfigureMessage {
  type: 'configure'
  generation: number
  profile: RecognitionProfile
  /** Explicit P4a partial-profile path; omitted keeps the P3 parity contract. */
  automatic?: boolean
}

export interface FrameMessage {
  type: 'frame'
  generation: number
  role: SourceRole
  frameIndex: number
  mediaTime: number
  wallTime: number
  width: number
  height: number
  /** RGBA pixels, transferred (not copied) to the worker. */
  pixels: ArrayBuffer
  /** Debug payloads are large; the editor asks for them, auto sync does not. */
  wantDebug: boolean
  /** Present only when this is one native clock-and-scores readback. */
  score?: {
    clockRect: Rect
    source: string
    generation: number
    width: number
    height: number
    segment: number
  }
}

export interface CancelMessage {
  type: 'cancel'
  generation: number
}

/** Discovery uses full-frame windows; these buffers are transferred to the worker. */
export interface WindowFrame {
  pixels: ArrayBuffer
  width: number
  height: number
  mediaTime: number
  wallTime: number
}

export interface LocateMessage {
  type: 'locate'
  generation: number
  requestId: number
  frames: WindowFrame[]
  /** Keep the grayscale WASM window for one subsequent learn request. */
  retainForLearning?: boolean
}

export interface LearnMessage {
  type: 'learn'
  generation: number
  requestId: number
  frames: WindowFrame[]
  roi: RoiRect
  /** Reuse a retained source-local window instead of sending its RGBA frames again. */
  windowId?: number
}

export type WorkerRequest = ConfigureMessage | FrameMessage | CancelMessage | LocateMessage | LearnMessage

export type RecognitionBackend = 'wasm' | 'typescript'

export interface RoiCandidate {
  roi: RoiRect
  score: number
  eventTimes: number[]
  period: number
  jitter: number
  persistence: number
  glyphScore: number
}

export interface LearnReport {
  profile: RecognitionProfile | null
  confidence: number
  learnedChars: string[]
  missingChars: string[]
  reason: string | null
  observations: number
  consistentOffsets: number
}

export interface AutoOperationFailure {
  status: 'unsupported' | 'cancelled' | 'failed'
  backend?: RecognitionBackend
  reason: string
  detail?: string
}

export type LocateResult =
  | { status: 'success'; backend: 'wasm'; candidates: RoiCandidate[]; windowId?: number }
  | AutoOperationFailure

export type LearnResult =
  | { status: 'success'; backend: 'wasm'; profile: RecognitionProfile | null; report: LearnReport }
  | AutoOperationFailure

export interface LocateResultMessage {
  type: 'located'
  generation: number
  requestId: number
  result: LocateResult
}

export interface LearnResultMessage {
  type: 'learned'
  generation: number
  requestId: number
  result: LearnResult
}

/** Pixel-change bracket and midpoint, all in the source's media seconds. */
export interface TickMoment {
  lastUnchanged: number
  firstChanged: number
  midpoint: number
  change: number
  noiseFloor: number
}

/** Debug payload trimmed to what survives structured cloning cheaply. */
export interface WorkerDebug {
  roiPixels: { x: number; y: number; width: number; height: number }
  binary: { data: Uint8Array; width: number; height: number }
  boxes: GlyphBox[]
  projection: number[]
  inkRatio: number
  matches: GlyphMatch[]
  normalized: Uint8Array[]
}

export interface ConfiguredMessage {
  type: 'configured'
  generation: number
  ready: boolean
  missing: string[]
  sampleCount: number
}

export interface ResultMessage {
  type: 'result'
  generation: number
  role: SourceRole
  frameIndex: number
  outcome: RecognitionOutcome
  debug: WorkerDebug | null
  /** Worker-side processing time in ms, shown in the debug panel. */
  elapsedMs: number
  backend?: RecognitionBackend
  tickMoment?: TickMoment
  /** Explicit capability result when the recognition fallback has no pixel detector. */
  tickMomentStatus?: 'supported' | 'unsupported'
  score?: ScoreReading
}

export interface WorkerErrorMessage {
  type: 'error'
  generation: number
  message: string
}

export type WorkerResponse = ConfiguredMessage | ResultMessage | WorkerErrorMessage | LocateResultMessage | LearnResultMessage
