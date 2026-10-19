/**
 * Manual offset control: four direction buttons around an editable readout, plus 归零.
 *
 *   ◀◀ 5s   ◀ 0.5s   [ +1.50 s ]   0.5s ▶   5s ▶▶
 *                       归零
 *
 * ◀ rewinds the official picture, ▶ rewinds the commentary; the arrows point at the side
 * that moves back. Holding a button repeats with acceleration, so crossing tens of
 * seconds is one gesture. Clicking the readout turns it into a text field for an exact
 * value. Brackets work as shortcuts from anywhere outside a text field.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  atLimit,
  clampManualOffset,
  formatOffset,
  formatStep,
  isTypingTarget,
  nudgedOffset,
  parseOffsetInput,
  repeatDelay,
  shortcutFor,
  type NudgeDirection,
} from './manualOffset'

interface Props {
  /** The requested offset; what the buttons build on. */
  value: number
  smallStep: number
  largeStep: number
  onChange: (offset: number) => void
  onReset: () => void
  /** Bind the bracket shortcuts globally. Off in tests that mount several controls. */
  shortcuts?: boolean
}

export function ManualOffsetControls({ value, smallStep, largeStep, onChange, onReset, shortcuts = true }: Props): React.ReactNode {
  // A held button keeps stepping from its own running total: the session applies each
  // offset asynchronously, and building on the prop would repeat the same step.
  const live = useRef(value)
  useEffect(() => { live.current = value }, [value])

  const step = useCallback((direction: NudgeDirection, size: number) => {
    const next = nudgedOffset(live.current, direction, size)
    if (next === live.current) return
    live.current = next
    onChange(next)
  }, [onChange])

  useEffect(() => {
    if (!shortcuts) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return
      const action = shortcutFor(event)
      if (!action) return
      event.preventDefault()
      if (action.kind === 'reset') {
        live.current = 0
        onReset()
      } else {
        step(action.direction, action.size === 'large' ? largeStep : smallStep)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcuts, step, onReset, smallStep, largeStep])

  return (
    <div className="offset-control">
      <div className="offset-row" role="group" aria-label="手动偏移">
        <StepButton direction="official" size={largeStep} glyph="◀◀" value={value} onStep={step} wide />
        <StepButton direction="official" size={smallStep} glyph="◀" value={value} onStep={step} />
        <OffsetReadout value={value} onCommit={(next) => { live.current = next; onChange(next) }} />
        <StepButton direction="commentary" size={smallStep} glyph="▶" value={value} onStep={step} />
        <StepButton direction="commentary" size={largeStep} glyph="▶▶" value={value} onStep={step} wide />
      </div>
      <div className="offset-legend">
        {/* The side labels repeat what each button's own name already says. */}
        <span aria-hidden="true">官方后退</span>
        <button type="button" className="offset-reset" onClick={() => { live.current = 0; onReset() }} disabled={value === 0}>
          归零
        </button>
        <span aria-hidden="true">解说后退</span>
      </div>
    </div>
  )
}

interface StepButtonProps {
  direction: NudgeDirection
  size: number
  glyph: string
  value: number
  onStep: (direction: NudgeDirection, size: number) => void
  wide?: boolean
}

function StepButton({ direction, size, glyph, value, onStep, wide = false }: StepButtonProps): React.ReactNode {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeats = useRef(0)
  // Pointer presses step on pointerdown and suppress the click that follows, so a
  // keyboard activation (Enter/Space → click with no pointer) still steps exactly once.
  const pointerStepped = useRef(false)

  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    repeats.current = 0
  }, [])
  useEffect(() => stop, [stop])

  const schedule = (): void => {
    repeats.current += 1
    timer.current = setTimeout(() => {
      onStep(direction, size)
      schedule()
    }, repeatDelay(repeats.current))
  }

  const label = direction === 'official' ? `官方后退 ${formatStep(size)}` : `解说后退 ${formatStep(size)}`
  const text = formatStep(size)
  return (
    <button
      type="button"
      className={`offset-step ${wide ? 'is-large' : ''} is-${direction}`.trim()}
      aria-label={label}
      title={label}
      disabled={atLimit(value, direction)}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture?.(event.pointerId)
        pointerStepped.current = true
        onStep(direction, size)
        schedule()
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onClick={() => {
        if (pointerStepped.current) {
          pointerStepped.current = false
          return
        }
        onStep(direction, size)
      }}
    >
      <span className="offset-glyph" aria-hidden="true">{glyph}</span>
      <span className="offset-step-size">{text}</span>
    </button>
  )
}

function OffsetReadout({ value, onCommit }: { value: number; onCommit: (value: number) => void }): React.ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  if (!editing) {
    return (
      <button
        type="button"
        className="offset-readout"
        aria-label={`当前目标偏移 ${formatOffset(value)} 秒，点击输入精确值`}
        title="点击输入精确值"
        onClick={() => {
          setDraft(value === 0 ? '' : formatOffset(value).replace('−', '-'))
          setError(null)
          setEditing(true)
        }}
      >
        <span className="offset-value">{formatOffset(value)}</span>
        <span className="offset-unit">s</span>
      </button>
    )
  }

  const commit = (): void => {
    const parsed = parseOffsetInput(draft)
    if (!parsed.ok) {
      setError(parsed.message)
      return
    }
    setEditing(false)
    onCommit(clampManualOffset(parsed.value))
  }

  return (
    <div className="offset-edit">
      <input
        ref={input}
        type="text"
        inputMode="decimal"
        aria-label="输入目标偏移（秒）"
        aria-invalid={error !== null}
        aria-describedby={error ? 'offset-edit-error' : undefined}
        className={error ? 'is-invalid' : undefined}
        value={draft}
        placeholder="0.00"
        onChange={(event) => { setDraft(event.target.value); setError(null) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setEditing(false)
          }
        }}
        onBlur={() => setEditing(false)}
      />
      {error && <span id="offset-edit-error" className="offset-edit-error" role="alert">{error}</span>}
    </div>
  )
}
