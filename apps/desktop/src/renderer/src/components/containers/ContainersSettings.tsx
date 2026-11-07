import { useState } from 'react'
import type { ContainerBackendId, ContainerBackendInfo, ContainerJob, ContainersPrefs } from '@shared/types'
import { useTabs } from '../../store'
import { notify } from '../Dialogs'
import { Modal } from '../Modal'
import { Switch } from '../Switch'
import { ENGINE_LABEL } from './model'

// ---------------------------------------------------------------------------
// Settings (⚙): engines shown, default engine, refresh, confirmations; registry login / logout

export function ContainersSettings({
  backends,
  prefs,
  onClose,
  onStart
}: {
  backends: ContainerBackendInfo[]
  prefs: ContainersPrefs
  onClose: () => void
  onStart: (engine: ContainerBackendId, title: string, job: ContainerJob) => Promise<void>
}): React.JSX.Element {
  const [registry, setRegistry] = useState('')
  const usable = backends.filter((b) => b.available)
  const [loginEngine, setLoginEngine] = useState<ContainerBackendId | undefined>((usable.find((b) => b.id === prefs.defaultEngine) ?? usable[0])?.id)

  const save = (patch: Partial<ContainersPrefs>): void => void window.ide.settings.set({ containers: { ...prefs, ...patch } })
  const toggleEngine = (id: ContainerBackendId, shown: boolean): void =>
    save({ hidden: shown ? prefs.hidden.filter((h) => h !== id) : [...new Set([...prefs.hidden, id])] })

  const login = async (): Promise<void> => {
    if (!loginEngine) return
    const profile = await window.ide.containers.loginProfile(loginEngine, registry)
    if (!profile) return notify(`The ${ENGINE_LABEL[loginEngine]} command line tool is not installed.`, 'error')
    onClose()
    await useTabs.getState().openProfile(profile)
  }
  const logout = async (): Promise<void> => {
    if (!loginEngine) return
    onClose()
    await onStart(loginEngine, `Log out of ${registry.trim() || 'Docker Hub'}`, { kind: 'logout', registry })
  }

  return (
    <Modal label="Containers settings" className="settings-dialog ctr-settings" onClose={onClose}>
      <header className="settings-head">
        <h2>Containers settings</h2>
        <span className="spacer" />
        <button className="icon-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="settings-body">
        <section className="settings-section">
          <h3>Engines</h3>
          <div className="settings-list">
            {backends.map((b) => (
              <div key={b.id} className="settings-row">
                <span className={`engine-status${b.available ? ' on' : ''}`}>
                  <span className="engine-dot" />
                </span>
                <span className="settings-row-text">
                  <span className="settings-row-name">{b.label}</span>
                  <span className="settings-row-help">{b.available ? `Running${b.detail ? ` — ${b.detail}` : ''}` : `${b.label} is not running`}</span>
                </span>
                {/* Only running engines can be shown or hidden. */}
                {b.available && <Switch checked={!prefs.hidden.includes(b.id)} onChange={(on) => toggleEngine(b.id, on)} label={`Show ${b.label}`} />}
              </div>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Behaviour</h3>
          <div className="settings-defaults">
            <label className="settings-default">
              <span>Default engine (new images, containers, volumes…)</span>
              <select
                aria-label="Default engine"
                value={prefs.defaultEngine ?? ''}
                onChange={(e) => save({ defaultEngine: (e.target.value || undefined) as ContainerBackendId | undefined })}
              >
                <option value="">The first running</option>
                {backends.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-default">
              <span>Refresh the lists</span>
              <select aria-label="Refresh" value={String(prefs.refresh)} onChange={(e) => save({ refresh: Number(e.target.value) })}>
                {[1, 3, 5, 10, 30].map((s) => (
                  <option key={s} value={s}>
                    Every {s} s
                  </option>
                ))}
                <option value="0">Only on demand</option>
              </select>
            </label>
          </div>
          <div className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-name">Confirm before removing</span>
              <span className="settings-row-help">Ask before removing a container, an image, a volume or a network.</span>
            </span>
            <Switch checked={prefs.confirmRemove} onChange={(on) => save({ confirmRemove: on })} label="Confirm before removing" />
          </div>
        </section>

        <section className="settings-section">
          <h3>Registries</h3>
          <p className="muted settings-note">
            Log in to pull and push private images. The login runs the engine's own tool in a terminal tab (you type the password there); the engine keeps it in
            its credential store (the OS keychain).
          </p>
          <div className="ctr-registry">
            <select
              aria-label="Registry engine"
              value={loginEngine ?? ''}
              onChange={(e) => setLoginEngine(e.target.value as ContainerBackendId)}
              disabled={!usable.length}
            >
              {usable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Registry"
              placeholder="Registry (empty: Docker Hub), e.g. ghcr.io"
              value={registry}
              onChange={(e) => setRegistry(e.target.value)}
            />
            <button className="tool-button primary" disabled={!loginEngine} onClick={() => void login()}>
              Log in…
            </button>
            <button className="tool-button" disabled={!loginEngine} onClick={() => void logout()}>
              Log out
            </button>
          </div>
          {!usable.length && <p className="muted settings-note">No engine is running.</p>}
        </section>
      </div>
    </Modal>
  )
}
