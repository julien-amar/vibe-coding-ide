import { useEffect, useRef, useState } from 'react'
import type { Profile } from '@shared/types'
import { ProfileIcon } from './ProfileIcon'

/**
 * Dropdown of launch profiles with their icons (a native <select> cannot show images).
 */
export function ProfileSelect({
  value,
  choices,
  placeholder,
  title,
  onChange
}: {
  value?: string
  choices: Profile[]
  placeholder: string
  title?: string
  onChange: (profileId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = choices.find((p) => p.id === value)

  useEffect(() => {
    if (!open) return
    setCursor(
      Math.max(
        0,
        choices.findIndex((p) => p.id === value)
      )
    )
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, choices, value])

  const pick = (p: Profile): void => {
    setOpen(false)
    if (p.id !== value) onChange(p.id)
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
    <div className="profile-select" ref={rootRef} onKeyDown={onKeyDown}>
      <button className="profile-select-button" title={title} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {current ? <ProfileIcon profile={current} /> : <span className="profile-icon placeholder" />}
        <span className="profile-select-name">{current?.name ?? placeholder}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="profile-select-menu" role="listbox">
          {choices.length === 0 && <div className="launcher-empty">Nothing installed</div>}
          {choices.map((p, i) => (
            <button
              key={p.id}
              role="option"
              aria-selected={p.id === value}
              className={`launcher-item${i === cursor ? ' selected' : ''}${p.id === value ? ' current' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(p)}
              title={p.source}
            >
              <ProfileIcon profile={p} />
              <span className="launcher-item-name">{p.name}</span>
              {p.id === value && <span className="profile-select-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
