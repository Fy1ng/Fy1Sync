import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraCropDialog } from './CameraCropDialog'

let video: HTMLVideoElement
vi.mock('../app/SessionContext', () => ({ useSession: () => session }))
const session = { engine: { element: () => video } }
let callbacks: Map<number, VideoFrameRequestCallback>
let sequence = 0
let width = 1280, height = 720, ready = 2
const read = vi.fn(() => ({ data: new Uint8ClampedArray(Math.min(960, width) * Math.round(Math.min(960, width) * height / width) * 4) }))
const draw = vi.fn()
const rough = { x: .02, y: .4, w: .16, h: .2 }

beforeEach(() => {
  vi.useFakeTimers()
  width = 1280; height = 720; ready = 2
  video = document.createElement('video')
  callbacks = new Map()
  Object.defineProperties(video, {
    videoWidth: { get: () => width }, videoHeight: { get: () => height }, readyState: { get: () => ready },
    requestVideoFrameCallback: { value: (callback: VideoFrameRequestCallback) => { callbacks.set(++sequence, callback); return sequence } },
    cancelVideoFrameCallback: { value: (id: number) => callbacks.delete(id) },
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw, getImageData: read, clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
  draw.mockClear(); read.mockClear()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(540)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
async function frame(time: number): Promise<void> {
  await act(async () => {
    const current = [...callbacks.values()]; callbacks.clear()
    current.forEach(callback => callback(performance.now(), { mediaTime: time } as VideoFrameCallbackMetadata))
    await vi.advanceTimersByTimeAsync(410)
  })
}
function mount(tighten = vi.fn(async () => ({ roi: { ...rough, x: .03, w: .15 }, found: [true, false, false, false] }))) {
  return { tighten, ...render(<StrictMode><CameraCropDialog initial={rough} onSave={vi.fn()} onRemove={null} onClose={vi.fn()} tighten={tighten} /></StrictMode>) }
}
async function begin(): Promise<void> {
  await act(async () => { await video.play() })
  fireEvent.click(screen.getByRole('button', { name: '重新收紧' }))
}

describe('camera dialog lifecycle', () => {
  it('StrictMode replay keeps live frame observation and samples six advancing frames', async () => {
    const { tighten, unmount } = mount()
    await begin()
    // Repeated decoded timestamp must not satisfy temporal sampling.
    for (let i = 0; i < 4; i++) await frame(0)
    expect(tighten).not.toHaveBeenCalled()
    for (let i = 1; i <= 5; i++) await frame(i * .5)
    expect(tighten).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('已收紧 1 条边')
    expect(screen.getByRole('button', { name: '保存并显示' })).toBeEnabled()
    unmount()
    expect(callbacks.size).toBe(0)
  })

  it('paused or stalled playback is recoverable without changing playback', async () => {
    const { tighten } = mount()
    fireEvent.click(screen.getByRole('button', { name: '重新收紧' }))
    await act(async () => {})
    expect(screen.getByRole('status')).toHaveTextContent('已暂停')
    expect(video.paused).toBe(true)
    await begin()
    await act(async () => { await vi.advanceTimersByTimeAsync(2800) })
    expect(screen.getByRole('status')).toHaveTextContent('连续视频帧')
    expect(screen.getByRole('button', { name: '重新收紧' })).toBeEnabled()
    expect(tighten).not.toHaveBeenCalled()
  })

  it('readback errors and pause during sampling restore controls', async () => {
    mount()
    read.mockImplementationOnce(() => { throw new Error('readback blocked') })
    await begin()
    await act(async () => {})
    expect(screen.getByRole('status')).toHaveTextContent('readback blocked')
    expect(screen.getByRole('button', { name: '保存并显示' })).toBeEnabled()
    await begin()
    await act(async () => video.pause())
    expect(screen.getByRole('status')).toHaveTextContent('播放状态或画面发生变化')
    expect(screen.getByRole('button', { name: '重新收紧' })).toBeEnabled()
  })

  it('manual edits or source reset discard an in-flight result', async () => {
    let resolve!: (value: { roi: typeof rough; found: boolean[] }) => void
    const tighten = vi.fn(() => new Promise<{ roi: typeof rough; found: boolean[] }>(done => { resolve = done }))
    const { container } = mount(tighten)
    await begin()
    for (let i = 1; i <= 5; i++) await frame(i * .5)
    expect(tighten).toHaveBeenCalledTimes(1)
    // Nudge while an asynchronous WASM load/call is pending.
    fireEvent.keyDown(container.querySelector('.roi-window')!, { key: 'ArrowRight' })
    const before = container.querySelector('.roi-window')!.getAttribute('style')
    await act(async () => resolve({ roi: { x: .5, y: .5, w: .1, h: .1 }, found: [true, true, true, true] }))
    expect(container.querySelector('.roi-window')!.getAttribute('style')).toBe(before)
    expect(screen.getByRole('button', { name: '保存并显示' })).toBeEnabled()
    await begin()
    await act(async () => video.dispatchEvent(new Event('loadstart')))
    expect(screen.getByRole('status')).toHaveTextContent('正在加载')
    expect(screen.getByRole('button', { name: '保存并显示' })).toBeDisabled()
  })

  it('late metadata and resolution changes resize preview but preserve normalized ROI', async () => {
    ready = 0; width = 0; height = 0
    const { container } = mount()
    Object.defineProperties(container.querySelector('.camera-dialog-stage')!, { clientWidth: { value: 960 }, clientHeight: { value: 540 } })
    expect(screen.getByRole('button', { name: '保存并显示' })).toBeDisabled()
    ready = 2; width = 1920; height = 1080
    await act(async () => video.dispatchEvent(new Event('loadeddata')))
    expect(container.querySelector('canvas')).toHaveAttribute('width', '960')
    expect(container.querySelector('.roi-size')).toHaveTextContent('307×216')
    width = 640; height = 480
    await act(async () => video.dispatchEvent(new Event('resize')))
    expect(container.querySelector('canvas')).toHaveAttribute('height', '480')
    expect(container.querySelector('.roi-size')).toHaveTextContent('102×96')
  })

  it('source replacement after sampling cannot apply an old asynchronous result', async () => {
    let resolve!: (value: { roi: typeof rough; found: boolean[] }) => void
    const tighten = vi.fn(() => new Promise<{ roi: typeof rough; found: boolean[] }>(done => { resolve = done }))
    const { container } = mount(tighten)
    await begin()
    for (let i = 1; i <= 5; i++) await frame(i * .5)
    expect(tighten).toHaveBeenCalledTimes(1)
    await act(async () => video.dispatchEvent(new Event('loadstart')))
    await act(async () => resolve({ roi: { x: .5, y: .5, w: .1, h: .1 }, found: [true, true, true, true] }))
    expect(container.querySelector('.roi-window')).toBeNull()
    expect(screen.getByRole('button', { name: '保存并显示' })).toBeDisabled()
    await act(async () => video.dispatchEvent(new Event('loadeddata')))
    expect(container.querySelector('.roi-size')).toHaveTextContent('205×144')
  })

  it('unmount during sampling cancels observers and a new dialog can retry', async () => {
    const first = mount()
    await begin()
    await frame(.5)
    first.unmount()
    expect(callbacks.size).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(first.tighten).not.toHaveBeenCalled()
    const second = mount()
    await begin()
    for (let i = 1; i <= 5; i++) await frame(i * .5)
    expect(second.tighten).toHaveBeenCalledTimes(1)
  })

  it('a found flag without coordinate movement cannot report a tightened edge', async () => {
    mount(vi.fn(async () => ({ roi: rough, found: [true, true, true, true] })))
    await begin()
    for (let i = 1; i <= 5; i++) await frame(i * .5)
    expect(screen.getByRole('status')).toHaveTextContent('保留原取景框')
    expect(screen.getByRole('status')).not.toHaveTextContent('已收紧')
  })
})
