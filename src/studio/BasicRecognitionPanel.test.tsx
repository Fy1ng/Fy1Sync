import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session, type SessionSnapshot } from '../app/session'
import { BASIC_CLOCK_PROFILE } from '../core/activeProfile'
import type { RoiRect } from '../core/profileSchema'
import type { BasicClockProgress, BasicClockVisualFrame, WorkerDebug } from '../recognition/protocol'
import { primeMediaElement } from '../test/setup'
import { BasicRecognitionPanel } from './BasicRecognitionPanel'
import { BasicRegionSheet } from './BasicRegionSheet'
import { AuthorApp } from '../../scripts/clock-search-authoring/AuthorApp'

const state = vi.hoisted(() => ({ session: null as unknown as Session, snapshot: null as unknown as SessionSnapshot }))
vi.mock('../app/SessionContext', () => ({ useSession: () => state.session, useSessionSnapshot: () => state.snapshot }))

const context = {
  createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height })),
  putImageData: vi.fn(), strokeRect: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn(),
  getImageData: vi.fn(() => ({ data: Uint8ClampedArray.of(12, 14, 18, 255) })), strokeStyle: '', lineWidth: 1,
}
let session: Session
const roi = { x: .1, y: .2, w: .3, h: .1 }
const search = { x: .05, y: .02, w: .9, h: .3 }

beforeEach(() => {
  context.getImageData.mockReset().mockReturnValue({ data: Uint8ClampedArray.of(12, 14, 18, 255) })
  context.putImageData.mockClear(); context.strokeRect.mockClear(); context.drawImage.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480)
  vi.stubGlobal('PointerEvent', MouseEvent)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  session = new Session({ createSampler: () => null })
  Object.assign(session, { setBasicPreviewEnabled: vi.fn(), setBasicClockRoi: vi.fn() })
  state.session = session
  state.snapshot = { ...session.snapshot, settings: { ...session.settings, recognitionMode: 'basic', basicClockRoi: null },
    basicProgress: { official: null, commentary: null } }
})
afterEach(() => { cleanup(); session.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function ready(width = 1280, height = 720) {
  const video = session.engine.element('official')
  Object.defineProperties(video, { videoWidth: { configurable: true, value: width }, videoHeight: { configurable: true, value: height } })
  video.src = 'blob:app://app/first'
  primeMediaElement(video, { duration: 100, currentTime: 5 })
  const descriptor = { kind: 'file' as const, url: video.src, input: 'first.mp4', label: '本地测试', loop: false, viaProxy: false }
  state.snapshot = { ...state.snapshot, media: { ...state.snapshot.media, official: { ...state.snapshot.media.official, status: 'ready', descriptor } } }
  vi.spyOn(session, 'snapshot', 'get').mockImplementation(() => state.snapshot)
  return video
}

function progress(overrides: Partial<BasicClockVisualFrame['diagnostic']> = {}, debug: WorkerDebug | null = null): BasicClockProgress {
  const visual: BasicClockVisualFrame = { diagnostic: { status: 'searching', mode: 'auto',
    preview: { width: 2, height: 2, data: Uint8Array.of(0, 255, 128, 64) }, candidates: [roi], mediaTime: 5.2, ...overrides },
  debug, frameIndex: 8, receivedAt: Date.now() }
  return { ...visual, visual }
}

function binaryDebug(): WorkerDebug {
  return { roiPixels: { x: 10, y: 20, width: 2, height: 2 }, binary: { width: 2, height: 2, data: Uint8Array.of(0, 255, 255, 0) },
    boxes: [{ x: 1, y: 0, width: 1, height: 2, ink: 2 }], projection: [0, 2], inkRatio: .5,
    normalized: [], matches: [{ char: '1', score: .94, runnerUpScore: .55, sampleIndex: 0 }] }
}

describe('共享基础识别侧栏', () => {
  it('首帧尚未可读时保持禁用确认, 下一绘制帧完成后才允许提交', async () => {
    let paint: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { paint = callback; return 1 })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    context.getImageData.mockReturnValueOnce({ data: Uint8ClampedArray.of(0, 0, 0, 0) })
    ready()
    render(<BasicRecognitionPanel />)
    fireEvent.click(screen.getByRole('button', { name: '框选倒计时' }))
    await waitFor(() => expect(context.getImageData).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: '使用此范围' })).toBeDisabled()
    act(() => paint?.(performance.now()))
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此范围' })).toBeEnabled())
  })

  it('绘制真实灰度像素及候选和寻找区间, 折叠及卸载停止调试图', () => {
    ready()
    state.snapshot.basicProgress.official = progress()
    state.snapshot.profiles.official = { ...BASIC_CLOCK_PROFILE, searchRoi: search }
    const view = render(<BasicRecognitionPanel />)
    expect(session.setBasicPreviewEnabled).toHaveBeenLastCalledWith(true)
    const card = screen.getByRole('article', { name: '官方画面基础识别' })
    expect(within(card).getByRole('status')).toHaveTextContent('正在寻找倒计时')
    expect(within(card).getByLabelText('官方画面寻找预览')).toBeInTheDocument()
    const pixels = context.putImageData.mock.calls[0]![0] as ImageData
    expect([...pixels.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 64, 64, 64, 255])
    expect(context.strokeRect).toHaveBeenCalledWith(.2, .4, .6, .2)
    expect(context.strokeRect).toHaveBeenCalledWith(.1, .04, 1.8, .6)
    expect(screen.getByText(/自动寻找区间由内置生产配置固定/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '基础识别' }))
    expect(session.setBasicPreviewEnabled).toHaveBeenLastCalledWith(false)
    view.unmount()
    expect(session.setBasicPreviewEnabled).toHaveBeenLastCalledWith(false)
  })

  it('无图消息只更新真实状态和计数, 不擦掉二值图或混用新读数时间', () => {
    ready()
    const value = progress({ status: 'locked', text: '1:39', threshold: 180 }, binaryDebug())
    state.snapshot.basicProgress.official = value
    const view = render(<BasicRecognitionPanel />)
    const card = screen.getByRole('article', { name: '官方画面基础识别' })
    const canvas = within(card).getByLabelText('官方画面二值化结果')
    const draws = context.putImageData.mock.calls.length
    state.snapshot.basicProgress.official = { ...value, diagnostic: { status: 'searching', mode: 'auto', text: '0:01', mediaTime: 9 },
      debug: null, frameIndex: 10, receivedAt: Date.now(), sync: { readings: 7, jumps: 2, lastDrop: 'not-decrement' } }
    view.rerender(<BasicRecognitionPanel />)
    expect(within(card).getByLabelText('官方画面二值化结果')).toBe(canvas)
    expect(context.putImageData.mock.calls.length).toBe(draws)
    expect(within(card).getByLabelText('官方画面识别读数')).toHaveTextContent('1:39')
    expect(within(card).getByText(/上次采样 5.20s, 阈值 180/)).toBeInTheDocument()
    expect(within(card).getByText(/有效读数 7, 跳秒 2, 读数未按秒递减/)).toBeInTheDocument()
  })

  it('新的寻找预览不替换最后完整二值快照, 清空数据后才清空图像', () => {
    ready()
    state.snapshot.basicProgress.official = progress({ status: 'locked', text: '1:39' }, binaryDebug())
    const view = render(<BasicRecognitionPanel />)
    const card = screen.getByRole('article', { name: '官方画面基础识别' })
    const canvas = within(card).getByLabelText('官方画面二值化结果')
    state.snapshot.basicProgress.official = progress({ status: 'searching', text: '0:02', mediaTime: 8 })
    view.rerender(<BasicRecognitionPanel />)
    expect(within(card).getByLabelText('官方画面二值化结果')).toBe(canvas)
    expect(within(card).getByLabelText('官方画面识别读数')).toHaveTextContent('1:39')
    state.snapshot.basicProgress.official = null
    view.rerender(<BasicRecognitionPanel />)
    expect(within(card).queryByLabelText('官方画面二值化结果')).not.toBeInTheDocument()
  })

  it('手动和记忆范围固定显示二值区域, 不在整帧和二值图之间切换', () => {
    ready()
    state.snapshot.settings.basicClockRoi = roi
    state.snapshot.basicProgress.official = progress({ mode: 'manual' })
    const view = render(<BasicRecognitionPanel />)
    const card = screen.getByRole('article', { name: '官方画面基础识别' })
    expect(within(card).getByText('手动范围')).toBeInTheDocument()
    expect(within(card).queryByLabelText('官方画面寻找预览')).not.toBeInTheDocument()
    expect(within(card).getByText('等待此范围的二值结果')).toBeInTheDocument()
    state.snapshot.settings.basicClockRoi = null
    state.snapshot.profiles.official = { ...BASIC_CLOCK_PROFILE, roi, roiOrigin: 'memory' }
    state.snapshot.basicProgress.official = progress({ mode: 'memory' })
    view.rerender(<BasicRecognitionPanel />)
    const remembered = screen.getByRole('article', { name: '官方画面基础识别' })
    expect(within(remembered).getByText('记忆范围')).toBeInTheDocument()
    expect(within(remembered).queryByLabelText('官方画面寻找预览')).not.toBeInTheDocument()
  })

  it('共享操作只出现一次, 生产寻找区间只读且没有编辑或恢复入口', () => {
    ready()
    state.snapshot.settings.basicClockRoi = roi
    state.snapshot.profiles.official = { ...BASIC_CLOCK_PROFILE, searchRoi: search }
    render(<BasicRecognitionPanel />)
    expect(screen.getAllByRole('button', { name: '框选倒计时' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '框选倒计时' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '设置寻找区间' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复全画面寻找' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '自动重新寻找' }))
    expect(session.setBasicClockRoi).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('官方流未就绪时禁用框选, 样式包模式不显示面板', () => {
    const view = render(<BasicRecognitionPanel />)
    expect(screen.getByRole('button', { name: '框选倒计时' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '设置寻找区间' })).not.toBeInTheDocument()
    state.snapshot = { ...state.snapshot, settings: { ...state.snapshot.settings, recognitionMode: 'style-pack' } }
    view.rerender(<BasicRecognitionPanel />)
    expect(screen.queryByRole('region', { name: '基础识别' })).not.toBeInTheDocument()
    expect(session.setBasicPreviewEnabled).toHaveBeenLastCalledWith(false)
  })

  async function openRegion(initial: RoiRect = roi, width = 1280, height = 720) {
    const video = ready(width, height)
    state.snapshot.settings.basicClockRoi = initial
    render(<BasicRecognitionPanel />)
    fireEvent.click(screen.getByRole('button', { name: '框选倒计时' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此范围' })).toBeEnabled())
    return video
  }

  it('一次提交共享比例范围, 使用官方原始分辨率单帧且不暂停或移动播放', async () => {
    const video = await openRegion()
    const pause = vi.spyOn(video, 'pause'), before = video.currentTime
    fireEvent.keyDown(screen.getByRole('group', { name: /识别区域/ }), { key: 'ArrowRight' })
    fireEvent.click(screen.getByRole('button', { name: '使用此范围' }))
    expect(session.setBasicClockRoi).toHaveBeenCalledExactlyOnceWith({ ...roi, x: roi.x + 1 / 1280 })
    expect(pause).not.toHaveBeenCalled()
    expect(video.currentTime).toBe(before)
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720)
  })

  it('制作工具可以在无Session上下文的通用Sheet中确认草稿', async () => {
    const video = ready()
    const save = vi.fn(), close = vi.fn()
    render(<BasicRegionSheet video={video} sourceToken="sample" initial={search} title="生产自动寻找区间" saveLabel="使用此区间"
      onSave={save} onClose={close} instructions="确认制作草稿." />)
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此区间' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '使用此区间' }))
    expect(save).toHaveBeenCalledExactlyOnceWith(search)
    expect(close).toHaveBeenCalledOnce()
    expect(session.setBasicClockRoi).not.toHaveBeenCalled()
  })

  it('admin同款聚焦和滚轮缩放不会改变比例范围, 原始4K像素保留', async () => {
    const clock = { x: .48, y: .04, w: .03, h: .03 }
    await openRegion(clock, 3840, 2160)
    const canvas = screen.getByLabelText('官方画面当前帧') as HTMLCanvasElement
    expect(canvas.width).toBe(3840); expect(canvas.height).toBe(2160)
    const initial = canvas.style.width
    fireEvent.click(screen.getByRole('button', { name: '放大到当前框' }))
    expect(screen.getByLabelText('画面缩放')).toHaveTextContent('4.00x')
    expect(canvas.style.width).not.toBe(initial)
    const host = canvas.closest('.editor-stage')!
    fireEvent.wheel(host, { deltaY: 50, clientX: 400, clientY: 200 })
    fireEvent.click(screen.getByRole('button', { name: '适应窗口' }))
    expect(canvas.style.width).toBe(initial)
    fireEvent.click(screen.getByRole('button', { name: '使用此范围' }))
    expect(session.setBasicClockRoi).toHaveBeenCalledExactlyOnceWith(clock)
  })

  it('放大后的空白拖动只平移视图, 不意外重画比例范围', async () => {
    await openRegion()
    fireEvent.click(screen.getByRole('button', { name: '放大到当前框' }))
    const stage = screen.getByLabelText('编辑画面')
    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(stage, { clientX: 170, clientY: 150 })
    fireEvent.pointerUp(stage)
    fireEvent.click(screen.getByRole('button', { name: '使用此范围' }))
    expect(session.setBasicClockRoi).toHaveBeenCalledExactlyOnceWith(roi)
  })

  it('取消框选不修改任何范围', async () => {
    await openRegion()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '倒计时范围 (两路共用)' })).not.toBeInTheDocument()
    expect(session.setBasicClockRoi).not.toHaveBeenCalled()
  })

  it('适应窗口后可拖出新比例框, 不与放大平移冲突', async () => {
    await openRegion()
    fireEvent.click(screen.getByRole('button', { name: '放大到当前框' }))
    fireEvent.click(screen.getByRole('button', { name: '重新绘制' }))
    const canvas = screen.getByLabelText('官方画面当前帧'), surface = canvas.parentElement!
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 960, height: 480, right: 960, bottom: 480, x: 0, y: 0, toJSON() {} })
    const pointer = (type: string, x: number, y: number): void => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      fireEvent(canvas, event)
    }
    pointer('pointerdown', 53.333333333333314 + 853.3333333333334 * .1, 96)
    pointer('pointermove', 480, 240); pointer('pointerup', 480, 240)
    fireEvent.click(screen.getByRole('button', { name: '使用此范围' }))
    const saved = vi.mocked(session.setBasicClockRoi).mock.calls[0]![0]!
    expect(saved.x).toBeCloseTo(.1); expect(saved.y).toBeCloseTo(.2)
    expect(saved.w).toBeCloseTo(.4); expect(saved.h).toBeCloseTo(.3)
  })

  it('官方源事件使截图失效, 必须重新取帧才能提交', async () => {
    const video = await openRegion()
    act(() => video.dispatchEvent(new Event('loadstart')))
    expect(screen.getByRole('button', { name: '使用此范围' })).toBeDisabled()
    expect(screen.getByText(/片源或画面尺寸已改变/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新取帧' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此范围' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '使用此范围' }))
    expect(session.setBasicClockRoi).toHaveBeenCalledExactlyOnceWith(roi)
  })

  it('即使尚未收到事件也拒绝向已更换尺寸的官方画面提交旧选区', async () => {
    const video = await openRegion()
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 })
    fireEvent.click(screen.getByRole('button', { name: '使用此范围' }))
    expect(session.setBasicClockRoi).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '使用此范围' })).toBeDisabled()
  })

  it('独立框选Sheet按当前sourceToken拒绝旧截图, 不需要Session上下文', async () => {
    const video = ready(), save = vi.fn(), close = vi.fn()
    const props = { video, initial: search, title: '制作区间', saveLabel: '使用此区间', instructions: '制作草稿.', onSave: save, onClose: close }
    const view = render(<BasicRegionSheet {...props} sourceToken="first" />)
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此区间' })).toBeEnabled())
    view.rerender(<BasicRegionSheet {...props} sourceToken="second" />)
    expect(screen.getByRole('button', { name: '使用此区间' })).toBeDisabled()
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重新取帧' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此区间' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '使用此区间' }))
    expect(save).toHaveBeenCalledExactlyOnceWith(search)
  })
})

describe('一次性生产区间工具前端', () => {
  it('正常已配置启动只读, 没有修改或解锁按钮', async () => {
    const save = vi.fn()
    vi.stubGlobal('clockSearchAuthor', { getState: vi.fn().mockResolvedValue({ config: { schemaVersion: 1, configured: true, roi: search }, writable: false, configPath: 'test/basic-search.json' }), save })
    render(<AuthorApp />)
    expect(await screen.findByText('只读配置')).toBeInTheDocument()
    expect(screen.getByText(/通过制作命令的 --reset/)).toBeInTheDocument()
    expect(screen.queryByLabelText('选择样例录像')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '框选生产寻找区间' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '写入生产配置' })).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it('--reset授权以writable为准, 已configured仍可重新制作且不会自动写入', async () => {
    const save = vi.fn()
    vi.stubGlobal('clockSearchAuthor', { getState: vi.fn().mockResolvedValue({ config: { schemaVersion: 1, configured: true, roi: search }, writable: true, configPath: 'test/basic-search.json' }), save })
    render(<AuthorApp />)
    expect(await screen.findByText('重新制作')).toBeInTheDocument()
    expect(screen.getByLabelText('选择样例录像')).toBeEnabled()
    expect(screen.getByRole('button', { name: '框选生产寻找区间' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '写入生产配置' })).toBeDisabled()
    expect(save).not.toHaveBeenCalled()
  })
})
