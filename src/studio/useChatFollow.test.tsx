import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatFollow } from './useChatFollow'

let geometry: { top: number; height: number; viewport: number; width: number }
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let resize: ResizeObserverCallback | null
const port = { scrollToEnd: vi.fn(), cancelScroll: vi.fn() }
function Fixture({ total = 40, count = 40, room = '288016' }: { total?: number; count?: number; room?: string }) {
  const node = useRef<HTMLDivElement>(null)
  const follow = useChatFollow(node, port, total, count, room)
  return <>
    <div ref={node} role="log" tabIndex={0} onScroll={follow.onScroll} />
    <output aria-label="未读">{follow.unread}</output>
    <button onClick={follow.jump}>回到底部</button>
  </>
}
function flushFrames() {
  act(() => {
    const queued = [...frames.values()]
    frames.clear()
    for (const run of queued) run(0)
  })
}
function scroll(top: number) {
  act(() => { geometry.top = top; fireEvent.scroll(screen.getByRole('log')) })
}
beforeEach(() => {
  geometry = { top: 600, height: 1200, viewport: 600, width: 320 }
  frames = new Map(); nextFrame = 0; resize = null
  port.scrollToEnd.mockReset().mockImplementation(() => { geometry.top = Math.max(0, geometry.height - geometry.viewport) })
  port.cancelScroll.mockReset()
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => geometry.top)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => geometry.height)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => geometry.viewport)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => geometry.width)
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => { frames.set(++nextFrame, run); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class { constructor(run: ResizeObserverCallback) { resize = run } observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('chat follow intent', () => {
  it('keeps following after resize scroll events arrive before the row measurements settle', () => {
    const view = render(<Fixture />)
    geometry.viewport = 400
    fireEvent.scroll(screen.getByRole('log'))
    geometry.height = 1450
    view.rerender(<Fixture total={45} count={45} />)
    flushFrames()
    expect(geometry.top).toBe(1050)
    expect(screen.getByLabelText('未读')).toHaveTextContent('0')
    geometry.height += 300
    view.rerender(<Fixture total={50} count={50} />)
    expect(geometry.top).toBe(1350)
  })

  it('pins variable-height remeasurements and fixed-count trim updates without new unread messages', () => {
    const view = render(<Fixture total={2000} count={2000} />)
    geometry.height += 40
    view.rerender(<Fixture total={2001} count={2000} />)
    expect(geometry.top).toBe(640)
    geometry.width = 260; geometry.height += 160
    view.rerender(<Fixture total={2001} count={2000} />)
    expect(geometry.top).toBe(800)
    expect(screen.getByLabelText('未读')).toHaveTextContent('0')
  })

  it('pauses before a small upward wheel scroll and does not follow its delayed bottom echo', () => {
    const view = render(<Fixture />)
    fireEvent.wheel(screen.getByRole('log'), { deltaY: -20 })
    fireEvent.scroll(screen.getByRole('log'))
    scroll(580)
    geometry.height += 90
    view.rerender(<Fixture total={43} count={43} />)
    flushFrames()
    expect(port.cancelScroll).toHaveBeenCalledOnce()
    expect(geometry.top).toBe(580)
    expect(screen.getByLabelText('未读')).toHaveTextContent('3')
    fireEvent.click(screen.getByRole('button'))
    expect(geometry.top).toBe(690)
    expect(screen.getByLabelText('未读')).toHaveTextContent('0')
    geometry.height += 30
    view.rerender(<Fixture total={44} count={44} />)
    expect(geometry.top).toBe(720)
  })

  it('treats an external scrollbar move as reading, but End restores persistent following', () => {
    const view = render(<Fixture />)
    scroll(300)
    expect(port.cancelScroll).toHaveBeenCalledOnce()
    geometry.height += 60
    view.rerender(<Fixture total={42} count={42} />)
    expect(geometry.top).toBe(300)
    expect(screen.getByLabelText('未读')).toHaveTextContent('2')
    fireEvent.keyDown(screen.getByRole('log'), { key: 'End' })
    expect(geometry.top).toBe(660)
    expect(screen.getByLabelText('未读')).toHaveTextContent('0')
  })

  it('cancels both an unfinished end command and queued follow restoration before the next frame', () => {
    const view = render(<Fixture />)
    geometry.height += 30
    view.rerender(<Fixture total={41} count={41} />)
    expect(port.scrollToEnd).toHaveBeenCalledOnce()
    fireEvent.scroll(screen.getByRole('log'))
    expect(frames.size).toBe(1)
    scroll(300)
    expect(port.cancelScroll).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
    geometry.height += 30
    view.rerender(<Fixture total={42} count={42} />)
    flushFrames()
    expect(port.scrollToEnd).toHaveBeenCalledOnce()
    expect(geometry.top).toBe(300)
    expect(screen.getByLabelText('未读')).toHaveTextContent('1')
  })

  it('does not resume following when a reflow temporarily clamps a reader to the bottom', () => {
    const view = render(<Fixture />)
    scroll(300)
    geometry.height = 900
    fireEvent.scroll(screen.getByRole('log'))
    geometry.height = 1230
    view.rerender(<Fixture total={41} count={41} />)
    flushFrames()
    expect(port.scrollToEnd).not.toHaveBeenCalled()
    expect(geometry.top).toBe(300)
    expect(screen.getByLabelText('未读')).toHaveTextContent('1')
    scroll(630)
    expect(screen.getByLabelText('未读')).toHaveTextContent('0')
    geometry.height += 30
    view.rerender(<Fixture total={42} count={42} />)
    expect(geometry.top).toBe(660)
  })
  it('ignores repeated bottom echoes even after a committed layout stores the clamped position', () => {
    const view = render(<Fixture />)
    scroll(300)
    geometry.height = 900
    fireEvent.scroll(screen.getByRole('log'))
    view.rerender(<Fixture total={41} count={41} />)
    fireEvent.scroll(screen.getByRole('log'))
    fireEvent.scroll(screen.getByRole('log'))
    geometry.height = 1230
    view.rerender(<Fixture total={42} count={42} />)
    flushFrames()
    expect(port.scrollToEnd).not.toHaveBeenCalled()
    expect(geometry.top).toBe(300)
    expect(screen.getByLabelText('未读')).toHaveTextContent('2')
    fireEvent.keyDown(screen.getByRole('log'), { key:'End' })
    expect(geometry.top).toBe(630)
  })
  it('resumes after an explicit downward key at a clamped end', () => {
    const view = render(<Fixture />)
    scroll(300)
    geometry.height = 900
    fireEvent.scroll(screen.getByRole('log'))
    view.rerender(<Fixture total={41} count={41} />)
    fireEvent.keyDown(screen.getByRole('log'), { key:'ArrowDown' })
    expect(screen.getByLabelText('未读')).toHaveTextContent('0')
    geometry.height = 1230
    view.rerender(<Fixture total={42} count={42} />)
    expect(geometry.top).toBe(630)
  })
  it('waits for a scrollbar or middle-button drag to finish before following the end', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const view = render(<Fixture />)
    fireEvent.pointerDown(screen.getByRole('log'), { button:1 })
    scroll(300)
    view.rerender(<Fixture total={41} count={41} />)
    scroll(600)
    expect(screen.getByLabelText('未读')).toHaveTextContent('1')
    fireEvent.pointerUp(window, { button:1 })
    expect(screen.getByLabelText('未读')).toHaveTextContent('0')
    geometry.height += 30
    view.rerender(<Fixture total={42} count={42} />)
    expect(geometry.top).toBe(630)
  })

  it('does not move a reader during a viewport resize, and cleans queued work on unmount', () => {
    const view = render(<Fixture />)
    fireEvent.keyDown(screen.getByRole('log'), { key: 'PageUp' })
    scroll(100)
    act(() => { geometry.viewport = 400; resize?.([], {} as ResizeObserver) })
    flushFrames()
    expect(geometry.top).toBe(100)
    act(() => resize?.([], {} as ResizeObserver))
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
  })

  it('resets unread and follows a different room rather than preserving the old room anchor', () => {
    const view = render(<Fixture />)
    scroll(200)
    view.rerender(<Fixture total={43} count={43} />)
    expect(screen.getByLabelText('未读')).toHaveTextContent('3')
    view.rerender(<Fixture total={44} count={1} room="huya:660000" />)
    expect(screen.getByLabelText('未读')).toHaveTextContent('0')
    expect(geometry.top).toBe(600)
  })
})
