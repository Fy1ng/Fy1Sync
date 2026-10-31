/** A clock-only rail view; the full pack remains the authoritative document. */
import { CLOCK_CHARS, type ClockChar, type PreprocessSettings, type RoiRect, type TemplateSample } from '../../core/profileSchema'
import { createEmptyHudStylePack, type HudStylePack } from '../../core/hudStylePack'

export interface EditorClockModel {
  id: string
  name: string
  roi: RoiRect
  preprocess: PreprocessSettings
  templates: Partial<Record<ClockChar, TemplateSample[]>>
  clockFormat: 'm:ss' | 'mm:ss' | 'ss'
  matchThreshold: number
}
export function clockModel(pack: HudStylePack): EditorClockModel {
  const variant = pack.variants[0]!
  const clock = variant.fields.clock
  if (!clock || clock.grammar.kind !== 'countdown') throw new Error('当前编辑器需要第一个布局档的倒计时字段')
  const { width, height } = variant.nativeSize
  return { id: pack.id, name: pack.name, roi: { x: clock.roi.x / width, y: clock.roi.y / height,
    w: clock.roi.w / width, h: clock.roi.h / height }, preprocess: clock.preprocess,
    clockFormat: clock.grammar.format, matchThreshold: clock.match.minScore,
    templates: Object.fromEntries(CLOCK_CHARS.flatMap(char => {
      const ids = clock.glyphs[char]
      return ids ? [[char, ids.map(id => ({ id, data: pack.bitmaps[id]!.data, createdAt: 0 }))]] : []
    })) }
}
export function patchClock(pack: HudStylePack, patch: Partial<EditorClockModel>): HudStylePack {
  const variant = pack.variants[0]!
  const clock = variant.fields.clock!
  const { width, height } = variant.nativeSize
  const bitmaps = { ...pack.bitmaps }
  const glyphs = patch.templates ? Object.fromEntries(Object.entries(patch.templates).map(([char, samples]) => [char, samples!.map(sample => {
    // IDs share one namespace with fixed templates, so existing assets stay untouched.
    let id = sample.id === ':' ? 'colon' : sample.id.replace(/:/g, 'colon')
    if (bitmaps[id] && bitmaps[id]!.data !== sample.data) id = `glyph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    bitmaps[id] = { width: 32, height: 48, data: sample.data }
    return id
  })])) : clock.glyphs
  const x = patch.roi ? Math.max(0, Math.min(width - 1, Math.round(patch.roi.x * width))) : clock.roi.x
  const y = patch.roi ? Math.max(0, Math.min(height - 1, Math.round(patch.roi.y * height))) : clock.roi.y
  const roi = patch.roi ? { x, y, w: Math.max(1, Math.min(width - x, Math.round(patch.roi.w * width))),
    h: Math.max(1, Math.min(height - y, Math.round(patch.roi.h * height))) } : clock.roi
  return { ...pack, id: patch.id ?? pack.id, name: patch.name ?? pack.name, revision: pack.revision + 1, bitmaps,
    variants: pack.variants.map((item, index) => index ? item : { ...item, fields: { ...item.fields, clock: {
      ...clock, roi, preprocess: patch.preprocess ?? clock.preprocess, glyphs,
      grammar: patch.clockFormat ? { kind: 'countdown', format: patch.clockFormat } : clock.grammar,
      match: { ...clock.match, minScore: patch.matchThreshold ?? clock.match.minScore },
    } } }) }
}
export function sizeEmptyClock(pack: HudStylePack, width: number, height: number): HudStylePack {
  const variant = pack.variants[0]!
  if (variant.nativeSize.width === width && variant.nativeSize.height === height) return pack
  if (Object.keys(pack.bitmaps).length || pack.variants.length > 1 || Object.keys(variant.cues).length || variant.organizer
    || Object.keys(variant.states).length || variant.fields.scoreLeft || variant.fields.scoreRight || variant.fields.round) return pack
  const resized = createEmptyHudStylePack(pack.id, pack.name, { width, height })
  const model = clockModel(pack)
  const clock = patchClock(resized, { roi: model.roi }).variants[0]!.fields.clock!
  return { ...resized, revision: pack.revision + 1, variants: [{ ...resized.variants[0]!, fields: { ...variant.fields,
    clock: { ...variant.fields.clock!, roi: clock.roi } } }] }
}
