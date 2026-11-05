import { useCallback, useEffect, useRef } from 'react'
import { Launcher } from './components/Launcher'
import { TabStrip } from './components/TabStrip'
import { TerminalView } from './components/TerminalView'
import { onSessionExit } from './pty-bus'
import { handleAppShortcut } from './shortcuts'
import { useTabs } from './store'

export function App(): React.JSX.Element {
  const { tabs, activeId, launcherOpen, setLauncherOpen, openProfile } = useTabs()
  const started = useRef(false)

  // Open the default shell on startup.
  useEffect(() => {
    if (started.current) return
    started.current = true
    void window.devhub.profiles.list().then((profiles) => {
      const first = profiles.find((p) => p.kind === 'shell') ?? profiles[0]
      if (first) void openProfile(first)
      else setLauncherOpen(true)
    })
  }, [openProfile, setLauncherOpen])

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
    <div className="app">
      <TabStrip />
      {launcherOpen && <Launcher onClose={closeLauncher} />}
      <main className="content">
        {tabs.map((t) => (
          <TerminalView key={t.id} tab={t} active={t.id === activeId} />
        ))}
        {tabs.length === 0 && (
          <div className="empty-state">
            <p>No tabs open.</p>
            <button onClick={() => setLauncherOpen(true)}>Open a tab</button>
          </div>
        )}
      </main>
    </div>
  )
}
