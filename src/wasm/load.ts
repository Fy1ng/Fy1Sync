import init, { RecognitionEngine } from './pkg/stream_syncer_wasm.js'
import wasmUrl from './pkg/stream_syncer_wasm_bg.wasm?url'
import type { WasmEngine } from '../recognition/backend'

export async function loadWasmEngine(): Promise<WasmEngine> {
  await init({ module_or_path: wasmUrl })
  return new RecognitionEngine()
}
