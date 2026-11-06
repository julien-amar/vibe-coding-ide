import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Profile, RecentProject, TabKind } from '@shared/types'
import { loadProfiles } from '../profiles'
import { useTabs } from '../store'
import { LINUX_LOGO, Logo } from '../logos'
import { ProfileIcon } from './ProfileIcon'
import { useSettingsUi } from './SettingsDialog'

interface Entry {
  key: string
  group: string
  label: string
  detail?: string
  badge: TabKind
  /** Launch profile (shows the shell/distro/agent icon instead of the kind badge). */
  profile?: Profile
  run: () => void
  /** Recent projects: remove from the list (trash button on hover, or the Delete key). */
  remove?: () => void
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
    void window.ide.project.recent().then(setRecent)
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.new-tab')) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  /** A recent project removed from the list (an open tab of it stays open). */
  const forget = useCallback(async (root: string): Promise<void> => {
    await window.ide.project.forget(root)
    setRecent((list) => list.filter((p) => p.root !== root))
  }, [])

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      {
        key: 'project:open',
        group: 'Projects',
        label: 'Open project…',
        detail: 'git log, terminal and AI agent side by side',
        badge: 'project',
        run: () => {
          onClose()
          void window.ide.project.pickFolder().then((root) => {
            if (root) void openProject(root)
          })
        }
      },
      // Projects inside WSL: the folder picker starts in the distro's home.
      ...(profiles ?? [])
        .filter((p) => p.kind === 'wsl' && p.wslDistro)
        .map((p) => ({
          key: `project:wsl:${p.wslDistro}`,
          group: 'Projects',
          label: `Open project in ${p.wslDistro}…`,
          detail: 'git, terminal and agent run inside the distribution',
          badge: 'project' as const,
          profile: p,
          run: () => {
            onClose()
            void window.ide.project.pickFolder(`\\\\wsl.localhost\\${p.wslDistro}\\home`).then((root) => {
              if (root) void openProject(root)
            })
          }
        })),
      ...recent.map((p) => ({
        key: `project:${p.root}`,
        group: 'Projects',
        label: p.name,
        detail: p.root,
        badge: 'project' as const,
        run: () => void openProject(p.root),
        remove: () => void forget(p.root)
      })),
      ...(profiles ?? [])
        .filter((p) => !(p.kind === 'agent' && p.wslDistro))
        .map((p) => ({
          key: p.id,
          group: PROFILE_GROUP[p.kind],
          label: p.name,
          badge: p.kind,
          profile: p,
          run: () => void openProfile(p)
        }))
    ]
    const q = query.trim().toLowerCase()
    const filtered = q ? list.filter((e) => `${e.label} ${e.group} ${e.detail ?? ''}`.toLowerCase().includes(q)) : list
    return GROUP_ORDER.flatMap((g) => filtered.filter((e) => e.group === g))
  }, [profiles, recent, query, openProfile, openProject, onClose, forget])

  useEffect(() => setCursor(0), [query])

  // Keyboard moves keep the selected entry in view.
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // A statement, not the effect's return value: scrollIntoView returns a Promise in recent
    // Chromium, which React would take for a cleanup function.
    void selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

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
    } else if (e.key === 'Delete' && entries[cursor]?.remove) {
      e.preventDefault()
      entries[cursor].remove!()
    }
  }

  return (
    <div className="launcher" ref={rootRef} onKeyDown={onKeyDown} role="dialog" aria-label="New tab">
      <div className="launcher-search">
        <svg className="launcher-search-icon" viewBox="0 0 16 16" aria-hidden>
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input autoFocus placeholder="Open a project, shell or AI agent…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="icon-button" title="Rescan shells and agents" onClick={refresh}>
          ⟳
        </button>
        <button
          className="icon-button launcher-settings"
          title="Settings: theme, WSL, shown shells and agents"
          aria-label="Settings"
          onClick={() => {
            onClose()
            useSettingsUi.getState().setOpen(true)
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden>
            <path
              d="M6.8 1.5h2.4l.4 1.9a5 5 0 011.3.75l1.8-.6 1.2 2.1-1.4 1.3a5 5 0 010 1.5l1.4 1.3-1.2 2.1-1.8-.6a5 5 0 01-1.3.75l-.4 1.9H6.8l-.4-1.9a5 5 0 01-1.3-.75l-1.8.6-1.2-2.1 1.4-1.3a5 5 0 010-1.5L2.1 5.65l1.2-2.1 1.8.6a5 5 0 011.3-.75z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
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
              <div className="launcher-group-label">
                <CategoryIcon group={g} />
                <span>{g}</span>
                <span className="launcher-group-count">{items.length}</span>
              </div>
              {items.map((item) => {
                const idx = entries.indexOf(item)
                return (
                  <div key={item.key} className="launcher-row">
                    <button
                      ref={idx === cursor ? selectedRef : undefined}
                      role="option"
                      aria-selected={idx === cursor}
                      className={`launcher-item${idx === cursor ? ' selected' : ''}`}
                      onMouseMove={() => setCursor(idx)}
                      onClick={item.run}
                      title={item.detail}
                    >
                      <span className="launcher-item-icon">
                        {item.profile && item.badge !== 'project' ? <ProfileIcon profile={item.profile} size={20} /> : <FolderIcon wsl={!!item.profile} />}
                      </span>
                      <span className="launcher-item-text">
                        <span className="launcher-item-name">{item.label}</span>
                        {item.detail && <span className="launcher-item-source">{`‎${item.detail}‎`}</span>}
                      </span>
                    </button>
                    {item.remove && (
                      <button
                        className="launcher-remove"
                        title={`Remove ${item.label} from the recent projects (Delete)`}
                        aria-label={`Remove ${item.label}`}
                        onClick={item.remove}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden>
                          <path
                            d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.6a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-8.6M7 7v4.5M9 7v4.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
        {!query && (
          <div className="launcher-group">
            <div className="launcher-group-label">
              <CategoryIcon group="Coming soon" />
              <span>Coming soon</span>
            </div>
            <div className="launcher-soon">
              {COMING_SOON.map((name) => (
                <span key={name} className="launcher-soon-item">
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="launcher-footer" aria-hidden>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icons of the launcher's categories (drawn in the category's colour)

const CATEGORY_CLASS: Record<string, string> = {
  Projects: 'project',
  Shells: 'shell',
  'WSL distributions': 'wsl',
  'AI agents': 'agent',
  'Coming soon': 'soon'
}

function CategoryIcon({ group }: { group: string }): React.JSX.Element {
  const cls = `launcher-category-icon ${CATEGORY_CLASS[group] ?? ''}`
  if (group === 'WSL distributions') return <Logo svg={LINUX_LOGO} size={14} className={cls} />
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden>
      {group === 'Projects' && <path d="M1.5 4.5a1.5 1.5 0 011.5-1.5h3l1.5 1.5H13a1.5 1.5 0 011.5 1.5v6A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12z" />}
      {group === 'Shells' && (
        <>
          <rect x="1" y="2" width="14" height="12" rx="2" />
          <path d="M4 6l2.5 2L4 10M8 10.5h4" fill="none" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {group === 'AI agents' && (
        <>
          <path d="M7 1.5l1.4 3.6L12 6.5 8.4 7.9 7 11.5 5.6 7.9 2 6.5l3.6-1.4z" />
          <path d="M12.5 9.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
        </>
      )}
      {group === 'Coming soon' && (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

/** Projects: a folder (with Tux for a folder inside a WSL distribution). */
function FolderIcon({ wsl }: { wsl: boolean }): React.JSX.Element {
  return (
    <span className="launcher-folder">
      <svg viewBox="0 0 20 20" aria-hidden>
        <path d="M2 5.5A1.5 1.5 0 013.5 4h4l1.8 1.8h7.2A1.5 1.5 0 0118 7.3v7.2a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 012 14.5z" />
      </svg>
      {wsl && <Logo svg={LINUX_LOGO} size={11} className="launcher-folder-badge" />}
    </span>
  )
}
