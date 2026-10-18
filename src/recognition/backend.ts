/** WASM is preferred; the TypeScript engine remains an independent fallback/oracle. */
import type { RecognitionOutcome } from '../core/types'
import { RecognitionEngine } from './engine'
import type { WorkerDebug, WorkerRequest, WorkerResponse } from './protocol'

export type RecognitionBackend = 'wasm' | 'typescript'
export const PREFERRED_RECOGNITION_BACKEND: RecognitionBackend = 'wasm'
export interface WorkerEngine {
  readonly backend: RecognitionBackend
  handle(request: WorkerRequest): WorkerResponse | null
}
export interface WasmEngine {
  configure(profileJson: string): string
  recognize(rgba: Uint8Array, width: number, height: number, mediaTime: number, wallTime: number, frameIndex: number, wantDebug: boolean): string
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
  // Extra debug metadata is structured-cloneable; the existing protocol and UI stay unchanged.
  if (response?.type === 'result' && response.debug) Object.assign(response.debug, { backend })
  return response
}
export class WasmWorkerEngine implements WorkerEngine {
  readonly backend = 'wasm' as const
  private generation = -1
  private configured = false
  constructor(private readonly wasm: WasmEngine, private readonly now: () => number) {}
  handle(request: WorkerRequest): WorkerResponse | null {
    switch (request.type) {
      case 'configure': {
        const readiness = JSON.parse(this.wasm.configure(JSON.stringify(request.profile))) as { ready: boolean; missing: string[]; sampleCount: number }
        this.generation = request.generation
        this.configured = true
        return { type: 'configured', generation: request.generation, ...readiness }
      }
      case 'cancel':
        this.generation = Math.max(this.generation, request.generation)
        return null
      case 'frame': {
        if (request.generation !== this.generation) return null
        if (!this.configured) return { type: 'error', generation: request.generation, message: '识别引擎尚未配置' }
        const started = this.now()
        let outcome: RecognitionOutcome
        let debug: WorkerDebug | null = null
        try {
          const pixels = new Uint8Array(request.pixels)
          if (pixels.length < request.width * request.height * 4) {
            outcome = { status: 'failed', reason: 'decode-failed', detail: '帧数据长度不足' }
          } else {
            const result = JSON.parse(this.wasm.recognize(pixels, request.width, request.height, request.mediaTime, request.wallTime, request.frameIndex, request.wantDebug)) as { outcome: RecognitionOutcome; debug: JsonDebug | null }
            outcome = result.outcome
            debug = request.wantDebug ? debugFromJson(result.debug) : null
          }
        } catch (error) {
          outcome = { status: 'failed', reason: 'decode-failed', detail: error instanceof Error ? error.message : String(error) }
        }
        return annotate({ type: 'result', generation: request.generation, role: request.role,
          frameIndex: request.frameIndex, outcome, debug, elapsedMs: this.now() - started }, this.backend)
      }
      default: return null
    }
  }
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
      fallbackReason = error instanceof Error ? error.message : String(error)
    }
  }
  const engine = new RecognitionEngine(now)
  options.report?.('typescript', fallbackReason)
  return { backend: 'typescript', handle: (request) => annotate(engine.handle(request), 'typescript') }
}
