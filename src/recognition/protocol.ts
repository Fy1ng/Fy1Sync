/**
 * Worker protocol for clock recognition.
 *
 * Every message carries a `generation`. The generation is bumped whenever the
 * profile, the ROI or the sampled source changes; results from an older
 * generation are stale by definition and get dropped instead of being applied to
 * the new configuration. That single field replaces a pile of "is this still
 * relevant?" checks scattered around the caller.
 */

import type { RecognitionProfile } from '../core/profileSchema'
import type { GlyphBox } from '../core/segmentation'
import type { GlyphMatch } from '../core/templateMatch'
import type { RecognitionOutcome, SourceRole } from '../core/types'

export interface ConfigureMessage {
  type: 'configure'
  generation: number
  profile: RecognitionProfile
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
}

export type WorkerRequest = ConfigureMessage | FrameMessage | CancelMessage

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
}

export interface WorkerErrorMessage {
  type: 'error'
  generation: number
  message: string
}

export type WorkerResponse = ConfiguredMessage | ResultMessage | WorkerErrorMessage
