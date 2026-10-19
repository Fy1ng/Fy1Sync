import init, { AutoClockSession, RecognitionEngine, TickMomentDetector, recognize_auto } from './pkg/stream_syncer_wasm.js'
import wasmUrl from './pkg/stream_syncer_wasm_bg.wasm?url'
import type { WasmEngine } from '../recognition/backend'

export async function loadWasmEngine(): Promise<WasmEngine> {
  await init({ module_or_path: wasmUrl })
  const recognition = new RecognitionEngine()
  return {
    configure: (profile) => recognition.configure(profile),
    recognize: (...args) => recognition.recognize(...args),
    recognizeAuto: (gray, width, height, profile) => recognize_auto(gray, width, height, profile),
    createAutoSession: () => new AutoClockSession(),
    createTickDetector: () => new TickMomentDetector(),
  }
}
