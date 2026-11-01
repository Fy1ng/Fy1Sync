/** An unavailable WASM backend reports the missing capability explicitly. */
import type { WorkerRequest, WorkerResponse } from './protocol'
export class RecognitionEngine {
  constructor(_now: () => number = () => Date.now(), private readonly reason = '样式包需要 Rust/WASM, 当前识别后端不可用') {}
  handle(request: WorkerRequest): WorkerResponse | null {
    if (request.type === 'cancel') return null
    if (request.type === 'locate' || request.type === 'learn') {
      const result = { status: 'unsupported', backend: 'typescript', reason: 'auto-profile-unsupported', detail: this.reason } as const
      const envelope = { generation: request.generation, requestId: request.requestId }
      return request.type === 'locate' ? { type: 'located', ...envelope, result } : { type: 'learned', ...envelope, result }
    }
    return { type: 'error', generation: request.generation, message: this.reason }
  }
}
