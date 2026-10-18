/** A labelled checkbox styled as a switch. Keeps the native input for keyboard and AT. */

interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}

export function Toggle({ checked, onChange, label, hint, disabled = false }: Props): React.ReactNode {
  return (
    <label className={`toggle ${disabled ? 'is-disabled' : ''}`.trim()}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </label>
  )
}
