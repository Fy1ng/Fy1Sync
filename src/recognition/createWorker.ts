/**
 * Isolated so tests can inject a fake worker: this is the only module that touches
 * `new Worker(new URL(...))`, which Vite rewrites at build time and jsdom cannot run.
 */

import type { WorkerLike } from './client'

export function createRecognitionWorker(): WorkerLike {
  return new Worker(new URL('./recognition.worker.ts', import.meta.url), {
    type: 'module',
    name: 'clock-recognition',
  }) as unknown as WorkerLike
}
