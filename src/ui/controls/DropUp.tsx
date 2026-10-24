/**
 * A drop-up menu, deliberately not a native `<select>`.
 *
 * Native select popups are painted by the OS above the fullscreen surface and cannot be
 * styled or positioned; docs/ui-layout.md asks for menus that open upward inside the
 * player. This is the accessible minimum for that: a `listbox` with roving selection,
 * arrow-key navigation, and Escape to dismiss.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useDismiss } from '../../app/hooks'

export interface DropUpOption<T extends string | number> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
}

interface Props<T extends string | number> {
  label: string
  value: T
  options: DropUpOption<T>[]
  onChange: (value: T) => void
  /** A disabled control still shows its label, so a placeholder can explain itself. */
  disabled?: boolean
  title?: string
  align?: 'left' | 'right'
}

export function DropUp<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  title,
  align = 'right',
}: Props<T>): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [activeValue, setActiveValue] = useState<T>(value)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()
  const close = useCallback(() => setOpen(false), [])
  const closeAndFocus = () => { setOpen(false); triggerRef.current?.focus() }
  const ref = useDismiss(open, close)
  const listRef = useRef<HTMLDivElement | null>(null)
  const focusValue = (options.find(option => option.value === activeValue && !option.disabled)
    ?? options.find(option => !option.disabled))?.value

  useEffect(() => {
    if (!open) return
    // Move focus into the list so arrow keys go to the menu and not the page behind it.
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    const active = Array.from(buttons ?? []).find(button => button.dataset.active === 'true') ?? buttons?.[0]
    active?.focus()
  }, [open, focusValue])

  const move = (from: number, delta: number): void => {
    const enabled = options.filter((option) => !option.disabled)
    if (enabled.length === 0) return
    const currentIndex = enabled.findIndex((option) => option.value === options[from]?.value)
    const nextIndex = (currentIndex + delta + enabled.length) % enabled.length
    const next = enabled[nextIndex]
    if (next) setActiveValue(next.value)
  }

  const selectedIndex = options.findIndex((option) => option.value === value)
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined

  return (
    <div className={`dropup dropup-${align}`} ref={ref}>
      <button
        type="button"
        className="dropup-trigger"
        ref={triggerRef}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => { setActiveValue(value); setOpen(previous => !previous) }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const enabled = options.filter(option => !option.disabled)
          const selected = enabled.find(option => option.value === value)
          const fallback = event.key === 'ArrowUp' ? enabled.at(-1) : enabled[0]
          if (selected || fallback) setActiveValue((selected ?? fallback)!.value)
          setOpen(true)
        }}
      >
        <span className="dropup-label">{label}</span>
        <span className="dropup-value">{current?.label ?? '—'}</span>
      </button>
      {open && !disabled && (
        <div className="dropup-menu" role="listbox" aria-label={label} id={menuId} ref={listRef} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAndFocus() }
          // Let the browser continue Tab navigation from the stable trigger.
          else if (event.key === 'Tab') closeAndFocus()
        }}>
          {options.map((option, index) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-selected={option.value === value}
              data-active={option.value === focusValue}
              tabIndex={option.value === focusValue ? 0 : -1}
              disabled={option.disabled}
              className="dropup-option"
              onClick={() => {
                onChange(option.value)
                closeAndFocus()
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault()
                  move(index, event.key === 'ArrowDown' ? 1 : -1)
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  const enabled = options.filter(candidate => !candidate.disabled)
                  const next = event.key === 'Home' ? enabled[0] : enabled.at(-1)
                  if (next) setActiveValue(next.value)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onChange(option.value)
                  closeAndFocus()
                }
              }}
            >
              <span>{option.label}</span>
              {option.hint && <span className="dropup-hint">{option.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
