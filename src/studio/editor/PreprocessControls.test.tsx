import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import { createHudPreprocess, type HudPreprocessSettings } from '../../core/hudPreprocess'
import type { GrabbedFrame } from '../../recognition/frameGrabber'
import { fieldModel } from './editorModel'
import { PreprocessControls, type PreprocessControlsProps } from './PreprocessControls'

const putImageData = vi.fn()
beforeEach(() => {
  putImageData.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData: (width: number, height: number): ImageData => ({ width, height,
      data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }),
    putImageData,
  } as unknown as CanvasRenderingContext2D)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function makeFrame(): GrabbedFrame {
  const pixels = new Uint8ClampedArray(8 * 8 * 4)
  for (let index = 0; index < 64; index++) pixels.set([index, index * 3, 255 - index, 64 + index], index * 4)
  return { pixels, width: 8, height: 8, mediaTime: 1, wallTime: 0 }
}

function makeProps(preprocess: Partial<HudPreprocessSettings> = {}, overrides: Partial<PreprocessControlsProps> = {}): PreprocessControlsProps {
  return { profile: { ...fieldModel(createEmptyHudStylePack(), 'clock'),
    preprocess: createHudPreprocess(preprocess), roi: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
  onPatch: vi.fn(), ...overrides }
}

function Controlled(props: PreprocessControlsProps): React.ReactNode {
  const [profile, setProfile] = useState(props.profile)
  return <PreprocessControls {...props} profile={profile} onPatch={update => {
    props.onPatch(update)
    setProfile(current => ({ ...current, ...update }))
  }} />
}

const mode = () => screen.getByRole('combobox', { name: '二值化模式' })
const changeMode = (value: HudPreprocessSettings['mode']) => fireEvent.change(mode(), { target: { value } })
const changeSlider = (name: string, value: number) => fireEvent.change(screen.getByRole('slider', { name }), { target: { value: String(value) } })

describe('preprocessing modes', () => {
  it('shows only mode-specific controls while preserving all inactive settings', () => {
    const settings = createHudPreprocess({ threshold: 193, adaptive: { windowSize: 25, offset: 19 },
      hsv: { hue: 120, tolerance: 20, saturationMin: 0.3, saturationMax: 0.9, valueMin: 0.2, valueMax: 0.8 } })
    const props = makeProps(settings)
    render(<Controlled {...props} />)
    expect(screen.getByRole('slider', { name: '阈值' })).toHaveValue('193')
    expect(screen.getByRole('slider', { name: '对比度' })).toBeVisible()
    expect(screen.queryByRole('slider', { name: '色相' })).not.toBeInTheDocument()
    changeMode('adaptive')
    expect(screen.getByRole('spinbutton', { name: '局部窗口大小' })).toHaveValue(25)
    expect(screen.getByRole('slider', { name: '局部偏移量' })).toHaveValue('19')
    expect(screen.queryByRole('slider', { name: '阈值' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '自动推荐阈值' })).not.toBeInTheDocument()
    changeMode('hsv')
    expect(screen.getByRole('slider', { name: '色相' })).toHaveValue('120')
    expect(screen.queryByRole('slider', { name: '对比度' })).not.toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: '局部窗口大小' })).not.toBeInTheDocument()
    changeMode('gray')
    expect(props.onPatch).toHaveBeenLastCalledWith({ preprocess: settings })
    expect(screen.getByRole('slider', { name: '阈值' })).toHaveValue('193')
  })

  it('patches gray contrast and threshold without dropping nested configuration', () => {
    const props = makeProps()
    render(<Controlled {...props} />)
    changeSlider('对比度', 2.1)
    changeSlider('阈值', 210)
    expect(props.onPatch).toHaveBeenLastCalledWith({ preprocess: createHudPreprocess({ scale: 2.1, threshold: 210 }) })
  })

  it('accepts only odd adaptive windows from 3 through 255 and exposes the offset limits', () => {
    const props = makeProps({ mode: 'adaptive' })
    render(<Controlled {...props} />)
    const windowSize = screen.getByRole('spinbutton', { name: '局部窗口大小' })
    expect(windowSize).toHaveAttribute('min', '3')
    expect(windowSize).toHaveAttribute('max', '255')
    expect(windowSize).toHaveAttribute('step', '2')
    for (const value of ['2', '16', '256', '257', '']) fireEvent.change(windowSize, { target: { value } })
    expect(props.onPatch).not.toHaveBeenCalled()
    fireEvent.change(windowSize, { target: { value: '255' } })
    expect(windowSize).toHaveValue(255)
    const offset = screen.getByRole('slider', { name: '局部偏移量' })
    expect(offset).toHaveAttribute('min', '0')
    expect(offset).toHaveAttribute('max', '128')
    changeSlider('局部偏移量', 128)
    expect(props.onPatch).toHaveBeenLastCalledWith({ preprocess: createHudPreprocess({ mode: 'adaptive', adaptive: { windowSize: 255, offset: 128 } }) })
  })

  it('bounds HSV values and prevents either saturation or brightness range crossing', () => {
    const props = makeProps({ mode: 'hsv' })
    render(<Controlled {...props} />)
    for (const [name, max] of [['色相', '359'], ['色相容差', '180'], ['最低饱和度', '1'], ['最高饱和度', '1'], ['最低明度', '1'], ['最高明度', '1']]) {
      const slider = screen.getByRole('slider', { name })
      expect(slider).toHaveAttribute('min', '0')
      expect(slider).toHaveAttribute('max', max)
    }
    changeSlider('最低饱和度', 0.8)
    changeSlider('最高饱和度', 0.2)
    expect(screen.getByRole('slider', { name: '最高饱和度' })).toHaveValue('0.8')
    changeSlider('最低饱和度', 0.95)
    expect(screen.getByRole('slider', { name: '最低饱和度' })).toHaveValue('0.8')
    changeSlider('最低明度', 0.6)
    changeSlider('最高明度', 0.3)
    expect(screen.getByRole('slider', { name: '最高明度' })).toHaveValue('0.6')
    changeSlider('最低明度', 0.9)
    expect(screen.getByRole('slider', { name: '最低明度' })).toHaveValue('0.6')
  })

  it('resets the entire configuration, including values belonging to inactive modes', () => {
    const props = makeProps({ mode: 'hsv', scale: 2.4, threshold: 50, invert: true,
      adaptive: { windowSize: 31, offset: 25 }, hsv: { hue: 280, tolerance: 45, saturationMin: 0.4, saturationMax: 0.8, valueMin: 0.2, valueMax: 0.9 } })
    render(<Controlled {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(props.onPatch).toHaveBeenLastCalledWith({ preprocess: createHudPreprocess() })
    expect(mode()).toHaveValue('gray')
    expect(screen.getByRole('switch', { name: /反相/ })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeDisabled()
  })

  it.each(['gray', 'adaptive', 'hsv'] as const)('blocks every setting and recommendation while %s is busy', currentMode => {
    const props = makeProps({ mode: currentMode, scale: 2 }, { frame: makeFrame(), busy: true, onRecommend: vi.fn() })
    render(<PreprocessControls {...props} />)
    expect(mode()).toBeDisabled()
    expect(screen.getByRole('switch', { name: /反相/ })).toBeDisabled()
    for (const control of [...screen.getAllByRole('slider'), ...screen.queryAllByRole('spinbutton'), ...screen.getAllByRole('button')])
      expect(control).toBeDisabled()
    changeMode(currentMode === 'gray' ? 'adaptive' : 'gray')
    fireEvent.click(screen.getByRole('button', { name: '自动判断反相' }))
    expect(props.onPatch).not.toHaveBeenCalled()
    expect(props.onRecommend).not.toHaveBeenCalled()
  })
})

describe('frame-based preprocessing recommendations', () => {
  it('dispatches threshold and polarity calculations only for the current frame', () => {
    const props = makeProps({}, { frame: makeFrame(), onRecommend: vi.fn() })
    render(<PreprocessControls {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '自动推荐阈值' }))
    fireEvent.click(screen.getByRole('button', { name: '自动判断反相' }))
    expect(props.onRecommend).toHaveBeenNthCalledWith(1, 'threshold')
    expect(props.onRecommend).toHaveBeenNthCalledWith(2, 'polarity')
    expect(screen.getByText(/结果固定, 不会逐帧跳变/)).toBeVisible()
  })

  it.each(['frame', 'callback'] as const)('disables recommendation when the %s is missing', missing => {
    const props = makeProps({}, { frame: missing === 'frame' ? null : makeFrame(), onRecommend: missing === 'callback' ? undefined : vi.fn() })
    render(<PreprocessControls {...props} />)
    expect(screen.getByRole('button', { name: '自动推荐阈值' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '自动判断反相' })).toBeDisabled()
  })

  it('copies the native RGBA crop without changing the source or showing grayscale', () => {
    const frame = makeFrame()
    const before = [...frame.pixels]
    render(<PreprocessControls {...makeProps({ mode: 'hsv' }, { frame, onRecommend: vi.fn() })} />)
    const canvas = screen.getByRole('img', { name: '原图取色' })
    expect(canvas).toHaveAttribute('width', '4')
    expect(canvas).toHaveAttribute('height', '4')
    const image = putImageData.mock.calls[0]![0] as ImageData
    expect([...image.data.slice(0, 4)]).toEqual([18, 54, 237, 82])
    expect([...image.data.slice(16, 20)]).toEqual([26, 78, 229, 90])
    expect([...frame.pixels]).toEqual(before)
  })

  it('maps a scaled canvas click into full-frame pixels and disarms after a selection', () => {
    const props = makeProps({ mode: 'hsv' }, { frame: makeFrame(), onRecommend: vi.fn() })
    render(<PreprocessControls {...props} />)
    const canvas = screen.getByRole('img', { name: '原图取色' })
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 200, height: 100 } as DOMRect)
    fireEvent.click(canvas, { clientX: 225, clientY: 75 })
    expect(props.onRecommend).not.toHaveBeenCalled()
    const pick = screen.getByRole('button', { name: '从原图取色' })
    fireEvent.click(pick)
    expect(pick).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('点击图标前景取色')).toBeVisible()
    fireEvent.click(canvas, { clientX: 225, clientY: 75 })
    expect(props.onRecommend).toHaveBeenCalledWith('hsv', { x: 4, y: 3 })
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(canvas, { clientX: 225, clientY: 75 })
    expect(props.onRecommend).toHaveBeenCalledTimes(1)
    fireEvent.click(pick)
    fireEvent.click(canvas, { clientX: 1000, clientY: -1000 })
    expect(props.onRecommend).toHaveBeenLastCalledWith('hsv', { x: 5, y: 2 })
  })

  it('cancels an armed color picker when the frame, ROI or busy state changes', () => {
    const props = makeProps({ mode: 'hsv' }, { frame: makeFrame(), onRecommend: vi.fn() })
    const { rerender } = render(<PreprocessControls {...props} />)
    const pick = screen.getByRole('button', { name: '从原图取色' })
    fireEvent.click(pick)
    rerender(<PreprocessControls {...props} frame={makeFrame()} />)
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(pick)
    rerender(<PreprocessControls {...props} profile={{ ...props.profile, roi: { x: 0, y: 0, w: 0.5, h: 0.5 } }} />)
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(pick)
    rerender(<PreprocessControls {...props} busy />)
    expect(pick).toBeDisabled()
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('img', { name: '原图取色' }))
    expect(props.onRecommend).not.toHaveBeenCalled()
  })

  it('asks for a frame rather than rendering a fake color crop', () => {
    render(<PreprocessControls {...makeProps({ mode: 'hsv' }, { onRecommend: vi.fn() })} />)
    expect(screen.queryByRole('img', { name: '原图取色' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '从原图取色' })).toBeDisabled()
    expect(screen.getByText('先取一帧, 再从原图选择前景颜色.')).toBeVisible()
  })
})
