/** A field-specific rail view; the full pack remains the authoritative document. */
import { CLOCK_CHARS, type ClockChar, type PreprocessSettings, type RoiRect, type TemplateSample } from '../../core/profileSchema'
import { createEmptyHudStylePack, type HudField, type HudFieldId, type HudSegment, type HudStylePack, type HudVariant } from '../../core/hudStylePack'
import { editorVariant } from './layoutModel'

export interface EditorClockModel {
  id: string
  name: string
  roi: RoiRect
  preprocess: PreprocessSettings
  segment: HudSegment
  templates: Partial<Record<ClockChar, TemplateSample[]>>
  clockFormat: 'm:ss' | 'mm:ss' | 'ss'
  matchThreshold: number
}

export const FIELD_LABELS: Record<HudFieldId, string> = { clock: '倒计时', scoreLeft: '左比分', scoreRight: '右比分' }

/** Left/right fonts share normalized digits, not their source regions or color preprocessing. */
function scoreGlyphs(variant: HudVariant): HudField['glyphs'] {
  return Object.fromEntries(CLOCK_CHARS.filter(char => char !== ':').flatMap(char => {
    const ids = [...new Set((['scoreLeft', 'scoreRight'] as const).flatMap(id => variant.fields[id]?.glyphs[char] ?? []))]
    return ids.length ? [[char, ids]] : []
  }))
}

/** Unconfigured fields get an editable empty view, without changing an imported document. */
export function editorField(pack: HudStylePack, fieldId: HudFieldId, variantId?: string): HudField {
  const variant = editorVariant(pack, variantId)
  const configured = variant.fields[fieldId]
  if (configured) return configured
  const fallback = createEmptyHudStylePack(pack.id, pack.name, variant.nativeSize).variants[0]!.fields.clock!
  if (fieldId === 'clock') return fallback
  const { width, height } = variant.nativeSize
  return { ...fallback, roi: { x: Math.floor(width * (fieldId === 'scoreLeft' ? 0.4 : 0.56)),
    y: Math.floor(height * 0.04), w: Math.max(1, Math.floor(width * 0.04)), h: Math.max(1, Math.floor(height * 0.08)) },
  grammar: { kind: 'integer', min: 0, max: 99 }, match: { ...fallback.match, minScore: 0.9 } }
}

export function fieldModel(pack: HudStylePack, fieldId: HudFieldId, variantId?: string): EditorClockModel {
  const variant = editorVariant(pack, variantId)
  const field = editorField(pack, fieldId, variant.id)
  const glyphs = fieldId === 'clock' ? field.glyphs : scoreGlyphs(variant)
  const { width, height } = variant.nativeSize
  return { id: pack.id, name: pack.name, roi: { x: field.roi.x / width, y: field.roi.y / height,
    w: field.roi.w / width, h: field.roi.h / height }, preprocess: field.preprocess, segment: field.segment,
    clockFormat: field.grammar.kind === 'countdown' ? field.grammar.format : 'ss', matchThreshold: field.match.minScore,
    templates: Object.fromEntries(CLOCK_CHARS.flatMap(char => {
      const ids = glyphs[char]
      return ids ? [[char, ids.map(id => ({ id, data: pack.bitmaps[id]!.data, createdAt: 0 }))]] : []
    })) }
}

export function fieldReadiness(pack: HudStylePack, fieldId: HudFieldId, variantId?: string): { ready: boolean; missing: ClockChar[]; sampleCount: number } {
  const field = editorField(pack, fieldId, variantId)
  const glyphs = fieldId === 'clock' ? field.glyphs : scoreGlyphs(editorVariant(pack, variantId))
  const needed = fieldId === 'clock' && field.grammar.kind === 'countdown' && field.grammar.format !== 'ss'
    ? CLOCK_CHARS : CLOCK_CHARS.filter(char => char !== ':')
  const missing = needed.filter(char => !glyphs[char]?.length)
  return { ready: missing.length === 0, missing,
    sampleCount: Object.values(glyphs).reduce((count, refs) => count + refs.length, 0) }
}

export function patchField(pack: HudStylePack, fieldId: HudFieldId, patch: Partial<EditorClockModel>, variantId?: string): HudStylePack {
  const variant = editorVariant(pack, variantId)
  const field = editorField(pack, fieldId, variant.id)
  const { width, height } = variant.nativeSize
  const bitmaps = { ...pack.bitmaps }
  const glyphs = patch.templates ? Object.fromEntries(Object.entries(patch.templates).map(([char, samples]) => [char, samples!.map(sample => {
    // IDs share one namespace with fixed templates, so existing assets stay untouched.
    let id = sample.id === ':' ? 'colon' : sample.id.replace(/:/g, 'colon')
    if (bitmaps[id] && bitmaps[id]!.data !== sample.data) id = `glyph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    bitmaps[id] = { width: 32, height: 48, data: sample.data }
    return id
  })])) : !variant.fields[fieldId] && fieldId !== 'clock' ? scoreGlyphs(variant) : field.glyphs
  const x = patch.roi ? Math.max(0, Math.min(width - 1, Math.round(patch.roi.x * width))) : field.roi.x
  const y = patch.roi ? Math.max(0, Math.min(height - 1, Math.round(patch.roi.y * height))) : field.roi.y
  const roi = patch.roi ? { x, y, w: Math.max(1, Math.min(width - x, Math.round(patch.roi.w * width))),
    h: Math.max(1, Math.min(height - y, Math.round(patch.roi.h * height))) } : field.roi
  const fields: HudVariant['fields'] = { ...variant.fields, [fieldId]: {
      ...field, roi, preprocess: patch.preprocess ?? field.preprocess, segment: patch.segment ?? field.segment, glyphs,
      grammar: fieldId === 'clock' && patch.clockFormat ? { kind: 'countdown', format: patch.clockFormat } : field.grammar,
      match: { ...field.match, minScore: patch.matchThreshold ?? field.match.minScore },
    } }
  if (patch.templates && fieldId !== 'clock') {
    const other = fieldId === 'scoreLeft' ? 'scoreRight' : 'scoreLeft'
    // Do not invent a second region just because the first side has been taught.
    if (fields[other]) fields[other] = { ...fields[other], glyphs }
  }
  return { ...pack, id: patch.id ?? pack.id, name: patch.name ?? pack.name, revision: pack.revision + 1, bitmaps,
    variants: pack.variants.map(item => item.id !== variant.id ? item : { ...item, fields }) }
}

export function clockModel(pack: HudStylePack, variantId?: string): EditorClockModel { return fieldModel(pack, 'clock', variantId) }
export function patchClock(pack: HudStylePack, patch: Partial<EditorClockModel>, variantId?: string): HudStylePack { return patchField(pack, 'clock', patch, variantId) }
export function sizeEmptyClock(pack: HudStylePack, width: number, height: number): HudStylePack {
  const variant = pack.variants[0]!
  if (variant.nativeSize.width === width && variant.nativeSize.height === height) return pack
  if (Object.keys(pack.bitmaps).length || pack.variants.length > 1 || Object.keys(variant.cues).length || variant.organizer
    || Object.keys(variant.states).length || variant.fields.scoreLeft || variant.fields.scoreRight) return pack
  const resized = createEmptyHudStylePack(pack.id, pack.name, { width, height })
  const model = clockModel(pack)
  const clock = patchClock(resized, { roi: model.roi }).variants[0]!.fields.clock!
  return { ...resized, revision: pack.revision + 1, variants: [{ ...resized.variants[0]!, fields: { ...variant.fields,
    clock: { ...variant.fields.clock!, roi: clock.roi } } }] }
}
