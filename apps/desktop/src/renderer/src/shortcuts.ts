import { useTabs } from './store'

/**
 * App-level shortcuts. Returns true if the event was handled, so the terminal
 * can ignore it instead of sending it to the shell.
 */
export function handleAppShortcut(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return false
  const mod = window.devhub.platform === 'darwin' ? e.metaKey : e.ctrlKey
  const store = useTabs.getState()
  const key = e.key.toLowerCase()

  if (mod && e.shiftKey && (key === 't' || key === ' ')) {
    store.setLauncherOpen(true)
    return true
  }
  if (mod && e.shiftKey && key === 'w') {
    if (store.activeId) store.close(store.activeId)
    return true
  }
  if (e.ctrlKey && key === 'tab') {
    store.activateRelative(e.shiftKey ? -1 : 1)
    return true
  }
  if (mod && e.altKey && /^[1-9]$/.test(e.key)) {
    const tabs = store.tabs
    const idx = e.key === '9' ? tabs.length - 1 : Number(e.key) - 1
    if (tabs[idx]) store.activate(tabs[idx].id)
    return true
  }
  return false
}
