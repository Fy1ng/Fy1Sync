/** Stable frame/slot IDs make re-capturing or reopening a frame idempotent. */
import type { HudFieldId, HudStylePack } from '../../core/hudStylePack'
import { CLOCK_CHARS, type ClockChar, type TemplateSample } from '../../core/profileSchema'
import type { GlyphBox } from '../../core/segmentation'
import type { GrabbedFrame } from '../../recognition/frameGrabber'
import { editorField, fieldModel, patchField } from './editorModel'

interface LabelledSample { char: ClockChar; sample: TemplateSample; index: number }
export interface GlyphChange { removed: LabelledSample[]; added: LabelledSample[] }
export interface GlyphFrameKey { prefix: string; geometry: string }
const frameHashes = new WeakMap<GrabbedFrame, Promise<string>>()

async function hash(data: Uint8Array | Uint8ClampedArray | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function glyphFrameKey(frame: GrabbedFrame, pack: HudStylePack, fieldId: HudFieldId, variantId: string,
  boxes: GlyphBox[]): Promise<GlyphFrameKey> {
  let digest = frameHashes.get(frame)
  if (!digest) { digest = hash(frame.pixels); frameHashes.set(frame, digest) }
  const field = editorField(pack, fieldId, variantId)
  const prefix = `frame-${await hash(JSON.stringify([await digest, frame.width, frame.height, variantId, fieldId]))}-`
  const geometry = (await hash(JSON.stringify([field.roi, field.preprocess, field.segment,
    boxes.map(({ x, y, width, height }) => [x, y, width, height])]))).slice(0, 16)
  return { prefix, geometry }
}

function entries(pack: HudStylePack, fieldId: HudFieldId, variantId: string): LabelledSample[] {
  return Object.entries(fieldModel(pack, fieldId, variantId).templates)
    .flatMap(([char, samples]) => samples!.map((sample, index) => ({ char: char as ClockChar, sample, index })))
}

export function labelledReading(pack: HudStylePack, fieldId: HudFieldId, variantId: string, key: GlyphFrameKey, count: number): string {
  const samples = entries(pack, fieldId, variantId)
  const chars = Array.from({ length: count }, (_, index) => {
    const matches = samples.filter(entry => entry.sample.id.startsWith(`${key.prefix}${index}-${key.geometry}-`))
    return matches.length === 1 ? matches[0]!.char : '?'
  })
  return chars.some(char => char !== '?') ? chars.join('') : ''
}

export async function teachGlyphs(pack: HudStylePack, fieldId: HudFieldId, variantId: string, key: GlyphFrameKey,
  count: number, updates: Array<{ index: number; char: ClockChar; data: string }>): Promise<{ pack: HudStylePack; change: GlyphChange }> {
  const existing = entries(pack, fieldId, variantId)
  const removed = new Map<string, LabelledSample>()
  const added: LabelledSample[] = []
  const remove = (entry: LabelledSample) => removed.set(`${entry.char}/${entry.sample.id}`, entry)
  for (const update of updates) {
    const prefix = `${key.prefix}${update.index}-`
    const previous = existing.filter(entry => entry.sample.id.startsWith(prefix))
    const id = `${prefix}${key.geometry}-${(await hash(update.data)).slice(0, 16)}`
    if (previous.length === 1 && previous[0]!.char === update.char && previous[0]!.sample.id === id
      && previous[0]!.sample.data === update.data) continue
    previous.forEach(remove)
    // Adopt one identical pre-existing sample instead of duplicating legacy editor output.
    if (previous.length === 0) {
      const legacy = existing.find(entry => !entry.sample.id.startsWith('frame-') && entry.char === update.char
        && entry.sample.data === update.data && !removed.has(`${entry.char}/${entry.sample.id}`))
      if (legacy) remove(legacy)
    }
    added.push({ char: update.char, index: previous[0]?.index ?? Number.MAX_SAFE_INTEGER,
      sample: { id, data: update.data, createdAt: Date.now() } })
  }
  // Shrinking or recutting a field must not retain slots that no longer exist.
  existing.filter(entry => entry.sample.id.startsWith(key.prefix)
    && Number(entry.sample.id.slice(key.prefix.length).split('-')[0]) >= count).forEach(remove)
  const change = { removed: [...removed.values()], added }
  return { pack: applyGlyphChange(pack, fieldId, variantId, change), change }
}

/** Undo deltas, not whole packs: unrelated field, ROI and metadata edits remain intact. */
export function applyGlyphChange(pack: HudStylePack, fieldId: HudFieldId, variantId: string, change: GlyphChange): HudStylePack {
  if (!change.removed.length && !change.added.length) return pack
  const model = fieldModel(pack, fieldId, variantId)
  const templates = { ...model.templates }
  for (const char of CLOCK_CHARS) {
    const removals = new Set(change.removed.filter(entry => entry.char === char).map(entry => entry.sample.id))
    const kept = (templates[char] ?? []).filter(sample => !removals.has(sample.id))
    for (const entry of change.added.filter(item => item.char === char).sort((a, b) => a.index - b.index)) {
      if (!kept.some(sample => sample.id === entry.sample.id)) kept.splice(Math.min(entry.index, kept.length), 0, entry.sample)
    }
    if (kept.length) templates[char] = kept
    else delete templates[char]
  }
  const updated = patchField(pack, fieldId, { templates }, variantId)
  const used = new Set(updated.variants.flatMap(variant => [
    ...Object.values(variant.fields).flatMap(field => Object.values(field?.glyphs ?? {}).flat()),
    ...Object.values(variant.cues).flatMap(cue => cue?.templates ?? []), ...(variant.organizer?.templates ?? []),
  ]))
  for (const entry of change.removed) if (!used.has(entry.sample.id)) delete updated.bitmaps[entry.sample.id]
  return updated
}
