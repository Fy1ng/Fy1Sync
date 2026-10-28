/// <reference lib="webworker" />
import { FrameReadback, type ReadbackRequest } from './frameReadback'

const readback = new FrameReadback()
self.addEventListener('message', (event: MessageEvent<ReadbackRequest>) => {
  const result = readback.read(event.data)
  self.postMessage(result, result.ok ? [result.pixels.buffer] : [])
})
