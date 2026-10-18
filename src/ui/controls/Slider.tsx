/**
 * A range input that reports live drag values and a settled value separately.
 *
 * Manual sync needs both: docs/ui-layout.md asks for live application while dragging, but
 * the seek planner should not be handed 60 intermediate values per second. `onInput` fires
 * on every movement for the readout, `onSettle` fires when the gesture ends.
 */

interface Props {
  value: number
  min: number
  max: number
  step: number
  onInput: (value: number) => void
  onSettle?: (value: number) => void
  label: string
  disabled?: boolean
  formatValue?: (value: number) => string
  className?: string
}

export function Slider({
  value,
  min,
  max,
  step,
  onInput,
  onSettle,
  label,
  disabled = false,
  formatValue,
  className = '',
}: Props): React.ReactNode {
  return (
    <label className={`slider ${className}`.trim()}>
      <span className="slider-label">
        <span>{label}</span>
        {formatValue && <span className="slider-value">{formatValue(value)}</span>}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onInput(Number(event.target.value))}
        // Pointer/key release is the end of the gesture. `change` alone is not enough:
        // for a range input browsers fire it on every movement, same as `input`.
        onPointerUp={onSettle ? (event) => onSettle(Number(event.currentTarget.value)) : undefined}
        onKeyUp={onSettle ? (event) => onSettle(Number(event.currentTarget.value)) : undefined}
      />
    </label>
  )
}
