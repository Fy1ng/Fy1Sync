import { describe, expect, it, vi } from 'vitest'

import { packBitmap } from '../core/bitmapCodec'
import { normalizeGlyph } from '../core/imageOps'
import { createEmptyProfile, type ClockChar, type RecognitionProfile } from '../core/profileSchema'
import { CLOCK_GLYPHS, createFrame, drawText, renderGlyphMask } from '../test/glyphFont'
import { RecognitionClient, type WorkerLike } from './client'
import { RecognitionEngine } from './engine'
import { FULL_FRAME_ROI, FrameGrabber } from './frameGrabber'
import type { ResultMessage, WorkerRequest, WorkerResponse } from './protocol'

const SCALE = 6

function profileWithTemplates(text = '1:59'): RecognitionProfile {
  const profile = createEmptyProfile('cs2/test', 'CS2 测试')
  profile.roi = { ...FULL_FRAME_ROI }
  profile.matchThreshold = 0.7
  const chars = new Set(text.split('').concat(CLOCK_GLYPHS))
  for (const char of chars) {
    const mask = normalizeGlyph(renderGlyphMask(char, SCALE))
    profile.templates[char as ClockChar] = [
      { id: `${char}-a`, data: packBitmap(mask), createdAt: 0, origin: 'test' },
    ]
  }
  return profile
}

function frameFor(text: string): { pixels: Uint8ClampedArray; width: number; height: number } {
  const frame = createFrame(text.length * 6 * SCALE + 16, 7 * SCALE + 16)
  drawText(frame, text, 8, 8, { scale: SCALE, tracking: 1 })
  return { pixels: frame.data, width: frame.width, height: frame.height }
}

function frameMessage(
  generation: number,
  text: string,
  overrides: Partial<Extract<WorkerRequest, { type: 'frame' }>> = {},
): Extract<WorkerRequest, { type: 'frame' }> {
  const frame = frameFor(text)
  return {
    type: 'frame',
    generation,
    role: 'official',
    frameIndex: 1,
    mediaTime: 10,
    wallTime: 1_700_000_000_000,
    width: frame.width,
    height: frame.height,
    pixels: frame.pixels.slice().buffer as ArrayBuffer,
    wantDebug: false,
    ...overrides,
  }
}

describe('RecognitionEngine', () => {
  it('reports readiness when configured', () => {
    const engine = new RecognitionEngine(() => 0)
    const response = engine.handle({ type: 'configure', generation: 1, profile: profileWithTemplates() })
    expect(response).toMatchObject({ type: 'configured', generation: 1, ready: true })
    expect((response as { missing: string[] }).missing).toEqual([])
  })

  it('reports the characters still missing templates', () => {
    const profile = createEmptyProfile('cs2/partial', '缺字')
    const engine = new RecognitionEngine(() => 0)
    const response = engine.handle({ type: 'configure', generation: 1, profile })
    expect(response).toMatchObject({ ready: false })
    expect((response as { missing: string[] }).missing.length).toBeGreaterThan(0)
  })

  it('recognizes a frame it was configured for', () => {
    const engine = new RecognitionEngine(() => 0)
    engine.handle({ type: 'configure', generation: 4, profile: profileWithTemplates('1:59') })
    const result = engine.handle(frameMessage(4, '1:59')) as ResultMessage
    expect(result.type).toBe('result')
    expect(result.outcome.status).toBe('success')
    if (result.outcome.status === 'success') {
      expect(result.outcome.reading.text).toBe('1:59')
      expect(result.outcome.reading.seconds).toBe(119)
      expect(result.outcome.reading.mediaTime).toBe(10)
    }
  })

  it('errors when a frame arrives before any profile', () => {
    const engine = new RecognitionEngine(() => 0)
    // generation -1 is the unconfigured engine's generation
    const response = engine.handle(frameMessage(-1, '1:59'))
    expect(response).toMatchObject({ type: 'error' })
  })

  it('drops frames from a stale generation', () => {
    const engine = new RecognitionEngine(() => 0)
    engine.handle({ type: 'configure', generation: 2, profile: profileWithTemplates() })
    expect(engine.handle(frameMessage(1, '1:59'))).toBeNull()
    expect(engine.handle(frameMessage(2, '1:59'))).not.toBeNull()
  })

  it('drops frames from generations older than a cancel', () => {
    const engine = new RecognitionEngine(() => 0)
    engine.handle({ type: 'configure', generation: 2, profile: profileWithTemplates() })
    expect(engine.handle({ type: 'cancel', generation: 3 })).toBeNull()
    expect(engine.handle(frameMessage(2, '1:59'))).toBeNull()
  })

  it('fails a frame whose pixel buffer is too short', () => {
    const engine = new RecognitionEngine(() => 0)
    engine.handle({ type: 'configure', generation: 1, profile: profileWithTemplates() })
    const result = engine.handle(
      frameMessage(1, '1:59', { pixels: new ArrayBuffer(16), width: 100, height: 40 }),
    ) as ResultMessage
    expect(result.outcome).toMatchObject({ status: 'failed', reason: 'decode-failed' })
  })

  it('omits debug payloads unless asked', () => {
    const engine = new RecognitionEngine(() => 0)
    engine.handle({ type: 'configure', generation: 1, profile: profileWithTemplates() })
    const lean = engine.handle(frameMessage(1, '1:59')) as ResultMessage
    expect(lean.debug).toBeNull()
    const rich = engine.handle(frameMessage(1, '1:59', { wantDebug: true })) as ResultMessage
    expect(rich.debug).not.toBeNull()
    expect(rich.debug?.boxes.length).toBe(4)
    expect(rich.debug?.projection.length).toBeGreaterThan(0)
  })

  it('measures elapsed time with the injected clock', () => {
    let t = 0
    const engine = new RecognitionEngine(() => (t += 5))
    engine.handle({ type: 'configure', generation: 1, profile: profileWithTemplates() })
    const result = engine.handle(frameMessage(1, '1:59')) as ResultMessage
    expect(result.elapsedMs).toBeGreaterThan(0)
  })

  it('ignores unknown message types', () => {
    const engine = new RecognitionEngine(() => 0)
    expect(engine.handle({ type: 'nope' } as unknown as WorkerRequest)).toBeNull()
  })
})

class FakeWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = []
  readonly transfers: Transferable[][] = []
  terminated = false
  private listeners: Array<(event: MessageEvent<WorkerResponse>) => void> = []
  private errorListeners: Array<(event: Event) => void> = []
  private readonly engine = new RecognitionEngine(() => 1)
  /** When true, requests are recorded but no response is produced. */
  silent = false

  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    this.sent.push(message)
    if (transfer) this.transfers.push(transfer)
    if (this.silent) return
    const response = this.engine.handle(message)
    if (response) this.emit(response)
  }

  terminate(): void {
    this.terminated = true
  }

  addEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
    if (type === 'message') this.listeners.push(listener as (event: MessageEvent<WorkerResponse>) => void)
    else this.errorListeners.push(listener as (event: Event) => void)
  }

  removeEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
    if (type === 'message') this.listeners = this.listeners.filter((entry) => entry !== listener)
    else this.errorListeners = this.errorListeners.filter((entry) => entry !== listener)
  }

  emit(response: WorkerResponse): void {
    const event = { data: response } as MessageEvent<WorkerResponse>
    for (const listener of [...this.listeners]) listener(event)
  }

  emitError(message: string): void {
    const event = new ErrorEvent('error', { message })
    for (const listener of [...this.errorListeners]) listener(event)
  }
}

function grabbed(text = '1:59', mediaTime = 12) {
  const frame = frameFor(text)
  return { ...frame, mediaTime, wallTime: 1_700_000_000_000 }
}

describe('RecognitionClient', () => {
  it('configures the worker with a full-frame ROI and keeps the real ROI locally', () => {
    const worker = new FakeWorker()
    const client = new RecognitionClient({ createWorker: () => worker })
    const profile = profileWithTemplates()
    profile.roi = { x: 0.4, y: 0.02, w: 0.2, h: 0.08 }
    client.configure(profile)
    const sent = worker.sent[0]
    expect(sent?.type).toBe('configure')
    if (sent?.type === 'configure') {
      expect(sent.profile.roi).toEqual(FULL_FRAME_ROI)
    }
    // The client keeps the real ROI so the grabber knows what to crop.
    expect(client.roi).toEqual({ x: 0.4, y: 0.02, w: 0.2, h: 0.08 })
  })

  it('delivers results for the current generation', () => {
    const worker = new FakeWorker()
    const results: ResultMessage[] = []
    const client = new RecognitionClient({
      createWorker: () => worker,
      onResult: (result) => results.push(result),
    })
    client.configure(profileWithTemplates())
    expect(client.submit('official', grabbed())).toBe(true)
    expect(results).toHaveLength(1)
    expect(results[0]?.outcome.status).toBe('success')
    expect(client.busy).toBe(false)
  })

  it('drops a frame while another is in flight', () => {
    const worker = new FakeWorker()
    const client = new RecognitionClient({ createWorker: () => worker, now: () => 1000 })
    client.configure(profileWithTemplates())
    worker.silent = true
    expect(client.submit('official', grabbed())).toBe(true)
    expect(client.submit('official', grabbed())).toBe(false)
    expect(client.getStats()).toMatchObject({ submitted: 1, dropped: 1 })
    expect(client.busy).toBe(true)
  })

  it('resumes after the stall timeout when the worker never answers', () => {
    const worker = new FakeWorker()
    let now = 0
    const client = new RecognitionClient({
      createWorker: () => worker,
      now: () => now,
      stallTimeoutMs: 500,
    })
    client.configure(profileWithTemplates())
    worker.silent = true
    expect(client.submit('official', grabbed())).toBe(true)
    now = 400
    expect(client.submit('official', grabbed())).toBe(false)
    now = 900
    expect(client.submit('official', grabbed())).toBe(true)
    expect(client.getStats()).toMatchObject({ submitted: 2, dropped: 1, stalled: 1 })
  })

  it('refuses to submit before a profile is configured', () => {
    const worker = new FakeWorker()
    const client = new RecognitionClient({ createWorker: () => worker })
    expect(client.submit('official', grabbed())).toBe(false)
    expect(worker.sent).toHaveLength(0)
  })

  it('ignores results from an older generation', () => {
    const worker = new FakeWorker()
    const results: ResultMessage[] = []
    const client = new RecognitionClient({
      createWorker: () => worker,
      onResult: (result) => results.push(result),
    })
    const generation = client.configure(profileWithTemplates())
    worker.emit({
      type: 'result',
      generation: generation - 1,
      role: 'official',
      frameIndex: 99,
      outcome: { status: 'failed', reason: 'no-candidates' },
      debug: null,
      elapsedMs: 1,
    })
    expect(results).toHaveLength(0)
  })

  it('bumps the generation on cancel so in-flight results are dropped', () => {
    const worker = new FakeWorker()
    const results: ResultMessage[] = []
    const client = new RecognitionClient({
      createWorker: () => worker,
      onResult: (result) => results.push(result),
    })
    client.configure(profileWithTemplates())
    worker.silent = true
    client.submit('official', grabbed())
    const before = client.generation
    const after = client.cancel()
    expect(after).toBe(before + 1)
    expect(client.busy).toBe(false)
    worker.silent = false
    // A late result tagged with the pre-cancel generation must not surface.
    worker.emit({
      type: 'result',
      generation: before,
      role: 'official',
      frameIndex: 1,
      outcome: { status: 'failed', reason: 'no-candidates' },
      debug: null,
      elapsedMs: 1,
    })
    expect(results).toHaveLength(0)
  })

  it('re-configuring bumps the generation', () => {
    const worker = new FakeWorker()
    const client = new RecognitionClient({ createWorker: () => worker })
    const first = client.configure(profileWithTemplates())
    const second = client.configure(profileWithTemplates())
    expect(second).toBe(first + 1)
  })

  it('surfaces worker errors and clears the in-flight slot', () => {
    const worker = new FakeWorker()
    const errors: string[] = []
    const client = new RecognitionClient({
      createWorker: () => worker,
      onError: (message) => errors.push(message),
    })
    client.configure(profileWithTemplates())
    worker.silent = true
    client.submit('official', grabbed())
    worker.emitError('boom')
    expect(errors).toEqual(['boom'])
    expect(client.busy).toBe(false)
  })

  it('reports configuration readiness to the caller', () => {
    const worker = new FakeWorker()
    const ready: boolean[] = []
    const client = new RecognitionClient({
      createWorker: () => worker,
      onConfigured: (message) => ready.push(message.ready),
    })
    client.configure(profileWithTemplates())
    expect(ready).toEqual([true])
  })

  it('transfers the pixel buffer instead of copying it', () => {
    const worker = new FakeWorker()
    const client = new RecognitionClient({ createWorker: () => worker })
    client.configure(profileWithTemplates())
    client.submit('official', grabbed())
    expect(worker.transfers[0]).toHaveLength(1)
    const frame = worker.sent.find((message) => message.type === 'frame')
    expect(frame?.type === 'frame' && frame.pixels.byteLength).toBeGreaterThan(0)
  })

  it('passes wantDebug through', () => {
    const worker = new FakeWorker()
    const results: ResultMessage[] = []
    const client = new RecognitionClient({
      createWorker: () => worker,
      onResult: (result) => results.push(result),
    })
    client.configure(profileWithTemplates())
    client.submit('official', grabbed(), true)
    expect(results[0]?.debug).not.toBeNull()
  })

  it('terminates the worker and stops accepting work after dispose', () => {
    const worker = new FakeWorker()
    const client = new RecognitionClient({ createWorker: () => worker })
    client.configure(profileWithTemplates())
    client.dispose()
    expect(worker.terminated).toBe(true)
    expect(client.submit('official', grabbed())).toBe(false)
  })
})

describe('FrameGrabber', () => {
  it('refuses to grab before the video has a frame', () => {
    const grabber = new FrameGrabber(() => 1)
    const video = document.createElement('video')
    const result = grabber.grab(video, FULL_FRAME_ROI)
    expect(result).toMatchObject({ ok: false, reason: 'no-video-frame' })
  })

  it('crops the ROI out of the frame', () => {
    const grabber = new FrameGrabber(() => 4242)
    const video = fakeVideo(320, 180)
    const drawImage = vi.fn()
    const getImageData = vi.fn(
      (_x: number, _y: number, w: number, h: number) =>
        ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) as ImageData,
    )
    stubCanvas({ drawImage, getImageData })

    const result = grabber.grab(video, { x: 0.5, y: 0, w: 0.25, h: 0.5 }, 7.5)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.width).toBe(80)
    expect(result.frame.height).toBe(90)
    expect(result.frame.mediaTime).toBe(7.5)
    expect(result.frame.wallTime).toBe(4242)
    expect(drawImage).toHaveBeenCalledWith(video, 160, 0, 80, 90, 0, 0, 80, 90)
  })

  it('falls back to currentTime when no media time is supplied', () => {
    const grabber = new FrameGrabber(() => 1)
    const video = fakeVideo(64, 64)
    video.currentTime = 3.25
    stubCanvas({
      drawImage: vi.fn(),
      getImageData: vi.fn(
        (_x: number, _y: number, w: number, h: number) =>
          ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) as ImageData,
      ),
    })
    const result = grabber.grab(video, FULL_FRAME_ROI)
    expect(result.ok && result.frame.mediaTime).toBe(3.25)
  })

  it('reports a tainted canvas with actionable text', () => {
    const grabber = new FrameGrabber(() => 1)
    const video = fakeVideo(64, 64)
    stubCanvas({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => {
        throw new Error('SecurityError: tainted canvases may not be exported')
      }),
    })
    const result = grabber.grab(video, FULL_FRAME_ROI)
    expect(result).toMatchObject({ ok: false, reason: 'canvas-tainted' })
    expect(result.ok === false && result.detail).toContain('本地代理')
  })

  it('reports draw failures as decode failures', () => {
    const grabber = new FrameGrabber(() => 1)
    const video = fakeVideo(64, 64)
    stubCanvas({
      drawImage: vi.fn(() => {
        throw new Error('no frame')
      }),
      getImageData: vi.fn(),
    })
    const result = grabber.grab(video, FULL_FRAME_ROI)
    expect(result).toMatchObject({ ok: false, reason: 'decode-failed', detail: 'no frame' })
  })
})

function fakeVideo(width: number, height: number): HTMLVideoElement {
  const video = document.createElement('video')
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: width })
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: height })
  Object.defineProperty(video, 'readyState', { configurable: true, value: 4 })
  return video
}

function stubCanvas(context: {
  drawImage: unknown
  getImageData: unknown
}): void {
  // jsdom has no 2D context; OffscreenCanvas is absent too, so the grabber falls
  // back to document.createElement('canvas') and this stub answers for it.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  )
}
