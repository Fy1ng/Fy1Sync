import init, { AutoClockSession, RecognitionEngine, TickMomentDetector, recognize_auto, recognize_score } from './pkg/stream_syncer_wasm.js'
import wasmUrl from './pkg/stream_syncer_wasm_bg.wasm?url'
import type { WasmEngine } from '../recognition/backend'

export async function loadWasmEngine(): Promise<WasmEngine> {
  await init({ module_or_path: wasmUrl })
  const recognition = new RecognitionEngine()
  return {
    configure: (profile) => recognition.configure(profile),
    recognize: (...args) => recognition.recognize(...args),
    recognizeAuto: (gray, width, height, profile) => recognize_auto(gray, width, height, profile),
    recognizeScore: (rgba, width, height, clockRoi) => recognize_score(rgba, width, height, clockRoi),
    createAutoSession: () => new AutoClockSession(),
    createTickDetector: () => new TickMomentDetector(),
  }
}

let cameraModule: Promise<(frames: Uint8Array, width: number, height: number, rough: string) => string> | null = null

/** The camera crop runs on the main thread: one call over a few small frames, on demand. */
export function loadCameraTighten(): Promise<(frames: Uint8Array, width: number, height: number, rough: string) => string> {
  cameraModule ??= (async () => {
    const module = await import('./pkg/stream_syncer_wasm.js')
    await module.default({ module_or_path: wasmUrl })
    return module.tighten_camera
  })()
  return cameraModule
}
