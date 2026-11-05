import { useCallback, useEffect } from 'react'
import { Launcher } from './components/Launcher'
import { ProjectView } from './components/ProjectView'
import { TabStrip } from './components/TabStrip'
import { TerminalView } from './components/TerminalView'
import { onSessionExit } from './pty-bus'
import { handleAppShortcut } from './shortcuts'
import { useTabs } from './store'
import { onWindowDragLeave, onWindowDragOver, onWindowDrop } from './tab-dnd'

let initStarted = false

export function App(): React.JSX.Element {
  const tabs = useTabs((s) => s.tabs)
  const activeId = useTabs((s) => s.activeId)
  const ready = useTabs((s) => s.ready)
  const launcherOpen = useTabs((s) => s.launcherOpen)
  const setLauncherOpen = useTabs((s) => s.setLauncherOpen)

  // Restore this window's tabs (or adopt a detached tab, or open the default shell).
  useEffect(() => {
    if (initStarted) return
    initStarted = true
    void useTabs.getState().init()
  }, [])

  useEffect(() => onSessionExit((id, code) => useTabs.getState().sessionExited(id, code)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (handleAppShortcut(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const closeLauncher = useCallback(() => setLauncherOpen(false), [setLauncherOpen])

  return (
    <div className="app" onDragOver={onWindowDragOver} onDrop={onWindowDrop} onDragLeave={onWindowDragLeave}>
      <TabStrip />
      {launcherOpen && <Launcher onClose={closeLauncher} />}
      <main className="content">
        {tabs.map((t) => {
          const visible = t.id === activeId
          return (
            <div key={t.id} className={`tab-panel${visible ? ' visible' : ''}`}>
              {t.kind === 'project' ? (
                <ProjectView tab={t} visible={visible} />
              ) : (
                t.sessionId && (
                  <TerminalView
                    sessionId={t.sessionId}
                    restoredScrollback={t.restoredScrollback}
                    visible={visible}
                    onTitle={(title) => useTabs.getState().setAutoTitle(t.id, title)}
                  />
                )
              )}
            </div>
          )
        })}
        {ready && tabs.length === 0 && (
          <div className="empty-state">
            <p>No tabs open.</p>
            <button onClick={() => setLauncherOpen(true)}>Open a tab</button>
          </div>
        )}
      </main>
    </div>
  )
}
