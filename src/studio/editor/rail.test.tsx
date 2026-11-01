import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    onBoxes: vi.fn(), onAssign: vi.fn(), onAssignReading: vi.fn().mockResolvedValue(null),
    onVerify: vi.fn(), recognized: null,
    reading: '0:19', onReadingChange: vi.fn(), onUndo: null, busy: false,
    ...overrides,
  }
}

function ControlledGlyphs(props: GlyphProps): React.ReactNode {
  const [reading, setReading] = useState(props.reading)
  return <GlyphSection {...props} reading={reading} onReadingChange={value => { props.onReadingChange(value); setReading(value) }} />
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

  it('keeps the glyph count visible and a controlled reading intact when collapsed', async () => {
    const props = glyphProps()
    render(<ControlledGlyphs {...props} />)
    const { summary, details } = disclosure('字符')
    const reading = screen.getByRole('textbox', { name: '整帧读数' })
    expect(details).toHaveAttribute('open')
    fireEvent.change(reading, { target: { value: '1:28' } })
    expect(props.onReadingChange).toHaveBeenCalledWith('1:28')
    fireEvent.click(summary)
    await waitFor(() => expect(details).not.toHaveAttribute('open'))
    expect(reading).not.toBeVisible()
    expect(summary).toHaveTextContent('4 个样本')
    expect(summary).toBeVisible()
    fireEvent.click(summary)
    await waitFor(() => expect(reading).toBeVisible())
    expect(reading).toHaveValue('1:28')
  })
})

describe('controlled glyph reading', () => {
  it('retains a saved countdown as the next jump baseline', async () => {
    const props = glyphProps()
    render(<ControlledGlyphs {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '存为样本' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '存为样本' })).toBeEnabled())
    expect(props.onAssignReading).toHaveBeenCalledWith('0:19')
    expect(screen.getByRole('textbox', { name: '整帧读数' })).toHaveValue('0:19')
    expect(props.onReadingChange).not.toHaveBeenCalled()
  })

  it('still clears a successfully saved score reading', async () => {
    const props = glyphProps({ fieldId: 'scoreLeft', reading: '8' })
    render(<ControlledGlyphs {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '存为样本' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '整帧读数' })).toHaveValue(''))
    expect(props.onAssignReading).toHaveBeenCalledWith('8')
    expect(props.onReadingChange).toHaveBeenCalledWith('')
    expect(screen.queryByRole('button', { name: '撤回自动写入' })).not.toBeInTheDocument()
  })

  it('does not clear newer controlled input when an older save completes', async () => {
    let finish!: (problem: string | null) => void
    const props = glyphProps({ fieldId: 'scoreLeft', reading: '8',
      onAssignReading: vi.fn(() => new Promise<string | null>(resolve => { finish = resolve })) })
    const { rerender } = render(<GlyphSection {...props} />)
    const save = screen.getByRole('button', { name: '存为样本' })
    fireEvent.click(save)
    fireEvent.click(save)
    expect(props.onAssignReading).toHaveBeenCalledTimes(1)
    rerender(<GlyphSection {...props} reading="9" />)
    await act(async () => { finish(null) })
    expect(screen.getByRole('textbox', { name: '整帧读数' })).toHaveValue('9')
    expect(props.onReadingChange).not.toHaveBeenCalled()
  })

  it('does not clear a different field after the old glyph rail unmounts', async () => {
    let finish!: (problem: string | null) => void
    const props = glyphProps({ fieldId: 'scoreLeft', reading: '8',
      onAssignReading: vi.fn(() => new Promise<string | null>(resolve => { finish = resolve })) })
    const { unmount } = render(<GlyphSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '存为样本' }))
    unmount()
    await act(async () => { finish(null) })
    expect(props.onReadingChange).not.toHaveBeenCalled()
  })

  it('clears a previous reading error when the parent supplies a new countdown', async () => {
    const props = glyphProps({ onAssignReading: vi.fn().mockResolvedValue('字符框数量不匹配') })
    const { rerender } = render(<GlyphSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '存为样本' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('字符框数量不匹配')
    rerender(<GlyphSection {...props} reading="0:18" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '整帧读数' })).toHaveValue('0:18')
  })

  it('offers undo even if the latest frame has no glyph boxes', () => {
    const props = glyphProps({ onUndo: vi.fn(), bounds: null, boxes: [], selected: -1 })
    const { rerender } = render(<GlyphSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '撤回自动写入' }))
    expect(props.onUndo).toHaveBeenCalledTimes(1)
    rerender(<GlyphSection {...props} onUndo={null} />)
    expect(screen.getByRole('button', { name: '撤回自动写入' })).toBeDisabled()
  })

  it('disables conflicting glyph operations while a jump is processing', () => {
    const props = glyphProps({ busy: true, onUndo: vi.fn() })
    render(<GlyphSection {...props} />)
    expect(screen.getByRole('textbox', { name: '整帧读数' })).toBeDisabled()
    for (const name of ['存为样本', '撤回自动写入', '与右侧合并', '居中拆分', '排除', '左边加 1 像素', '0', '验证当前帧']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    fireEvent.click(screen.getByRole('button', { name: '撤回自动写入' }))
    expect(props.onUndo).not.toHaveBeenCalled()
  })
})
