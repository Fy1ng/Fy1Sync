/** The editor and player share these Rust frame and glyph entry points. */
import type { HudCueId, HudFieldId, HudResultFieldId, HudStylePack } from './hudStylePack'
import type { ClockChar } from './profileSchema'
import type { GlyphBox } from './segmentation'
import type { HudPreprocessRecommendation, HudPreprocessRequest } from './hudPreprocess'

export interface HudImage { data: Uint8Array; width: number; height: number }
export interface HudGlyphMatch { char: ClockChar | null; score: number; runnerUpScore: number; sampleIndex: number }
export interface HudCueDebug {
  roiPixels: { x: number; y: number; width: number; height: number }
  gray: HudImage
  binary: HudImage
}
export interface HudDebug extends HudCueDebug {
  boxes: GlyphBox[]
  projection: number[]
  inkRatio: number
  normalized: Uint8Array[]
  matches: HudGlyphMatch[]
}
export interface HudAnalysis extends Omit<HudDebug, 'matches'> { bitmaps: string[] }
export type HudFieldResult = (
  | { status: 'read'; reading: { text: string; value: number; confidence: number; scores: number[]; source: 'recognized' | 'derived' } }
  | { status: 'absent' }
  | { status: 'indeterminate'; reason: string }
  | { status: 'failed'; reason: string }
) & { debug: HudDebug | null }
export type HudPresenceResult = ({ status: 'matched' } | { status: 'not-matched' }
  | { status: 'indeterminate'; reason: string } | { status: 'failed'; reason: string }) & { score: number | null; debug: HudCueDebug | null }
export type HudContent = 'live' | 'replay' | 'indeterminate'
/** `unconfigured`: the pack judges no phase of play, so the frame is not held back on that account. */
export type HudPhase = 'active' | 'planted' | 'paused' | 'roundOver' | 'statistics' | 'indeterminate' | 'unconfigured'
export interface HudCueAnalysis extends HudCueDebug { bitmap: string }
export interface HudFrameResult {
  variantId: string | null
  selectionReason: 'no-match' | 'multiple-matches' | null
  content: HudContent
  phase: HudPhase
  fields: Record<HudResultFieldId, HudFieldResult>
  cues: Partial<Record<HudCueId, HudPresenceResult>>
  states: Record<string, HudPresenceResult>
  organizer: HudPresenceResult
}
export interface HudFrame { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number }

type JsonImage = Omit<HudImage, 'data'> & { data: number[] }
type JsonCueDebug = Omit<HudCueDebug, 'gray' | 'binary'> & { gray: JsonImage; binary: JsonImage }
type JsonAnalysis = Omit<HudAnalysis, 'gray' | 'binary' | 'normalized'> & { gray: JsonImage; binary: JsonImage; normalized: number[][] }
type JsonDebug = Omit<HudDebug, 'gray' | 'binary' | 'normalized'> & { gray: JsonImage; binary: JsonImage; normalized: number[][] }
export function hudDebugFromJson(debug: JsonDebug): HudDebug {
  return { ...debug, gray: { ...debug.gray, data: Uint8Array.from(debug.gray.data) },
    binary: { ...debug.binary, data: Uint8Array.from(debug.binary.data) },
    normalized: debug.normalized.map(mask => Uint8Array.from(mask)) }
}
function cueDebugFromJson(debug: JsonCueDebug): HudCueDebug {
  return { ...debug, gray: { ...debug.gray, data: Uint8Array.from(debug.gray.data) },
    binary: { ...debug.binary, data: Uint8Array.from(debug.binary.data) } }
}
export function hudFrameFromJson(value: string): HudFrameResult {
  const result = JSON.parse(value) as HudFrameResult
  for (const field of Object.values(result.fields)) if (field.debug) field.debug = hudDebugFromJson(field.debug as unknown as JsonDebug)
  for (const presence of [...Object.values(result.cues), ...Object.values(result.states), result.organizer])
    if (presence.debug) presence.debug = cueDebugFromJson(presence.debug as unknown as JsonCueDebug)
  return result
}

interface HudModule {
  recognize_hud_frame(rgba: Uint8Array, width: number, height: number, pack: string, variant: string): string
  prepare_hud_glyphs(rgba: Uint8Array, width: number, height: number, pack: string, variant: string, field: string, boxes: string): string
  prepare_hud_cue(rgba: Uint8Array, width: number, height: number, pack: string, variant: string, cue: string): string
  recommend_hud_preprocess(rgba: Uint8Array, width: number, height: number, pack: string, variant: string, target: string, request: string): string
}
let modulePromise: Promise<HudModule> | null = null
async function loadHudWasm(): Promise<HudModule> {
  modulePromise ??= (async () => {
    try {
      const module = await import('../wasm/pkg/stream_syncer_wasm.js')
      const { default: wasmUrl } = await import('../wasm/pkg/stream_syncer_wasm_bg.wasm?url')
      await module.default({ module_or_path: wasmUrl })
      const hud = module as unknown as HudModule
      if (!hud.recognize_hud_frame || !hud.prepare_hud_glyphs || !hud.prepare_hud_cue || !hud.recommend_hud_preprocess) throw new Error('当前 WASM 缺少样式包识别入口')
      return hud
    } catch (error) {
      throw new Error(`样式包需要 Rust/WASM, 无法加载: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  return modulePromise
}
const pixels = (frame: HudFrame): Uint8Array => new Uint8Array(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength)
export async function recognizeHudFrame(frame: HudFrame, pack: HudStylePack, variantId = ''): Promise<HudFrameResult> {
  const wasm = await loadHudWasm()
  return hudFrameFromJson(wasm.recognize_hud_frame(pixels(frame), frame.width, frame.height, JSON.stringify(pack), variantId))
}
export async function prepareHudGlyphs(frame: HudFrame, pack: HudStylePack, variantId = pack.variants[0]!.id, boxes?: GlyphBox[], fieldId: HudFieldId = 'clock'): Promise<HudAnalysis> {
  const wasm = await loadHudWasm()
  const result = JSON.parse(wasm.prepare_hud_glyphs(pixels(frame), frame.width, frame.height, JSON.stringify(pack), variantId, fieldId,
    boxes ? JSON.stringify(boxes) : '')) as JsonAnalysis
  return { ...result, gray: { ...result.gray, data: Uint8Array.from(result.gray.data) },
    binary: { ...result.binary, data: Uint8Array.from(result.binary.data) },
    normalized: result.normalized.map(mask => Uint8Array.from(mask)) }
}
export async function prepareHudCue(frame: HudFrame, pack: HudStylePack, cueId: HudCueId | 'organizer', variantId = pack.variants[0]!.id): Promise<HudCueAnalysis> {
  const wasm = await loadHudWasm()
  const result = JSON.parse(wasm.prepare_hud_cue(pixels(frame), frame.width, frame.height, JSON.stringify(pack), variantId, cueId)) as JsonCueDebug & { bitmap: string }
  return { ...cueDebugFromJson(result), bitmap: result.bitmap }
}

export async function recommendHudPreprocess(frame: HudFrame, pack: HudStylePack, variantId: string,
  target: HudFieldId | HudCueId | 'organizer', request: HudPreprocessRequest): Promise<HudPreprocessRecommendation> {
  const wasm = await loadHudWasm()
  return JSON.parse(wasm.recommend_hud_preprocess(pixels(frame), frame.width, frame.height,
    JSON.stringify(pack), variantId, target, JSON.stringify(request))) as HudPreprocessRecommendation
}
