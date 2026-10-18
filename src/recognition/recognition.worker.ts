/// <reference lib="webworker" />
/**
 * Worker shell. All logic lives in `RecognitionEngine`; this file only bridges
 * `postMessage` to it so the engine stays unit-testable.
 */

import { RecognitionEngine } from './engine'
import type { WorkerRequest } from './protocol'

const engine = new RecognitionEngine(() =>
  typeof performance !== 'undefined' ? performance.now() : Date.now(),
)

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const response = engine.handle(event.data)
  if (response) self.postMessage(response)
})
