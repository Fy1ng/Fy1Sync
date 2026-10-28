import { describe, expect, it, vi } from 'vitest'
import { FrameGrabber, FULL_FRAME_ROI, startFrameLoop } from './frameGrabber'

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
