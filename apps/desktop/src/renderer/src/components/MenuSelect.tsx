import { useEffect, useRef, useState } from 'react'

/** A choice of a MenuSelect: its value, label, icon and tooltip. */
export interface MenuChoice {
  value: string
  label: string
  icon?: React.ReactNode
  title?: string
}

/**
 * A dropdown in a panel's header (a terminal's profile, the Git panel's repository): a flat button
 * with the current choice, opening a menu of choices with their icons (a native <select> cannot
 * show images). Keyboard: Enter / Space / ↓ open it, ↑ ↓ move, Enter picks, Escape closes.
 */
export function MenuSelect({
  value,
  choices,
  placeholder,
  title,
  label,
  empty = 'Nothing to choose',
  className = '',
  onChange
}: {
  value?: string
  choices: MenuChoice[]
  placeholder: string
  title?: string
  /** Accessible name of the button (else its text). */
  label?: string
  empty?: string
  className?: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = choices.find((c) => c.value === value)

  useEffect(() => {
    if (!open) return
    setCursor(
      Math.max(
        0,
        choices.findIndex((c) => c.value === value)
      )
    )
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, choices, value])

  const pick = (c: MenuChoice): void => {
    setOpen(false)
    if (c.value !== value) onChange(c.value)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') setOpen(false)
    else if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, choices.length - 1))
    else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0))
    else if (e.key === 'Enter' && choices[cursor]) pick(choices[cursor])
    else return
    e.preventDefault()
  }

  return (
    <div className={`profile-select ${className}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        className="profile-select-button"
        title={title}
        aria-label={label ? `${label}: ${current?.label ?? placeholder}` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current?.icon ?? <span className="profile-icon placeholder" />}
        <span className="profile-select-name">{current?.label ?? placeholder}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="profile-select-menu" role="listbox" aria-label={label}>
          {choices.length === 0 && <div className="launcher-empty">{empty}</div>}
          {choices.map((c, i) => (
            <button
              key={c.value}
              role="option"
              aria-selected={c.value === value}
              className={`launcher-item${i === cursor ? ' selected' : ''}${c.value === value ? ' current' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(c)}
              title={c.title}
            >
              {c.icon}
              <span className="launcher-item-name">{c.label}</span>
              {c.value === value && <span className="profile-select-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
