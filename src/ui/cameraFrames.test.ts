import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cameraSamplingPlan, sampleCameraFrames } from './cameraFrames'

let video: HTMLVideoElement
let callback: VideoFrameRequestCallback | undefined
let time = 0
let paused = false
let pixel: number[]
let draw: ReturnType<typeof vi.fn>
let readback: ReturnType<typeof vi.fn>
const rough = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
beforeEach(() => {
  vi.useFakeTimers()
  time = 0; paused = false; callback = undefined; pixel = [190, 20, 100, 255]
  video = document.createElement('video')
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 80 }, videoHeight: { configurable: true, value: 60 },
    currentSrc: { configurable: true, value: 'app://app/test-source.mp4' }, readyState: { configurable: true, value: 2 },
    currentTime: { configurable: true, get: () => time }, paused: { configurable: true, get: () => paused },
    requestVideoFrameCallback: { configurable: true, value: vi.fn((next: VideoFrameRequestCallback) => { callback = next; return 1 }) },
    cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
  })
  draw = vi.fn()
  readback = vi.fn((_x: number, _y: number, width: number, height: number) => {
    const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => pixel[i % 4]!)
    return { data, width, height }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw, getImageData: readback } as unknown as CanvasRenderingContext2D)
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const frame = (value: number) => { time = value; callback?.(performance.now(), { mediaTime: time } as VideoFrameCallbackMetadata) }

describe('local color camera sampling', () => {
  it('keeps small 4K camera regions at native pixels instead of reducing the entire video to 960px', () => {
    const plan = cameraSamplingPlan(3840, 2160, { x: 100 / 3840, y: 80 / 2160, w: 256 / 3840, h: 144 / 2160 })
    expect(plan.width).toBe(plan.sw)
    expect(plan.height).toBe(plan.sh)
    expect(plan.width).toBeGreaterThan(256)
    expect(plan.width).toBeLessThan(290)
    expect(plan.rough.w * plan.width).toBeCloseTo(256)
    expect(plan.rough.h * plan.height).toBeCloseTo(144)
  })
  it.each([[3840, 2160], [2160, 3840]])('bounds large and portrait sampling %j x %j', (width, height) => {
    const plan = cameraSamplingPlan(width, height, { x: 0, y: 0, w: 1, h: 1 })
    expect(Math.max(plan.width, plan.height)).toBe(960)
    expect(plan.region).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(plan.rough).toEqual(plan.region)
  })
  it('retains six distinct RGBA frames, timing and crop context without controlling playback', async () => {
    const play = vi.spyOn(video, 'play'), pause = vi.spyOn(video, 'pause')
    const pending = sampleCameraFrames(video, rough, new AbortController().signal)
    frame(0); frame(0.1); frame(0.3)
    expect(draw).toHaveBeenCalledOnce()
    for (let i = 1; i < 6; i++) { pixel = [190 - i, 20 + i, 100, 255]; frame(i * 0.5) }
    const sample = await pending
    expect(draw).toHaveBeenCalledTimes(6)
    const plan = cameraSamplingPlan(80, 60, rough)
    expect(draw).toHaveBeenLastCalledWith(video, plan.x, plan.y, plan.sw, plan.sh, 0, 0, plan.width, plan.height)
    expect(sample.frames.length).toBe(sample.width * sample.height * 4 * 6)
    expect([...sample.frames.subarray(0, 4)]).toEqual([190, 20, 100, 255])
    expect([...sample.frames.subarray(-4)]).toEqual([185, 25, 100, 255])
    expect(sample.region).toEqual(plan.region)
    expect(play).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled()
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not train on repeated frozen frames and times out without modifying playback', async () => {
    const pending = sampleCameraFrames(video, rough, new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('连续视频帧')
    for (let i = 0; i < 4; i++) frame(0)
    await vi.advanceTimersByTimeAsync(2600)
    await rejected
    expect(draw).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['pause', 'seeking', 'resize', 'emptied', 'loadstart', 'error', 'ended'])('discards samples when %s interrupts the source', async event => {
    const pending = sampleCameraFrames(video, rough, new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow()
    video.dispatchEvent(new Event(event))
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels frame observers and rejects paused or invalid input before sampling', async () => {
    const controller = new AbortController()
    const pending = sampleCameraFrames(video, rough, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    paused = true
    await expect(sampleCameraFrames(video, rough, new AbortController().signal)).rejects.toThrow('已暂停')
    expect(() => cameraSamplingPlan(80, 60, { ...rough, x: -1 })).toThrow()
    expect(() => cameraSamplingPlan(80, 60, { ...rough, w: 0.001 })).toThrow()
  })
})
