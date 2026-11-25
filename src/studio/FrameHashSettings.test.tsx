import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { primeMediaElement } from '../test/setup'
import { FrameHashSettings, visibleFrameFraction } from './FrameHashSettings'

const canvasContext = {
  drawImage: vi.fn(),
  clearRect: vi.fn(),
}

let session: Session

beforeEach(() => {
  canvasContext.drawImage.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(360)
  vi.stubGlobal('PointerEvent', MouseEvent)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  session = new Session({ createSampler: () => null })
})

afterEach(() => {
  cleanup()
  session.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockRect(element: HTMLElement, width = 640, height = 360): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON() {},
  })
}

function pointer(target: Element, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  fireEvent(target, event)
}

describe('FrameHashSettings visual ROI editor', () => {
  it('draws a crop region on blank drag and commits settings only on pointer release', () => {
    const update = vi.spyOn(session, 'updateSettings')
    render(<SessionProvider session={session}><FrameHashSettings /></SessionProvider>)

    const commentaryStage = screen.getByLabelText('解说裁剪画布')
    const commentaryCrop = screen.getByRole('group', { name: '解说有效区域' })
    mockRect(commentaryStage)

    // Real browser hit-testing lands on the full-screen RoiWindow child first.
    pointer(commentaryCrop, 'pointerdown', 64, 36)
    pointer(commentaryStage, 'pointermove', 384, 252)
    expect(update).not.toHaveBeenCalled()

    pointer(commentaryStage, 'pointerup', 384, 252)
    expect(update).toHaveBeenCalledTimes(1)
    const saved = session.settings.frameHashRegions.commentary
    expect(saved.x).toBeCloseTo(0.1, 2)
    expect(saved.y).toBeCloseTo(0.1, 2)
    expect(saved.w).toBeCloseTo(0.5, 2)
    expect(saved.h).toBeCloseTo(0.6, 2)

    fireEvent.click(screen.getByRole('button', { name: '解说铺满画面' }))
    expect(session.settings.frameHashRegions.commentary).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('synchronizes mask creation, dragging and deletion across both cropped canvases', async () => {
    for (const role of ['official', 'commentary'] as const) {
      await session.loadSource(role, {
        kind: 'progressive', url: `https://example.test/${role}.mp4`,
        input: role, label: role, loop: false, viaProxy: false,
      })
      const video = session.engine.element(role)
      Object.defineProperties(video, {
        videoWidth: { configurable: true, value: 1920 },
        videoHeight: { configurable: true, value: 1080 },
      })
      primeMediaElement(video, { duration: 120, currentTime: 10 })
    }
    session.flush()

    const update = vi.spyOn(session, 'updateSettings')
    render(<SessionProvider session={session}><FrameHashSettings /></SessionProvider>)

    fireEvent.click(screen.getByRole('radio', { name: /^标注忽略区域/ }))
    const commentaryStage = screen.getByLabelText('解说遮罩画布')
    const officialStage = screen.getByLabelText('画面遮罩画布')
    mockRect(commentaryStage)
    mockRect(officialStage)

    pointer(commentaryStage, 'pointerdown', 0, 252)
    pointer(commentaryStage, 'pointermove', 160, 360)
    expect(update).not.toHaveBeenCalled()
    pointer(commentaryStage, 'pointerup', 160, 360)

    expect(update).toHaveBeenCalledTimes(1)
    expect(session.settings.frameHashMasks).toHaveLength(1)
    expect(session.settings.frameHashMasks[0]!.x).toBeCloseTo(0, 2)
    expect(session.settings.frameHashMasks[0]!.y).toBeCloseTo(0.7, 2)
    expect(session.settings.frameHashMasks[0]!.w).toBeCloseTo(0.25, 2)
    expect(session.settings.frameHashMasks[0]!.h).toBeCloseTo(0.3, 2)

    // Both canvases display the shared mask.
    const officialMask = screen.getByRole('group', { name: '画面画布忽略区域 1' })
    const commentaryMask = screen.getByRole('group', { name: '解说画布忽略区域 1' })
    expect(officialMask).toBeInTheDocument()
    expect(commentaryMask).toBeInTheDocument()

    // Dragging the mask on the official canvas moves both sides and commits once.
    update.mockClear()
    pointer(officialMask, 'pointerdown', 40, 280)
    pointer(officialMask, 'pointermove', 104, 280)
    expect(update).not.toHaveBeenCalled()
    pointer(officialMask, 'pointerup', 104, 280)
    expect(update).toHaveBeenCalledTimes(1)
    expect(session.settings.frameHashMasks[0]!.x).toBeCloseTo(0.1, 2)

    // Deleting via keyboard removes the mask from both canvases.
    fireEvent.keyDown(officialMask, { key: 'Delete' })
    expect(session.settings.frameHashMasks).toHaveLength(0)
  })

  it('warns immediately when masks leave less than 25% visible picture and syncs with percentage inputs', () => {
    expect(visibleFrameFraction([{ x: 0, y: 0, w: 1, h: 0.8 }])).toBeLessThan(0.25)

    session.updateSettings({ frameHashMasks: [{ x: 0, y: 0, w: 1, h: 0.82 }] })
    session.flush()
    render(<SessionProvider session={session}><FrameHashSettings /></SessionProvider>)

    expect(screen.getByRole('alert')).toHaveTextContent('忽略区域过大')

    const details = screen.getByText('精确百分比微调').closest('details')!
    details.open = true
    const spin = within(details).getByRole('spinbutton', { name: '画面区域左侧百分比' })
    fireEvent.change(spin, { target: { value: '15' } })
    expect(session.settings.frameHashRegions.official.x).toBeCloseTo(0.15, 2)

    fireEvent.click(screen.getByRole('button', { name: '恢复完整画面' }))
    expect(session.settings.frameHashRegions).toEqual({
      official: { x: 0, y: 0, w: 1, h: 1 },
      commentary: { x: 0, y: 0, w: 1, h: 1 },
    })
    expect(session.settings.frameHashMasks).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
