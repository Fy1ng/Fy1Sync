/// <reference lib="webworker" />
import { loadCameraTighten } from '../wasm/load'
import type { CameraSample } from './cameraFrames'

self.addEventListener('message', async (event: MessageEvent<CameraSample>) => {
  try {
    const { frames, width, height, rough } = event.data
    const tighten = await loadCameraTighten()
    self.postMessage({ ok: true, value: JSON.parse(tighten(frames, width, height, JSON.stringify(rough))) as unknown })
  } catch { self.postMessage({ ok: false }) }
})
