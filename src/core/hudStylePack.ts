/** Portable HUD assets. Validation never repairs or fills imported data. */
import { CLOCK_CHARS, type ClockChar } from './profileSchema'
import { createHudPreprocess, type HudPreprocessSettings } from './hudPreprocess'

export const HUD_STYLE_PACK_VERSION = 1 as const
export const HUD_FIELD_IDS = ['clock', 'scoreLeft', 'scoreRight'] as const
export const HUD_RESULT_FIELD_IDS = [...HUD_FIELD_IDS, 'round'] as const
export const HUD_CUE_IDS = ['replay', 'bomb', 'timeout', 'roundPrefix', 'roundOver', 'roundHistory', 'scoreboard'] as const
export type HudFieldId = (typeof HUD_FIELD_IDS)[number]
export type HudResultFieldId = (typeof HUD_RESULT_FIELD_IDS)[number]
export type HudCueId = (typeof HUD_CUE_IDS)[number]
export interface HudRoi { x: number; y: number; w: number; h: number }
export interface HudSize { width: number; height: number }
export interface HudBitmap extends HudSize { data: string }
export interface HudSegment { minColumnInk: number; minGlyphWidth: number; minGapWidth: number; minInkRatio: number }
export type HudGrammar = { kind: 'countdown'; format: 'm:ss' | 'mm:ss' | 'ss' } | { kind: 'integer'; min: number; max: number }
export interface HudField {
  enabled: boolean
  roi: HudRoi
  preprocess: HudPreprocessSettings
  segment: HudSegment
  glyphs: Partial<Record<ClockChar, string[]>>
  grammar: HudGrammar
  match: { minScore: number; minMargin: number }
  gateCue: HudCueId | null
}
export interface HudCue {
  enabled: boolean
  roi: HudRoi
  preprocess: HudPreprocessSettings
  templates: string[]
  minScore: number
}
export type HudCondition = { kind: 'cue'; cue: HudCueId; present: boolean } | { kind: 'field'; field: HudFieldId; present: boolean }
export interface HudVariant {
  id: string
  nativeSize: HudSize
  fields: Record<HudFieldId, HudField | null>
  cues: Partial<Record<HudCueId, HudCue>>
  states: Record<string, HudCondition[][]>
  organizer: HudCue | null
}
export interface HudStylePack {
  kind: 'hud-style-pack'
  schemaVersion: typeof HUD_STYLE_PACK_VERSION
  id: string
  revision: number
  name: string
  bitmaps: Record<string, HudBitmap>
  variants: HudVariant[]
}
export interface HudPackIssue { path: string; message: string; severity: 'error' }
export interface HudPackValidation { pack: HudStylePack | null; issues: HudPackIssue[] }

const ID = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const at = (path: string, key: string): string => path ? `${path}.${key}` : key

export function parseHudStylePack(value: unknown): HudPackValidation {
  const issues: HudPackIssue[] = []
  const error = (path: string, message: string): void => { issues.push({ path, message, severity: 'error' }) }
  const object = (raw: unknown, path: string, keys: readonly string[]): raw is Record<string, unknown> => {
    if (!record(raw)) { error(path, '必须是对象'); return false }
    for (const key of Object.keys(raw)) if (!keys.includes(key)) error(at(path, key), '未知字段')
    for (const key of keys) if (!Object.hasOwn(raw, key)) error(at(path, key), '缺少必填字段')
    return true
  }
  const number = (raw: unknown, path: string, min: number, max: number, integer = false): raw is number => {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || (integer && !Number.isSafeInteger(raw)) || raw < min || raw > max) {
      error(path, `必须是 ${min} 到 ${max} 的${integer ? '整数' : '有限数值'}`); return false
    }
    return true
  }
  const id = (raw: unknown, path: string, max = 128): raw is string => {
    if (typeof raw !== 'string' || raw.length > max || !ID.test(raw) || raw.includes('..')) { error(path, '标识格式无效'); return false }
    return true
  }
  const boolean = (raw: unknown, path: string): void => { if (typeof raw !== 'boolean') error(path, '必须是布尔值') }
  const size = (raw: unknown, path: string): raw is Record<string, number> => {
    if (!object(raw, path, ['width', 'height'])) return false
    const width = number(raw.width, at(path, 'width'), 1, 16384, true)
    const height = number(raw.height, at(path, 'height'), 1, 16384, true)
    return width && height
  }
  const preprocess = (raw: unknown, path: string): void => {
    if (!object(raw, path, ['mode', 'scale', 'threshold', 'invert', 'adaptive', 'hsv'])) return
    if (!['gray', 'adaptive', 'hsv'].includes(raw.mode as string)) error(`${path}.mode`, '必须是 gray, adaptive 或 hsv')
    number(raw.scale, at(path, 'scale'), 0.1, 10)
    number(raw.threshold, at(path, 'threshold'), 0, 255)
    boolean(raw.invert, at(path, 'invert'))
    const adaptivePath = `${path}.adaptive`
    if (object(raw.adaptive, adaptivePath, ['windowSize', 'offset'])) {
      if (number(raw.adaptive.windowSize, `${adaptivePath}.windowSize`, 3, 255, true)
        && (raw.adaptive.windowSize as number) % 2 !== 1) error(`${adaptivePath}.windowSize`, '局部窗口大小必须为奇数')
      number(raw.adaptive.offset, `${adaptivePath}.offset`, 0, 128)
    }
    const hsvPath = `${path}.hsv`
    if (object(raw.hsv, hsvPath, ['hue', 'tolerance', 'saturationMin', 'saturationMax', 'valueMin', 'valueMax'])) {
      if (number(raw.hsv.hue, `${hsvPath}.hue`, 0, 360) && raw.hsv.hue === 360) error(`${hsvPath}.hue`, '色相必须小于 360')
      number(raw.hsv.tolerance, `${hsvPath}.tolerance`, 0, 180)
      for (const key of ['saturationMin', 'saturationMax', 'valueMin', 'valueMax']) number(raw.hsv[key], `${hsvPath}.${key}`, 0, 1)
      if (typeof raw.hsv.saturationMin === 'number' && typeof raw.hsv.saturationMax === 'number'
        && raw.hsv.saturationMin > raw.hsv.saturationMax) error(`${hsvPath}.saturationMin`, '最低饱和度不能高于最高饱和度')
      if (typeof raw.hsv.valueMin === 'number' && typeof raw.hsv.valueMax === 'number'
        && raw.hsv.valueMin > raw.hsv.valueMax) error(`${hsvPath}.valueMin`, '最低明度不能高于最高明度')
    }
  }
  const roi = (raw: unknown, path: string, native: Record<string, unknown>): raw is Record<string, number> => {
    if (!object(raw, path, ['x', 'y', 'w', 'h'])) return false
    const checked = ['x', 'y', 'w', 'h'].map(key => number(raw[key], at(path, key), key === 'w' || key === 'h' ? 1 : 0, 16384, true))
    if (!checked.every(Boolean)) return false
    const r = raw as Record<string, number>
    if (typeof native.width === 'number' && typeof native.height === 'number' && (r.x! + r.w! > native.width || r.y! + r.h! > native.height)) error(path, '区域超出原生画面')
    return true
  }
  if (!record(value)) return { pack: null, issues: [{ path: '', message: '样式包必须是对象', severity: 'error' }] }
  if (value.schemaVersion === 2 || (value.kind !== 'hud-style-pack' && ('templates' in value || 'clockFormat' in value))) {
    return { pack: null, issues: [{ path: 'schemaVersion', message: '旧版倒计时配置已停用, 请重新制作样式包', severity: 'error' }] }
  }
  object(value, '', ['kind', 'schemaVersion', 'id', 'revision', 'name', 'bitmaps', 'variants'])
  if (value.kind !== 'hud-style-pack') error('kind', '必须是 hud-style-pack')
  if (value.schemaVersion !== HUD_STYLE_PACK_VERSION) error('schemaVersion', '仅支持样式包 schemaVersion 1, 请重新制作或升级应用')
  id(value.id, 'id', 65)
  number(value.revision, 'revision', 1, Number.MAX_SAFE_INTEGER, true)
  if (typeof value.name !== 'string' || value.name.trim().length === 0) error('name', '必须是非空名称')
  const bitmaps = record(value.bitmaps) ? value.bitmaps : {}
  if (!record(value.bitmaps)) error('bitmaps', '必须是位图对象')
  for (const [key, bitmap] of Object.entries(bitmaps)) {
    const path = `bitmaps.${key}`
    id(key, path)
    if (!object(bitmap, path, ['width', 'height', 'data'])) continue
    const width = number(bitmap.width, `${path}.width`, 1, 16384, true)
    const height = number(bitmap.height, `${path}.height`, 1, 16384, true)
    if (typeof bitmap.data !== 'string' || !BASE64.test(bitmap.data)) { error(`${path}.data`, '必须是严格 Base64'); continue }
    let decoded: string
    try { decoded = atob(bitmap.data) } catch { error(`${path}.data`, '必须是严格 Base64'); continue }
    if (btoa(decoded) !== bitmap.data) { error(`${path}.data`, 'Base64 填充位必须为 0'); continue }
    if (!width || !height) continue
    const pixels = (bitmap.width as number) * (bitmap.height as number)
    if (decoded.length !== Math.ceil(pixels / 8)) { error(`${path}.data`, '位图字节数必须恰好是 ceil(width*height/8)'); continue }
    const remaining = pixels % 8
    if (remaining && (decoded.charCodeAt(decoded.length - 1) & ((1 << (8 - remaining)) - 1)) !== 0) error(`${path}.data`, '位图末尾多余位必须为 0')
    let ink = 0
    for (let p = 0; p < pixels; p += 1) if (decoded.charCodeAt(p >> 3) & (1 << (7 - (p % 8)))) ink += 1
    if (ink === 0 || ink === pixels) error(`${path}.data`, '位图不能全空或全满')
  }
  const references = (raw: unknown, path: string, dimensions: { width: number; height: number } | null, allowEmpty = false): void => {
    if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0)) { error(path, allowEmpty ? '必须是位图 ID 数组' : '必须是非空位图 ID 数组'); return }
    raw.forEach((ref: unknown, index) => {
      const p = `${path}[${index}]`
      if (typeof ref !== 'string' || !Object.hasOwn(bitmaps, ref)) { error(p, '引用的位图不存在'); return }
      const bitmap = bitmaps[ref]
      if (dimensions && record(bitmap) && (bitmap.width !== dimensions.width || bitmap.height !== dimensions.height)) error(p, '引用的位图尺寸不匹配')
    })
  }
  if (!Array.isArray(value.variants) || value.variants.length === 0) error('variants', '必须至少有一个布局档')
  const variantIds = new Set<string>()
  if (Array.isArray(value.variants)) value.variants.forEach((variant: unknown, index) => {
    const path = `variants[${index}]`
    if (!object(variant, path, ['id', 'nativeSize', 'fields', 'cues', 'states', 'organizer'])) return
    if (id(variant.id, `${path}.id`)) {
      if (variantIds.has(variant.id)) error(`${path}.id`, '布局 ID 重复')
      variantIds.add(variant.id)
    }
    size(variant.nativeSize, `${path}.nativeSize`)
    const native = record(variant.nativeSize) ? variant.nativeSize : {}
    const cues = record(variant.cues) ? variant.cues : {}
    if (!record(variant.cues)) error(`${path}.cues`, '必须是对象')
    for (const key of Object.keys(cues)) if (!(HUD_CUE_IDS as readonly string[]).includes(key)) error(`${path}.cues.${key}`, '未知字段')
    const template = (raw: unknown, p: string): void => {
      if (!object(raw, p, ['enabled', 'roi', 'preprocess', 'templates', 'minScore'])) return
      boolean(raw.enabled, `${p}.enabled`)
      const region = raw.roi
      const hasRoi = roi(region, `${p}.roi`, native)
      preprocess(raw.preprocess, `${p}.preprocess`)
      number(raw.minScore, `${p}.minScore`, 0, 1)
      references(raw.templates, `${p}.templates`, hasRoi ? { width: region.w!, height: region.h! } : null, true)
    }
    for (const [key, cue] of Object.entries(cues)) template(cue, `${path}.cues.${key}`)
    if (variant.organizer !== null) template(variant.organizer, `${path}.organizer`)
    const fields = record(variant.fields) ? variant.fields : {}
    if (object(variant.fields, `${path}.fields`, HUD_FIELD_IDS)) for (const fieldId of HUD_FIELD_IDS) {
      const field = variant.fields[fieldId]
      const p = `${path}.fields.${fieldId}`
      if (field === null) continue
      if (!object(field, p, ['enabled', 'roi', 'preprocess', 'segment', 'glyphs', 'grammar', 'match', 'gateCue'])) continue
      boolean(field.enabled, `${p}.enabled`)
      roi(field.roi, `${p}.roi`, native)
      preprocess(field.preprocess, `${p}.preprocess`)
      if (object(field.segment, `${p}.segment`, ['minColumnInk', 'minGlyphWidth', 'minGapWidth', 'minInkRatio'])) {
        for (const key of ['minColumnInk', 'minGlyphWidth', 'minGapWidth']) number(field.segment[key], `${p}.segment.${key}`, 1, 16384, true)
        number(field.segment.minInkRatio, `${p}.segment.minInkRatio`, 0, 1)
      }
      if (!record(field.glyphs)) error(`${p}.glyphs`, '必须是对象')
      else for (const [char, refs] of Object.entries(field.glyphs)) {
        if (!(CLOCK_CHARS as readonly string[]).includes(char) || (fieldId !== 'clock' && char === ':')) error(`${p}.glyphs.${char}`, '不支持的字符')
        references(refs, `${p}.glyphs.${char}`, { width: 32, height: 48 })
      }
      if (!record(field.grammar)) error(`${p}.grammar`, '必须是对象')
      else if (fieldId === 'clock') {
        object(field.grammar, `${p}.grammar`, ['kind', 'format'])
        if (field.grammar.kind !== 'countdown') error(`${p}.grammar.kind`, '倒计时必须使用 countdown 语法')
        if (!['m:ss', 'mm:ss', 'ss'].includes(field.grammar.format as string)) error(`${p}.grammar.format`, '倒计时格式必须是 m:ss, mm:ss 或 ss')
      } else {
        object(field.grammar, `${p}.grammar`, ['kind', 'min', 'max'])
        if (field.grammar.kind !== 'integer') error(`${p}.grammar.kind`, '数字字段必须使用 integer 语法')
        const min = number(field.grammar.min, `${p}.grammar.min`, 0, 99, true)
        const max = number(field.grammar.max, `${p}.grammar.max`, 0, 99, true)
        if (min && max && (field.grammar.min as number) > (field.grammar.max as number)) error(`${p}.grammar`, 'min 不能大于 max')
      }
      if (object(field.match, `${p}.match`, ['minScore', 'minMargin'])) {
        number(field.match.minScore, `${p}.match.minScore`, 0, 1)
        number(field.match.minMargin, `${p}.match.minMargin`, 0, 1)
      }
      if (field.gateCue !== null) error(`${p}.gateCue`, '该字段的 gateCue 必须为 null')
      if (field.gateCue !== null && (typeof field.gateCue !== 'string' || !Object.hasOwn(cues, field.gateCue))) error(`${p}.gateCue`, '引用的 cue 不存在')
    }
    if (!record(variant.states)) error(`${path}.states`, '必须是对象')
    else for (const [state, groups] of Object.entries(variant.states)) {
      const p = `${path}.states.${state}`
      id(state, p)
      if (!Array.isArray(groups) || groups.length === 0) { error(p, '必须是非空条件组数组'); continue }
      groups.forEach((group: unknown, groupIndex) => {
        const gp = `${p}[${groupIndex}]`
        if (!Array.isArray(group) || group.length === 0) { error(gp, '条件组不能为空'); return }
        group.forEach((condition: unknown, conditionIndex) => {
          const cp = `${gp}[${conditionIndex}]`
          if (!record(condition)) { error(cp, '必须是条件对象'); return }
          if (condition.kind === 'cue') {
            object(condition, cp, ['kind', 'cue', 'present'])
            if (typeof condition.cue !== 'string' || !Object.hasOwn(cues, condition.cue)) error(`${cp}.cue`, '引用的 cue 不存在')
          } else if (condition.kind === 'field') {
            object(condition, cp, ['kind', 'field', 'present'])
            if (typeof condition.field !== 'string' || !(HUD_FIELD_IDS as readonly string[]).includes(condition.field) || !Object.hasOwn(fields, condition.field) || fields[condition.field] === null) error(`${cp}.field`, '引用的字段未配置')
          } else { error(`${cp}.kind`, '未知条件类型'); return }
          boolean(condition.present, `${cp}.present`)
        })
      })
    }
  })
  return { pack: issues.length === 0 ? value as unknown as HudStylePack : null, issues }
}

export const validateHudStylePack = parseHudStylePack

export function createEmptyHudStylePack(id = 'custom/untitled', name = '未命名场景', nativeSize: HudSize = { width: 1920, height: 1080 }): HudStylePack {
  return {
    kind: 'hud-style-pack', schemaVersion: HUD_STYLE_PACK_VERSION, id, revision: 1, name, bitmaps: {},
    variants: [{
      id: `official-top-${nativeSize.height}`, nativeSize: { ...nativeSize },
      fields: {
        clock: {
          enabled: true,
          roi: { x: Math.floor(nativeSize.width * 0.44), y: Math.floor(nativeSize.height * 0.02), w: Math.max(1, Math.floor(nativeSize.width * 0.12)), h: Math.max(1, Math.floor(nativeSize.height * 0.07)) },
          preprocess: createHudPreprocess(),
          segment: { minColumnInk: 1, minGlyphWidth: 2, minGapWidth: 1, minInkRatio: 0.08 },
          glyphs: {}, grammar: { kind: 'countdown', format: 'm:ss' }, match: { minScore: 0.82, minMargin: 0.03 }, gateCue: null,
        },
        scoreLeft: null, scoreRight: null,
      },
      cues: {}, states: {}, organizer: null,
    }],
  }
}

export function hudPackReadiness(pack: HudStylePack, variantId = pack.variants[0]?.id): { ready: boolean; missing: ClockChar[]; sampleCount: number } {
  const clock = pack.variants.find(variant => variant.id === variantId)?.fields.clock
  const needed = clock?.grammar.kind === 'countdown' && clock.grammar.format === 'ss' ? CLOCK_CHARS.filter(char => char !== ':') : CLOCK_CHARS
  const missing = needed.filter(char => !clock?.glyphs[char]?.length)
  const sampleCount = Object.values(clock?.glyphs ?? {}).reduce((count, refs) => count + refs.length, 0)
  return { ready: clock?.enabled === true && missing.length === 0, missing, sampleCount }
}
