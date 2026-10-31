/** The editor and player share these Rust frame and glyph entry points. */
import type { HudCueId, HudFieldId, HudStylePack } from './hudStylePack'
import type { ClockChar } from './profileSchema'
import type { GlyphBox } from './segmentation'

export interface HudImage { data: Uint8Array; width: number; height: number }
export interface HudGlyphMatch { char: ClockChar | null; score: number; runnerUpScore: number; sampleIndex: number }
export interface HudDebug {
  roiPixels: { x: number; y: number; width: number; height: number }
  gray: HudImage
  binary: HudImage
  boxes: GlyphBox[]
  projection: number[]
  inkRatio: number
  normalized: Uint8Array[]
  matches: HudGlyphMatch[]
}
export interface HudAnalysis extends Omit<HudDebug, 'matches'> { bitmaps: string[] }
export type HudFieldResult = (
  | { status: 'read'; reading: { text: string; value: number; confidence: number; scores: number[] } }
  | { status: 'absent' }
  | { status: 'indeterminate'; reason: string }
  | { status: 'failed'; reason: string }
) & { debug: HudDebug | null }
export type HudPresenceResult = { status: 'matched' } | { status: 'not-matched' }
  | { status: 'indeterminate'; reason: string } | { status: 'failed'; reason: string }
export interface HudFrameResult {
  variantId: string
  fields: Record<HudFieldId, HudFieldResult>
  cues: Partial<Record<HudCueId, HudPresenceResult>>
  states: Record<string, HudPresenceResult>
  organizer: HudPresenceResult
}
export interface HudFrame { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number }

type JsonImage = Omit<HudImage, 'data'> & { data: number[] }
type JsonAnalysis = Omit<HudAnalysis, 'gray' | 'binary' | 'normalized'> & { gray: JsonImage; binary: JsonImage; normalized: number[][] }
type JsonDebug = Omit<HudDebug, 'gray' | 'binary' | 'normalized'> & { gray: JsonImage; binary: JsonImage; normalized: number[][] }
export function hudDebugFromJson(debug: JsonDebug): HudDebug {
  return { ...debug, gray: { ...debug.gray, data: Uint8Array.from(debug.gray.data) },
    binary: { ...debug.binary, data: Uint8Array.from(debug.binary.data) },
    normalized: debug.normalized.map(mask => Uint8Array.from(mask)) }
}
export function hudFrameFromJson(value: string): HudFrameResult {
  const result = JSON.parse(value) as HudFrameResult
  for (const field of Object.values(result.fields)) if (field.debug) field.debug = hudDebugFromJson(field.debug as unknown as JsonDebug)
  return result
}

interface HudModule {
  recognize_hud_frame(rgba: Uint8Array, width: number, height: number, pack: string, variant: string): string
  prepare_hud_glyphs(rgba: Uint8Array, width: number, height: number, pack: string, variant: string, boxes: string): string
}
let modulePromise: Promise<HudModule> | null = null
async function loadHudWasm(): Promise<HudModule> {
  modulePromise ??= (async () => {
    try {
      const module = await import('../wasm/pkg/stream_syncer_wasm.js')
      const { default: wasmUrl } = await import('../wasm/pkg/stream_syncer_wasm_bg.wasm?url')
      await module.default({ module_or_path: wasmUrl })
      const hud = module as unknown as HudModule
      if (!hud.recognize_hud_frame || !hud.prepare_hud_glyphs) throw new Error('当前 WASM 缺少样式包识别入口')
      return hud
    } catch (error) {
      throw new Error(`样式包需要 Rust/WASM, 无法加载: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  return modulePromise
}
const pixels = (frame: HudFrame): Uint8Array => new Uint8Array(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength)
export async function recognizeHudFrame(frame: HudFrame, pack: HudStylePack, variantId = pack.variants[0]!.id): Promise<HudFrameResult> {
  const wasm = await loadHudWasm()
  return hudFrameFromJson(wasm.recognize_hud_frame(pixels(frame), frame.width, frame.height, JSON.stringify(pack), variantId))
}
export async function prepareHudGlyphs(frame: HudFrame, pack: HudStylePack, variantId = pack.variants[0]!.id, boxes?: GlyphBox[]): Promise<HudAnalysis> {
  const wasm = await loadHudWasm()
  const result = JSON.parse(wasm.prepare_hud_glyphs(pixels(frame), frame.width, frame.height, JSON.stringify(pack), variantId,
    boxes ? JSON.stringify(boxes) : '')) as JsonAnalysis
  return { ...result, gray: { ...result.gray, data: Uint8Array.from(result.gray.data) },
    binary: { ...result.binary, data: Uint8Array.from(result.binary.data) },
    normalized: result.normalized.map(mask => Uint8Array.from(mask)) }
}
