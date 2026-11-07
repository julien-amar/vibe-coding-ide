import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { AppSettings, Profile } from '@shared/types'
import { loadProfiles } from '../profiles'
import { Modal } from './Modal'
import { Switch } from './Switch'
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
  const [version, setVersion] = useState('')
  /** "Reset to defaults" asks for a confirmation in place (a dialog would open under this one). */
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setConfirmReset(false)
    void window.ide.settings.get().then((s) => alive && setSettings(s))
    void window.ide.profiles.all().then((p) => alive && setAll(p))
    void window.ide.app.version().then((v) => alive && setVersion(v))
    const off = window.ide.settings.onChanged((s) => alive && setSettings(s))
    return () => {
      alive = false
      off()
    }
  }, [open, setOpen])

  if (!open) return null

  const refreshProfiles = async (wslChanged: boolean): Promise<void> => {
    if (wslChanged) {
      // Distributions appear / disappear: look again.
      setAll(null)
      setAll(await window.ide.profiles.all())
    }
    void loadProfiles(true)
  }

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    const before = settings
    setSettings(await window.ide.settings.set(patch))
    await refreshProfiles('wsl' in patch && patch.wsl !== before?.wsl)
  }

  const reset = async (): Promise<void> => {
    const before = settings
    const next = await window.ide.settings.reset()
    setSettings(next)
    setConfirmReset(false)
    await refreshProfiles(next.wsl !== before?.wsl)
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
      <h3>{title}</h3>
      {all === null ? (
        <p className="muted">Looking…</p>
      ) : list.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="settings-list">
          {list.map((p) => (
            <label key={p.id} className="settings-row">
              <ProfileIcon profile={p} size={20} />
              <span className="settings-row-text">
                <span className="settings-row-name">{p.name}</span>
              </span>
              <Switch checked={!hidden.has(p.id)} disabled={disabled} onChange={(on) => toggle(p.id, on)} label={`Show ${p.name}`} />
            </label>
          ))}
        </div>
      )}
    </section>
  )

  const profiles = all ?? []
  // Defaults of new projects: among the profiles offered (not hidden; agents of this machine).
  const shells = profiles.filter((p) => (p.kind === 'shell' || (p.kind === 'wsl' && settings?.wsl)) && !hidden.has(p.id))
  const agents = profiles.filter((p) => p.kind === 'agent' && !p.wslDistro && !hidden.has(p.id))
  const select = (label: string, key: 'defaultShell' | 'defaultAgent', list: Profile[]): React.JSX.Element => (
    <label className="settings-default">
      <span>{label}</span>
      <select aria-label={label} value={settings?.[key] ?? ''} onChange={(e) => void save({ [key]: e.target.value || undefined })}>
        <option value="">Automatic (the first found)</option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <Modal label="Settings" className="settings-dialog" onClose={() => setOpen(false)}>
      <header className="settings-head">
        <h2>Settings</h2>
        <span className="spacer" />
        <button className="icon-button" title="Close (Esc)" aria-label="Close" onClick={() => setOpen(false)}>
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
            <h3>New projects</h3>
            <div className="settings-defaults">
              {select('Default shell', 'defaultShell', shells)}
              {select('Default AI agent', 'defaultAgent', agents)}
            </div>
            <p className="muted settings-note">Projects inside a WSL distribution use the distribution's own shell and agent when it has one.</p>
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
      <footer className="settings-foot">
        {confirmReset ? (
          <>
            <span>Reset every setting to its default?</span>
            <span className="spacer" />
            <button className="tool-button" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button className="tool-button danger" onClick={() => void reset()}>
              Reset
            </button>
          </>
        ) : (
          <>
            <button className="tool-button" onClick={() => setConfirmReset(true)}>
              Reset to defaults
            </button>
            <span className="spacer" />
            {version && (
              <span className="settings-version" title="vibe-coding-ide version">
                vibe-coding-ide v{version}
              </span>
            )}
          </>
        )}
      </footer>
    </Modal>
  )
}
