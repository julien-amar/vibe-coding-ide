import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import type { AppSettings, Profile } from '@shared/types'
import { loadProfiles } from '../profiles'
import { ProfileIcon } from './ProfileIcon'

/** Whether the Settings screen is open (opened from the launcher). */
export const useSettingsUi = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

const THEMES: { value: AppSettings['theme']; label: string; icon: React.JSX.Element }[] = [
  {
    value: 'system',
    label: 'System',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  },
  {
    value: 'light',
    label: 'Light',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="3" fill="currentColor" />
        <path
          d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden>
        <path d="M13.5 9.8A5.8 5.8 0 016.2 2.5a5.8 5.8 0 107.3 7.3z" fill="currentColor" />
      </svg>
    )
  }
]

/**
 * Application settings: appearance, WSL integration, and which shells, distributions and AI agents
 * are offered (launcher, defaults of new projects, agent switcher). Changes apply at once to every
 * window and are kept in the app's data folder.
 */
export function SettingsDialog(): React.JSX.Element | null {
  const { open, setOpen } = useSettingsUi()
  const [settings, setSettings] = useState<AppSettings>()
  const [all, setAll] = useState<Profile[] | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    void window.ide.settings.get().then((s) => alive && setSettings(s))
    void window.ide.profiles.all().then((p) => alive && setAll(p))
    const off = window.ide.settings.onChanged((s) => alive && setSettings(s))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      alive = false
      off()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, setOpen])

  if (!open) return null

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await window.ide.settings.set(patch)
    setSettings(next)
    if ('wsl' in patch) {
      // Distributions appear / disappear: look again.
      setAll(null)
      setAll(await window.ide.profiles.all())
    }
    void loadProfiles(true)
  }

  const hidden = new Set(settings?.hiddenProfiles ?? [])
  const toggle = (id: string, shown: boolean): void => {
    const next = new Set(hidden)
    if (shown) next.delete(id)
    else next.add(id)
    void save({ hiddenProfiles: [...next] })
  }

  const section = (title: string, list: Profile[], empty: string, disabled = false): React.JSX.Element => (
    <section className={`settings-section${disabled ? ' disabled' : ''}`}>
      <h3>
        {title}
        <span className="settings-count">
          {list.filter((p) => !hidden.has(p.id)).length} / {list.length} shown
        </span>
      </h3>
      {all === null ? (
        <p className="muted">Looking…</p>
      ) : list.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="settings-list">
          {list.map((p) => (
            <label key={p.id} className="settings-row" title={p.source}>
              <ProfileIcon profile={p} size={20} />
              <span className="settings-row-text">
                <span className="settings-row-name">{p.name}</span>
                {p.source && <span className="settings-row-source">{`‎${p.source}‎`}</span>}
              </span>
              <Switch checked={!hidden.has(p.id)} disabled={disabled} onChange={(on) => toggle(p.id, on)} label={`Show ${p.name}`} />
            </label>
          ))}
        </div>
      )}
    </section>
  )

  const profiles = all ?? []
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="settings-head">
          <h2>Settings</h2>
          <span className="muted">Saved automatically</span>
          <span className="spacer" />
          <button className="icon-button" title="Close (Esc)" onClick={() => setOpen(false)}>
            ✕
          </button>
        </header>
        {settings && (
          <div className="settings-body">
            <section className="settings-section">
              <h3>Appearance</h3>
              <div className="segmented settings-theme" role="radiogroup" aria-label="Theme">
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    role="radio"
                    aria-checked={settings.theme === t.value}
                    className={settings.theme === t.value ? 'active' : ''}
                    onClick={() => void save({ theme: t.value })}
                  >
                    {t.icon}
                    {t.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <label className="settings-row settings-toggle">
                <span className="settings-row-text">
                  <span className="settings-row-name">WSL integration</span>
                  <span className="settings-row-help">
                    Offer WSL distributions, projects inside them and the AI agents installed there. Off: wsl.exe is not started to look for them.
                  </span>
                </span>
                <Switch checked={settings.wsl} onChange={(on) => void save({ wsl: on })} label="WSL integration" />
              </label>
            </section>

            {section(
              'Shells',
              profiles.filter((p) => p.kind === 'shell'),
              'No shell found.'
            )}
            {section(
              'WSL distributions',
              profiles.filter((p) => p.kind === 'wsl'),
              settings.wsl ? 'No distribution installed.' : 'Turn WSL integration on to list them.',
              !settings.wsl
            )}
            {section(
              'AI agents',
              profiles.filter((p) => p.kind === 'agent'),
              'No AI agent CLI found on PATH (claude, codex, gemini, opencode, pi).'
            )}
            <p className="muted settings-note">
              Hidden entries are not offered in the launcher, as defaults of new projects or in the agent switcher; open tabs keep running.
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

function Switch({
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
