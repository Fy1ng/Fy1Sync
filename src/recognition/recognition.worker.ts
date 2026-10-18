/// <reference lib="webworker" />
/** Initialization is shared and requests retain their generation and FIFO order. */
import { createWorkerEngine } from './backend'
import type { WorkerRequest } from './protocol'

const engine = createWorkerEngine({
  report: (backend, reason) => console.info('[识别 Worker] 后端:', backend, reason ?? ''),
})
let queue = Promise.resolve()
self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  queue = queue.then(async () => {
    const response = (await engine).handle(request)
    if (response) self.postMessage(response)
  }).catch((error: unknown) => {
    self.postMessage({ type: 'error', generation: request.generation,
      message: error instanceof Error ? error.message : String(error) })
  })
})
