import type { HudCueId, HudFieldId } from '../../core/hudStylePack'
import type { HudContent, HudFieldResult, HudPhase, HudPresenceResult } from '../../core/hudWasm'

export type ValidationTarget = HudFieldId | HudCueId | 'organizer' | 'layout' | 'state' | 'frame'
export interface ValidationRange { from: number; to: number; step: number }
export interface ValidationNote {
  kind: 'issue' | 'transition'
  target: ValidationTarget
  code: string
  message: string
}
export interface ValidationField {
  status: HudFieldResult['status']
  text: string | null
  value: number | null
  confidence: number | null
  reason: string | null
}
export interface ValidationPresence {
  status: HudPresenceResult['status']
  score: number | null
  reason: string | null
}
/** Compact recognition evidence only; full frame/debug pixel arrays are never retained per row. */
export interface ValidationRow {
  index: number
  at: number
  layout: string | null
  content: HudContent
  phase: HudPhase
  fields: Record<HudFieldId, ValidationField>
  cues: Partial<Record<HudCueId | 'organizer', ValidationPresence>>
  notes: ValidationNote[]
}
export interface ValidationSummary {
  sampled: number
  issueFrames: number
  unavailableFrames: number
  transitionFrames: number
  fields: Record<HudFieldId, { read: number; attempted: number; absent: number; disabled: number }>
}
export interface ValidationRun extends ValidationRange {
  packId: string
  packName: string
  packRevision: number
  sourceName: string
  total: number
}
export interface ValidationImage {
  target: ValidationTarget
  label: string
  url: string
  width: number
  height: number
}
export interface ValidationPreview { index: number; at: number; images: ValidationImage[] }
export interface ValidationState {
  phase: 'idle' | 'running' | 'complete' | 'stopped' | 'error'
  run: ValidationRun | null
  rows: ValidationRow[]
  error: string | null
  preview: ValidationPreview | null
  previewBusy: boolean
  selectedIndex: number | null
}

export const MAX_VALIDATION_SAMPLES = 7200
export const EMPTY_VALIDATION_STATE: ValidationState = {
  phase: 'idle', run: null, rows: [], error: null, preview: null, previewBusy: false, selectedIndex: null,
}
