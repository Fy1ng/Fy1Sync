/** HUD style packs always run through the shared Rust/WASM entry. */
import { isHudPack, type ActiveProfile } from '../core/activeProfile'
import { hudFrameFromJson, type HudFrameResult } from '../core/hudWasm'
import { hudClockOutcome } from './hudResult'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import { RecognitionEngine } from './engine'
import type {
  FrameMessage, RecognitionBackend, TickMoment, WorkerDebug, WorkerRequest, WorkerResponse,
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
export interface WasmEngine {
  recognizeHud?(rgba: Uint8Array, width: number, height: number, packJson: string, variantId: string): string
  configure(profileJson: string): string
  recognize(rgba: Uint8Array, width: number, height: number, mediaTime: number, wallTime: number, frameIndex: number, wantDebug: boolean): string
  createTickDetector?(): WasmTickDetector
}
function annotate(response: WorkerResponse | null, backend: RecognitionBackend): WorkerResponse | null {
  if (response?.type === 'result') {
    response.backend = backend
    response.tickMomentStatus = backend === 'wasm' ? 'supported' : 'unsupported'
  }
  return response
}

type DetectorState = { detector: WasmTickDetector; width: number; height: number; time: number; variantId?: string | null }

export class WasmWorkerEngine implements WorkerEngine {
  readonly backend = 'wasm' as const
  private generation = -1
  private configured = false
  private profile: ActiveProfile | null = null
  private readonly detectors = new Map<SourceRole, DetectorState>()

  constructor(private readonly wasm: WasmEngine, private readonly now: () => number) {}

  handle(request: WorkerRequest): WorkerResponse | null {
    switch (request.type) {
      case 'configure': {
        this.configured = false
        this.profile = null
        this.resetDetectors()
        if (!isHudPack(request.profile)) throw new Error('旧版倒计时配置已停用, 请重新制作样式包')
        const readiness = JSON.parse(this.wasm.configure(JSON.stringify(request.profile))) as { ready: boolean; missing: string[]; sampleCount: number }
        this.generation = request.generation
        this.configured = true
        this.profile = request.profile
        return { type: 'configured', generation: request.generation, ...readiness }
      }
      case 'cancel':
        this.generation = Math.max(this.generation, request.generation)
        this.resetDetectors()
        return null
      case 'frame': {
        if (request.generation !== this.generation) return null
        if (!this.configured) return { type: 'error', generation: request.generation, message: '识别引擎尚未配置' }
        const started = this.now()
        let outcome: RecognitionOutcome
        let debug: WorkerDebug | null = null
        let tickMoment: TickMoment | undefined
        let hud: HudFrameResult | undefined
        try {
          const pixels = validPixels(request)
          if (this.profile && isHudPack(this.profile)) {
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
          outcome = { status: 'failed', reason: 'decode-failed', detail: errorText(error) }
        }
        return annotate({ type: 'result', generation: request.generation, role: request.role,
          frameIndex: request.frameIndex, outcome, debug, elapsedMs: this.now() - started,
          ...(hud ? { hud } : {}), ...(tickMoment ? { tickMoment } : {}) }, this.backend)
      }
      default: return null
    }
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
  const engine = new RecognitionEngine(now, `样式包需要 Rust/WASM, 无法加载: ${fallbackReason ?? '当前后端不可用'}`)
  options.report?.('typescript', fallbackReason)
  return { backend: 'typescript', handle: (request) => annotate(engine.handle(request), 'typescript') }
}
