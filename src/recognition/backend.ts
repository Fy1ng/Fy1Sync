/** Both automatic clocks and HUD style packs run through Rust/WASM. */
import { isBasicClock, isHudPack, type ActiveProfile, type BasicClockProfile } from '../core/activeProfile'
import type { RoiRect } from '../core/profileSchema'
import { hudFrameFromJson, type HudFrameResult } from '../core/hudWasm'
import { hudClockOutcome } from './hudResult'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import { RecognitionEngine } from './engine'
import { createBasicClockTemplates } from './basicTemplates'
import type {
  BasicClockDiagnostic, FrameMessage, RecognitionBackend, TickMoment, WorkerDebug, WorkerRequest, WorkerResponse,
} from './protocol'

export type { RecognitionBackend } from './protocol'
export const PREFERRED_RECOGNITION_BACKEND: RecognitionBackend = 'wasm'
export interface WorkerEngine {
  readonly backend: RecognitionBackend
  handle(request: WorkerRequest): WorkerResponse | null
}
export interface WasmTickDetector {
  push(gray: Uint8Array, width: number, height: number, mediaTime: number): string
  reset(): void
  free(): void
}
export interface WasmBasicClockRecognizer {
  push(rgba: Uint8Array, width: number, height: number, mediaTime: number, wallTime: number, frameIndex: number, wantDebug: boolean): string
  reset(): void
  free(): void
  setRoi?(roiJson: string): void
  setSearchRoi?(roiJson: string): void
  resetTiming?(): void
  setRoiPreservingCache?(roiJson: string): void
}
export interface WasmEngine {
  recognizeHud?(rgba: Uint8Array, width: number, height: number, packJson: string, variantId: string): string
  configure(profileJson: string): string
  recognize(rgba: Uint8Array, width: number, height: number, mediaTime: number, wallTime: number, frameIndex: number, wantDebug: boolean): string
  createTickDetector?(): WasmTickDetector
  createBasicClockRecognizer?(templatesJson: string): WasmBasicClockRecognizer
}
function annotate(response: WorkerResponse | null, backend: RecognitionBackend): WorkerResponse | null {
  if (response?.type === 'result') {
    response.backend = backend
    response.tickMomentStatus = backend === 'wasm' ? 'supported' : 'unsupported'
  }
  return response
}

type DetectorState = { detector: WasmTickDetector; width: number; height: number; time: number; variantId?: string | null }
type BasicState = { recognizer: WasmBasicClockRecognizer; width: number; height: number; time: number; confirmedRoi?: RoiRect }

export class WasmWorkerEngine implements WorkerEngine {
  readonly backend = 'wasm' as const
  private generation = -1
  private configured = false
  private profile: ActiveProfile | null = null
  private readonly detectors = new Map<SourceRole, DetectorState>()
  private readonly basicRecognizers = new Map<SourceRole, BasicState>()
  private basicTemplates: string | null = null
  private basicSampleCount = 0

  constructor(private readonly wasm: WasmEngine, private readonly now: () => number,
    private readonly makeBasicTemplates: () => Record<string, string[]> = createBasicClockTemplates) {}

  handle(request: WorkerRequest): WorkerResponse | null {
    switch (request.type) {
      case 'configure': {
        let preserveBasic = !!request.preserveBasic && this.canPreserveBasic(request.profile)
        if (preserveBasic && isBasicClock(request.profile) && request.profile.roi
          && this.profile && isBasicClock(this.profile) && !this.profile.roi) {
          try {
            for (const state of this.basicRecognizers.values()) {
              state.recognizer.setRoiPreservingCache!(JSON.stringify(request.profile.roi))
            }
          } catch (error) {
            if (error instanceof WebAssembly.RuntimeError) throw error
            // Native layout evidence may have changed after the last diagnostic.
            preserveBasic = false
          }
        }
        this.configured = false
        this.profile = null
        this.resetDetectors()
        if (!preserveBasic) this.clearBasicRecognizers()
        let readiness: { ready: boolean; missing: string[]; sampleCount: number }
        if (isBasicClock(request.profile)) {
          if (!this.wasm.createBasicClockRecognizer) throw new Error('WASM 不支持基础倒计时识别, 请重新构建应用')
          if (!preserveBasic) {
            const templates = this.makeBasicTemplates()
            for (const char of '0123456789:') {
              if (!templates[char]?.length) throw new Error('基础倒计时数字字形不可用, 请切换样式包模式')
            }
            this.basicTemplates = JSON.stringify(templates)
            this.basicSampleCount = Object.values(templates).reduce((count, samples) => count + samples.length, 0)
          }
          readiness = { ready: true, missing: [], sampleCount: this.basicSampleCount }
        } else {
          if (!isHudPack(request.profile)) throw new Error('旧版倒计时配置已停用, 请重新制作样式包')
          readiness = JSON.parse(this.wasm.configure(JSON.stringify(request.profile))) as typeof readiness
        }
        this.generation = request.generation
        this.configured = true
        this.profile = request.profile
        return { type: 'configured', generation: request.generation, ...readiness }
      }
      case 'cancel':
        this.generation = Math.max(this.generation, request.generation)
        this.resetDetectors()
        for (const state of this.basicRecognizers.values()) {
          if (!request.preserveBasic) {
            state.recognizer.reset()
            state.confirmedRoi = undefined
            state.time = -Infinity
          } else if (request.resetTiming) {
            this.resetBasicTiming(state)
          }
        }
        return null
      case 'frame': {
        if (request.generation !== this.generation) return null
        if (!this.configured) return { type: 'error', generation: request.generation, message: '识别引擎尚未配置' }
        const started = this.now()
        let outcome: RecognitionOutcome
        let debug: WorkerDebug | null = null
        let tickMoment: TickMoment | undefined
        let hud: HudFrameResult | undefined
        let basic: BasicClockDiagnostic | undefined
        try {
          const pixels = validPixels(request)
          if (this.profile && isBasicClock(this.profile)) {
            const state = this.basicRecognizer(request)
            const result = JSON.parse(state.recognizer.push(pixels, request.width, request.height,
              request.mediaTime, request.wallTime, request.frameIndex, request.wantDebug)) as {
                outcome: RecognitionOutcome; debug?: WorkerDebug | null; basic?: BasicClockDiagnostic; tickMoment?: TickMoment
              }
            outcome = result.outcome
            basic = result.basic ? restoreBasicDiagnostic(result.basic, request) : undefined
            if (basic?.status === 'locked' && outcome.status === 'success' && basic.roi) state.confirmedRoi = { ...basic.roi }
            if (basic && this.profile.roi && this.profile.roiOrigin === 'memory') basic.mode = 'memory'
            if (basic && this.profile.searchRoi) basic.searchRoi = this.profile.searchRoi
            debug = request.wantDebug ? restoreBasicDebug(result.debug) : null
            tickMoment = result.tickMoment
          } else if (this.profile && isHudPack(this.profile)) {
            if (!this.wasm.recognizeHud) throw new Error('WASM 不支持样式包识别, 请重新构建应用')
            hud = hudFrameFromJson(this.wasm.recognizeHud(pixels, request.width, request.height, JSON.stringify(this.profile), ''))
            const detector = this.detectors.get(request.role)
            if (detector && detector.variantId !== hud.variantId) {
              detector.detector.reset()
              detector.variantId = hud.variantId
            }
            const crop = hud.fields.clock.debug?.gray
            if (crop) tickMoment = this.detectTick(request.role, crop.data, crop.width, crop.height, request.mediaTime, hud.variantId)
            outcome = hudClockOutcome(hud, request)
            debug = request.wantDebug ? hud.fields.clock.debug : null
          } else {
            outcome = { status: 'failed', reason: 'no-profile', detail: '请手动选择样式包' }
          }
        } catch (error) {
          if (error instanceof WebAssembly.RuntimeError) return {
            type: 'error', generation: request.generation, message: `识别计算失败: ${errorText(error)}`,
          }
          outcome = { status: 'failed', reason: 'decode-failed', detail: errorText(error) }
        }
        return annotate({ type: 'result', generation: request.generation, role: request.role,
          frameIndex: request.frameIndex, outcome, debug, elapsedMs: this.now() - started,
          ...(hud ? { hud } : {}), ...(basic ? { basic } : {}), ...(tickMoment ? { tickMoment } : {}) }, this.backend)
      }
      default: return null
    }
  }

  private basicRecognizer(frame: FrameMessage): BasicState {
    let state = this.basicRecognizers.get(frame.role)
    if (!state) {
      if (!this.wasm.createBasicClockRecognizer || !this.basicTemplates) throw new Error('基础倒计时识别尚未配置')
      const recognizer = this.wasm.createBasicClockRecognizer(this.basicTemplates)
      const basicProfile = this.profile && isBasicClock(this.profile) ? this.profile : null
      const roi = basicProfile?.roi
      try {
        if (roi && !recognizer.setRoi) throw new Error(`WASM 不支持${basicProfile?.roiOrigin === 'memory' ? '记忆' : '手动'}倒计时区域, 请重新构建应用`)
        recognizer.setRoi?.(JSON.stringify(roi ?? null))
        if (basicProfile?.searchRoi && !recognizer.setSearchRoi) throw new Error('WASM 不支持倒计时搜索范围, 请重新构建应用')
        recognizer.setSearchRoi?.(JSON.stringify(basicProfile?.searchRoi ?? null))
      } catch (error) { recognizer.free(); throw error }
      state = { recognizer,
        width: frame.width, height: frame.height, time: -Infinity }
      this.basicRecognizers.set(frame.role, state)
    }
    // No countdown transition is inferred across seeks, dimension changes or long gaps.
    if (state.width !== frame.width || state.height !== frame.height) {
      state.recognizer.reset()
      state.confirmedRoi = undefined
    } else if (frame.mediaTime < state.time
      || (Number.isFinite(state.time) && frame.mediaTime - state.time > 1.5)) this.resetBasicTiming(state)
    state.width = frame.width
    state.height = frame.height
    state.time = frame.mediaTime
    return state
  }

  private clearBasicRecognizers(): void {
    for (const state of this.basicRecognizers.values()) state.recognizer.free()
    this.basicRecognizers.clear()
  }

  private resetBasicTiming(state: BasicState): void {
    if (!state.recognizer.resetTiming) throw new Error('WASM 不支持保留倒计时缓存, 请重新构建应用')
    state.recognizer.resetTiming()
    state.time = -Infinity
  }

  private canPreserveBasic(next: ActiveProfile): boolean {
    const previous = this.profile
    if (!this.configured || !previous || !isBasicClock(previous) || !isBasicClock(next)
      || !this.basicTemplates || !sameRoi(previous.searchRoi, next.searchRoi)) return false
    if (sameRoi(previous.roi, next.roi)) return true
    return this.canPromoteBasicMemory(previous, next)
  }

  private canPromoteBasicMemory(previous: BasicClockProfile, next: BasicClockProfile): boolean {
    return !previous.roi && !!next.roi && next.roiOrigin === 'memory' && this.basicRecognizers.size > 0
      && [...this.basicRecognizers.values()].every(state => !!state.recognizer.setRoiPreservingCache
        && !!state.confirmedRoi && sameRoi(state.confirmedRoi, next.roi))
  }

  private detectTick(role: SourceRole, gray: Uint8Array, width: number, height: number, time: number, variantId?: string | null): TickMoment | undefined {
    if (!this.wasm.createTickDetector) return undefined
    let state = this.detectors.get(role)
    if (!state) {
      state = { detector: this.wasm.createTickDetector(), width, height, time: -Infinity, variantId }
      this.detectors.set(role, state)
    }
    if (state.width !== width || state.height !== height || time <= state.time) state.detector.reset()
    state.width = width
    state.height = height
    state.time = time
    const moment = JSON.parse(state.detector.push(gray, width, height, time)) as (Omit<TickMoment, 'midpoint'> & { tickTime: number }) | null
    return moment ? { lastUnchanged: moment.lastUnchanged, firstChanged: moment.firstChanged,
      midpoint: moment.tickTime, change: moment.change, noiseFloor: moment.noiseFloor } : undefined
  }

  private resetDetectors(): void {
    for (const { detector } of this.detectors.values()) detector.free()
    this.detectors.clear()
  }
}

function sameRoi(left?: RoiRect, right?: RoiRect): boolean {
  if (!left || !right) return left === right
  return (['x', 'y', 'w', 'h'] as const).every(key => Number.isFinite(left[key]) && Number.isFinite(right[key])
    && Math.abs(left[key] - right[key]) <= 1e-6)
}

function validPixels(frame: FrameMessage): Uint8Array {
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width <= 0 || frame.height <= 0
    || frame.width * frame.height > 16_777_216 || !Number.isFinite(frame.mediaTime)) throw new Error('帧尺寸或时间戳无效')
  const pixels = new Uint8Array(frame.pixels)
  if (pixels.length < frame.width * frame.height * 4) throw new Error('帧数据长度不足')
  return pixels
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function restoreBasicDebug(debug: WorkerDebug | null | undefined): WorkerDebug | null {
  if (!debug) return null
  return { ...debug, binary: { ...debug.binary, data: Uint8Array.from(debug.binary.data) },
    normalized: debug.normalized.map(mask => Uint8Array.from(mask)) }
}

function restoreBasicDiagnostic(diagnostic: BasicClockDiagnostic, frame: FrameMessage): BasicClockDiagnostic {
  const { preview, ...rest } = diagnostic
  return { ...rest, mediaTime: frame.mediaTime, inputSize: { width: frame.width, height: frame.height },
    ...(frame.wantDebug && preview ? { preview: { ...preview, data: Uint8Array.from(preview.data) } } : {}) }
}

async function loadWasm(): Promise<WasmEngine> {
  return (await import('../wasm/load')).loadWasmEngine()
}
export async function createWorkerEngine(options: {
  preferred?: RecognitionBackend
  load?: () => Promise<WasmEngine>
  now?: () => number
  report?: (backend: RecognitionBackend, reason?: string) => void
} = {}): Promise<WorkerEngine> {
  const now = options.now ?? (() => performance.now())
  let fallbackReason: string | undefined
  if ((options.preferred ?? PREFERRED_RECOGNITION_BACKEND) === 'wasm') {
    try {
      const engine = new WasmWorkerEngine(await (options.load ?? loadWasm)(), now)
      options.report?.('wasm')
      return engine
    } catch (error) {
      fallbackReason = errorText(error)
    }
  }
  const engine = new RecognitionEngine(now, `倒计时识别需要 Rust/WASM, 无法加载: ${fallbackReason ?? '当前后端不可用'}`)
  options.report?.('typescript', fallbackReason)
  return { backend: 'typescript', handle: (request) => annotate(engine.handle(request), 'typescript') }
}
