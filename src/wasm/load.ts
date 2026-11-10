import init, { BasicClockRecognizer, RecognitionEngine, TickMomentDetector, recognize_hud_frame } from './pkg/stream_syncer_wasm.js'
import wasmUrl from './pkg/stream_syncer_wasm_bg.wasm?url'
import type { WasmEngine } from '../recognition/backend'

export async function loadWasmEngine(): Promise<WasmEngine> {
  await init({ module_or_path: wasmUrl })
  const recognition = new RecognitionEngine()
  return {
    recognizeHud: (...args) => recognize_hud_frame(...args),
    configure: (profile) => recognition.configure(profile),
    recognize: (...args) => recognition.recognize(...args),
    createTickDetector: () => new TickMomentDetector(),
    createBasicClockRecognizer: (templates) => {
      const basic = new BasicClockRecognizer(templates)
      return { push: (...args) => basic.push(...args), reset: () => basic.reset(), resetTiming: () => basic.reset_timing(), free: () => basic.free(),
        setRoi: roi => basic.set_roi(roi), setSearchRoi: roi => basic.set_search_roi(roi),
        setRoiPreservingCache: roi => basic.set_roi_preserving_layout(roi) }
    },
  }
}

let cameraModule: Promise<(frames: Uint8Array, width: number, height: number, rough: string) => string> | null = null

/** Camera workers load the matching RGBA detector and WASM from the same frontend bundle. */
export function loadCameraTighten(): Promise<(frames: Uint8Array, width: number, height: number, rough: string) => string> {
  cameraModule ??= (async () => {
    const module = await import('./pkg/stream_syncer_wasm.js')
    await module.default({ module_or_path: wasmUrl })
    return module.tighten_camera
  })()
  return cameraModule
}
