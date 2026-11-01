/** Layout operations keep the pack's shared bitmap namespace intact. */
import { packBitmap, unpackBitmap } from '../../core/bitmapCodec'
import { HUD_FIELD_IDS, parseHudStylePack, type HudBitmap, type HudCue, type HudRoi, type HudSize, type HudStylePack, type HudVariant } from '../../core/hudStylePack'

export function editorVariant(pack: HudStylePack, variantId = pack.variants[0]!.id): HudVariant {
  return pack.variants.find(variant => variant.id === variantId) ?? pack.variants[0]!
}

export function addLayout(pack: HudStylePack, variantId: string, size: HudSize): { pack: HudStylePack; id: string } {
  const current = editorVariant(pack, variantId)
  let index = 1
  while (pack.variants.some(variant => variant.id === `layout-${index}`)) index++
  const id = `layout-${index}`
  const sameSize = current.nativeSize.width === size.width && current.nativeSize.height === size.height
  const variant: HudVariant = sameSize ? { ...structuredClone(current), id, organizer: null }
    : { id, nativeSize: { width: size.width, height: size.height }, fields: { clock: null, scoreLeft: null, scoreRight: null }, cues: {}, states: {}, organizer: null }
  return { pack: { ...pack, revision: pack.revision + 1, variants: [...pack.variants, variant] }, id }
}

function unusedId(base: string, suffix: string, exists: (id: string) => boolean): string {
  let index = 1
  while (true) {
    const tail = `${suffix}${index === 1 ? '' : `-${index}`}`
    const id = `${base.slice(0, 128 - tail.length).replace(/\/+$/u, '')}${tail}`
    if (!exists(id)) return id
    index++
  }
}

function scaledRoi(roi: HudRoi, ratio: number, size: HudSize): HudRoi {
  const x = Math.max(0, Math.min(size.width - 1, Math.round(roi.x * ratio)))
  const y = Math.max(0, Math.min(size.height - 1, Math.round(roi.y * ratio)))
  const right = Math.max(x + 1, Math.min(size.width, Math.round((roi.x + roi.w) * ratio)))
  const bottom = Math.max(y + 1, Math.min(size.height, Math.round((roi.y + roi.h) * ratio)))
  return { x, y, w: right - x, h: bottom - y }
}

function scaledBitmap(bitmap: HudBitmap, width: number, height: number): HudBitmap {
  const source = unpackBitmap(bitmap.data, bitmap.width * bitmap.height)
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(bitmap.width - 1, Math.floor((x + 0.5) * bitmap.width / width))
    const sy = Math.min(bitmap.height - 1, Math.floor((y + 0.5) * bitmap.height / height))
    mask[y * width + x] = source[sy * bitmap.width + sx]!
  }
  return { width, height, data: packBitmap(mask) }
}

/** Generated layouts own their scaled templates; normalized glyphs stay shared. */
export function generateScaledLayout(pack: HudStylePack, variantId: string, height: 1440 | 1080): { pack: HudStylePack; id: string } {
  const current = editorVariant(pack, variantId)
  if (current.nativeSize.width !== 3840 || current.nativeSize.height !== 2160) throw new Error('只能从 3840x2160 布局生成低分辨率布局')
  const ratio = height / 2160
  const nativeSize = { width: height === 1440 ? 2560 : 1920, height }
  const id = unusedId(current.id, `-${height}`, value => pack.variants.some(variant => variant.id === value))
  const variant = { ...structuredClone(current), id, nativeSize }
  const bitmaps = { ...pack.bitmaps }
  const scaleWindow = (preprocess: HudCue['preprocess']): void => {
    if (preprocess.mode === 'adaptive') preprocess.adaptive.windowSize = Math.max(3, Math.round(preprocess.adaptive.windowSize * ratio) | 1)
  }
  const scaleCue = (cue: HudCue): void => {
    cue.roi = scaledRoi(cue.roi, ratio, nativeSize)
    scaleWindow(cue.preprocess)
    cue.templates = cue.templates.map(reference => {
      const bitmapId = unusedId(reference, `-${height}`, value => Object.hasOwn(bitmaps, value))
      bitmaps[bitmapId] = scaledBitmap(pack.bitmaps[reference]!, cue.roi.w, cue.roi.h)
      return bitmapId
    })
  }
  for (const fieldId of HUD_FIELD_IDS) {
    const field = variant.fields[fieldId]
    if (!field) continue
    field.roi = scaledRoi(field.roi, ratio, nativeSize)
    scaleWindow(field.preprocess)
    for (const key of ['minColumnInk', 'minGlyphWidth', 'minGapWidth'] as const) {
      field.segment[key] = Math.max(1, Math.round(field.segment[key] * ratio))
    }
  }
  for (const cue of Object.values(variant.cues)) scaleCue(cue)
  if (variant.organizer) scaleCue(variant.organizer)
  const updated = { ...pack, revision: pack.revision + 1, bitmaps, variants: [...pack.variants, variant] }
  const checked = parseHudStylePack(updated)
  if (!checked.pack) throw new Error(`无法生成 ${height}p 布局: ${checked.issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`)
  return { pack: updated, id }
}

export function renameLayout(pack: HudStylePack, variantId: string, id: string): { pack: HudStylePack; error: string | null } {
  const updated = { ...pack, revision: pack.revision + 1,
    variants: pack.variants.map(variant => variant.id === variantId ? { ...variant, id } : variant) }
  const issues = parseHudStylePack(updated).issues.filter(issue => /^variants\[\d+\]\.id$/u.test(issue.path))
  return issues.length ? { pack, error: issues.map(issue => issue.message).join('; ') } : { pack: updated, error: null }
}

export function removeLayout(pack: HudStylePack, variantId: string): HudStylePack {
  return pack.variants.length <= 1 ? pack : { ...pack, revision: pack.revision + 1,
    variants: pack.variants.filter(variant => variant.id !== variantId) }
}
