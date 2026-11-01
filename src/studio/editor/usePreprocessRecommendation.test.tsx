import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import { createHudPreprocess, type HudPreprocessRecommendation } from '../../core/hudPreprocess'
import * as wasm from '../../core/hudWasm'
import { usePreprocessRecommendation } from './usePreprocessRecommendation'

function fixture() {
  const pack = createEmptyHudStylePack()
  return { pack, frame: { width: 16, height: 8, pixels: new Uint8ClampedArray(512), mediaTime: 1, wallTime: 0 },
    variantId: pack.variants[0]!.id, target: 'clock' as const, revision: { current: 0 }, disabled: false,
    apply: vi.fn(), message: vi.fn() }
}

describe('preprocessing recommendation transactions', () => {
  it('applies a reliable recommendation once and forwards absolute pixel coordinates', async () => {
    const options = fixture()
    const settings = createHudPreprocess({ mode: 'hsv' })
    const recommend = vi.spyOn(wasm, 'recommendHudPreprocess').mockResolvedValue({ settings, reason: null })
    const view = renderHook(() => usePreprocessRecommendation(options))
    await act(async () => view.result.current.recommend('hsv', { x: 10, y: 6 }))
    expect(recommend).toHaveBeenCalledWith(options.frame, options.pack, options.variantId, 'clock', { kind: 'hsv', x: 10, y: 6 })
    expect(options.apply).toHaveBeenCalledOnce()
    expect(options.apply).toHaveBeenCalledWith(settings)
    expect(view.result.current.busy).toBe(false)
    expect(options.message).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('固定') }))
  })

  it('keeps current parameters when polarity is ambiguous', async () => {
    const options = fixture()
    vi.spyOn(wasm, 'recommendHudPreprocess').mockResolvedValue({ settings: null, reason: 'ambiguous-polarity' })
    const view = renderHook(() => usePreprocessRecommendation(options))
    await act(async () => view.result.current.recommend('polarity'))
    expect(options.apply).not.toHaveBeenCalled()
    expect(options.message).toHaveBeenCalledWith({ kind: 'warn', text: expect.stringContaining('参数保持不变') })
  })

  it('does not overwrite newer parameter edits with a late recommendation', async () => {
    const options = fixture()
    let finish!: (result: HudPreprocessRecommendation) => void
    const recommend = vi.spyOn(wasm, 'recommendHudPreprocess').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = renderHook(() => usePreprocessRecommendation(options))
    let first!: Promise<void>
    act(() => { first = view.result.current.recommend('threshold') })
    await act(async () => view.result.current.recommend('threshold'))
    expect(recommend).toHaveBeenCalledOnce()
    options.revision.current++
    await act(async () => { finish({ settings: createHudPreprocess(), reason: null }); await first })
    expect(options.apply).not.toHaveBeenCalled()
    expect(options.message).not.toHaveBeenCalled()
    expect(view.result.current.busy).toBe(false)
  })

  it('ignores work from a previous frame and prevents recommendations while automatic teaching runs', async () => {
    const options = fixture()
    let finish!: (result: HudPreprocessRecommendation) => void
    const recommend = vi.spyOn(wasm, 'recommendHudPreprocess').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = renderHook(current => usePreprocessRecommendation(current), { initialProps: options })
    let first!: Promise<void>
    act(() => { first = view.result.current.recommend('polarity') })
    view.rerender({ ...options, frame: { ...options.frame }, disabled: true })
    await act(async () => { finish({ settings: createHudPreprocess(), reason: null }); await first })
    await act(async () => view.result.current.recommend('polarity'))
    expect(recommend).toHaveBeenCalledOnce()
    expect(options.apply).not.toHaveBeenCalled()
  })
})
