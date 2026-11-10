import type { ActiveProfile } from '../core/activeProfile'
import type { HudFrameResult } from '../core/hudWasm'
/**
 * Worker protocol for clock recognition.
 *
 * Every message carries a `generation`. The generation is bumped whenever the
 * profile, the ROI or the sampled source changes; results from an older
 * generation are stale by definition and get dropped instead of being applied to
 * the new configuration. That single field replaces a pile of "is this still
 * relevant?" checks scattered around the caller.
 */

import type { GlyphBox } from '../core/segmentation'
import type { GlyphMatch } from '../core/templateMatch'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import type { RoiRect } from '../core/profileSchema'

export interface ConfigureMessage {
  type: 'configure'
  generation: number
  profile: ActiveProfile
  /** Preserve compatible layout caches when promoting a discovered clock to memory. */
  preserveBasic?: boolean
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
}

export interface CancelMessage {
  type: 'cancel'
  generation: number
  /** Window completion may retain an automatic clock; source invalidation never does. */
  preserveBasic?: boolean
  /** Playback interruptions invalidate time evidence while keeping verified layout parameters. */
  resetTiming?: boolean
}

export type WorkerRequest = ConfigureMessage | FrameMessage | CancelMessage

export type RecognitionBackend = 'wasm' | 'typescript'

/** Pixel-change bracket and midpoint, all in the source's media seconds. */
export interface TickMoment {
  lastUnchanged: number
  firstChanged: number
  midpoint: number
  change: number
  noiseFloor: number
}

export interface BasicClockDiagnostic {
  status: 'searching' | 'confirming' | 'locked' | 'ambiguous'
  mode: 'auto' | 'manual' | 'memory'
  roi?: RoiRect
  searchRoi?: RoiRect
  text?: string
  candidates?: RoiRect[]
  preview?: { width: number; height: number; data: Uint8Array }
  threshold?: number
  mediaTime?: number
  inputSize?: { width: number; height: number }
}

export interface BasicClockVisualFrame {
  diagnostic: BasicClockDiagnostic
  debug: WorkerDebug | null
  frameIndex: number
  receivedAt: number
}

export interface BasicClockProgress extends BasicClockVisualFrame {
  visual?: BasicClockVisualFrame
  sync?: { readings: number; jumps: number; lastDrop?: string }
  error?: string
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
  hud?: HudFrameResult
  basic?: BasicClockDiagnostic
  /** Worker-side processing time in ms, shown in the debug panel. */
  elapsedMs: number
  backend?: RecognitionBackend
  tickMoment?: TickMoment
  /** Explicit capability result when the recognition fallback has no pixel detector. */
  tickMomentStatus?: 'supported' | 'unsupported'
}

export interface WorkerErrorMessage {
  type: 'error'
  generation: number
  message: string
}

export type WorkerResponse = ConfiguredMessage | ResultMessage | WorkerErrorMessage
