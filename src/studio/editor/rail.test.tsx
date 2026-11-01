import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import { DEFAULT_PREPROCESS } from '../../core/profileSchema'
import { fieldModel, type EditorClockModel } from './editorModel'
import { BinarizeSection, GlyphSection, ParamsSection } from './rail'

afterEach(cleanup)

type GlyphProps = React.ComponentProps<typeof GlyphSection>

function glyphProps(overrides: Partial<GlyphProps> = {}): GlyphProps {
  return {
    profile: fieldModel(createEmptyHudStylePack(), 'clock'),
    readiness: { ready: false, missing: ['2', '3'], sampleCount: 4 },
    boxes: Array.from({ length: 4 }, (_, index) => ({ x: index * 8, y: 0, width: 4, height: 8, ink: 16 })),
    selected: 0,
    bounds: { width: 32, height: 8 },
    onBoxes: vi.fn(), onAssign: vi.fn(),
    onVerify: vi.fn(), recognized: null,
    reading: '0:19', onUndo: null, busy: false,
    ...overrides,
  }
}

function BinarizeHarness(): React.ReactNode {
  const [profile, setProfile] = useState(() => fieldModel(createEmptyHudStylePack(), 'clock'))
  const patch = (update: Partial<EditorClockModel>) => setProfile(current => ({ ...current, ...update }))
  return <><BinarizeSection profile={profile} onPatch={patch} /><ParamsSection profile={profile} onPatch={patch} /></>
}

function disclosure(title: string) {
  const summary = screen.getByRole('heading', { name: title }).closest('summary')!
  return { summary, details: summary.parentElement! }
}

describe('editor rail disclosures', () => {
  it('starts binarization expanded and preserves settings across collapse and reset', async () => {
    const { container } = render(<BinarizeHarness />)
    const { summary, details } = disclosure('二值化')
    const threshold = screen.getByRole('slider', { name: '阈值' })
    expect(details).toHaveAttribute('open')
    expect(summary.querySelector('button')).toBeNull()
    expect(container.querySelectorAll('details.rail-more > summary')).toHaveLength(1)
    fireEvent.change(threshold, { target: { value: '90' } })
    fireEvent.click(screen.getByRole('switch', { name: /反相/ }))
    fireEvent.click(summary)
    await waitFor(() => expect(details).not.toHaveAttribute('open'))
    expect(threshold).not.toBeVisible()
    expect(threshold).toHaveValue('90')
    fireEvent.click(summary)
    await waitFor(() => expect(threshold).toBeVisible())
    expect(screen.getByRole('switch', { name: /反相/ })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(threshold).toHaveValue(String(DEFAULT_PREPROCESS.threshold))
    expect(screen.getByRole('switch', { name: /反相/ })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeDisabled()
  })

  it('keeps the glyph count visible and the read-only output current when collapsed', async () => {
    const props = glyphProps()
    const { rerender } = render(<GlyphSection {...props} />)
    const { summary, details } = disclosure('字符')
    const reading = screen.getByLabelText('当前读数')
    expect(details).toHaveAttribute('open')
    fireEvent.click(summary)
    await waitFor(() => expect(details).not.toHaveAttribute('open'))
    expect(reading).not.toBeVisible()
    expect(summary).toHaveTextContent('4 个样本')
    expect(summary).toBeVisible()
    rerender(<GlyphSection {...props} reading="1:28" />)
    expect(reading).toHaveTextContent('1:28')
    expect(details).not.toHaveAttribute('open')
    fireEvent.click(summary)
    await waitFor(() => expect(reading).toBeVisible())
    expect(reading).toHaveTextContent('1:28')
  })
})

describe('click-to-teach glyph reading', () => {
  it('shows a read-only placeholder with no manual input or save action', () => {
    render(<GlyphSection {...glyphProps({ reading: '' })} />)
    const reading = screen.getByLabelText('当前读数')
    expect(reading.tagName).toBe('OUTPUT')
    expect(reading).toHaveTextContent('待标注')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('整帧读数')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '存为样本' })).not.toBeInTheDocument()
  })

  it('displays partial and complete character labels without creating more samples', () => {
    const props = glyphProps({ reading: '0:??' })
    const { rerender } = render(<GlyphSection {...props} />)
    expect(screen.getByLabelText('当前读数')).toHaveTextContent('0:??')
    rerender(<GlyphSection {...props} reading="0:18" />)
    expect(screen.getByLabelText('当前读数')).toHaveTextContent('0:18')
    expect(props.onAssign).not.toHaveBeenCalled()
  })

  it('dispatches each character button immediately without a separate save', () => {
    const props = glyphProps()
    render(<GlyphSection {...props} />)
    for (const [index, char] of ['0', ':', '1', '9'].entries()) {
      fireEvent.click(screen.getByRole('button', { name: char }))
      expect(props.onAssign).toHaveBeenNthCalledWith(index + 1, char)
    }
    expect(props.onAssign).toHaveBeenCalledTimes(4)
  })

  it.each(['clock', 'scoreLeft', 'scoreRight'] as const)('offers the same undo action for %s labels', fieldId => {
    const props = glyphProps({ fieldId, onUndo: vi.fn(), reading: fieldId === 'clock' ? '0:19' : '8' })
    render(<GlyphSection {...props} />)
    const undo = screen.getByRole('button', { name: '撤回' })
    expect(undo).toHaveAttribute('title', expect.stringContaining('Ctrl+Z'))
    fireEvent.click(undo)
    expect(props.onUndo).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '存为样本' })).not.toBeInTheDocument()
    if (fieldId !== 'clock') expect(screen.queryByRole('button', { name: ':' })).not.toBeInTheDocument()
    if (fieldId !== 'clock') expect(screen.getByText('左右比分共用数字样本, 两侧识别区域和二值化参数分别设置.')).toBeInTheDocument()
  })

  it('offers undo even if the latest frame has no glyph boxes', () => {
    const props = glyphProps({ onUndo: vi.fn(), bounds: null, boxes: [], selected: -1 })
    const { rerender } = render(<GlyphSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '撤回' }))
    expect(props.onUndo).toHaveBeenCalledTimes(1)
    rerender(<GlyphSection {...props} onUndo={null} />)
    expect(screen.getByRole('button', { name: '撤回' })).toBeDisabled()
  })

  it('disables conflicting glyph operations while teaching or seeking is in progress', () => {
    const props = glyphProps({ busy: true, onUndo: vi.fn() })
    render(<GlyphSection {...props} />)
    expect(screen.getByLabelText('当前读数')).toHaveTextContent('0:19')
    for (const name of ['撤回', '与右侧合并', '居中拆分', '排除', '左边加 1 像素', '0', '验证当前帧']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    fireEvent.click(screen.getByRole('button', { name: '撤回' }))
    fireEvent.click(screen.getByRole('button', { name: '0' }))
    expect(props.onUndo).not.toHaveBeenCalled()
    expect(props.onAssign).not.toHaveBeenCalled()
  })

  it('requires a selected glyph box before a character can be labelled', () => {
    const props = glyphProps({ selected: -1 })
    render(<GlyphSection {...props} />)
    const zero = screen.getByRole('button', { name: '0' })
    expect(zero).toBeDisabled()
    fireEvent.click(zero)
    expect(props.onAssign).not.toHaveBeenCalled()
  })
})
