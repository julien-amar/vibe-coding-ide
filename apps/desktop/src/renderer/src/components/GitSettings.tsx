import { useState } from 'react'
import type { GitPrefs } from '@shared/types'
import { Modal } from './Modal'
import { Switch } from './Switch'

/** The Git panel's settings (⚙), for every project: how diffs are shown, the push command. */
export function GitSettings({ prefs, onClose }: { prefs: GitPrefs; onClose: () => void }): React.JSX.Element {
  const save = (patch: Partial<GitPrefs>): void => void window.ide.settings.set({ git: { ...prefs, ...patch } })
  const [context, setContext] = useState(String(prefs.contextLines))
  const [push, setPush] = useState(prefs.pushCommand)
  const saveContext = (): void => {
    const n = Math.round(Number(context))
    if (Number.isFinite(n) && n >= 0 && n <= 50) save({ contextLines: n })
    else setContext(String(prefs.contextLines))
  }

  return (
    <Modal label="Git settings" className="settings-dialog git-settings" onClose={onClose}>
      <header className="settings-head">
        <h2>Git settings</h2>
        <span className="spacer" />
        <button className="icon-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="settings-body">
        <section className="settings-section">
          <h3>Diffs</h3>
          <div className="settings-defaults">
            <label className="settings-default">
              <span>Lines around each change</span>
              <input
                type="number"
                min={0}
                max={50}
                aria-label="Lines around each change"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                onBlur={saveContext}
                onKeyDown={(e) => e.key === 'Enter' && saveContext()}
              />
            </label>
            <label className="settings-default">
              <span>Ignore whitespace</span>
              <select aria-label="Ignore whitespace" value={prefs.whitespace} onChange={(e) => save({ whitespace: e.target.value as GitPrefs['whitespace'] })}>
                <option value="none">None (show every change)</option>
                <option value="eol">At the end of lines</option>
                <option value="change">Changes in amount (spaces, tabs)</option>
                <option value="all">All whitespace</option>
              </select>
            </label>
          </div>
          <div className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-name">Ignore blank lines</span>
              <span className="settings-row-help">Lines added or removed that are empty are not shown as changes.</span>
            </span>
            <Switch checked={prefs.ignoreBlankLines} onChange={(on) => save({ ignoreBlankLines: on })} label="Ignore blank lines" />
          </div>
          <p className="muted settings-note">
            While whitespace or blank lines are ignored, changes are staged, unstaged or discarded per file (not per hunk or line): the diff shown is not the
            file's whole change.
          </p>
        </section>

        <section className="settings-section">
          <h3>Push</h3>
          <label className="settings-default git-push-command">
            <span>
              Push command
              <span
                className="info-icon"
                role="img"
                aria-label="About the push command"
                title={
                  'Run in the repository by the Push button (no shell: words, "quoted" ones kept together). Empty: git push (a new branch is published to origin).\n\n' +
                  'Gerrit: changes are pushed for review to refs/for/<branch> — use git review (the git-review tool) as the push command.'
                }
              >
                ⓘ
              </span>
            </span>
            <input
              aria-label="Push command"
              placeholder="git push"
              spellCheck={false}
              value={push}
              onChange={(e) => setPush(e.target.value)}
              onBlur={() => save({ pushCommand: push.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && save({ pushCommand: push.trim() })}
            />
          </label>
        </section>
      </div>
    </Modal>
  )
}
