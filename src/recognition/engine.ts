/** An unavailable WASM backend reports the missing capability explicitly. */
import type { WorkerRequest, WorkerResponse } from './protocol'
export class RecognitionEngine {
  constructor(_now: () => number = () => Date.now(), private readonly reason = '倒计时识别需要 Rust/WASM, 当前识别后端不可用') {}
  handle(request: WorkerRequest): WorkerResponse | null {
    if (request.type === 'cancel') return null
    if (request.type !== 'configure' && request.type !== 'frame') return null
    return { type: 'error', generation: request.generation, message: this.reason }
  }
}
