import { describe, expect, it, vi } from 'vitest'
import { FrameGrabber, FULL_FRAME_ROI, startFrameLoop } from './frameGrabber'
import { FrameReadback, type ReadbackRequest } from './frameReadback'

describe('discovery frame acquisition', () => {
  it('captures one native strip with the original clock pixel rectangle unchanged', () => {
    const video = document.createElement('video')
    Object.defineProperties(video, { videoWidth: { value: 3840 }, videoHeight: { value: 2160 }, readyState: { value: 4 } })
    const drawImage = vi.fn()
    const getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4), width, height,
    }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, getImageData } as unknown as CanvasRenderingContext2D)
    const result = new FrameGrabber(() => 123).grabStrip(video, { x: 1856 / 3840, y: 100 / 2160, w: 112 / 3840, h: 60 / 2160 }, 7)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame).toMatchObject({ width: 606, height: 174, mediaTime: 7, wallTime: 123,
      clockRect: { x: 247, y: 48, width: 112, height: 60 } })
    expect(drawImage).toHaveBeenCalledWith(video, 1609, 52, 606, 174, 0, 0, 606, 174)
    expect(getImageData).toHaveBeenCalledTimes(1)
  })
  it('downscales the full frame without changing its aspect ratio or media timestamp', () => {
    const video = document.createElement('video')
    Object.defineProperties(video, {
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
      readyState: { value: 4 },
    })
    video.currentTime = 999
    const drawImage = vi.fn()
    const getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4), width, height,
    }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage, getImageData,
    } as unknown as CanvasRenderingContext2D)
    const result = new FrameGrabber(() => 1000).grabScaled(video, FULL_FRAME_ROI, 640, 7.25)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame).toMatchObject({ width: 640, height: 360, mediaTime: 7.25, wallTime: 1000 })
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080, 0, 0, 640, 360)
    expect(getImageData).toHaveBeenCalledWith(0, 0, 640, 360)
  })

  it('never enlarges smaller input frames', () => {
    const video = document.createElement('video')
    Object.defineProperties(video, {
      videoWidth: { value: 320 },
      videoHeight: { value: 180 },
      readyState: { value: 4 },
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4), width, height,
      }),
    } as unknown as CanvasRenderingContext2D)
    const result = new FrameGrabber().grabScaled(video, FULL_FRAME_ROI, 960, 1)
    expect(result.ok && [result.frame.width, result.frame.height]).toEqual([320, 180])
  })

  it('uses rVFC metadata.mediaTime for every callback and cancels the pending frame', () => {
    let callback: ((now: number, metadata: { mediaTime: number }) => void) | null = null
    const cancel = vi.fn()
    const video = {
      currentTime: 999,
      requestVideoFrameCallback: vi.fn((next) => { callback = next; return 12 }),
      cancelVideoFrameCallback: cancel,
    } as unknown as HTMLVideoElement
    const onFrame = vi.fn()
    const stop = startFrameLoop(video, 4, onFrame)
    const present = (mediaTime: number): void => {
      if (callback) callback(100, { mediaTime })
    }
    present(10.031)
    present(10.062)
    expect(onFrame.mock.calls).toEqual([[10.031], [10.062]])
    stop()
    expect(cancel).toHaveBeenCalledWith(12)
    present(10.093)
    expect(onFrame).toHaveBeenCalledTimes(2)
  })
})

describe('worker pixel readback', () => {
  function harness() {
    const contexts: Array<{ drawImage: ReturnType<typeof vi.fn>; getImageData: ReturnType<typeof vi.fn> }> = []
    const canvases = vi.fn(function (this: object) {
      const context = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) })) }
      contexts.push(context)
      return { getContext: () => context }
    })
    vi.stubGlobal('OffscreenCanvas', canvases)
    const reader = new FrameReadback()
    const close = vi.fn()
    const request: ReadbackRequest = { id: 1, source: { close } as unknown as ImageBitmap,
      rect: { x: 3, y: 5, width: 8, height: 6 }, width: 4, height: 3 }
    return { reader, request, close, canvases, contexts }
  }

  it('preserves the crop and closes the transferred surface before reading pixels', () => {
    const h = harness()
    try {
      const result = h.reader.read(h.request)
      expect(result).toEqual({ id: 1, ok: true, pixels: new Uint8ClampedArray([1, 2, 3, 255]) })
      expect(h.contexts[0]!.drawImage).toHaveBeenCalledWith(h.request.source, 3, 5, 8, 6, 0, 0, 4, 3)
      expect(h.close).toHaveBeenCalledOnce()
      expect(h.close.mock.invocationCallOrder[0]).toBeLessThan(h.contexts[0]!.getImageData.mock.invocationCallOrder[0]!)
    } finally { vi.unstubAllGlobals() }
  })

  it.each(['draw', 'read'] as const)('closes the surface and reports a tainted canvas on %s failure', kind => {
    const h = harness()
    try {
      h.reader.read(h.request)
      h.close.mockClear()
      h.contexts[0]![kind === 'draw' ? 'drawImage' : 'getImageData'].mockImplementationOnce(() => {
        throw new DOMException('Security: source is not origin-clean', 'SecurityError')
      })
      expect(h.reader.read({ ...h.request, id: 2 })).toMatchObject({ id: 2, ok: false, reason: 'canvas-tainted',
        detail: '画布被跨域视频污染，无法读取像素。请通过本地代理加载该源。' })
      expect(h.close).toHaveBeenCalledOnce()
      h.reader.read({ ...h.request, id: 3 })
      expect(h.canvases).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })

  it('caches at most four sizes and reuses recent canvases', () => {
    const h = harness()
    try {
      for (const width of [1, 2, 3, 4, 1, 5, 1, 2]) h.reader.read({ ...h.request, width })
      expect(h.canvases).toHaveBeenCalledTimes(6)
      expect(h.close).toHaveBeenCalledTimes(8)
    } finally { vi.unstubAllGlobals() }
  })
})

describe('asynchronous frame acquisition', () => {
  function harness(timeoutMs = 1000) {
    const video = document.createElement('video')
    Object.defineProperties(video, { videoWidth: { value: 3840 }, videoHeight: { value: 2160 }, readyState: { value: 4 } })
    video.currentTime = 999
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const capture = vi.fn(() => Promise.resolve(bitmap))
    vi.stubGlobal('createImageBitmap', capture)
    vi.stubGlobal('OffscreenCanvas', vi.fn())
    const postMessage = vi.fn<(request: ReadbackRequest, transfer?: Transferable[]) => void>()
    const terminate = vi.fn()
    const worker = Object.assign(new EventTarget(), { postMessage, terminate }) as unknown as Worker
    const clock = vi.fn(() => 123)
    const grabber = new FrameGrabber(clock, { createWorker: () => worker, timeoutMs })
    const reply = (id = postMessage.mock.calls.at(-1)![0].id) => worker.dispatchEvent(new MessageEvent('message', {
      data: { id, ok: true, pixels: new Uint8ClampedArray([5, 6, 7, 255]) },
    }))
    return { video, bitmap, capture, postMessage, terminate, worker, clock, grabber, reply }
  }

  it('transfers a cropped bitmap and preserves triggering clocks and the exact native clockRect', async () => {
    const h = harness()
    try {
      const run = h.grabber.grabStripAsync(h.video, { x: 1856 / 3840, y: 100 / 2160, w: 112 / 3840, h: 60 / 2160 }, 7.25)
      h.video.currentTime = 1000
      h.clock.mockReturnValue(9999)
      await Promise.resolve()
      expect(h.capture).toHaveBeenCalledWith(h.video, 1609, 52, 606, 174, {
        resizeWidth: 606, resizeHeight: 174, colorSpaceConversion: 'default',
      })
      expect(h.postMessage.mock.calls[0]![1]).toEqual([h.bitmap])
      expect(h.bitmap.close).toHaveBeenCalledOnce()
      h.reply()
      expect(await run).toMatchObject({ ok: true, frame: { width: 606, height: 174, mediaTime: 7.25, wallTime: 123,
        pixels: new Uint8ClampedArray([5, 6, 7, 255]), clockRect: { x: 247, y: 48, width: 112, height: 60 } } })
    } finally { h.grabber.dispose(); vi.unstubAllGlobals() }
  })

  it('skips and counts new frames on the same video across grabbers without a queue', async () => {
    const h = harness()
    const other = new FrameGrabber()
    try {
      const run = h.grabber.grabScaledAsync(h.video, FULL_FRAME_ROI, 960, 1)
      expect(h.grabber.busy).toBe(true)
      expect(await h.grabber.grabAsync(h.video, FULL_FRAME_ROI, 2)).toEqual({ ok: false, skipped: true, reason: 'backpressure' })
      expect(await other.grabAsync(h.video, FULL_FRAME_ROI, 3)).toEqual({ ok: false, skipped: true, reason: 'backpressure' })
      expect(h.grabber.getStats().dropped).toBe(1)
      expect(other.getStats().dropped).toBe(1)
      expect(h.capture).toHaveBeenCalledOnce()
      h.reply()
      await run
      expect(h.grabber.busy).toBe(false)
    } finally { other.dispose(); h.grabber.dispose(); vi.unstubAllGlobals() }
  })

  it.each(['cancel', 'timeout', 'dispose'] as const)('closes a late bitmap after %s and holds its slot until creation settles', async kind => {
    vi.useFakeTimers()
    const h = harness()
    try {
      let finish!: (bitmap: ImageBitmap) => void
      h.capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const run = h.grabber.grabAsync(h.video, FULL_FRAME_ROI, 1)
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(1000)
      else h.grabber[kind]()
      expect(await run).toMatchObject(kind === 'timeout' ? { ok: false, reason: 'decode-failed', detail: '抓帧读回超时, 请重试' }
        : { ok: false, skipped: true, reason: 'cancelled' })
      expect(h.grabber.busy).toBe(true)
      finish(h.bitmap)
      await Promise.resolve()
      expect(h.bitmap.close).toHaveBeenCalledOnce()
      expect(h.postMessage).not.toHaveBeenCalled()
      expect(h.grabber.busy).toBe(false)
    } finally { h.grabber.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it.each(['cancel', 'timeout', 'error', 'messageerror', 'transfer'] as const)('releases transferred resources after %s and ignores late results', async kind => {
    vi.useFakeTimers()
    const h = harness()
    try {
      if (kind === 'transfer') h.postMessage.mockImplementationOnce(() => { throw new Error('transfer failed') })
      const run = h.grabber.grabAsync(h.video, FULL_FRAME_ROI, 1)
      await Promise.resolve()
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(1000)
      else if (kind === 'cancel') h.grabber.cancel()
      else if (kind !== 'transfer') h.worker.dispatchEvent(new Event(kind))
      expect(await run).toMatchObject(kind === 'cancel' ? { ok: false, skipped: true, reason: 'cancelled' } : { ok: false, reason: 'decode-failed' })
      expect(h.bitmap.close).toHaveBeenCalledOnce()
      expect(h.terminate).toHaveBeenCalledOnce()
      expect(h.grabber.busy).toBe(false)
      h.reply()
      expect(h.grabber.busy).toBe(false)
    } finally { h.grabber.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it('preserves pollution errors from ImageBitmap creation and worker readback', async () => {
    const h = harness()
    try {
      h.capture.mockRejectedValueOnce(new DOMException('Cross-origin video', 'SecurityError'))
      expect(await h.grabber.grabAsync(h.video, FULL_FRAME_ROI)).toMatchObject({ ok: false, reason: 'canvas-tainted',
        detail: '画布被跨域视频污染，无法读取像素。请通过本地代理加载该源。' })
      const run = h.grabber.grabAsync(h.video, FULL_FRAME_ROI)
      await Promise.resolve()
      const id = h.postMessage.mock.calls[0]![0].id
      h.worker.dispatchEvent(new MessageEvent('message', { data: { id, ok: false, reason: 'canvas-tainted', detail: '原有中文提示' } }))
      expect(await run).toMatchObject({ ok: false, reason: 'canvas-tainted', detail: '原有中文提示' })
      expect(h.bitmap.close).toHaveBeenCalledOnce()
    } finally { h.grabber.dispose(); vi.unstubAllGlobals() }
  })

  it('recovers from a worker timeout without accepting its result in the next generation', async () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      const first = h.grabber.grabAsync(h.video, FULL_FRAME_ROI, 1)
      await Promise.resolve()
      const oldId = h.postMessage.mock.calls[0]![0].id
      await vi.advanceTimersByTimeAsync(1000)
      expect(await first).toMatchObject({ ok: false, reason: 'decode-failed' })
      const next = h.grabber.grabAsync(h.video, FULL_FRAME_ROI, 2)
      await Promise.resolve()
      h.reply(oldId)
      expect(h.grabber.busy).toBe(true)
      h.reply()
      expect(await next).toMatchObject({ ok: true, frame: { mediaTime: 2 } })
      expect(h.bitmap.close).toHaveBeenCalledTimes(2)
    } finally { h.grabber.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it.each(['createImageBitmap', 'OffscreenCanvas'] as const)('falls back to the synchronous path without %s', async feature => {
    const h = harness()
    try {
      vi.stubGlobal(feature, undefined)
      const fallback = vi.spyOn(h.grabber, 'grab').mockReturnValue({ ok: false, reason: 'no-video-frame' })
      expect(await h.grabber.grabAsync(h.video, FULL_FRAME_ROI, 8)).toEqual({ ok: false, reason: 'no-video-frame' })
      expect(fallback).toHaveBeenCalledWith(h.video, FULL_FRAME_ROI, 8)
      expect(h.capture).not.toHaveBeenCalled()
    } finally { h.grabber.dispose(); vi.unstubAllGlobals() }
  })

  it('rejects an undecoded video before allocating a bitmap or worker', async () => {
    const h = harness()
    try {
      expect(await h.grabber.grabAsync(document.createElement('video'), FULL_FRAME_ROI)).toMatchObject({ ok: false, reason: 'no-video-frame' })
      expect(h.capture).not.toHaveBeenCalled()
      expect(h.postMessage).not.toHaveBeenCalled()
    } finally { h.grabber.dispose(); vi.unstubAllGlobals() }
  })
})
