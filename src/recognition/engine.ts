/**
 * Worker-side recognition engine, kept free of `self`/`postMessage` so it can be
 * unit tested directly. The worker shell is a thin adapter over this class.
 */

import { profileReadiness, type RecognitionProfile } from '../core/profileSchema'
import { compileTemplates, recognizeFrame, type CompiledTemplates } from '../core/templateMatch'
import type {
  ConfiguredMessage,
  FrameMessage,
  ResultMessage,
  WorkerDebug,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

export class RecognitionEngine {
  private generation = -1
  private profile: RecognitionProfile | null = null
  private templates: CompiledTemplates | null = null

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns the response to post back, or `null` when nothing should be sent. */
  handle(request: WorkerRequest): WorkerResponse | null {
    switch (request.type) {
      case 'configure':
        return this.configure(request.generation, request.profile)
      case 'cancel':
        // Bumping the generation is enough: in-flight frames from older
        // generations are dropped when their results are produced.
        this.generation = Math.max(this.generation, request.generation)
        return null
      case 'frame':
        return this.processFrame(request)
      default:
        return null
    }
  }

  private configure(generation: number, profile: RecognitionProfile): ConfiguredMessage {
    this.generation = generation
    this.profile = profile
    this.templates = compileTemplates(profile)
    const readiness = profileReadiness(profile)
    return {
      type: 'configured',
      generation,
      ready: readiness.ready,
      missing: readiness.missing,
      sampleCount: readiness.sampleCount,
    }
  }

  private processFrame(request: FrameMessage): WorkerResponse | null {
    if (request.generation !== this.generation) return null
    if (!this.profile || !this.templates) {
      return { type: 'error', generation: request.generation, message: '识别引擎尚未配置' }
    }
    const started = this.now()
    try {
      const pixels = new Uint8Array(request.pixels)
      const expected = request.width * request.height * 4
      if (pixels.length < expected) {
        return {
          type: 'result',
          generation: request.generation,
          role: request.role,
          frameIndex: request.frameIndex,
          outcome: { status: 'failed', reason: 'decode-failed', detail: '帧数据长度不足' },
          debug: null,
          elapsedMs: this.now() - started,
        }
      }
      const result = recognizeFrame(
        { data: pixels, width: request.width, height: request.height },
        this.profile,
        this.templates,
        {
          mediaTime: request.mediaTime,
          wallTime: request.wallTime,
          frameIndex: request.frameIndex,
        },
      )
      return {
        type: 'result',
        generation: request.generation,
        role: request.role,
        frameIndex: request.frameIndex,
        outcome: result.outcome,
        debug: request.wantDebug ? toWorkerDebug(result.debug) : null,
        elapsedMs: this.now() - started,
      } satisfies ResultMessage
    } catch (error) {
      return {
        type: 'result',
        generation: request.generation,
        role: request.role,
        frameIndex: request.frameIndex,
        outcome: {
          status: 'failed',
          reason: 'decode-failed',
          detail: error instanceof Error ? error.message : String(error),
        },
        debug: null,
        elapsedMs: this.now() - started,
      }
    }
  }
}

function toWorkerDebug(debug: import('../core/templateMatch').RecognizeDebug | null): WorkerDebug | null {
  if (!debug) return null
  return {
    roiPixels: debug.roiPixels,
    binary: { data: debug.binary.data, width: debug.binary.width, height: debug.binary.height },
    boxes: debug.boxes,
    projection: debug.projection,
    inkRatio: debug.inkRatio,
    matches: debug.matches,
    normalized: debug.normalized,
  }
}
