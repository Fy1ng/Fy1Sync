import { webcrypto } from 'node:crypto'
import { useState } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { packBitmap } from '../../core/bitmapCodec'
import { createEmptyHudStylePack, parseHudStylePack, type HudStylePack } from '../../core/hudStylePack'
import * as hud from '../../core/hudWasm'
import { TEMPLATE_PIXELS, type ClockChar } from '../../core/profileSchema'
import { FrameGrabber, type GrabbedFrame } from '../../recognition/frameGrabber'
import { primeMediaElement } from '../../test/setup'
import type { EditorTarget } from './cueModel'
import { fieldModel, patchField } from './editorModel'
import { useCountdownTeaching } from './useCountdownTeaching'
import { clockText } from './reading'

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function bitmap(index: number): string {
  const pixels = new Uint8Array(TEMPLATE_PIXELS)
  pixels[index % TEMPLATE_PIXELS] = 255
  return packBitmap(pixels)
}
function picture(time: number): GrabbedFrame {
  const pixels = new Uint8ClampedArray(512)
  new DataView(pixels.buffer).setFloat64(0, time)
  return { width: 16, height: 8, pixels, mediaTime: time, wallTime: 1 }
}
function analysis(time: number, count = 4): hud.HudAnalysis {
  return { roiPixels: { x: 0, y: 0, width: 16, height: 8 },
    gray: { width: 16, height: 8, data: new Uint8Array(128) }, binary: { width: 16, height: 8, data: new Uint8Array(128) },
    boxes: Array.from({ length: count }, (_, index) => ({ x: index * 4, y: 0, width: 3, height: 8, ink: 24 })),
    projection: [], inkRatio: 0.5, normalized: [], bitmaps: Array.from({ length: count }, (_, index) => bitmap(Math.round(time * 10) + index)) }
}

interface Scope { fieldId: EditorTarget; source: string; documentRevision: number }
function setup(options: { time?: number; duration?: number; format?: 'm:ss' | 'mm:ss' | 'ss'; still?: boolean; pack?: HudStylePack } = {}) {
  const video = options.still ? null : document.createElement('video')
  if (video) primeMediaElement(video, { currentTime: options.time ?? 5, duration: options.duration ?? 30 })
  const initial = options.pack ?? patchField(createEmptyHudStylePack('test/countdown', 'Original'), 'clock', { clockFormat: options.format ?? 'm:ss' })
  const count = options.format === 'mm:ss' ? 5 : options.format === 'ss' ? 2 : 4
  const revision = { current: 0 }
  const writes = vi.fn()
  const messages = vi.fn()
  const selected = vi.fn()
  const grabber = new FrameGrabber()
  const grab = vi.spyOn(grabber, 'grab').mockImplementation(node => ({ ok: true, frame: picture(node.currentTime) }))
  const prepare = vi.spyOn(hud, 'prepareHudGlyphs').mockImplementation(async frame => analysis((frame as GrabbedFrame).mediaTime, count))
  const recognize = vi.spyOn(hud, 'recognizeHudFrame').mockImplementation(async (frame, pack, variantId) => {
    const at = (frame as GrabbedFrame).mediaTime
    const text = clockText(Math.max(0, 20 - at), options.format ?? 'm:ss')
    const glyphs = pack.variants.find(variant => variant.id === variantId)!.fields.clock!.glyphs
    const debug = { ...analysis(at, count), matches: [...text].map(char => ({
      char: glyphs[char as ClockChar]?.length ? char as ClockChar : null,
      score: glyphs[char as ClockChar]?.length ? 0.98 : 0.3, runnerUpScore: 0.1, sampleIndex: 0,
    })) }
    return { variantId: variantId!, selectionReason: null, content: 'live', phase: 'unconfigured', cues: {}, states: {},
      organizer: { status: 'failed', reason: 'not-configured', score: null, debug: null }, fields: {
        clock: { status: 'failed', reason: 'insufficient-templates', debug },
        scoreLeft: { status: 'failed', reason: 'not-configured', debug: null },
        scoreRight: { status: 'failed', reason: 'not-configured', debug: null }, round: { status: 'failed', reason: 'not-configured', debug: null },
      } }
  })
  const scope: Scope = { fieldId: 'clock', source: 'fixture.mp4', documentRevision: 0 }
  const hook = renderHook((current: Scope) => {
    const [pack, setPack] = useState(initial)
    const [frame, setFrame] = useState(() => picture(options.time ?? 5))
    const [boxes, setBoxes] = useState(() => analysis(frame.mediaTime, count).boxes)
    const onFrame = (next: GrabbedFrame) => { setFrame(next); setBoxes(analysis(next.mediaTime, count).boxes) }
    const teaching = useCountdownTeaching({ ...current, pack, variantId: pack.variants[0]!.id, frame, boxes,
      video: { current: video }, grabber: { current: grabber }, revision, onFrame, onSelect: selected,
      onMessage: messages, onPack: updated => { revision.current++; writes(updated); setPack(updated) } })
    return { ...teaching, pack, frame, boxes, onFrame, setBoxes,
      edit: (update: (pack: HudStylePack) => HudStylePack) => { revision.current++; setPack(update) } }
  }, { initialProps: scope })
  video?.addEventListener('seeking', () => hook.result.current.onSeeking(video))
  video?.addEventListener('seeked', () => hook.result.current.onSeeked(video))
  video?.addEventListener('play', () => hook.result.current.onPlay())
  const assign = async (char: ClockChar, index: number) => { await act(async () => hook.result.current.assign(char, index)) }
  const label = async (text: string) => { for (const [index, char] of [...text].entries()) await assign(char as ClockChar, index) }
  const jump = async (seconds: number) => {
    act(() => { hook.result.current.jump(seconds) })
    await waitFor(() => expect(hook.result.current.busy).toBe(false))
  }
  const undo = async () => { act(() => hook.result.current.undo?.()); await waitFor(() => expect(hook.result.current.busy).toBe(false)) }
  const capture = async (time: number) => {
    act(() => { if (video) video.currentTime = time; hook.result.current.onFrame(picture(time)) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  return { ...hook, initial, video, writes, messages, selected, grab, prepare, recognize, scope, label, assign, jump, undo, capture }
}
function sampleCount(pack: HudStylePack, field: 'clock' | 'scoreLeft' = 'clock'): number {
  return Object.values(fieldModel(pack, field).templates).reduce((total, samples) => total + samples.length, 0)
}

describe('character button teaching', () => {
  it('saves each click immediately, shows partial labels and counts backwards through undo', async () => {
    const view = setup()
    await view.assign('0', 0)
    expect(view.result.current.reading).toBe('0???')
    expect(sampleCount(view.result.current.pack)).toBe(1)
    act(() => expect(view.result.current.jump(1)).toBe(false))
    for (const [index, char] of [[1, ':'], [2, '1'], [3, '5']] as const) await view.assign(char, index)
    expect(view.result.current.reading).toBe('0:15')
    expect(sampleCount(view.result.current.pack)).toBe(4)
    for (const [index, expected] of ['0:1?', '0:??', '0???', ''].entries()) {
      await view.undo()
      await waitFor(() => expect(view.result.current.reading).toBe(expected))
      expect(sampleCount(view.result.current.pack)).toBe(3 - index)
      expect(view.selected).toHaveBeenLastCalledWith(3 - index)
    }
    expect(view.result.current.undo).toBeNull()
    expect(view.result.current.pack.bitmaps).toEqual({})
  })

  it('does not duplicate a reselected slot or a re-captured/revisited frame, even after reopening its pack', async () => {
    const view = setup()
    await view.label('0:15')
    const saved = view.result.current.pack
    await view.assign('5', 3)
    expect(view.result.current.pack).toBe(saved)
    await view.capture(6)
    await view.capture(5)
    await waitFor(() => expect(view.result.current.reading).toBe('0:15'))
    await view.assign('5', 3)
    expect(view.result.current.pack).toBe(saved)
    view.unmount()
    const reopened = setup({ pack: saved })
    await waitFor(() => expect(reopened.result.current.reading).toBe('0:15'))
    await reopened.label('0:15')
    expect(reopened.writes).not.toHaveBeenCalled()
    expect(sampleCount(reopened.result.current.pack)).toBe(4)
    expect(reopened.result.current.undo).toBeNull()
  })

  it('corrects a label without accumulating conflicting samples and undo restores the original', async () => {
    const view = setup()
    await view.label('0:15')
    const saved = view.result.current.pack
    await view.assign('6', 3)
    expect(view.result.current.reading).toBe('0:16')
    expect(sampleCount(view.result.current.pack)).toBe(4)
    expect(fieldModel(view.result.current.pack, 'clock').templates['5']).toBeUndefined()
    await view.undo()
    await waitFor(() => expect(view.result.current.reading).toBe('0:15'))
    expect(view.result.current.pack.variants).toEqual(saved.variants)
    expect(view.result.current.pack.bitmaps).toEqual(saved.bitmaps)
    expect(parseHudStylePack(view.result.current.pack).issues).toEqual([])
  })

  it('supports still screenshots and independent score characters with the same undo', async () => {
    const view = setup({ still: true })
    view.rerender({ ...view.scope, fieldId: 'scoreLeft' })
    await view.assign('1', 0)
    await view.assign('8', 1)
    expect(sampleCount(view.result.current.pack, 'scoreLeft')).toBe(2)
    expect(sampleCount(view.result.current.pack)).toBe(0)
    await view.assign(':', 2)
    expect(sampleCount(view.result.current.pack, 'scoreLeft')).toBe(2)
    await view.undo()
    expect(sampleCount(view.result.current.pack, 'scoreLeft')).toBe(1)
    expect(view.grab).not.toHaveBeenCalled()
  })

  it('keeps manually adjusted character boxes when undoing a click on the current frame', async () => {
    const view = setup()
    const boxes = view.result.current.boxes.map((box, index) => index === 0 ? { ...box, width: 2 } : box)
    act(() => view.result.current.setBoxes(boxes))
    await view.assign('0', 0)
    await view.undo()
    expect(view.result.current.boxes).toBe(boxes)
    expect(sampleCount(view.result.current.pack)).toBe(0)
    expect(view.grab).not.toHaveBeenCalled()
  })

  it('adopts an identical legacy sample without duplication, and undo restores the legacy ID', async () => {
    const initial = patchField(createEmptyHudStylePack(), 'clock', { templates: {
      '0': [{ id: 'legacy-zero', data: analysis(5).bitmaps[0]!, createdAt: 0 }],
    } })
    const view = setup({ pack: initial })
    await view.assign('0', 0)
    expect(sampleCount(view.result.current.pack)).toBe(1)
    expect(fieldModel(view.result.current.pack, 'clock').templates['0']![0]!.id).toMatch(/^frame-/)
    await view.undo()
    expect(view.result.current.pack.variants).toEqual(initial.variants)
    expect(view.result.current.pack.bitmaps).toEqual(initial.bitmaps)
  })

  it('preserves unrelated changes and shared bitmaps when undoing a click', async () => {
    const view = setup()
    await view.assign('1', 0)
    const shared = fieldModel(view.result.current.pack, 'clock').templates['1']![0]!
    act(() => view.result.current.edit(pack => patchField(pack, 'scoreLeft', { name: 'Kept name', templates: { '1': [shared] } })))
    await view.undo()
    expect(view.result.current.pack.name).toBe('Kept name')
    expect(sampleCount(view.result.current.pack)).toBe(0)
    expect(sampleCount(view.result.current.pack, 'scoreLeft')).toBe(1)
    expect(view.result.current.pack.bitmaps[shared.id]).toBeDefined()
    expect(parseHudStylePack(view.result.current.pack).issues).toEqual([])
  })

  it('does not save twice while processing and rejects late work after a different frame is captured', async () => {
    const view = setup()
    let finish!: (value: hud.HudAnalysis) => void
    view.prepare.mockImplementationOnce(() => new Promise<hud.HudAnalysis>(resolve => { finish = resolve }))
    let first!: Promise<void>
    act(() => { first = view.result.current.assign('0', 0) })
    await view.assign('0', 0)
    expect(view.prepare).toHaveBeenCalledOnce()
    await view.capture(6)
    await act(async () => { finish(analysis(5)); await first })
    expect(view.writes).not.toHaveBeenCalled()
    expect(view.result.current.busy).toBe(false)
  })

  it('refuses a stale capture when automatic capture is disabled', async () => {
    const view = setup()
    act(() => { view.video!.currentTime = 6 })
    await view.assign('0', 0)
    expect(view.writes).not.toHaveBeenCalled()
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('取当前帧') }))
  })
})

describe('shared jump history', () => {
  it('uses button labels for all four jumps, deduplicates the return and undoes jumps before earlier clicks', async () => {
    const view = setup()
    await view.label('0:15')
    const baseline = view.result.current.pack
    for (const [seconds, time, reading, samples] of [
      [1, 6, '0:14', 8], [10, 16, '0:04', 12], [-1, 15, '0:05', 16], [-10, 5, '0:15', 16],
    ] as const) {
      await view.jump(seconds)
      expect(view.video!.currentTime).toBe(time)
      await waitFor(() => expect(view.result.current.reading).toBe(reading))
      expect(sampleCount(view.result.current.pack)).toBe(samples)
    }
    for (const [time, reading, samples] of [[15, '0:05', 16], [16, '0:04', 12], [6, '0:14', 8], [5, '0:15', 4]] as const) {
      await view.undo()
      expect(view.video!.currentTime).toBe(time)
      await waitFor(() => expect(view.result.current.reading).toBe(reading))
      expect(sampleCount(view.result.current.pack)).toBe(samples)
    }
    expect(view.result.current.pack.variants).toEqual(baseline.variants)
    expect(view.result.current.pack.bitmaps).toEqual(baseline.bitmaps)
    await view.undo()
    expect(sampleCount(view.result.current.pack)).toBe(3)
  })

  it('undoes a correction to an auto-taught frame before undoing the jump itself', async () => {
    const view = setup()
    await view.label('0:15')
    await view.jump(1)
    await view.assign('3', 3)
    expect(view.result.current.reading).toBe('0:13')
    expect(sampleCount(view.result.current.pack)).toBe(8)
    await view.undo()
    await waitFor(() => expect(view.result.current.reading).toBe('0:14'))
    await view.undo()
    expect(view.video!.currentTime).toBe(5)
    expect(sampleCount(view.result.current.pack)).toBe(4)
  })

  it.each([['mm:ss', '01:00', '00:59'], ['ss', '45', '44'], ['m:ss', '1:00', '0:59']] as const)(
    'preserves the %s format', async (format, before, after) => {
      const view = setup({ format })
      await view.label(before)
      await view.jump(1)
      await waitFor(() => expect(view.result.current.reading).toBe(after))
    })

  it('does not invent a negative or invalid clock reading', async () => {
    const view = setup()
    await view.label('0:00')
    await view.jump(1)
    expect(sampleCount(view.result.current.pack)).toBe(4)
    expect(view.result.current.reading).toBe('')
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('超出格式范围') }))
  })

  it('uses the actual clamped integer distance but refuses fractional boundaries', async () => {
    const view = setup({ time: 25, duration: 26 })
    await view.label('0:15')
    await view.jump(10)
    await waitFor(() => expect(view.result.current.reading).toBe('0:14'))
    const writes = view.writes.mock.calls.length
    await view.jump(10)
    expect(view.writes).toHaveBeenCalledTimes(writes)
    await view.capture(25.5)
    await view.label('0:15')
    const before = sampleCount(view.result.current.pack)
    await view.jump(10)
    expect(sampleCount(view.result.current.pack)).toBe(before)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('不足整秒') }))
  })

  it('refuses a mismatched target glyph count without altering earlier samples', async () => {
    const view = setup()
    await view.label('0:15')
    const saved = view.result.current.pack
    view.prepare.mockResolvedValueOnce(analysis(6, 3))
    await view.jump(1)
    expect(view.result.current.pack).toBe(saved)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('切出了 3 个字符框') }))
  })

  it('does not write after failed capture or late preparation from changed settings', async () => {
    const view = setup()
    await view.label('0:15')
    view.grab.mockReturnValueOnce({ ok: false, reason: 'no-video-frame' })
    await view.jump(1)
    expect(sampleCount(view.result.current.pack)).toBe(4)
    await view.capture(5)
    await waitFor(() => expect(view.result.current.reading).toBe('0:15'))
    let finish!: (value: hud.HudAnalysis) => void
    view.prepare.mockImplementationOnce(() => new Promise<hud.HudAnalysis>(resolve => { finish = resolve }))
    act(() => { view.result.current.jump(1) })
    act(() => view.result.current.edit(pack => patchField(pack, 'clock', { name: 'New settings' })))
    await act(async () => { finish(analysis(6)); await new Promise(resolve => setTimeout(resolve, 10)) })
    await waitFor(() => expect(view.result.current.busy).toBe(false))
    expect(sampleCount(view.result.current.pack)).toBe(4)
    expect(view.result.current.pack.name).toBe('New settings')
  })

  it('forgets history for a different document without erasing saved templates', async () => {
    const view = setup()
    await view.label('0:15')
    view.rerender({ ...view.scope, documentRevision: 1 })
    expect(view.result.current.undo).toBeNull()
    expect(sampleCount(view.result.current.pack)).toBe(4)
  })

  it('releases a timed-out operation and ignores its late result', async () => {
    const view = setup()
    await view.label('0:15')
    vi.useFakeTimers()
    let finish!: (value: hud.HudAnalysis) => void
    view.prepare.mockImplementationOnce(() => new Promise<hud.HudAnalysis>(resolve => { finish = resolve }))
    act(() => { view.result.current.jump(1) })
    act(() => vi.advanceTimersByTime(10_000))
    expect(view.result.current.busy).toBe(false)
    await act(async () => { finish(analysis(6)) })
    expect(sampleCount(view.result.current.pack)).toBe(4)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('超时') }))
  })
})

describe('automatic one-second teaching', () => {
  it('requires one complete current-frame reading, then processes serially until zero and retains undo', async () => {
    const view = setup({ time: 17 })
    expect(view.result.current.canAutoStart).toBe(false)
    await view.label('0:03')
    await waitFor(() => expect(view.result.current.canAutoStart).toBe(true))
    act(() => { view.result.current.startAuto() })
    expect(view.result.current.autoRunning).toBe(true)
    expect(view.result.current.busy).toBe(true)
    await waitFor(() => expect(view.result.current.autoRunning).toBe(false), { timeout: 3000 })
    expect(view.video!.currentTime).toBe(20)
    expect(view.result.current.autoSteps).toBe(3)
    await waitFor(() => expect(view.result.current.reading).toBe('0:00'))
    expect(view.recognize).toHaveBeenCalledTimes(3)
    // New evidence must not be included in the pack passed to recognition for that same frame.
    expect(view.recognize.mock.calls[0]![1].variants[0]!.fields.clock!.glyphs['2']).toBeUndefined()
    expect(sampleCount(view.result.current.pack)).toBe(16)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('倒计时已到 0') }))
    await view.undo()
    expect(view.video!.currentTime).toBe(19)
    expect(sampleCount(view.result.current.pack)).toBe(12)
  })

  it('stops on recognition mismatch before committing the bad frame', async () => {
    const view = setup({ time: 17 })
    await view.label('0:03')
    const recognize = view.recognize.getMockImplementation()!
    view.recognize.mockImplementation(async (...args) => {
      const result = await recognize(...args)
      if ((args[0] as GrabbedFrame).mediaTime === 19) result.fields.clock = { status: 'read', debug: null,
        reading: { text: '0:02', value: 2, source: 'recognized', confidence: 1, scores: [1, 1, 1, 1] } }
      return result
    })
    act(() => view.result.current.startAuto())
    await waitFor(() => expect(view.result.current.autoRunning).toBe(false), { timeout: 3000 })
    expect(view.result.current.autoSteps).toBe(1)
    expect(view.video!.currentTime).toBe(19)
    expect(sampleCount(view.result.current.pack)).toBe(8)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('倒计时不匹配') }))
  })

  it('can be stopped during a pending recognition and ignores its late completion', async () => {
    const view = setup()
    await view.label('0:15')
    let finish!: (result: hud.HudFrameResult) => void
    const original = view.recognize.getMockImplementation()!
    view.recognize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => view.result.current.startAuto())
    await waitFor(() => expect(view.recognize).toHaveBeenCalledOnce())
    act(() => view.result.current.startAuto())
    act(() => view.result.current.stopAuto())
    expect(view.result.current.autoRunning).toBe(false)
    await act(async () => {
      finish(await original(picture(6), view.result.current.pack, view.result.current.pack.variants[0]!.id))
      await new Promise(resolve => setTimeout(resolve, 150))
    })
    expect(view.video!.currentTime).toBe(6)
    expect(sampleCount(view.result.current.pack)).toBe(4)
    expect(view.recognize).toHaveBeenCalledOnce()
    expect(view.result.current.autoSteps).toBe(0)
  })

  it('stops at the file boundary without creating a clamped duplicate', async () => {
    const view = setup({ time: 5, duration: 6.5 })
    await view.label('0:15')
    act(() => view.result.current.startAuto())
    await waitFor(() => expect(view.result.current.autoRunning).toBe(false), { timeout: 3000 })
    expect(view.video!.currentTime).toBe(6)
    expect(view.result.current.autoSteps).toBe(1)
    expect(sampleCount(view.result.current.pack)).toBe(8)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('素材末尾') }))
  })

  it('cancels further steps if settings change between frames', async () => {
    const view = setup()
    await view.label('0:15')
    act(() => view.result.current.startAuto())
    await waitFor(() => expect(view.result.current.autoSteps).toBe(1))
    act(() => view.result.current.edit(pack => patchField(pack, 'clock', { name: 'Changed' })))
    await waitFor(() => expect(view.result.current.autoRunning).toBe(false))
    expect(view.video!.currentTime).toBe(6)
    expect(view.result.current.autoSteps).toBe(1)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('设置已改变') }))
  })

  it('stops after capture failure without silently retrying', async () => {
    const view = setup()
    await view.label('0:15')
    view.grab.mockReturnValueOnce({ ok: false, reason: 'no-video-frame' })
    act(() => view.result.current.startAuto())
    await waitFor(() => expect(view.result.current.autoRunning).toBe(false))
    expect(view.grab).toHaveBeenCalledOnce()
    expect(sampleCount(view.result.current.pack)).toBe(4)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('取帧失败') }))
  })

  it('stops the automatic session on timeout and prevents a late step from restarting it', async () => {
    const view = setup()
    await view.label('0:15')
    vi.useFakeTimers()
    let finish!: (value: hud.HudAnalysis) => void
    view.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => { view.result.current.startAuto(); vi.advanceTimersByTime(100) })
    expect(view.result.current.autoRunning).toBe(true)
    act(() => vi.advanceTimersByTime(10_000))
    expect(view.result.current.autoRunning).toBe(false)
    expect(view.result.current.busy).toBe(false)
    await act(async () => finish(analysis(6)))
    act(() => vi.advanceTimersByTime(500))
    expect(sampleCount(view.result.current.pack)).toBe(4)
    expect(view.video!.currentTime).toBe(6)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('超时') }))
  })
})
