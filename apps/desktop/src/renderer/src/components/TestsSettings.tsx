import { useState } from 'react'
import type { TestsPrefs } from '@shared/types'
import { useTestsPrefs } from '../prefs'
import { Modal } from './Modal'

/** The ⚙ of the Tests panel's header: its settings. */
export function TestsSettingsButton(): React.JSX.Element {
  const prefs = useTestsPrefs()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="icon-button pane-action"
        title="Tests settings: how Run all runs the test projects (every project)"
        aria-label="Tests settings"
        onClick={() => setOpen(true)}
      >
        ⚙
      </button>
      {open && <TestsSettings prefs={prefs} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The Tests panel's settings (⚙), for every project: how Run all runs the test projects. */
export function TestsSettings({ prefs, onClose }: { prefs: TestsPrefs; onClose: () => void }): React.JSX.Element {
  const save = (patch: Partial<TestsPrefs>): void => void window.ide.settings.set({ tests: { ...prefs, ...patch } })
  const [parallelism, setParallelism] = useState(String(prefs.parallelism))
  const saveParallelism = (): void => {
    const n = Math.round(Number(parallelism))
    if (Number.isFinite(n) && n >= 1 && n <= 16) save({ parallelism: n })
    else setParallelism(String(prefs.parallelism))
  }

  return (
    <Modal label="Tests settings" className="settings-dialog tests-settings" onClose={onClose}>
      <header className="settings-head">
        <h2>Tests settings</h2>
        <span className="spacer" />
        <button className="icon-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="settings-body">
        <section className="settings-section">
          <h3>Run all</h3>
          <div className="settings-defaults">
            <label className="settings-default">
              <span>Test projects</span>
              <select aria-label="Run all" value={prefs.runAll} onChange={(e) => save({ runAll: e.target.value as TestsPrefs['runAll'] })}>
                <option value="parallel">In parallel</option>
                <option value="sequential">One after the other</option>
              </select>
            </label>
            {/* Only in parallel (one after the other: one at a time). */}
            {prefs.runAll === 'parallel' && (
              <label className="settings-default">
                <span>Projects at once</span>
                <input
                  type="number"
                  min={1}
                  max={16}
                  aria-label="Projects at once"
                  value={parallelism}
                  onChange={(e) => setParallelism(e.target.value)}
                  onBlur={saveParallelism}
                  onKeyDown={(e) => e.key === 'Enter' && saveParallelism()}
                />
              </label>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}
