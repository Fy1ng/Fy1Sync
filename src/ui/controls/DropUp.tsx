/**
 * A drop-up menu, deliberately not a native `<select>`.
 *
 * Native select popups are painted by the OS above the fullscreen surface and cannot be
 * styled or positioned; docs/ui-layout.md asks for menus that open upward inside the
 * player. This is the accessible minimum for that: a `listbox` with roving selection,
 * arrow-key navigation, and Escape to dismiss.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
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
  const close = useCallback(() => setOpen(false), [])
  const ref = useDismiss(open, close)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    // Move focus into the list so arrow keys go to the menu and not the page behind it.
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.focus()
  }, [open])

  const move = (from: number, delta: number): void => {
    const enabled = options.filter((option) => !option.disabled)
    if (enabled.length === 0) return
    const currentIndex = enabled.findIndex((option) => option.value === options[from]?.value)
    const nextIndex = (currentIndex + delta + enabled.length) % enabled.length
    const next = enabled[nextIndex]
    if (next) onChange(next.value)
  }

  const selectedIndex = options.findIndex((option) => option.value === value)
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined

  return (
    <div className={`dropup dropup-${align}`} ref={ref}>
      <button
        type="button"
        className="dropup-trigger"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="dropup-label">{label}</span>
        <span className="dropup-value">{current?.label ?? '—'}</span>
      </button>
      {open && !disabled && (
        <div className="dropup-menu" role="listbox" aria-label={label} ref={listRef}>
          {options.map((option, index) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-selected={option.value === value}
              disabled={option.disabled}
              className="dropup-option"
              onClick={() => {
                onChange(option.value)
                close()
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault()
                  move(index, event.key === 'ArrowDown' ? 1 : -1)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onChange(option.value)
                  close()
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
