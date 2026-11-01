import { useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packBitmap } from '../../core/bitmapCodec'
import { createEmptyHudStylePack, parseHudStylePack, type HudStylePack } from '../../core/hudStylePack'
import * as hud from '../../core/hudWasm'
import { TEMPLATE_PIXELS, type ClockChar } from '../../core/profileSchema'
import { FrameGrabber, type GrabbedFrame } from '../../recognition/frameGrabber'
import { primeMediaElement } from '../../test/setup'
import type { EditorTarget } from './cueModel'
import { fieldModel, patchField } from './editorModel'
import { useCountdownTeaching } from './useCountdownTeaching'

afterEach(() => { vi.useRealTimers() })

function bitmap(index: number): string {
  const pixels = new Uint8Array(TEMPLATE_PIXELS)
  pixels[index] = 255
  return packBitmap(pixels)
}

function analysis(time: number, count = 4): hud.HudAnalysis {
  return { roiPixels: { x: 0, y: 0, width: 16, height: 8 },
    gray: { width: 16, height: 8, data: new Uint8Array(128) }, binary: { width: 16, height: 8, data: new Uint8Array(128) },
    boxes: Array.from({ length: count }, (_, index) => ({ x: index * 4, y: 0, width: 3, height: 8, ink: 24 })),
    projection: [], inkRatio: 0.5, normalized: [], bitmaps: Array.from({ length: count }, (_, index) => bitmap(time * 4 + index)) }
}

interface Scope { fieldId: EditorTarget; source: string; documentRevision: number }

function setup(options: { time?: number; duration?: number; format?: 'm:ss' | 'mm:ss' | 'ss' } = {}) {
  const video = document.createElement('video')
  primeMediaElement(video, { currentTime: options.time ?? 5, duration: options.duration ?? 30 })
  const initial = patchField(createEmptyHudStylePack('test/countdown', 'Original'), 'clock', {
    clockFormat: options.format ?? 'm:ss', templates: { '0': [{ id: 'existing-0', data: bitmap(0), createdAt: 0 }] },
  })
  const revision = { current: 0 }
  const frames = vi.fn()
  const writes = vi.fn()
  const messages = vi.fn()
  const grabber = new FrameGrabber()
  const grab = vi.spyOn(grabber, 'grab').mockImplementation(node => ({ ok: true, frame: {
    width: 16, height: 8, pixels: new Uint8ClampedArray(512), mediaTime: node.currentTime, wallTime: 1,
  } }))
  const prepare = vi.spyOn(hud, 'prepareHudGlyphs').mockImplementation(async frame => analysis((frame as GrabbedFrame).mediaTime,
    options.format === 'mm:ss' ? 5 : options.format === 'ss' ? 2 : 4))
  const scope: Scope = { fieldId: 'clock', source: 'fixture.mp4', documentRevision: 0 }
  const hook = renderHook((current: Scope) => {
    const [pack, setPack] = useState(initial)
    const teaching = useCountdownTeaching({ ...current, pack, variantId: pack.variants[0]!.id,
      sampleName: 'Fixture', video: { current: video }, grabber: { current: grabber }, revision,
      onFrame: frames, onMessage: messages, onPack: updated => { revision.current++; writes(updated); setPack(updated) } })
    return { ...teaching, pack, edit: (update: (pack: HudStylePack) => HudStylePack) => { revision.current++; setPack(update) } }
  }, { initialProps: scope })
  video.addEventListener('seeking', () => hook.result.current.onSeeking(video))
  video.addEventListener('seeked', () => hook.result.current.onSeeked(video))
  video.addEventListener('play', () => hook.result.current.onPlay())
  const fill = (text: string) => act(() => hook.result.current.changeReading(text))
  const jump = (seconds: number) => act(async () => { hook.result.current.jump(seconds) })
  return { ...hook, initial, video, frames, writes, messages, grab, prepare, scope, fill, jump }
}

function sampleCount(pack: HudStylePack): number {
  return Object.values(fieldModel(pack, 'clock').templates).reduce((total, samples) => total + samples.length, 0)
}

describe('countdown jump teaching', () => {
  it('collects per-box labels in visual order and uses the complete clock for jumps and undo', async () => {
    const view = setup()
    const frame = { width: 16, height: 8, pixels: new Uint8ClampedArray(512), mediaTime: 5, wallTime: 1 }
    const boxes = analysis(5).boxes
    for (const [index, char] of [[2, '1'], [0, '0'], [3, '5']] as const) {
      act(() => view.result.current.recordGlyph(char, index, boxes, frame))
      expect(view.result.current.reading).toBe('')
    }
    act(() => view.result.current.recordGlyph(':', 1, boxes, frame))
    expect(view.result.current.reading).toBe('0:15')
    await view.jump(1)
    expect(view.result.current.reading).toBe('0:14')
    expect(view.writes).toHaveBeenCalledOnce()
    await act(async () => view.result.current.undo?.())
    expect(view.result.current.reading).toBe('0:15')
    expect(view.video.currentTime).toBe(5)
  })

  it('requires a valid countdown and updates a corrected glyph at its own position', () => {
    const view = setup()
    const frame = { width: 16, height: 8, pixels: new Uint8ClampedArray(512), mediaTime: 5, wallTime: 1 }
    const boxes = analysis(5).boxes
    for (const [index, char] of [...'0:99'].entries()) act(() => view.result.current.recordGlyph(char as ClockChar, index, boxes, frame))
    expect(view.result.current.reading).toBe('')
    act(() => view.result.current.recordGlyph('1', 2, boxes, frame))
    expect(view.result.current.reading).toBe('0:19')
    act(() => view.result.current.recordGlyph('8', 3, boxes, frame))
    expect(view.result.current.reading).toBe('0:18')
  })

  it.each(['frame', 'boxes', 'field', 'reading'] as const)('never combines incomplete labels across a different %s', change => {
    const view = setup()
    let frame = { width: 16, height: 8, pixels: new Uint8ClampedArray(512), mediaTime: 5, wallTime: 1 }
    let boxes = analysis(5).boxes
    for (const [index, char] of [...'0:1'].entries()) act(() => view.result.current.recordGlyph(char as ClockChar, index, boxes, frame))
    if (change === 'frame') frame = { ...frame }
    if (change === 'boxes') boxes = boxes.map(box => ({ ...box }))
    if (change === 'field') {
      view.rerender({ ...view.scope, fieldId: 'scoreLeft' })
      view.rerender(view.scope)
    }
    if (change === 'reading') view.fill('')
    act(() => view.result.current.recordGlyph('5', 3, boxes, frame))
    expect(view.result.current.reading).toBe('')
    act(() => expect(view.result.current.jump(1)).toBe(false))
  })

  it('does not anchor an old captured frame to a newer video time when automatic capture is off', () => {
    const view = setup()
    const frame = { width: 16, height: 8, pixels: new Uint8ClampedArray(512), mediaTime: 4, wallTime: 1 }
    const boxes = analysis(4).boxes
    for (const [index, char] of [...'0:16'].entries()) act(() => view.result.current.recordGlyph(char as ClockChar, index, boxes, frame))
    expect(view.result.current.reading).toBe('')
    expect(view.writes).not.toHaveBeenCalled()
  })

  it('labels only the destination frame, follows all four jumps and undoes each append', async () => {
    const view = setup()
    view.fill('0:15')
    for (const [index, [seconds, time, reading]] of ([
      [1, 6, '0:14'], [10, 16, '0:04'], [-1, 15, '0:05'], [-10, 5, '0:15'],
    ] as const).entries()) {
      await view.jump(seconds)
      expect(view.video.currentTime).toBe(time)
      expect(view.result.current.reading).toBe(reading)
      expect(view.result.current.busy).toBe(false)
      expect(sampleCount(view.result.current.pack)).toBe(1 + (index + 1) * 4)
      const stored = fieldModel(view.result.current.pack, 'clock').templates[reading.at(-1)! as ClockChar]!.at(-1)!
      expect(stored.data).toBe(analysis(time).bitmaps[3])
    }
    for (const [time, reading] of [[15, '0:05'], [16, '0:04'], [6, '0:14'], [5, '0:15']] as const) {
      await act(async () => view.result.current.undo?.())
      expect(view.video.currentTime).toBe(time)
      expect(view.result.current.reading).toBe(reading)
    }
    expect(view.result.current.undo).toBeNull()
    expect(view.result.current.pack.bitmaps).toEqual(view.initial.bitmaps)
    expect(view.result.current.pack.variants).toEqual(view.initial.variants)
    expect(parseHudStylePack(view.result.current.pack).issues).toEqual([])
  })

  it('undo preserves manual additions, settings and other fields made after the jump', async () => {
    const view = setup()
    view.fill('0:15')
    await view.jump(1)
    const shared = fieldModel(view.result.current.pack, 'clock').templates['1']![0]!
    act(() => view.result.current.edit(pack => {
      const model = fieldModel(pack, 'clock')
      const updated = patchField(pack, 'clock', { name: 'Kept name', preprocess: { ...model.preprocess, threshold: 90 },
        templates: { ...model.templates, '7': [{ id: 'manual-7', data: bitmap(100), createdAt: 0 }] } })
      return patchField(updated, 'scoreLeft', { templates: { '2': [shared] } })
    }))
    await act(async () => view.result.current.undo?.())
    expect(view.result.current.pack.name).toBe('Kept name')
    expect(fieldModel(view.result.current.pack, 'clock').preprocess.threshold).toBe(90)
    expect(sampleCount(view.result.current.pack)).toBe(2)
    expect(view.result.current.pack.bitmaps['manual-7']).toBeDefined()
    expect(view.result.current.pack.bitmaps[shared.id]).toBeDefined()
    expect(fieldModel(view.result.current.pack, 'scoreLeft').templates['2']).toHaveLength(1)
    expect(parseHudStylePack(view.result.current.pack).issues).toEqual([])
  })

  it.each([
    ['mm:ss', '01:00', '00:59'], ['ss', '45', '44'], ['m:ss', '1:00', '0:59'],
  ] as const)('preserves the %s grammar while counting through a boundary', async (format, before, after) => {
    const view = setup({ format })
    view.fill(before)
    await view.jump(1)
    expect(view.result.current.reading).toBe(after)
    expect(view.writes).toHaveBeenCalledOnce()
  })

  it('uses an integer clamped distance, but never teaches a no-op or a fractional boundary', async () => {
    const view = setup({ time: 25, duration: 26 })
    view.fill('0:15')
    await view.jump(10)
    expect(view.result.current.reading).toBe('0:14')
    await view.jump(10)
    expect(view.writes).toHaveBeenCalledOnce()
    act(() => { view.video.currentTime = 25.5 })
    view.fill('0:15')
    await view.jump(10)
    expect(view.writes).toHaveBeenCalledOnce()
    expect(view.result.current.reading).toBe('')
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('不足整秒') }))
  })

  it.each(['wrong', '0:99', '0:00'])('does not manufacture samples from the invalid or exhausted reading %s', async reading => {
    const view = setup()
    view.fill(reading)
    await view.jump(1)
    expect(view.video.currentTime).toBe(6)
    expect(view.result.current.reading).toBe('')
    expect(view.writes).not.toHaveBeenCalled()
    expect(view.result.current.undo).toBeNull()
  })

  it('refuses new frames with a different glyph count, without losing previous templates', async () => {
    const view = setup()
    view.prepare.mockResolvedValueOnce(analysis(6, 3))
    view.fill('0:15')
    await view.jump(1)
    expect(view.result.current.reading).toBe('0:14')
    expect(view.writes).not.toHaveBeenCalled()
    expect(view.result.current.pack).toBe(view.initial)
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('切出了 3 个字符框') }))
  })

  it('does not leave a previous-frame reading or write samples after a failed capture', async () => {
    const view = setup()
    view.grab.mockReturnValueOnce({ ok: false, reason: 'no-video-frame' })
    view.fill('0:15')
    await view.jump(1)
    expect(view.result.current.reading).toBe('')
    expect(view.writes).not.toHaveBeenCalled()
    expect(view.prepare).not.toHaveBeenCalled()
    expect(view.result.current.busy).toBe(false)
  })

  it('ignores repeated clicks in flight and refuses a late preparation after settings change', async () => {
    const view = setup()
    let finish!: (value: hud.HudAnalysis) => void
    view.prepare.mockImplementationOnce(() => new Promise<hud.HudAnalysis>(resolve => { finish = resolve }))
    view.fill('0:15')
    await view.jump(1)
    expect(view.result.current.busy).toBe(true)
    await view.jump(10)
    expect(view.video.currentTime).toBe(6)
    act(() => view.result.current.edit(pack => patchField(pack, 'clock', { name: 'New settings' })))
    await act(async () => finish(analysis(6)))
    expect(view.writes).not.toHaveBeenCalled()
    expect(view.result.current.busy).toBe(false)
    expect(view.result.current.pack.name).toBe('New settings')
  })

  it('clears a stale baseline on a scrub or playback and never auto-teaches other fields', async () => {
    const view = setup()
    view.fill('0:15')
    act(() => { view.video.currentTime = 8 })
    expect(view.result.current.reading).toBe('')
    view.fill('0:12')
    await act(async () => view.video.play())
    expect(view.result.current.reading).toBe('')
    view.rerender({ ...view.scope, fieldId: 'scoreLeft' })
    view.fill('12')
    act(() => expect(view.result.current.jump(1)).toBe(false))
    expect(view.result.current.reading).toBe('12')
    expect(view.writes).not.toHaveBeenCalled()
  })

  it.each(['source', 'documentRevision'] as const)('forgets undo on a different %s', async key => {
    const view = setup()
    view.fill('0:15')
    await view.jump(1)
    expect(view.result.current.undo).not.toBeNull()
    view.rerender(key === 'source' ? { ...view.scope, source: 'other.mp4' } : { ...view.scope, documentRevision: 1 })
    expect(view.result.current.undo).toBeNull()
    expect(view.result.current.reading).toBe('')
  })

  it('releases a timed-out operation and ignores its later result', async () => {
    vi.useFakeTimers()
    const view = setup()
    let finish!: (value: hud.HudAnalysis) => void
    view.prepare.mockImplementationOnce(() => new Promise<hud.HudAnalysis>(resolve => { finish = resolve }))
    view.fill('0:15')
    await view.jump(1)
    act(() => vi.advanceTimersByTime(10_000))
    expect(view.result.current.busy).toBe(false)
    expect(view.result.current.reading).toBe('')
    await act(async () => finish(analysis(6)))
    expect(view.writes).not.toHaveBeenCalled()
    expect(view.messages).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('超时') }))
  })
})
