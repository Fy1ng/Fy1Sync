import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyHudStylePack, type HudStylePack } from '../../core/hudStylePack'
import type { HudFieldResult, HudFrameResult } from '../../core/hudWasm'
import { FrameGrabber, type GrabbedFrame } from '../../recognition/frameGrabber'
import { BatchValidationSession, createValidationCapture, validationSampleCount, waitValidationVideo, type ValidationCapture } from './batchValidationRunner'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.querySelectorAll('video').forEach(video => video.remove()) })

const frame = (at: number): GrabbedFrame => ({ pixels: new Uint8ClampedArray(16), width: 2, height: 2, mediaTime: at, wallTime: 0 })
const disabled = (): HudFieldResult => ({ status: 'disabled', debug: null })
const result = (): HudFrameResult => ({ variantId: 'official-top-1080', selectionReason: null, content: 'live', phase: 'active',
  fields: { clock: { status: 'failed', reason: 'low-confidence', debug: null }, scoreLeft: disabled(), scoreRight: disabled(), round: disabled() },
  cues: {}, states: {}, organizer: { status: 'disabled', score: null, debug: null } })

function fixture() {
  const pack = createEmptyHudStylePack()
  const capture: ValidationCapture = { frameAt: vi.fn(async at => frame(at)), dispose: vi.fn() }
  const factory = vi.fn(() => capture)
  const recognize = vi.fn(async (_frame: GrabbedFrame, _pack: HudStylePack) => result())
  const options = { source: 'app-media://local/clip', sourceName: 'validation.mp4', pack, range: { from: 0, to: 4, step: 1 }, duration: 10, capture: factory, recognize }
  return { pack, capture, factory, recognize, options }
}

describe('read-only validation sampling', () => {
  it('uses a bounded half-open range so the end of a video is never requested', () => {
    expect(validationSampleCount({ from: 1, to: 4, step: 1 }, 4)).toBe(3)
    expect(validationSampleCount({ from: 1, to: 4.2, step: 1 }, 5)).toBe(4)
    expect(validationSampleCount({ from: 0, to: 3600, step: 0.5 }, 3600)).toBe(7200)
    for (const range of [{ from: 0, to: 3601, step: 0.5 }, { from: 0, to: Infinity, step: 1 },
      { from: -1, to: 1, step: 1 }, { from: 4, to: 4, step: 1 }, { from: 0, to: 10, step: 0 }, { from: 0, to: 4000, step: 1 }]) {
      expect(() => validationSampleCount(range, 3601)).toThrow()
    }
  })

  it('freezes the pack at start, uses automatic layout selection and continues through OCR failure', async () => {
    const test = fixture()
    const original = structuredClone(test.pack)
    const session = new BatchValidationSession(test.options)
    test.pack.name = 'Changed after scan creation'
    test.pack.variants[0]!.fields.clock!.match.minScore = 0.1
    const current = JSON.stringify(test.pack)
    const progress = vi.fn()
    await session.scan(new AbortController().signal, progress)
    expect(session.rows).toHaveLength(4)
    expect(session.rows.every(row => row.fields.clock.status === 'failed')).toBe(true)
    expect(test.recognize).toHaveBeenCalledTimes(4)
    expect(test.recognize.mock.calls.map(([image]) => image.mediaTime)).toEqual([0, 1, 2, 3])
    expect(test.recognize.mock.calls[0]).toHaveLength(2)
    expect(test.recognize.mock.calls[0]![1]).toEqual(original)
    expect(JSON.stringify(test.pack)).toBe(current)
    expect(session.run.packName).toBe(original.name)
    expect(test.capture.dispose).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(session.rows)).not.toContain('pixels')
    expect(JSON.stringify(session.rows)).not.toContain('debug')
  })

  it('keeps isolated capture errors as findings and proceeds to the next timestamp', async () => {
    const test = fixture()
    vi.mocked(test.capture.frameAt).mockRejectedValueOnce(new Error('decode failed'))
    const session = new BatchValidationSession(test.options)
    await session.scan(new AbortController().signal, () => {})
    expect(session.rows).toHaveLength(4)
    expect(session.rows[0]!.notes).toEqual(expect.arrayContaining([expect.objectContaining({ target: 'frame', code: 'frame-error' })]))
    expect(test.recognize).toHaveBeenCalledTimes(3)
    expect(test.capture.dispose).toHaveBeenCalledOnce()
  })

  it('stops a broken decoder after three consecutive infrastructure failures, retaining partial evidence', async () => {
    const test = fixture()
    vi.mocked(test.capture.frameAt).mockRejectedValue(new Error('decode failed'))
    const session = new BatchValidationSession(test.options)
    await expect(session.scan(new AbortController().signal, () => {})).rejects.toThrow('连续 3 次')
    expect(session.rows).toHaveLength(3)
    expect(test.capture.dispose).toHaveBeenCalledOnce()
    expect(test.recognize).not.toHaveBeenCalled()
  })

  it('cancels between frames without adding a fake failure or mutating a template', async () => {
    const test = fixture()
    const serialized = JSON.stringify(test.pack)
    const session = new BatchValidationSession(test.options)
    const controller = new AbortController()
    await expect(session.scan(controller.signal, () => controller.abort())).rejects.toThrow()
    expect(session.rows).toHaveLength(1)
    expect(test.capture.dispose).toHaveBeenCalledOnce()
    expect(JSON.stringify(test.pack)).toBe(serialized)
    await expect(session.scan(new AbortController().signal, () => {})).rejects.toThrow('新的验收')
  })

  it('discards a late recognition result after cancellation', async () => {
    const test = fixture()
    const controller = new AbortController()
    test.recognize.mockImplementation(async () => { controller.abort(); return result() })
    const session = new BatchValidationSession(test.options)
    const progress = vi.fn()
    await expect(session.scan(controller.signal, progress)).rejects.toThrow()
    expect(session.rows).toHaveLength(0)
    expect(progress).not.toHaveBeenCalled()
    expect(test.capture.dispose).toHaveBeenCalledOnce()
  })

  it('can stop while WASM initialization is still pending without waiting for it to settle', async () => {
    const test = fixture()
    let resolve!: (value: HudFrameResult) => void
    test.recognize.mockImplementation(() => new Promise<HudFrameResult>(done => { resolve = done }))
    const session = new BatchValidationSession(test.options)
    const controller = new AbortController()
    const pending = session.scan(controller.signal, () => {})
    await vi.waitFor(() => expect(test.recognize).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(test.capture.dispose).toHaveBeenCalledOnce()
    resolve(result())
    await Promise.resolve()
    expect(session.rows).toHaveLength(0)
  })

  it('rejects an invalid pack before opening any decoder', () => {
    const test = fixture()
    test.pack.variants[0]!.fields.clock!.roi.w = -1
    expect(() => new BatchValidationSession(test.options)).toThrow('样式包格式无效')
    expect(test.factory).not.toHaveBeenCalled()
  })
})

function decodingVideo() {
  const video = document.createElement('video')
  let time = 0, ready = 1, seeking = false
  const requested = vi.fn((value: number) => { time = value; seeking = true })
  Object.defineProperties(video, {
    currentTime: { get: () => time, set: requested }, readyState: { get: () => ready }, seeking: { get: () => seeking },
    videoWidth: { value: 3840 }, videoHeight: { value: 2160 },
  })
  const seeked = () => { seeking = false; video.dispatchEvent(new Event('seeked')) }
  const decoded = () => { ready = 2; video.dispatchEvent(new Event('loadeddata')) }
  return { video, requested, seeked, decoded }
}

describe('validation decoder lifecycle', () => {
  it('waits for both the seek and decode, including a slow 4K source', async () => {
    const test = decodingVideo()
    const done = vi.fn()
    const pending = waitValidationVideo(test.video, 3, new AbortController().signal).then(done)
    expect(test.requested).toHaveBeenCalledWith(3)
    test.seeked()
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    test.decoded()
    await pending
    expect(done).toHaveBeenCalledOnce()
  })

  it('cancels a pending seek and removes its event listeners immediately', async () => {
    const test = decodingVideo()
    const remove = vi.spyOn(test.video, 'removeEventListener')
    const controller = new AbortController()
    const pending = waitValidationVideo(test.video, 2, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(remove).toHaveBeenCalledWith('loadeddata', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('seeked', expect.any(Function))
    test.seeked(); test.decoded()
  })

  it('bounds an unresponsive decoder instead of hanging a scan', async () => {
    vi.useFakeTimers()
    const test = decodingVideo()
    const pending = waitValidationVideo(test.video, 2, new AbortController().signal, 100)
    const failure = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(100)
    await failure
    expect(vi.getTimerCount()).toBe(0)
  })

  it('owns a separate video and releases it without moving the editor source', async () => {
    const editor = document.createElement('video')
    editor.className = 'editor-media'
    editor.currentTime = 7
    document.body.append(editor)
    const loaded = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const capture = createValidationCapture('app-media://local/validation')
    const decoder = document.querySelector<HTMLVideoElement>('video.validation-decoder')!
    Object.defineProperties(decoder, { readyState: { value: 2 }, videoWidth: { value: 2 }, videoHeight: { value: 2 }, seeking: { value: false } })
    vi.spyOn(FrameGrabber.prototype, 'grab').mockReturnValue({ ok: true, frame: frame(2) })
    const snapshot = await capture.frameAt(2, new AbortController().signal)
    expect(snapshot.mediaTime).toBe(2)
    expect(editor.currentTime).toBe(7)
    expect(editor.paused).toBe(true)
    expect(decoder).not.toBe(editor)
    capture.dispose()
    expect(document.querySelector('video.validation-decoder')).toBeNull()
    expect(loaded).toHaveBeenCalledTimes(2)
    expect(editor.currentTime).toBe(7)
  })
})
