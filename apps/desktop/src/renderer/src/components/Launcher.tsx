import { useEffect, useMemo, useRef, useState } from 'react'
import type { Profile, RecentProject, TabKind } from '@shared/types'
import { loadProfiles } from '../profiles'
import { useTabs } from '../store'
import { KindBadge } from './KindBadge'
import { ProfileIcon } from './ProfileIcon'

interface Entry {
  key: string
  group: string
  label: string
  detail?: string
  badge: TabKind
  /** Launch profile (shows the shell/distro/agent icon instead of the kind badge). */
  profile?: Profile
  run: () => void
}

const GROUP_ORDER = ['Projects', 'Shells', 'WSL distributions', 'AI agents']
const PROFILE_GROUP: Record<Profile['kind'], string> = { shell: 'Shells', wsl: 'WSL distributions', agent: 'AI agents' }

/** Tab types from the plan that are not built yet; shown so the launcher reflects the roadmap. */
const COMING_SOON = ['Web browser', 'Messaging', 'Containers', 'S/FTP client']

export function Launcher({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const openProfile = useTabs((s) => s.openProfile)
  const openProject = useTabs((s) => s.openProject)

  useEffect(() => {
    void loadProfiles().then(setProfiles)
    void window.devhub.project.recent().then(setRecent)
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.new-tab')) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      {
        key: 'project:open',
        group: 'Projects',
        label: 'Open folder…',
        detail: 'git log, terminal and AI agent side by side',
        badge: 'project',
        run: () => {
          onClose()
          void window.devhub.project.pickFolder().then((root) => {
            if (root) void openProject(root)
          })
        }
      },
      ...recent.map((p) => ({
        key: `project:${p.root}`,
        group: 'Projects',
        label: p.name,
        detail: p.root,
        badge: 'project' as const,
        run: () => void openProject(p.root)
      })),
      ...(profiles ?? []).map((p) => ({
        key: p.id,
        group: PROFILE_GROUP[p.kind],
        label: p.name,
        detail: p.source,
        badge: p.kind,
        profile: p,
        run: () => void openProfile(p)
      }))
    ]
    const q = query.trim().toLowerCase()
    const filtered = q ? list.filter((e) => `${e.label} ${e.group} ${e.detail ?? ''}`.toLowerCase().includes(q)) : list
    return GROUP_ORDER.flatMap((g) => filtered.filter((e) => e.group === g))
  }, [profiles, recent, query, openProfile, openProject, onClose])

  useEffect(() => setCursor(0), [query])

  const refresh = (): void => {
    setProfiles(null)
    void loadProfiles(true).then(setProfiles)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, entries.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter' && entries[cursor]) {
      entries[cursor].run()
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
        {profiles !== null && entries.length === 0 && <div className="launcher-empty">Nothing found</div>}
        {GROUP_ORDER.map((g) => {
          const items = entries.filter((e) => e.group === g)
          if (items.length === 0) return null
          return (
            <div key={g} className="launcher-group">
              <div className="launcher-group-label">{g}</div>
              {items.map((item) => {
                const idx = entries.indexOf(item)
                return (
                  <button
                    key={item.key}
                    role="option"
                    aria-selected={idx === cursor}
                    className={`launcher-item${idx === cursor ? ' selected' : ''}`}
                    onMouseEnter={() => setCursor(idx)}
                    onClick={item.run}
                    title={item.detail}
                  >
                    {item.profile ? <ProfileIcon profile={item.profile} /> : <KindBadge kind={item.badge} />}
                    <span className="launcher-item-name">{item.label}</span>
                    <span className="launcher-item-source">{item.detail}</span>
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
