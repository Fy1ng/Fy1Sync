import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { BatchValidationPanel } from './BatchValidationPanel'
import { EMPTY_VALIDATION_STATE, type ValidationField, type ValidationRow, type ValidationState } from './batchValidationTypes'

const field = (text: string, value: number): ValidationField => ({ status: 'read', text, value, confidence: 0.97, reason: null })
function row(index: number, notes: ValidationRow['notes'] = []): ValidationRow {
  return { index, at: 12.5 + index, layout: 'official-top-1440', content: 'live', phase: 'active',
    fields: { clock: field('1:00', 60), scoreLeft: field('4', 4), scoreRight: field('8', 8) },
    cues: { timeout: { status: 'not-matched', score: 0.25, reason: null }, timeoutRight: { status: 'matched', score: 0.99, reason: null } }, notes }
}
function completed(rows: ValidationRow[], phase: ValidationState['phase'] = 'complete'): ValidationState {
  return { ...EMPTY_VALIDATION_STATE, phase, rows,
    run: { packId: 'iem/cs2', packName: 'IEM', packRevision: 8, sourceName: 'validation.mp4', from: 12.5, to: 72.5, step: 1, total: 60 } }
}
function setup(overrides: Partial<React.ComponentProps<typeof BatchValidationPanel>> = {}) {
  const props: React.ComponentProps<typeof BatchValidationPanel> = { duration: 300, mediaTime: 12.5, sourceName: 'validation.mp4',
    state: EMPTY_VALIDATION_STATE, onStart: vi.fn(), onStop: vi.fn(), onInspect: vi.fn(), onJump: vi.fn(), onClose: vi.fn(), ...overrides }
  const view = render(<BatchValidationPanel {...props} />)
  return { props, ...view, update: (next: Partial<typeof props>) => view.rerender(<BatchValidationPanel {...props} {...next} />) }
}

describe('read-only batch validation range', () => {
  it('defaults to the next minute with a half-open one-second range and does not start by itself', () => {
    const { props } = setup()
    expect(screen.getByRole('spinbutton', { name: '验收开始时间' })).toHaveValue(12.5)
    expect(screen.getByRole('spinbutton', { name: '验收结束时间' })).toHaveValue(72.5)
    expect(screen.getByRole('combobox', { name: '验收抽样间隔' })).toHaveValue('1')
    expect(screen.getByText('预计 60 帧')).toBeInTheDocument()
    expect(props.onStart).not.toHaveBeenCalled()
    expect(screen.getByText(/不会保存或修改样本/)).toBeInTheDocument()
    expect(screen.getByText(/读取成功率和置信度不是准确率/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '存为模板' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开始验收' }))
    expect(props.onStart).toHaveBeenCalledWith({ from: 12.5, to: 72.5, step: 1 })
  })

  it('bounds the initial range to the recording and marks positions without reading media', () => {
    const { props, update } = setup({ duration: 40 })
    expect(screen.getByRole('spinbutton', { name: '验收结束时间' })).toHaveValue(40)
    update({ duration: 40, mediaTime: 20.25 })
    fireEvent.click(screen.getByRole('button', { name: '当前位置为开始' }))
    expect(screen.getByRole('spinbutton', { name: '验收开始时间' })).toHaveValue(20.25)
    update({ duration: 40, mediaTime: 29 })
    fireEvent.click(screen.getByRole('button', { name: '当前位置为结束' }))
    fireEvent.change(screen.getByRole('combobox', { name: '验收抽样间隔' }), { target: { value: '0.5' } })
    expect(screen.getByText('预计 18 帧')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开始验收' }))
    expect(props.onStart).toHaveBeenCalledWith({ from: 20.25, to: 29, step: 0.5 })
    fireEvent.click(screen.getByRole('button', { name: '选择全片' }))
    expect(screen.getByRole('spinbutton', { name: '验收开始时间' })).toHaveValue(0)
    expect(screen.getByRole('spinbutton', { name: '验收结束时间' })).toHaveValue(40)
  })

  it('refuses missing media, empty, reversed, out-of-range and oversized intervals', () => {
    const { props, update } = setup({ duration: Number.NaN })
    expect(screen.getByRole('button', { name: '开始验收' })).toBeDisabled()
    expect(screen.getByText(/载入可定位的录像/)).toBeInTheDocument()
    update({ duration: 20_000 })
    const from = screen.getByRole('spinbutton', { name: '验收开始时间' })
    const to = screen.getByRole('spinbutton', { name: '验收结束时间' })
    fireEvent.change(from, { target: { value: '' } })
    expect(screen.getByRole('button', { name: '开始验收' })).toBeDisabled()
    fireEvent.change(from, { target: { value: '100' } })
    fireEvent.change(to, { target: { value: '99' } })
    expect(screen.getByText(/结束时间必须晚于开始时间/)).toBeInTheDocument()
    fireEvent.change(from, { target: { value: '-1' } })
    expect(screen.getByText(/范围必须在 0 到/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '选择全片' }))
    expect(screen.getByText(/本次超过 7200 帧/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始验收' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: '验收抽样间隔' }), { target: { value: '5' } })
    expect(screen.getByText('预计 4000 帧')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始验收' })).toBeEnabled()
    expect(props.onStart).not.toHaveBeenCalled()
  })

  it('accepts exactly 7200 samples and resets range when the recording changes', () => {
    const { update } = setup({ duration: 7200, mediaTime: 0 })
    fireEvent.click(screen.getByRole('button', { name: '选择全片' }))
    expect(screen.getByText('预计 7200 帧')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始验收' })).toBeEnabled()
    update({ duration: 50, mediaTime: 2, sourceName: 'next.mp4' })
    expect(screen.getByRole('spinbutton', { name: '验收开始时间' })).toHaveValue(2)
    expect(screen.getByRole('spinbutton', { name: '验收结束时间' })).toHaveValue(50)
  })
})

describe('batch validation results', () => {
  it('shows snapshot progress and retains partial results after stopping', () => {
    const rows = [row(0, [{ kind: 'issue', target: 'clock', code: 'clock-jump', message: '倒计时疑似跳变' }])]
    const state = completed(rows, 'running')
    const { props, update } = setup({ state })
    expect(screen.getByText(/快照: IEM \/ iem\/cs2 \/ revision 8/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '验收进度' })).toHaveAttribute('value', '1')
    expect(screen.getByRole('status')).toHaveTextContent('正在验收: 1 / 60 帧')
    expect(screen.getByRole('spinbutton', { name: '验收开始时间' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '查看 12.50s 验收结果' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '返回制作' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '停止验收' }))
    expect(props.onStop).toHaveBeenCalledOnce()
    update({ state: { ...state, phase: 'stopped' } })
    expect(screen.getByRole('status')).toHaveTextContent('已停止验收, 已保留部分结果: 1 / 60 帧')
    expect(screen.getByRole('button', { name: '重新验收' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '查看 12.50s 验收结果' }))
    expect(props.onInspect).toHaveBeenCalledWith(0)
    fireEvent.click(screen.getByRole('button', { name: '返回制作' }))
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('separates issues, transitions and normal frames with bounded result pages', () => {
    const rows = Array.from({ length: 123 }, (_, index) => row(index, index < 61
      ? [{ kind: 'issue', target: 'clock', code: 'clock-jump', message: `疑点 ${index}` }]
      : index === 61 ? [{ kind: 'transition', target: 'timeout', code: 'cue-transition', message: '左侧 Timeout 出现' }] : []))
    setup({ state: completed(rows) })
    let list = screen.getByRole('list', { name: '验收结果' })
    expect(within(list).getAllByRole('button')).toHaveLength(50)
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    list = screen.getByRole('list', { name: '验收结果' })
    expect(within(list).getAllByRole('button')).toHaveLength(11)
    expect(within(list).getByRole('button', { name: '查看 62.50s 验收结果' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '状态切换' }))
    expect(within(screen.getByRole('list', { name: '验收结果' })).getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: '验收结果' })).getAllByRole('button')).toHaveLength(50)
  })

  it('shows no-issue uncertainty, per-field rates and absent or disabled counts', () => {
    const rows = [row(0), row(1)]
    rows[1]!.fields.clock = { status: 'absent', text: null, value: null, confidence: null, reason: null }
    for (const value of rows) value.fields.scoreRight = { status: 'disabled', text: null, value: null, confidence: null, reason: null }
    setup({ state: completed(rows) })
    expect(screen.getByText(/当前抽样未发现疑点, 不代表准确率 100%/)).toBeInTheDocument()
    const stats = screen.getByLabelText('验收统计')
    expect(within(stats).getByText('读取成功 1/1')).toBeInTheDocument()
    expect(within(stats).getByText('未出现 1 / 已关闭 0')).toBeInTheDocument()
    expect(within(stats).getByText('读取成功 0/0')).toBeInTheDocument()
    expect(within(stats).getByText('--')).toBeInTheDocument()
    expect(within(stats).getByText(/没有人工真值/)).toBeInTheDocument()
  })

  it('renders full read-only evidence, crops and source-frame navigation', () => {
    const selected = row(4, [{ kind: 'issue', target: 'clock', code: 'clock-jump', message: '倒计时疑似跳变' },
      { kind: 'transition', target: 'timeoutRight', code: 'timeout-start', message: '右侧 Timeout 出现' }])
    selected.phase = 'paused'
    const state = { ...completed([selected]), selectedIndex: 4, preview: { index: 4, at: 16.5, images: [
      { target: 'frame' as const, label: '整帧', url: 'data:image/png;base64,AA==', width: 320, height: 180 },
      { target: 'clock' as const, label: '倒计时', url: 'data:image/png;base64,AA==', width: 80, height: 30 },
    ] } }
    const { props, update } = setup({ state })
    const detail = screen.getByRole('region', { name: '验收帧详情' })
    expect(within(detail).getByText('直播 / 暂停')).toBeInTheDocument()
    expect(within(detail).getByText('1:00 / 置信度 0.970')).toBeInTheDocument()
    expect(within(detail).getByText('出现 / 得分 0.990')).toBeInTheDocument()
    expect(within(detail).getByRole('img', { name: '整帧原始画面' })).toHaveAttribute('src', 'data:image/png;base64,AA==')
    expect(within(detail).getByRole('img', { name: '倒计时原始画面' })).toHaveAttribute('width', '80')
    expect(within(detail).getByRole('list', { name: '当前帧检查记录' }).children).toHaveLength(2)
    fireEvent.click(within(detail).getByRole('button', { name: '回到此帧' }))
    expect(props.onJump).toHaveBeenCalledWith(16.5)
    update({ state: { ...state, previewBusy: true, preview: { ...state.preview, index: 3 } } })
    expect(within(detail).queryByRole('img')).not.toBeInTheDocument()
    expect(within(detail).getByRole('button', { name: '回到此帧' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重新验收' })).toBeDisabled()
    expect(within(detail).getByRole('status')).toHaveTextContent('正在读取原始画面')
  })

  it('reports capture errors without discarding earlier result rows', () => {
    setup({ state: { ...completed([row(0)], 'error'), error: '视频取帧超时' } })
    expect(screen.getByRole('alert')).toHaveTextContent('视频取帧超时')
    expect(screen.getByRole('status')).toHaveTextContent('验收中断, 已保留部分结果: 1 / 60 帧')
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByRole('button', { name: '查看 12.50s 验收结果' })).toBeEnabled()
  })
})
