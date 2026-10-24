import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DropUp } from './DropUp'

function harness(initial = 'a') {
  const changed = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    return <><DropUp label="选择" value={value} options={[
      { value: 'a', label: 'A' }, { value: 'disabled', label: '不可用', disabled: true },
      { value: 'b', label: 'B' }, { value: 'c', label: 'C' },
    ]} onChange={next => { changed(next); setValue(next) }} /><button type="button">外部</button></>
  }
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: /^选择/ })
  return { trigger, changed }
}
const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key })

describe('DropUp keyboard interaction', () => {
  it('moves focus past disabled items, then commits the focused item with Enter', () => {
    const { trigger, changed } = harness()
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'A' }))
    press('ArrowDown')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'B' }))
    press('ArrowDown')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'C' }))
    expect(changed).not.toHaveBeenCalled()
    press('Enter')
    expect(changed).toHaveBeenCalledExactlyOnceWith('c')
    expect(trigger).toHaveTextContent('C')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('cancels with Escape and restores the trigger without changing the value', () => {
    const { trigger, changed } = harness()
    trigger.focus()
    press('ArrowDown')
    press('ArrowDown')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'B' }))
    press('Escape')
    expect(changed).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveTextContent('A')
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'A' }))
  })

  it('wraps arrows and supports Home, End and Space', () => {
    const { trigger, changed } = harness('b')
    fireEvent.click(trigger)
    press('End')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'C' }))
    press('ArrowDown')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'A' }))
    press('ArrowUp')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'C' }))
    press('Home')
    press(' ')
    expect(changed).toHaveBeenCalledExactlyOnceWith('a')
    expect(trigger).toHaveFocus()
  })

  it('focuses an enabled option when the current placeholder is disabled', () => {
    const { trigger } = harness('disabled')
    fireEvent.click(trigger)
    const first = screen.getByRole('option', { name: 'A' })
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('option', { name: '不可用' })).toHaveAttribute('tabindex', '-1')
  })

  it('closes for Tab from the trigger and does not steal an outside pointer focus', () => {
    const { trigger } = harness()
    fireEvent.click(trigger)
    press('Tab')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    const outside = screen.getByRole('button', { name: '外部' })
    outside.focus()
    fireEvent.pointerDown(outside)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(outside).toHaveFocus()
  })
})
