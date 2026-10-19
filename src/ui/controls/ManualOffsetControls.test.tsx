import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManualOffsetControls } from './ManualOffsetControls'
import {
  atLimit,
  formatOffset,
  formatStep,
  isTypingTarget,
  normalizeSteps,
  nudgedOffset,
  parseOffsetInput,
  repeatDelay,
  shortcutFor,
} from './manualOffset'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('manual offset arithmetic', () => {
  it('◀ rewinds official (offset grows), ▶ rewinds commentary (offset shrinks)', () => {
    // docs/sync-design.md: offset > 0 rewinds the official source.
    expect(nudgedOffset(0, 'official', 0.5)).toBe(0.5)
    expect(nudgedOffset(0, 'commentary', 0.5)).toBe(-0.5)
    expect(nudgedOffset(1, 'commentary', 5)).toBe(-4)
  })

  it('does not collect float residue over many small steps', () => {
    let value = 0
    for (let n = 0; n < 7; n += 1) value = nudgedOffset(value, 'official', 0.1)
    expect(value).toBe(0.7)
  })

  it('clamps to ±60 s and reports the limit', () => {
    expect(nudgedOffset(58, 'official', 5)).toBe(60)
    expect(nudgedOffset(-59.5, 'commentary', 5)).toBe(-60)
    expect(atLimit(60, 'official')).toBe(true)
    expect(atLimit(60, 'commentary')).toBe(false)
    expect(atLimit(-60, 'commentary')).toBe(true)
  })

  it.each([
    ['5', 5], ['+5', 5], ['-2.35', -2.35], ['−2.35', -2.35], ['2,5', 2.5], ['3s', 3], ['3 秒', 3], ['.5', 0.5], ['-0', 0],
  ])('parses %s', (text, value) => {
    expect(parseOffsetInput(text)).toEqual({ ok: true, value })
  })

  it.each([
    ['', '请输入偏移秒数'], ['abc', '只能输入数字，例如 -2.5'], ['1e3', '只能输入数字，例如 -2.5'], ['--1', '只能输入数字，例如 -2.5'], ['61', '偏移范围是 ±60 秒'],
  ])('rejects %j with a Chinese message', (text, message) => {
    expect(parseOffsetInput(text)).toEqual({ ok: false, message })
  })

  it('formats the readout with a real minus sign', () => {
    expect(formatOffset(0)).toBe('0.00')
    expect(formatOffset(1.5)).toBe('+1.50')
    expect(formatOffset(-0.05)).toBe('−0.05')
    expect(formatStep(0.5)).toBe('0.5s')
    expect(formatStep(5)).toBe('5s')
    expect(formatStep(0.05)).toBe('0.05s')
  })

  it('repeats slowly first, then accelerates', () => {
    expect(repeatDelay(1)).toBeGreaterThan(300)
    expect(repeatDelay(2)).toBeLessThan(repeatDelay(1))
    expect(repeatDelay(20)).toBeLessThan(repeatDelay(5))
  })

  it('keeps step settings bounded and the large step not below the small one', () => {
    const fallback = { small: 0.5, large: 5 }
    expect(normalizeSteps(0.25, 10, fallback)).toEqual({ small: 0.25, large: 10 })
    expect(normalizeSteps(0.001, 999, fallback)).toEqual({ small: 0.05, large: 30 })
    expect(normalizeSteps(2, 1, fallback)).toEqual({ small: 2, large: 2 })
    expect(normalizeSteps('x', Number.NaN, fallback)).toEqual(fallback)
  })
})

describe('shortcuts', () => {
  const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({ code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra })

  it('maps brackets, Shift and backslash', () => {
    expect(shortcutFor(key('BracketLeft'))).toEqual({ kind: 'nudge', direction: 'official', size: 'small' })
    expect(shortcutFor(key('BracketRight', { shiftKey: true }))).toEqual({ kind: 'nudge', direction: 'commentary', size: 'large' })
    expect(shortcutFor(key('Backslash'))).toEqual({ kind: 'reset' })
  })

  it('leaves browser and editing chords alone', () => {
    expect(shortcutFor(key('BracketLeft', { ctrlKey: true }))).toBeNull()
    expect(shortcutFor(key('BracketLeft', { altKey: true }))).toBeNull()
    expect(shortcutFor(key('KeyA'))).toBeNull()
  })

  it('treats text fields and open menus as typing targets', () => {
    document.body.innerHTML = '<input id="a"><textarea id="b"></textarea><div role="listbox"><button id="c"></button></div><button id="d"></button>'
    expect(isTypingTarget(document.getElementById('a'))).toBe(true)
    expect(isTypingTarget(document.getElementById('b'))).toBe(true)
    expect(isTypingTarget(document.getElementById('c'))).toBe(true)
    expect(isTypingTarget(document.getElementById('d'))).toBe(false)
    document.body.innerHTML = ''
  })
})

function Harness({ initial = 0, onChange }: { initial?: number; onChange?: (value: number) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <input aria-label="其他输入框" />
      <ManualOffsetControls
        value={value}
        smallStep={0.5}
        largeStep={5}
        onChange={(next) => { setValue(next); onChange?.(next) }}
        onReset={() => { setValue(0); onChange?.(0) }}
      />
    </>
  )
}

const readout = () => screen.getByRole('button', { name: /当前目标偏移/ })

describe('ManualOffsetControls', () => {
  it('names every button by side and step', () => {
    render(<Harness />)
    for (const name of ['官方后退 5s', '官方后退 0.5s', '解说后退 0.5s', '解说后退 5s']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })

  it('steps once per click, including keyboard activation', () => {
    const changes: number[] = []
    render(<Harness onChange={(value) => changes.push(value)} />)
    const button = screen.getByRole('button', { name: '官方后退 0.5s' })
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(button, { pointerId: 1 })
    fireEvent.click(button)
    // Enter / Space produce a click with no pointer before it.
    fireEvent.click(screen.getByRole('button', { name: '解说后退 5s' }))
    expect(changes).toEqual([0.5, -4.5])
    expect(readout().textContent).toContain('−4.50')
  })

  it('repeats while held and stops on release', () => {
    vi.useFakeTimers()
    const changes: number[] = []
    render(<Harness onChange={(value) => changes.push(value)} />)
    const button = screen.getByRole('button', { name: '解说后退 0.5s' })
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 })
    act(() => { vi.advanceTimersByTime(repeatDelay(1) + repeatDelay(2) + repeatDelay(3)) })
    fireEvent.pointerUp(button, { pointerId: 1 })
    const held = changes.length
    act(() => { vi.advanceTimersByTime(2000) })
    expect(held).toBe(4)
    expect(changes.length).toBe(held)
    expect(changes.at(-1)).toBe(-2)
  })

  it('disables the side that has reached the limit', () => {
    render(<Harness initial={60} />)
    expect((screen.getByRole('button', { name: '官方后退 0.5s' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '解说后退 0.5s' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('accepts an exact value typed into the readout', () => {
    const changes: number[] = []
    render(<Harness onChange={(value) => changes.push(value)} />)
    fireEvent.click(readout())
    const field = screen.getByRole('textbox', { name: '输入目标偏移（秒）' })
    fireEvent.change(field, { target: { value: 'abc' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toBe('只能输入数字，例如 -2.5')
    expect(changes).toEqual([])
    fireEvent.change(field, { target: { value: '-12.3' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(changes).toEqual([-12.3])
    expect(readout().textContent).toContain('−12.30')
  })

  it('Escape leaves the readout unchanged', () => {
    const changes: number[] = []
    render(<Harness initial={2} onChange={(value) => changes.push(value)} />)
    fireEvent.click(readout())
    const field = screen.getByRole('textbox', { name: '输入目标偏移（秒）' })
    fireEvent.change(field, { target: { value: '9' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(changes).toEqual([])
    expect(readout().textContent).toContain('+2.00')
  })

  it('answers shortcuts on the page but not while typing', () => {
    const changes: number[] = []
    render(<Harness onChange={(value) => changes.push(value)} />)
    fireEvent.keyDown(document.body, { code: 'BracketLeft' })
    fireEvent.keyDown(document.body, { code: 'BracketRight', shiftKey: true })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '其他输入框' }), { code: 'BracketLeft' })
    fireEvent.keyDown(document.body, { code: 'Backslash' })
    expect(changes).toEqual([0.5, -4.5, 0])
  })

  it('归零 is disabled at zero and resets otherwise', () => {
    const changes: number[] = []
    render(<Harness initial={3} onChange={(value) => changes.push(value)} />)
    const reset = screen.getByRole('button', { name: '归零' }) as HTMLButtonElement
    fireEvent.click(reset)
    expect(changes).toEqual([0])
    expect(reset.disabled).toBe(true)
  })
})
