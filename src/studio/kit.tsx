/**
 * The handful of controls the studio is built from. Each keeps the native element it
 * stands in for (checkbox, radio group, button) so keyboard and screen readers get the
 * real thing; only the drawing is ours.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

/** Chromium has native popovers; jsdom (the unit tests) does not, and gets plain toggling. */
const NATIVE_POPOVER = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype

/**
 * An anchored panel on the browser's own popover: it sits in the top layer, closes on an
 * outside click or Escape (the innermost one first), and is placed against its trigger with
 * CSS anchor positioning, flipping to stay on screen. It replaces a hand-rolled outside-click
 * hook whose trigger had to dodge a close-and-reopen race with a 120 ms timer.
 *
 * Its content mounts only while open. `anchor` places a panel opened from code (no trigger
 * pointing at it) against that element.
 */
export function Popover({ id, open, onOpen, onClose, anchor = null, className = '', children, label }: {
  id?: string
  open: boolean
  /** The browser opened it, from a trigger whose `popoverTarget` names this `id`. */
  onOpen?: () => void
  onClose: () => void
  anchor?: HTMLElement | null
  className?: string
  label: string
  children: React.ReactNode
}): React.ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !NATIVE_POPOVER) return
    const shown = node.matches(':popover-open')
    if (open && !shown) node.showPopover(anchor ? { source: anchor } : undefined)
    else if (!open && shown) node.hidePopover()
  }, [open, anchor])
  return (
    // Without native popovers (jsdom) the attribute alone would hide the panel for good.
    <div ref={ref} id={id} popover={NATIVE_POPOVER ? 'auto' : undefined} className={`pop ${className}`.trim()} role="dialog" aria-label={label}
      data-open={open || undefined}
      onToggle={(event) => {
        const shown = event.newState === 'open'
        if (shown && !open) onOpen?.()
        else if (!shown && open) onClose()
      }}
      onKeyDown={NATIVE_POPOVER ? undefined : (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      {open && children}
    </div>
  )
}

/**
 * Open state plus the wiring for one trigger and its `Popover`: spread `trigger` on the
 * button and `popover` on the panel. The trigger names the panel (`popoverTarget`), so the
 * browser toggles it and knows a click on it is not an outside click.
 */
export function usePopover(): {
  open: boolean
  close: () => void
  trigger: { popoverTarget?: string; onClick?: () => void; 'aria-expanded': boolean }
  popover: { id: string; open: boolean; onOpen: () => void; onClose: () => void }
} {
  const id = useId()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const show = useCallback(() => setOpen(true), [])
  const toggle = useCallback(() => setOpen((value) => !value), [])
  return {
    open,
    close,
    trigger: NATIVE_POPOVER ? { popoverTarget: id, 'aria-expanded': open } : { onClick: toggle, 'aria-expanded': open },
    popover: { id, open, onOpen: show, onClose: close },
  }
}

/** Trigger props for a popover whose open state lives elsewhere (see `usePopover`). */
export function popoverTrigger(id: string, open: boolean, toggle: () => void): { popoverTarget?: string; onClick?: () => void; 'aria-expanded': boolean } {
  return NATIVE_POPOVER ? { popoverTarget: id, 'aria-expanded': open } : { onClick: toggle, 'aria-expanded': open }
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

/** A labelled slider with its value on the right; `--fill` paints the travelled part. */
export function Range({ label, value, min, max, step, unit = '', format, onChange, disabled = false }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string
  format?: (value: number) => string
  onChange: (value: number) => void
  disabled?: boolean
}): React.ReactNode {
  return (
    <label className="range">
      <span className="range-head">
        <span>{label}</span>
        <span className="num">{format ? format(value) : `${value}${unit}`}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} disabled={disabled}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))} />
    </label>
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

/**
 * Tabs down the left with the chosen pane beside them. Up/Down move between tabs the way a
 * vertical tab list should; `aside` sits under the list for facts about the whole section.
 */
export function SideTabs<T extends string>({ label, tabs, value, onChange, aside, children }: {
  label: string
  tabs: { id: T; label: string; badge?: React.ReactNode }[]
  value: T
  onChange: (id: T) => void
  aside?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  const base = useId()
  const current = tabs.find((tab) => tab.id === value) ?? tabs[0]
  const move = (event: React.KeyboardEvent<HTMLElement>): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const index = tabs.findIndex((tab) => tab.id === value)
    const next = tabs[(index + step + tabs.length) % tabs.length]!
    onChange(next.id)
    document.getElementById(`${base}-${next.id}`)?.focus()
  }
  return (
    <div className="side-tabs">
      <div className="side-nav">
        <div role="tablist" aria-orientation="vertical" aria-label={label} onKeyDown={move}>
          {tabs.map((tab) => (
            <button key={tab.id} id={`${base}-${tab.id}`} type="button" role="tab" aria-selected={tab.id === value}
              tabIndex={tab.id === value ? 0 : -1} aria-controls={`${base}-panel`}
              className={tab.id === value ? 'is-on' : undefined} onClick={() => onChange(tab.id)}>
              <span>{tab.label}</span>
              {tab.badge}
            </button>
          ))}
        </div>
        {aside && <div className="side-aside">{aside}</div>}
      </div>
      <div className="side-panel" id={`${base}-panel`} role="tabpanel" aria-labelledby={current ? `${base}-${current.id}` : undefined}>
        {children}
      </div>
    </div>
  )
}

/**
 * A full-window workspace with a title, for the screens that are not about watching.
 *
 * A modal `<dialog>`: the browser traps focus inside it, makes the page behind inert, closes
 * it on Escape or a click on the backdrop, and puts focus back where it was when it closes.
 */
export function Sheet({ title, onClose, children, wide = false }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}): React.ReactNode {
  const ref = useRef<HTMLDialogElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // The content mounts once the dialog is open, so an autoFocus inside it lands.
  const [shown, setShown] = useState(false)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    if (typeof node.showModal === 'function') {
      if (!node.open) node.showModal()
      // Start on the sheet itself rather than on its close button.
      node.focus({ preventScroll: true })
    } else node.setAttribute('open', '')
    setShown(true)
  }, [])
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className={`sheet ${wide ? 'is-wide' : ''}`.trim()}
      role="dialog"
      aria-label={title}
      closedby="any"
      onClose={() => closeRef.current()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // The browser closes the dialog; the page behind must not also act on this Escape.
        event.stopPropagation()
        if (typeof ref.current?.showModal !== 'function') onClose()
      }}
    >
      <header className="sheet-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
          <Icon name="close" />
        </button>
      </header>
      {shown && children}
    </dialog>
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
  pip: <><rect x="3.5" y="5" width="17" height="14" rx="1.5" /><rect x="12" y="11.5" width="6.5" height="5" rx="0.8" fill="currentColor" stroke="none" /></>,
  camera: <><path d="M4.5 8h3l1.5-2.5h6L16.5 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13.2" r="3.3" /></>,
  record: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  star: <path d="m12 4.5 2.3 4.7 5.2.8-3.8 3.6.9 5.1L12 16.3l-4.6 2.4.9-5.1L4.5 10l5.2-.8L12 4.5Z" />,
  history: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" /><path d="M4.5 4.5V9H9M12 8v4.3l3 1.8" /></>,
  stats: <path d="M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8.5" />,
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9M19.5 4.5V9H15" />,
  volume: <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3ZM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />,
  mute: <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3ZM16 9.5l5 5m0-5-5 5" />,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5c1-3.5 3.7-5 7-5s6 1.5 7 5" /></>,
  // A toothed cog: the teeth are what read as 设置, so they are solid, not spokes.
  gear: <><path strokeLinejoin="round" d="M18.31 10.05 20.48 10.55 20.48 13.45 18.31 13.95 17.84 15.08 19.02 16.96 16.96 19.02 15.08 17.84 13.95 18.31 13.45 20.48 10.55 20.48 10.05 18.31 8.92 17.84 7.04 19.02 4.98 16.96 6.16 15.08 5.69 13.95 3.52 13.45 3.52 10.55 5.69 10.05 6.16 8.92 4.98 7.04 7.04 4.98 8.92 6.16 10.05 5.69 10.55 3.52 13.45 3.52 13.95 5.69 15.08 6.16 16.96 4.98 19.02 7.04 17.84 8.92Z" /><circle cx="12" cy="12" r="2.6" /></>,
  trophy: <path d="M8 4.5h8v4.2a4 4 0 0 1-8 0V4.5ZM8 6H4.8a3 3 0 0 0 3.3 4M16 6h3.2a3 3 0 0 1-3.3 4M12 12.7V16M8.5 19.5h7M10 16h4v3.5h-4Z" />,
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
