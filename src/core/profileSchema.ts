/**
 * Recognition profile schema (v2) plus validation and v1 migration.
 *
 * v1 stored a single template bitmap per character. Real broadcasts render the
 * same digit slightly differently between rounds (anti-aliasing, overlays,
 * scoreboard animation), so v2 stores an array of samples per character and
 * matching takes the best score across them.
 */

import type { CountdownFormat } from './clockJump'

export const PROFILE_SCHEMA_VERSION = 2 as const
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
  /** Light-on-dark clocks need inversion so ink is 255. */
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
  schemaVersion: typeof PROFILE_SCHEMA_VERSION
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
    schemaVersion: PROFILE_SCHEMA_VERSION,
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

export interface ProfileIssue {
  path: string
  message: string
  severity: 'error' | 'warning'
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u
const CLOCK_FORMATS: CountdownFormat[] = ['m:ss', 'mm:ss', 'ss', 'auto']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkFraction(value: unknown, path: string, issues: ProfileIssue[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: '必须是数字', severity: 'error' })
    return 0
  }
  if (value < 0 || value > 1) {
    issues.push({ path, message: '必须在 0 与 1 之间', severity: 'error' })
  }
  return value
}

function validateRoi(value: unknown, issues: ProfileIssue[]): RoiRect {
  if (!isRecord(value)) {
    issues.push({ path: 'roi', message: '缺少识别区域', severity: 'error' })
    return { x: 0, y: 0, w: 0, h: 0 }
  }
  const roi: RoiRect = {
    x: checkFraction(value.x, 'roi.x', issues),
    y: checkFraction(value.y, 'roi.y', issues),
    w: checkFraction(value.w, 'roi.w', issues),
    h: checkFraction(value.h, 'roi.h', issues),
  }
  if (roi.w <= 0 || roi.h <= 0) {
    issues.push({ path: 'roi', message: '识别区域宽高必须大于 0', severity: 'error' })
  }
  if (roi.x + roi.w > 1.0001 || roi.y + roi.h > 1.0001) {
    issues.push({ path: 'roi', message: '识别区域超出画面范围', severity: 'error' })
  }
  return roi
}

function validatePreprocess(value: unknown, issues: ProfileIssue[]): PreprocessSettings {
  if (!isRecord(value)) {
    issues.push({ path: 'preprocess', message: '缺少预处理参数，已使用默认值', severity: 'warning' })
    return { ...DEFAULT_PREPROCESS }
  }
  const scale = typeof value.scale === 'number' && value.scale > 0 ? value.scale : NaN
  if (!Number.isFinite(scale)) {
    issues.push({ path: 'preprocess.scale', message: '对比度必须大于 0', severity: 'error' })
  }
  const threshold = typeof value.threshold === 'number' ? value.threshold : NaN
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    issues.push({ path: 'preprocess.threshold', message: '阈值必须在 0-255 之间', severity: 'error' })
  }
  return {
    scale: Number.isFinite(scale) ? scale : DEFAULT_PREPROCESS.scale,
    threshold: Number.isFinite(threshold) ? threshold : DEFAULT_PREPROCESS.threshold,
    invert: value.invert === true,
  }
}

function validateSamples(
  char: string,
  value: unknown,
  issues: ProfileIssue[],
): TemplateSample[] {
  if (!Array.isArray(value)) {
    issues.push({ path: `templates.${char}`, message: '必须是样本数组', severity: 'error' })
    return []
  }
  const samples: TemplateSample[] = []
  value.forEach((raw, index) => {
    const path = `templates.${char}[${index}]`
    if (!isRecord(raw) || typeof raw.data !== 'string' || raw.data.length === 0) {
      issues.push({ path, message: '样本缺少位图数据', severity: 'error' })
      return
    }
    const expectedChars = Math.ceil(Math.ceil(TEMPLATE_PIXELS / 8) / 3) * 4
    if (raw.data.length < expectedChars) {
      issues.push({ path, message: '位图数据长度不足', severity: 'error' })
      return
    }
    samples.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `${char}-${index}`,
      data: raw.data,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      ...(typeof raw.origin === 'string' ? { origin: raw.origin } : {}),
    })
  })
  return samples
}

export interface ValidationResult {
  profile: RecognitionProfile | null
  issues: ProfileIssue[]
}

/** Validate an already-v2 object. Use `parseProfile` for unknown input. */
export function validateProfile(value: unknown): ValidationResult {
  const issues: ProfileIssue[] = []
  if (!isRecord(value)) {
    return { profile: null, issues: [{ path: '', message: '配置必须是对象', severity: 'error' }] }
  }

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!ID_PATTERN.test(id)) {
    issues.push({ path: 'id', message: 'id 只能包含小写字母、数字、. _ - 和 /', severity: 'error' })
  }
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id
  if (!name) issues.push({ path: 'name', message: '缺少名称', severity: 'error' })

  const roi = validateRoi(value.roi, issues)
  const preprocess = validatePreprocess(value.preprocess, issues)

  const clockFormat = CLOCK_FORMATS.includes(value.clockFormat as CountdownFormat)
    ? (value.clockFormat as CountdownFormat)
    : 'm:ss'
  if (value.clockFormat !== undefined && !CLOCK_FORMATS.includes(value.clockFormat as CountdownFormat)) {
    issues.push({ path: 'clockFormat', message: '未知时钟格式，已回退到 m:ss', severity: 'warning' })
  }

  const detectWindowSeconds = clampNumber(value.detectWindowSeconds, 1, 10, 3, 'detectWindowSeconds', issues)
  const sampleFps = clampNumber(value.sampleFps, 1, 60, 30, 'sampleFps', issues)
  const matchThreshold = clampNumber(value.matchThreshold, 0.1, 1, 0.82, 'matchThreshold', issues)

  const templates: Partial<Record<ClockChar, TemplateSample[]>> = {}
  if (value.templates !== undefined) {
    if (!isRecord(value.templates)) {
      issues.push({ path: 'templates', message: '模板必须是对象', severity: 'error' })
    } else {
      for (const [char, samples] of Object.entries(value.templates)) {
        if (!CLOCK_CHARS.includes(char as ClockChar)) {
          issues.push({ path: `templates.${char}`, message: '不支持的字符，已忽略', severity: 'warning' })
          continue
        }
        const parsed = validateSamples(char, samples, issues)
        if (parsed.length > 0) templates[char as ClockChar] = parsed
      }
    }
  }

  if (issues.some((issue) => issue.severity === 'error')) {
    return { profile: null, issues }
  }

  return {
    profile: {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      id,
      name,
      roi,
      clockFormat,
      detectWindowSeconds,
      sampleFps,
      matchThreshold,
      preprocess,
      templates,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    },
    issues,
  }
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  path: string,
  issues: ProfileIssue[],
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: '必须是数字', severity: 'error' })
    return fallback
  }
  if (value < min || value > max) {
    issues.push({ path, message: `必须在 ${min} 与 ${max} 之间`, severity: 'error' })
    return fallback
  }
  return value
}

/**
 * Accept v1 or v2 input and return a validated v2 profile.
 * v1 shape: `templates: { "0": { data: string } }` and `threshold`/`invert` at
 * the top level instead of nested under `preprocess`.
 */
export function parseProfile(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { profile: null, issues: [{ path: '', message: '配置必须是对象', severity: 'error' }] }
  }
  const version = typeof value.schemaVersion === 'number' ? value.schemaVersion : 1
  if (version > PROFILE_SCHEMA_VERSION) {
    return {
      profile: null,
      issues: [
        {
          path: 'schemaVersion',
          message: `配置版本 ${version} 高于当前支持的 ${PROFILE_SCHEMA_VERSION}，请升级应用`,
          severity: 'error',
        },
      ],
    }
  }
  if (version === PROFILE_SCHEMA_VERSION) return validateProfile(value)

  const migrated = migrateV1(value)
  const result = validateProfile(migrated.value)
  return { profile: result.profile, issues: [...migrated.issues, ...result.issues] }
}

function migrateV1(value: Record<string, unknown>): {
  value: Record<string, unknown>
  issues: ProfileIssue[]
} {
  const issues: ProfileIssue[] = [
    { path: 'schemaVersion', message: '已从 v1 迁移到 v2（单模板转为样本数组）', severity: 'warning' },
  ]
  const templates: Record<string, unknown[]> = {}
  const rawTemplates = isRecord(value.templates) ? value.templates : {}
  for (const [char, sample] of Object.entries(rawTemplates)) {
    if (Array.isArray(sample)) {
      templates[char] = sample
    } else if (isRecord(sample) && typeof sample.data === 'string') {
      templates[char] = [{ id: `${char}-migrated`, data: sample.data, createdAt: 0, origin: 'v1' }]
    } else if (typeof sample === 'string') {
      templates[char] = [{ id: `${char}-migrated`, data: sample, createdAt: 0, origin: 'v1' }]
    }
  }

  const preprocess = isRecord(value.preprocess)
    ? value.preprocess
    : {
        scale: typeof value.scale === 'number' ? value.scale : DEFAULT_PREPROCESS.scale,
        threshold: typeof value.threshold === 'number' ? value.threshold : DEFAULT_PREPROCESS.threshold,
        invert: value.invert === true,
      }

  return {
    value: { ...value, schemaVersion: PROFILE_SCHEMA_VERSION, templates, preprocess },
    issues,
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
