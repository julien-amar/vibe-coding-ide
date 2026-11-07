/** An on/off switch (the settings dialogs' toggles). */
export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? ' on' : ''}`}
      onClick={(e) => {
        e.preventDefault()
        onChange(!checked)
      }}
    >
      <span className="switch-knob" />
    </button>
  )
}
