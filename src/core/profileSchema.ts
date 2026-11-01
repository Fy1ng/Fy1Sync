/** Internal transient clock-learning model. Persisted assets use HudStylePack. */
import type { CountdownFormat } from './clockJump'

export const TEMPLATE_WIDTH = 32
export const TEMPLATE_HEIGHT = 48
export const TEMPLATE_PIXELS = TEMPLATE_WIDTH * TEMPLATE_HEIGHT
export const CLOCK_CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':'] as const
export type ClockChar = (typeof CLOCK_CHARS)[number]

export interface RoiRect {
  /** Fractions of the video content box, 0..1. */
  x: number
  y: number
  w: number
  h: number
}

export interface PreprocessSettings {
  /** Contrast multiplier applied to the grayscale value before thresholding. */
  scale: number
  /** Binarisation cut-off, 0..255. */
  threshold: number
  /** Dark-on-light clocks need inversion so ink is 255. */
  invert: boolean
}

export interface TemplateSample {
  id: string
  /** Bit-packed base64 bitmap, TEMPLATE_PIXELS pixels. */
  data: string
  createdAt: number
  /** Where the sample came from, for the editor's sample list. */
  origin?: string
}

export interface RecognitionProfile {
  /** Stable id such as `cs2/iem`. */
  id: string
  name: string
  roi: RoiRect
  clockFormat: CountdownFormat
  detectWindowSeconds: number
  sampleFps: number
  matchThreshold: number
  preprocess: PreprocessSettings
  templates: Partial<Record<ClockChar, TemplateSample[]>>
  updatedAt: number
  notes?: string
}

export const DEFAULT_PREPROCESS: PreprocessSettings = { scale: 1.4, threshold: 150, invert: false }

export function createEmptyProfile(id = 'custom/untitled', name = '未命名场景'): RecognitionProfile {
  return {
    id,
    name,
    roi: { x: 0.44, y: 0.02, w: 0.12, h: 0.07 },
    clockFormat: 'm:ss',
    detectWindowSeconds: 3,
    sampleFps: 30,
    matchThreshold: 0.82,
    preprocess: { ...DEFAULT_PREPROCESS },
    templates: {},
    updatedAt: 0,
    notes: '',
  }
}

/** A profile can only drive recognition when every needed glyph has a sample. */
export function profileReadiness(profile: RecognitionProfile): {
  ready: boolean
  missing: ClockChar[]
  sampleCount: number
} {
  const needed: ClockChar[] = profile.clockFormat === 'ss' ? ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] : [...CLOCK_CHARS]
  const missing = needed.filter((char) => (profile.templates[char]?.length ?? 0) === 0)
  const sampleCount = Object.values(profile.templates).reduce(
    (total, samples) => total + (samples?.length ?? 0),
    0,
  )
  return { ready: missing.length === 0, missing, sampleCount }
}
