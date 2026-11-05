import { useEffect, useMemo, useRef, useState } from 'react'
import type { Profile, ProfileKind } from '@shared/types'
import { useTabs } from '../store'
import { KindBadge } from './KindBadge'

const GROUPS: Array<{ kind: ProfileKind; label: string }> = [
  { kind: 'shell', label: 'Shells' },
  { kind: 'wsl', label: 'WSL distributions' },
  { kind: 'agent', label: 'AI agents' }
]

/** Tab types from the plan that are not built yet; shown so the launcher reflects the roadmap. */
const COMING_SOON = ['Project', 'Web browser', 'Messaging', 'Containers', 'S/FTP client']

export function Launcher({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const openProfile = useTabs((s) => s.openProfile)

  useEffect(() => {
    void window.devhub.profiles.list().then(setProfiles)
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.new-tab')) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (profiles ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.kind.includes(q))
  }, [profiles, query])

  // Flatten in display order so arrow keys follow the grouped layout.
  const ordered = useMemo(() => GROUPS.flatMap((g) => filtered.filter((p) => p.kind === g.kind)), [filtered])

  useEffect(() => setCursor(0), [query])

  const refresh = (): void => {
    setProfiles(null)
    void window.devhub.profiles.list(true).then(setProfiles)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, ordered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter' && ordered[cursor]) {
      void openProfile(ordered[cursor])
    }
  }

  return (
    <div className="launcher" ref={rootRef} onKeyDown={onKeyDown} role="dialog" aria-label="New tab">
      <div className="launcher-search">
        <input autoFocus placeholder="Open a new tab…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="icon-button" title="Rescan shells" onClick={refresh}>
          ⟳
        </button>
      </div>
      <div className="launcher-list" role="listbox">
        {profiles === null && <div className="launcher-empty">Scanning…</div>}
        {profiles !== null && ordered.length === 0 && <div className="launcher-empty">Nothing found</div>}
        {GROUPS.map((g) => {
          const items = ordered.filter((p) => p.kind === g.kind)
          if (items.length === 0) return null
          return (
            <div key={g.kind} className="launcher-group">
              <div className="launcher-group-label">{g.label}</div>
              {items.map((p) => {
                const idx = ordered.indexOf(p)
                return (
                  <button
                    key={p.id}
                    role="option"
                    aria-selected={idx === cursor}
                    className={`launcher-item${idx === cursor ? ' selected' : ''}`}
                    onMouseEnter={() => setCursor(idx)}
                    onClick={() => void openProfile(p)}
                    title={p.source}
                  >
                    <KindBadge kind={p.kind} />
                    <span className="launcher-item-name">{p.name}</span>
                    <span className="launcher-item-source">{p.source}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
        {!query && (
          <div className="launcher-group">
            <div className="launcher-group-label">Coming soon</div>
            {COMING_SOON.map((name) => (
              <div key={name} className="launcher-item disabled" aria-disabled>
                <span className="kind-badge soon">··</span>
                <span className="launcher-item-name">{name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
