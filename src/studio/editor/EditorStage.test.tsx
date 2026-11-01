import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import { fieldModel, patchField } from './editorModel'
import { EditorStage } from './EditorStage'
import { RoiWindow } from './RoiWindow'

const mediaSize = { width: 3840, height: 2160 }
const roi = { x: 1850 / 3840, y: 96 / 2160, w: 116 / 3840, h: 64 / 2160 }
afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1100)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
  vi.stubGlobal('PointerEvent', MouseEvent)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

function Stage({ material = 'first.png', layout = 'top', field = 'clock' }) {
  return <EditorStage mediaSize={mediaSize} roi={roi} resetKey={`${material}/${layout}`} enabled hidden={false}>
    {rect => <div data-testid="picture" data-field={field} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />}
  </EditorStage>
}

describe('editor stage interactions', () => {
  it('focuses, pans blank space, resets by button and double-click, and keeps field changes zoomed', () => {
    const { container, rerender } = render(<Stage />)
    const stage = container.querySelector('.editor-stage')!
    const picture = screen.getByTestId('picture')
    const initial = picture.getAttribute('style')
    fireEvent.click(screen.getByText('放大到当前框'))
    expect(screen.getByLabelText('画面缩放')).toHaveTextContent('4.00x')
    const focused = picture.getAttribute('style')
    rerender(<Stage field="scoreLeft" />)
    expect(picture.getAttribute('style')).toBe(focused)
    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(stage, { clientX: 180, clientY: 130 })
    fireEvent.pointerUp(stage)
    expect(Number.parseFloat(picture.style.left)).toBeCloseTo(1100 / 2 - 1908 * 4 + 80)
    expect(Number.parseFloat(picture.style.top)).toBeCloseTo(700 / 2 - 128 * 4 + 30)
    fireEvent.doubleClick(stage)
    expect(picture.getAttribute('style')).toBe(initial)
    fireEvent.click(screen.getByText('放大到当前框'))
    fireEvent.click(screen.getByText('适应窗口'))
    expect(picture.getAttribute('style')).toBe(initial)
    fireEvent.wheel(stage, { deltaY: -300, clientX: 550, clientY: 350 })
    expect(picture.getAttribute('style')).not.toBe(initial)
  })

  it('resets when replacing footage or switching layout and never resurrects an old view', () => {
    const { rerender } = render(<Stage />)
    fireEvent.click(screen.getByText('放大到当前框'))
    rerender(<Stage material="second.png" />)
    expect(screen.getByLabelText('画面缩放')).toHaveTextContent('0.29x')
    rerender(<Stage />)
    expect(screen.getByLabelText('画面缩放')).toHaveTextContent('0.29x')
    fireEvent.click(screen.getByText('放大到当前框'))
    rerender(<Stage layout="bottom" />)
    expect(screen.getByLabelText('画面缩放')).toHaveTextContent('0.29x')
  })
})

describe('zoomed native ROI edits', () => {
  it('preserves sub-one-percent native regions and clamps resizing to one native pixel', () => {
    const change = vi.fn()
    const { container } = render(<RoiWindow roi={{ x: 100 / 3840, y: 50 / 2160, w: 11 / 3840, h: 9 / 2160 }}
      videoWidth={3840} videoHeight={2160} contentBox={{ x: -300, y: -100, width: 15360, height: 8640 }} onChange={change} />)
    const region = container.querySelector('.roi-window')!
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(change).toHaveBeenLastCalledWith({ x: 101 / 3840, y: 50 / 2160, w: 11 / 3840, h: 9 / 2160 })
    fireEvent.keyDown(region, { key: 'ArrowUp', altKey: true, shiftKey: true })
    expect(change.mock.lastCall![0].h * 2160).toBe(1)
  })

  it('exports native pixels after drag, resize and 1/10px nudges at different display scales', () => {
    let exported = createEmptyHudStylePack('test/zoom', '缩放测试', mediaSize)
    exported.variants[0]!.fields.clock!.roi = { x: 1850, y: 96, w: 116, h: 64 }
    function Editable({ scale }: { scale: number }) {
      const [pack, setPack] = useState(exported)
      return <RoiWindow roi={fieldModel(pack, 'clock').roi} videoWidth={3840} videoHeight={2160}
        contentBox={{ x: -7000, y: -100, width: 3840 * scale, height: 2160 * scale }}
        onChange={next => { exported = patchField(pack, 'clock', { roi: next }); setPack(exported) }} />
    }
    const { container, rerender } = render(<Editable scale={4} />)
    const region = container.querySelector('.roi-window')!
    const handle = container.querySelector('[data-handle="se"]')!
    fireEvent.pointerDown(handle, { button: 0, clientX: 400, clientY: 200 })
    fireEvent.pointerMove(handle, { clientX: 448, clientY: 232 })
    fireEvent.pointerUp(handle)
    expect(exported.variants[0]!.fields.clock!.roi).toEqual({ x: 1850, y: 96, w: 128, h: 72 })
    fireEvent.pointerDown(region, { button: 0, clientX: 400, clientY: 200 })
    fireEvent.pointerMove(region, { clientX: 440, clientY: 180 })
    fireEvent.pointerUp(region)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    fireEvent.keyDown(region, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(region, { key: 'ArrowRight', altKey: true })
    expect(exported.variants[0]!.fields.clock!.roi).toEqual({ x: 1861, y: 101, w: 129, h: 72 })
    rerender(<Editable scale={0.29} />)
    fireEvent.keyDown(region, { key: 'ArrowLeft' })
    expect(exported.variants[0]!.fields.clock!.roi.x).toBe(1860)
    expect(exported.variants[0]!.fields.clock!.roi.w).toBe(129)
  })
})
