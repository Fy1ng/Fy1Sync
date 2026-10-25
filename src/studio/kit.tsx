/**
 * The handful of controls the studio is built from. Each keeps the native element it
 * stands in for (checkbox, radio group, button) so keyboard and screen readers get the
 * real thing; only the drawing is ours.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useDismiss } from '../app/hooks'

/** An anchored panel that closes on outside click or Escape. */
export function Popover({ open, onClose, className = '', children, label }: {
  open: boolean
  onClose: () => void
  className?: string
  label: string
  children: React.ReactNode
}): React.ReactNode {
  const ref = useDismiss(open, onClose)
  if (!open) return null
  return <div ref={ref} className={`pop ${className}`.trim()} role="dialog" aria-label={label}>{children}</div>
}

/** Open/close state plus the trigger wiring, so every popover behaves the same. */
export function usePopover(): { open: boolean; toggle: () => void; close: () => void } {
  const [open, setOpen] = useState(false)
  // The trigger sits outside the panel, so the panel's outside-click close fires first on a
  // click on the trigger; remembering when lets the toggle that follows not reopen it.
  const closedAt = useRef(0)
  const close = useCallback(() => { closedAt.current = performance.now(); setOpen(false) }, [])
  const toggle = useCallback(() => {
    if (performance.now() - closedAt.current < 120) return
    setOpen(value => !value)
  }, [])
  return { open, toggle, close }
}

export function Switch({ checked, onChange, label, disabled = false, detail }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  detail?: string
}): React.ReactNode {
  return (
    <label className={`switch ${disabled ? 'is-disabled' : ''}`.trim()}>
      <span className="switch-text">
        {label}
        {detail && <small>{detail}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch-track" aria-hidden="true" />
    </label>
  )
}

export function Segmented<T extends string | number>({ value, options, onChange, label, disabled = false }: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}): React.ReactNode {
  const name = useId()
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={String(option.value)} className={option.value === value ? 'is-on' : undefined}>
          <input type="radio" name={name} checked={option.value === value} disabled={disabled}
            onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  )
}

/**
 * A button that repeats while held, and speeds up the longer it is held: taps make small
 * corrections, a held press crosses tens of seconds without a separate "big step" control.
 */
export function HoldButton({ onStep, className, children, label, disabled = false, title }: {
  onStep: (held: number) => void
  className?: string
  children: React.ReactNode
  label: string
  disabled?: boolean
  title?: string
}): React.ReactNode {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const count = useRef(0)
  const fromPointer = useRef(false)
  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    count.current = 0
  }, [])
  useEffect(() => stop, [stop])
  const repeat = (): void => {
    timer.current = setTimeout(() => {
      count.current += 1
      onStep(count.current)
      repeat()
    }, count.current === 0 ? 420 : Math.max(60, 160 - count.current * 6))
  }
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture?.(event.pointerId)
        fromPointer.current = true
        onStep(0)
        repeat()
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onClick={() => {
        // Pointer presses already stepped on pointerdown; this is keyboard activation.
        if (fromPointer.current) { fromPointer.current = false; return }
        onStep(0)
      }}
    >
      {children}
    </button>
  )
}

/** A full-window workspace with a title, for the screens that are not about watching. */
export function Sheet({ title, onClose, children, wide = false }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}): React.ReactNode {
  return (
    <div className="sheet-scrim" onPointerDown={onClose}>
      <section
        className={`sheet ${wide ? 'is-wide' : ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
      >
        <header className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}

const PATHS = {
  play: <path d="M7 4.8v14.4c0 .8.9 1.3 1.6.9l11.5-7.2c.6-.4.6-1.4 0-1.8L8.6 3.9C7.9 3.5 7 4 7 4.8Z" fill="currentColor" />,
  pause: <><rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" /><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" /></>,
  expand: <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />,
  shrink: <path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5" />,
  chat: <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8.5L6 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z" />,
  more: <><circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" /></>,
  close: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  tune: <path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9M15 5.5v4M9 14.5v4" />,
  swap: <path d="M7 8.5h11l-3-3M17 15.5H6l3 3" />,
  chevron: <path d="m7.5 10 4.5 4.5 4.5-4.5" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  file: <path d="M7 3.5h6.5L18.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5ZM13.5 3.5v5h5" />,
  back: <path d="m14.5 6-6 6 6 6" />,
  forward: <path d="m9.5 6 6 6-6 6" />,
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name }: { name: IconName }): React.ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
