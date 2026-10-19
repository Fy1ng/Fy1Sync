/** WASM is preferred; the TypeScript engine remains an independent fallback/oracle. */
import { toGrayscale } from '../core/imageOps'
import type { RecognitionProfile } from '../core/profileSchema'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import { RecognitionEngine } from './engine'
import type {
  LearnReport, RecognitionBackend, RoiCandidate, TickMoment, WindowFrame,
  WorkerDebug, WorkerRequest, WorkerResponse,
} from './protocol'

export type { RecognitionBackend } from './protocol'
export const PREFERRED_RECOGNITION_BACKEND: RecognitionBackend = 'wasm'
export interface WorkerEngine {
  readonly backend: RecognitionBackend
  handle(request: WorkerRequest): WorkerResponse | null
}
export interface WasmAutoSession {
  push(gray: Uint8Array, width: number, height: number, mediaTime: number): void
  locate(): string
  learn(roiJson: string): string
  free(): void
}
export interface WasmTickDetector {
  push(gray: Uint8Array, width: number, height: number, mediaTime: number): string
  reset(): void
  free(): void
}
export interface WasmEngine {
  configure(profileJson: string): string
  recognize(rgba: Uint8Array, width: number, height: number, mediaTime: number, wallTime: number, frameIndex: number, wantDebug: boolean): string
  createAutoSession?(): WasmAutoSession
  createTickDetector?(): WasmTickDetector
  recognizeAuto?(gray: Uint8Array, width: number, height: number, profileJson: string): string
}
type JsonDebug = Omit<WorkerDebug, 'binary' | 'normalized'> & {
  binary: { data: number[]; width: number; height: number }
  normalized: number[][]
}
function debugFromJson(debug: JsonDebug | null): WorkerDebug | null {
  return debug && {
    ...debug,
    binary: { ...debug.binary, data: Uint8Array.from(debug.binary.data) },
    normalized: debug.normalized.map((mask) => Uint8Array.from(mask)),
  }
}
function annotate(response: WorkerResponse | null, backend: RecognitionBackend): WorkerResponse | null {
  if (response?.type === 'result') {
    response.backend = backend
    response.tickMomentStatus = backend === 'wasm' ? 'supported' : 'unsupported'
    if (response.debug) Object.assign(response.debug, { backend })
  }
  return response
}

type DetectorState = { detector: WasmTickDetector; width: number; height: number; time: number }

export class WasmWorkerEngine implements WorkerEngine {
  readonly backend = 'wasm' as const
  private generation = -1
  private configured = false
  private profile: RecognitionProfile | null = null
  private automatic = false
  private readonly detectors = new Map<SourceRole, DetectorState>()
  private retainedWindow: { session: WasmAutoSession; generation: number; id: number } | null = null
  private nextWindowId = 0

  constructor(private readonly wasm: WasmEngine, private readonly now: () => number) {}

  handle(request: WorkerRequest): WorkerResponse | null {
    switch (request.type) {
      case 'configure': {
        this.releaseWindow()
        const readiness = JSON.parse(this.wasm.configure(JSON.stringify(request.profile))) as { ready: boolean; missing: string[]; sampleCount: number }
        this.resetDetectors()
        this.generation = request.generation
        this.configured = true
        this.profile = request.profile
        this.automatic = request.automatic ?? false
        return { type: 'configured', generation: request.generation, ...readiness }
      }
      case 'cancel':
        this.generation = Math.max(this.generation, request.generation)
        this.resetDetectors()
        this.releaseWindow()
        return null
      case 'locate':
      case 'learn':
        return this.processWindow(request)
      case 'frame': {
        if (request.generation !== this.generation) return null
        if (!this.configured) return { type: 'error', generation: request.generation, message: '识别引擎尚未配置' }
        const started = this.now()
        let outcome: RecognitionOutcome
        let debug: WorkerDebug | null = null
        let tickMoment: TickMoment | undefined
        try {
          const pixels = validPixels(request)
          const gray = toGrayscale(pixels, request.width, request.height).data
          tickMoment = this.detectTick(request.role, gray, request.width, request.height, request.mediaTime)
          if (this.automatic) {
            if (!this.wasm.recognizeAuto || !this.profile) {
              outcome = { status: 'failed', reason: 'insufficient-templates', detail: '当前后端不支持自动学习预设' }
            } else {
              const reading = JSON.parse(this.wasm.recognizeAuto(gray, request.width, request.height, JSON.stringify(this.profile))) as {
                text: string | null; value: number | null; confidence: number; reason: string | null
              }
              if (reading.text !== null && reading.value !== null) {
                // P4a exports the minimum score only; use that conservative bound for every glyph.
                outcome = { status: 'success', reading: { text: reading.text, seconds: reading.value,
                  scores: Array.from(reading.text, () => reading.confidence), confidence: reading.confidence,
                  mediaTime: request.mediaTime, wallTime: request.wallTime, frameIndex: request.frameIndex } }
              } else {
                outcome = { status: 'failed', reason: reading.reason === 'low-confidence' ? 'low-confidence'
                  : reading.reason === 'invalid-format' ? 'invalid-format'
                    : reading.reason === 'missing-template' ? 'insufficient-templates' : 'no-candidates',
                detail: reading.reason ?? undefined }
              }
            }
          } else {
            const result = JSON.parse(this.wasm.recognize(pixels, request.width, request.height, request.mediaTime, request.wallTime, request.frameIndex, request.wantDebug)) as { outcome: RecognitionOutcome; debug: JsonDebug | null }
            outcome = result.outcome
            debug = request.wantDebug ? debugFromJson(result.debug) : null
          }
        } catch (error) {
          outcome = { status: 'failed', reason: 'decode-failed', detail: errorText(error) }
        }
        return annotate({ type: 'result', generation: request.generation, role: request.role,
          frameIndex: request.frameIndex, outcome, debug, elapsedMs: this.now() - started,
          ...(tickMoment ? { tickMoment } : {}) }, this.backend)
      }
      default: return null
    }
  }

  private processWindow(request: Extract<WorkerRequest, { type: 'locate' | 'learn' }>): WorkerResponse | null {
    const envelope = { generation: request.generation, requestId: request.requestId }
    const failed = (reason: string, detail: string): WorkerResponse => {
      const result = { status: 'failed', backend: this.backend, reason, detail } as const
      return request.type === 'locate' ? { type: 'located', ...envelope, result } : { type: 'learned', ...envelope, result }
    }
    if (request.generation < this.generation) {
      return request.type === 'learn' && request.windowId !== undefined
        ? failed('stale-window', '自动学习窗口已因配置或取消失效') : null
    }
    const changedGeneration = request.generation > this.generation
    if (changedGeneration) {
      this.resetDetectors()
      this.releaseWindow()
    }
    this.generation = request.generation
    if (request.type === 'locate' || request.windowId === undefined) this.releaseWindow()
    if (!this.wasm.createAutoSession) {
      const result = { status: 'unsupported', backend: this.backend, reason: 'auto-profile-unsupported' } as const
      return request.type === 'locate' ? { type: 'located', ...envelope, result } : { type: 'learned', ...envelope, result }
    }
    let session: WasmAutoSession | undefined
    try {
      if (request.type === 'learn' && request.windowId !== undefined) {
        const retained = this.retainedWindow
        if (!retained) return changedGeneration
          ? failed('stale-window', '自动学习窗口不属于当前配置')
          : failed('window-unavailable', '自动学习窗口已释放, 请重新识别')
        if (retained.generation !== request.generation) return failed('stale-window', '自动学习窗口不属于当前配置')
        if (retained.id !== request.windowId) return failed('invalid-window-id', '自动学习窗口编号不匹配, 请重新识别')
        this.retainedWindow = null
        session = retained.session
      } else {
        if (request.frames.length === 0) throw new Error('自动识别窗口没有帧')
        session = this.wasm.createAutoSession()
        for (const frame of request.frames) {
          const gray = toGrayscale(validPixels(frame), frame.width, frame.height).data
          session.push(gray, frame.width, frame.height, frame.mediaTime)
        }
      }
      if (request.type === 'locate') {
        const candidates = JSON.parse(session.locate()) as RoiCandidate[]
        const result = { status: 'success', backend: this.backend, candidates } as const
        if (request.retainForLearning) {
          const windowId = ++this.nextWindowId
          this.retainedWindow = { session, generation: request.generation, id: windowId }
          session = undefined
          return { type: 'located', ...envelope, result: { ...result, windowId } }
        }
        return { type: 'located', ...envelope, result }
      }
      const report = JSON.parse(session.learn(JSON.stringify(request.roi))) as LearnReport
      return { type: 'learned', ...envelope, result: { status: 'success', backend: this.backend, profile: report.profile, report } }
    } catch (error) {
      const result = { status: 'failed', backend: this.backend, reason: 'invalid-window', detail: errorText(error) } as const
      return request.type === 'locate' ? { type: 'located', ...envelope, result } : { type: 'learned', ...envelope, result }
    } finally {
      session?.free()
    }
  }

  private detectTick(role: SourceRole, gray: Uint8Array, width: number, height: number, time: number): TickMoment | undefined {
    if (!this.wasm.createTickDetector) return undefined
    let state = this.detectors.get(role)
    if (!state) {
      state = { detector: this.wasm.createTickDetector(), width, height, time: -Infinity }
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

  private releaseWindow(): void {
    this.retainedWindow?.session.free()
    this.retainedWindow = null
  }
}

function validPixels(frame: WindowFrame): Uint8Array {
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
  const engine = new RecognitionEngine(now)
  options.report?.('typescript', fallbackReason)
  return { backend: 'typescript', handle: (request) => annotate(engine.handle(request), 'typescript') }
}
