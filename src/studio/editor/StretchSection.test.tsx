/** A slow 4K seek must settle before the scan subscribes to presented frames. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import { StretchSection } from './StretchSection'

const mocks = vi.hoisted(() => ({ grab: vi.fn(), prepare: vi.fn(), dispose: vi.fn() }))
vi.mock('../../recognition/frameGrabber', () => ({
  FULL_FRAME_ROI: { x: 0, y: 0, w: 1, h: 1 },
  FrameGrabber: class { grab = mocks.grab; dispose = mocks.dispose },
}))
vi.mock('../../core/hudWasm', () => ({ prepareHudGlyphs: mocks.prepare }))

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  mocks.grab.mockReturnValue({ ok: true, frame: { pixels: new Uint8Array(16), width: 2, height: 2, mediaTime: 0.5 } })
  mocks.prepare.mockResolvedValue({ binary: { data: new Uint8Array([255, 0, 0, 255]), width: 2, height: 2 },
    boxes: Array.from({ length: 4 }, (_, x) => ({ x, y: 0, width: 1, height: 1, ink: 1 })), bitmaps: ['AA==', 'AQ==', 'Ag==', 'Aw=='] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

function setup() {
  const video = document.createElement('video')
  let time = 0.5, seeking = false, ready = 2
  const callbacks = new Map<number, VideoFrameRequestCallback>()
  let serial = 0
  Object.defineProperties(video, {
    currentTime: { get: () => time, set: (value: number) => { time = value; seeking = true; ready = 1 } },
    seeking: { get: () => seeking }, readyState: { get: () => ready },
    videoWidth: { get: () => 3840 }, videoHeight: { get: () => 2160 },
  })
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {})
  const play = vi.spyOn(video, 'play').mockResolvedValue()
  const request = vi.fn((callback: VideoFrameRequestCallback) => { callbacks.set(++serial, callback); return serial })
  const cancel = vi.fn((id: number) => { callbacks.delete(id) })
  video.requestVideoFrameCallback = request
  video.cancelVideoFrameCallback = cancel
  const remove = vi.spyOn(video, 'removeEventListener')
  const rendered = render(<StretchSection video={video} pack={createEmptyHudStylePack()} onSave={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /设为入点/ }))
  time = 12.5
  fireEvent.click(screen.getByRole('button', { name: /设为出点/ }))
  fireEvent.change(screen.getByRole('textbox', { name: '入点读数' }), { target: { value: '1:53' } })
  const start = () => fireEvent.click(screen.getByRole('button', { name: '扫描这一段' }))
  const seeked = () => { seeking = false; fireEvent(video, new Event('seeked')) }
  const decoded = () => { ready = 2; fireEvent(video, new Event('loadeddata')) }
  const present = async (mediaTime: number) => {
    const [id, callback] = [...callbacks][0]!
    callbacks.delete(id)
    await act(async () => { callback(0, { mediaTime } as VideoFrameCallbackMetadata) })
  }
  return { video, pause, play, request, cancel, remove, callbacks, start, seeked, decoded, present, unmount: rendered.unmount }
}

describe('stretch scan lifecycle', () => {
  it('subscribes only after seeked and a decoded frame, so old metadata cannot be grabbed', async () => {
    const scan = setup()
    scan.start()
    expect(scan.video.currentTime).toBe(0.5)
    expect(scan.request).not.toHaveBeenCalled()
    expect(scan.play).not.toHaveBeenCalled()
    scan.seeked()
    expect(scan.request).not.toHaveBeenCalled()
    scan.decoded()
    await waitFor(() => expect(scan.request).toHaveBeenCalledTimes(1))
    expect(scan.play).toHaveBeenCalledTimes(1)
    await scan.present(0.5)
    expect(mocks.grab).toHaveBeenCalledTimes(1)
    expect(mocks.grab.mock.calls[0]?.[2]).toBe(0.5)
    await scan.present(12.6)
    await screen.findByRole('list', { name: '扫描结果' })
    expect(scan.video.playbackRate).toBe(1)
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    expect(scan.remove).toHaveBeenCalledWith('ended', expect.any(Function))
    expect(scan.remove).toHaveBeenCalledWith('error', expect.any(Function))
  })
  it('cancels an unfinished seek without starting playback or leaving a callback', async () => {
    const scan = setup()
    scan.start()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await screen.findByRole('button', { name: '扫描这一段' })
    scan.seeked()
    scan.decoded()
    expect(scan.request).not.toHaveBeenCalled()
    expect(scan.play).not.toHaveBeenCalled()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    expect(scan.remove).toHaveBeenCalledWith('seeked', expect.any(Function))
  })
  it('cleans the pending presentation callback and playback rate when the video ends', async () => {
    const scan = setup()
    scan.start()
    scan.seeked()
    scan.decoded()
    await waitFor(() => expect(scan.request).toHaveBeenCalledTimes(1))
    await scan.present(0.5)
    fireEvent(scan.video, new Event('ended'))
    await screen.findByRole('list', { name: '扫描结果' })
    expect(scan.callbacks.size).toBe(0)
    expect(scan.cancel).toHaveBeenCalled()
    expect(scan.video.playbackRate).toBe(1)
  })
  it('reports an actual missing frame after seeking instead of hiding the failure', async () => {
    const scan = setup()
    mocks.grab.mockReturnValue({ ok: false, reason: 'no-video-frame' })
    scan.start()
    scan.seeked()
    scan.decoded()
    await waitFor(() => expect(scan.request).toHaveBeenCalledTimes(1))
    await scan.present(0.5)
    expect(await screen.findByRole('alert')).toHaveTextContent('取帧失败: no-video-frame')
    expect(scan.callbacks.size).toBe(0)
    expect(scan.video.playbackRate).toBe(1)
  })
  it('releases a seek and decode wait when the component is removed', async () => {
    const scan = setup()
    scan.start()
    scan.unmount()
    await act(async () => {})
    expect(scan.request).not.toHaveBeenCalled()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    expect(scan.remove).toHaveBeenCalledWith('loadeddata', expect.any(Function))
  })
})
