import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEmptyHudStylePack, type HudCondition } from '../../core/hudStylePack'
import { editorCue } from './cueModel'
import { StateRules } from './CueSection'

afterEach(cleanup)

it('editing cue requirements preserves imported OR groups, field conditions and other states', () => {
  const pack = createEmptyHudStylePack()
  const variant = pack.variants[0]!
  variant.cues.replay = editorCue(pack, 'replay')
  variant.cues.bomb = editorCue(pack, 'bomb')
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
  second.cues.bomb = editorCue(pack, 'bomb')
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
