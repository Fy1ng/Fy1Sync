/** Fixed graphics share the field rail, but retain their whole native bitmap. */
import { HUD_CUE_IDS, type HudCue, type HudCueId, type HudStylePack } from '../../core/hudStylePack'
import type { HudCueAnalysis } from '../../core/hudWasm'
import { fieldModel, type EditorClockModel } from './editorModel'
import { editorVariant } from './layoutModel'
import { createHudPreprocess } from '../../core/hudPreprocess'

export type CueTarget = HudCueId | 'organizer'
export type EditorTarget = 'clock' | 'scoreLeft' | 'scoreRight' | CueTarget
export const CUE_LABELS: Record<CueTarget, string> = { replay: '回放标记', bomb: '炸弹', timeout: '左侧 Timeout', timeoutRight: '右侧 Timeout',
  roundPrefix: 'Round 前缀', roundOver: 'Round Over', roundHistory: '回合记录标题', scoreboard: '记分板标题', organizer: '主办方区域' }
export const STATE_LABELS: Record<string, string> = { replay: '回放', active: '进行中', planted: '下包', paused: '暂停',
  'round-over': '回合结束', 'round-history': '回合记录', scoreboard: '记分板' }
export function isCueTarget(id: EditorTarget): id is CueTarget { return id === 'organizer' || (HUD_CUE_IDS as readonly string[]).includes(id) }

export function editorCue(pack: HudStylePack, id: CueTarget, variantId?: string): HudCue {
  const variant = editorVariant(pack, variantId)
  const cue = id === 'organizer' ? variant.organizer : variant.cues[id]
  if (cue) return cue
  const clock = variant.fields.clock
  return { enabled: true, roi: clock?.roi ?? { x: 0, y: 0, w: Math.max(1, Math.floor(variant.nativeSize.width / 10)), h: Math.max(1, Math.floor(variant.nativeSize.height / 10)) },
    preprocess: createHudPreprocess({ scale: 1 }), templates: [], minScore: 0.9 }
}
export function cueModel(pack: HudStylePack, id: CueTarget, variantId?: string): EditorClockModel {
  const cue = editorCue(pack, id, variantId)
  const { width, height } = editorVariant(pack, variantId).nativeSize
  return { ...fieldModel(pack, 'clock', variantId), enabled: cue.enabled, roi: { x: cue.roi.x / width, y: cue.roi.y / height, w: cue.roi.w / width, h: cue.roi.h / height },
    preprocess: cue.preprocess, matchThreshold: cue.minScore, templates: {} }
}
export function patchCue(pack: HudStylePack, id: CueTarget, patch: Partial<EditorClockModel>, sample?: HudCueAnalysis, variantId?: string): HudStylePack {
  const variant = editorVariant(pack, variantId)
  const cue = editorCue(pack, id, variant.id)
  const { width, height } = variant.nativeSize
  const x = patch.roi ? Math.max(0, Math.min(width - 1, Math.round(patch.roi.x * width))) : cue.roi.x
  const y = patch.roi ? Math.max(0, Math.min(height - 1, Math.round(patch.roi.y * height))) : cue.roi.y
  const roi = patch.roi ? { x, y, w: Math.max(1, Math.min(width - x, Math.round(patch.roi.w * width))),
    h: Math.max(1, Math.min(height - y, Math.round(patch.roi.h * height))) } : cue.roi
  const changedSize = roi.w !== cue.roi.w || roi.h !== cue.roi.h
  const templates = changedSize ? [] : cue.templates
  const bitmapId = `cue-${id.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const updated: HudCue = { enabled: patch.enabled ?? cue.enabled, roi, preprocess: patch.preprocess ?? cue.preprocess, minScore: patch.matchThreshold ?? cue.minScore,
    templates: sample ? [...templates, bitmapId] : templates }
  return { ...pack, id: patch.id ?? pack.id, name: patch.name ?? pack.name, revision: pack.revision + 1,
    bitmaps: sample ? { ...pack.bitmaps, [bitmapId]: { width: roi.w, height: roi.h, data: sample.bitmap } } : pack.bitmaps,
    variants: pack.variants.map(item => item.id !== variant.id ? item : id === 'organizer' ? { ...item, organizer: updated }
      : { ...item, cues: { ...item.cues, [id]: updated } }) }
}
