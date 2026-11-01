import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEmptyHudStylePack, type HudCondition } from '../../core/hudStylePack'
import type { HudFrameResult, HudPresenceResult } from '../../core/hudWasm'
import { editorCue } from './cueModel'
import { CueSection, FrameStatePreview, presenceText, StateRules } from './CueSection'

afterEach(cleanup)

it('editing cue requirements preserves imported OR groups, field conditions and other states', () => {
  const pack = createEmptyHudStylePack()
  const variant = pack.variants[0]!
  variant.cues.replay = { ...editorCue(pack, 'replay'), enabled: true }
  variant.cues.bomb = { ...editorCue(pack, 'bomb'), enabled: true }
  const field: HudCondition = { kind: 'field', field: 'clock', present: true }
  variant.states.replay = [[field, { kind: 'cue', cue: 'replay', present: true }], [{ kind: 'cue', cue: 'bomb', present: true }]]
  variant.states.planted = [[{ kind: 'cue', cue: 'bomb', present: true }]]
  const change = vi.fn()
  render(<StateRules pack={pack} onChange={change} />)
  fireEvent.click(screen.getByText('状态规则'))
  fireEvent.change(screen.getByLabelText('回放 1 回放标记'), { target: { value: 'absent' } })
  expect(change).toHaveBeenCalledWith({ replay: [[field, { kind: 'cue', cue: 'replay', present: false }],
    [{ kind: 'cue', cue: 'bomb', present: true }]], planted: variant.states.planted })
  expect(screen.getByLabelText('回放 1 Timeout')).toBeDisabled()
})

it('shows and edits the selected layout state rules', () => {
  const pack = createEmptyHudStylePack()
  const second = { ...structuredClone(pack.variants[0]!), id: 'second' }
  second.cues.bomb = { ...editorCue(pack, 'bomb'), enabled: true }
  second.states.planted = [[{ kind: 'cue', cue: 'bomb', present: true }]]
  pack.variants.push(second)
  const change = vi.fn()
  render(<StateRules pack={pack} variantId="second" onChange={change} />)
  fireEvent.click(screen.getByText('状态规则'))
  expect(screen.getByLabelText('下包 1 炸弹')).toHaveValue('present')
  fireEvent.change(screen.getByLabelText('下包 1 炸弹'), { target: { value: 'absent' } })
  expect(change).toHaveBeenCalledWith({ planted: [[{ kind: 'cue', cue: 'bomb', present: false }]] })
  expect(pack.variants[0]!.states).toEqual({})
})

it('presents disabled cues and organizers as closed rather than absent or failed', () => {
  const disabled: HudPresenceResult = { status: 'disabled', score: null, debug: null }
  expect(presenceText(disabled)).toBe('已关闭')
  expect(presenceText({ ...disabled, score: 0.99 }, true)).toBe('已关闭')
  expect(presenceText({ status: 'not-matched', score: 0.4, debug: null })).toBe('不出现 / 得分 0.400')
  const pack = createEmptyHudStylePack()
  pack.variants[0]!.cues.replay = { ...editorCue(pack, 'replay'), enabled: false }
  const result: HudFrameResult = { variantId: pack.variants[0]!.id, selectionReason: null,
    content: 'indeterminate', phase: 'unconfigured',
    fields: { clock: { status: 'disabled', debug: null }, scoreLeft: { status: 'disabled', debug: null },
      scoreRight: { status: 'disabled', debug: null }, round: { status: 'disabled', debug: null } },
    cues: { replay: disabled }, states: {}, organizer: disabled }
  render(<><CueSection id="replay" pack={pack} result={disabled} onSave={null} onThreshold={vi.fn()} onRemove={vi.fn()} />
    <FrameStatePreview result={result} /></>)
  expect(screen.getByRole('status')).toHaveTextContent('已关闭')
  expect(screen.getByTestId('hud-organizer')).toHaveTextContent('已关闭')
  expect(screen.queryByText(/识别失败|undefined/)).not.toBeInTheDocument()
})

it('keeps a disabled cue requirement and restores the same selection when re-enabled', () => {
  const pack = createEmptyHudStylePack()
  const variant = pack.variants[0]!
  variant.cues.replay = { ...editorCue(pack, 'replay'), enabled: false }
  variant.cues.bomb = { ...editorCue(pack, 'bomb'), enabled: true }
  variant.states.replay = [[{ kind: 'cue', cue: 'replay', present: false }], [{ kind: 'cue', cue: 'bomb', present: true }]]
  const original = structuredClone(variant.states)
  const change = vi.fn()
  const view = render(<StateRules pack={pack} onChange={change} />)
  fireEvent.click(screen.getByText('状态规则'))
  const closed = screen.getByLabelText('回放 1 回放标记 (已关闭)') as HTMLSelectElement
  expect(closed).toBeDisabled()
  expect(closed).toHaveValue('absent')
  expect([...closed.options].map(option => option.value)).toEqual(['', 'present', 'absent'])
  expect(screen.getByLabelText('回放 2 炸弹')).toBeEnabled()
  expect(screen.getAllByText('该组引用了已关闭字段, 暂不参与判断')).toHaveLength(1)
  fireEvent.change(closed, { target: { value: 'present' } })
  expect(change).not.toHaveBeenCalled()
  expect(variant.states).toEqual(original)

  const enabled = structuredClone(pack)
  enabled.variants[0]!.cues.replay!.enabled = true
  view.rerender(<StateRules pack={enabled} onChange={change} />)
  const restored = screen.getByLabelText('回放 1 回放标记')
  expect(restored).toBeEnabled()
  expect(restored).toHaveValue('absent')
  expect(screen.queryByText('该组引用了已关闭字段, 暂不参与判断')).not.toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
  fireEvent.change(restored, { target: { value: 'present' } })
  expect(change).toHaveBeenCalledWith({ replay: [[{ kind: 'cue', cue: 'replay', present: true }], original.replay![1]] })
})

it('warns once per inactive AND group without disabling other OR groups or rewriting rules', () => {
  const pack = createEmptyHudStylePack()
  const variant = pack.variants[0]!
  variant.fields.clock!.enabled = false
  variant.cues.replay = { ...editorCue(pack, 'replay'), enabled: false }
  variant.cues.bomb = { ...editorCue(pack, 'bomb'), enabled: true }
  variant.states.replay = [
    [{ kind: 'field', field: 'clock', present: true }, { kind: 'cue', cue: 'replay', present: false }],
    [{ kind: 'cue', cue: 'bomb', present: true }],
    [{ kind: 'field', field: 'clock', present: false }],
  ]
  variant.states.active = [[{ kind: 'cue', cue: 'replay', present: true }]]
  const original = structuredClone(variant.states)
  const change = vi.fn()
  const view = render(<StateRules pack={pack} onChange={change} />)
  fireEvent.click(screen.getByText('状态规则'))
  expect(screen.getAllByText('该组引用了已关闭字段, 暂不参与判断')).toHaveLength(3)
  expect(screen.getByText('clock: 读到 (已关闭)')).toBeVisible()
  expect(screen.getByText('clock: 不在 (已关闭)')).toBeVisible()
  expect(screen.getByLabelText('回放 2 炸弹')).toBeEnabled()
  expect(screen.getByLabelText('回放 2 炸弹')).toHaveValue('present')
  expect(change).not.toHaveBeenCalled()
  expect(variant.states).toEqual(original)

  const enabled = structuredClone(pack)
  enabled.variants[0]!.fields.clock!.enabled = true
  view.rerender(<StateRules pack={enabled} onChange={change} />)
  expect(screen.getAllByText('该组引用了已关闭字段, 暂不参与判断')).toHaveLength(2)
  enabled.variants[0]!.cues.replay!.enabled = true
  view.rerender(<StateRules pack={enabled} onChange={change} />)
  expect(screen.queryByText('该组引用了已关闭字段, 暂不参与判断')).not.toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
  expect(enabled.variants[0]!.states).toEqual(original)
})
