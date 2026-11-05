import { create } from 'zustand'
import type { Profile, ProfileKind } from '@shared/types'

export interface Tab {
  id: string
  kind: ProfileKind
  profileId: string
  sessionId: string
  /** Title set by the shell (OSC title) or the profile name. */
  autoTitle: string
  /** Title set by the user; overrides autoTitle when present. */
  customTitle?: string
  exitCode?: number
}

export const tabTitle = (t: Tab): string => t.customTitle ?? t.autoTitle

interface State {
  tabs: Tab[]
  activeId?: string
  launcherOpen: boolean
  openProfile(profile: Profile): Promise<void>
  close(id: string): void
  closeOthers(id: string): void
  activate(id: string): void
  activateRelative(delta: number): void
  rename(id: string, title: string | undefined): void
  setAutoTitle(id: string, title: string): void
  move(id: string, toIndex: number): void
  sessionExited(sessionId: string, code: number): void
  setLauncherOpen(open: boolean): void
}

let nextId = 1

export const useTabs = create<State>((set, get) => ({
  tabs: [],
  activeId: undefined,
  launcherOpen: false,

  async openProfile(profile) {
    set({ launcherOpen: false })
    const { sessionId, title } = await window.devhub.pty.create({ profileId: profile.id, cols: 80, rows: 24 })
    const tab: Tab = { id: `tab-${nextId++}`, kind: profile.kind, profileId: profile.id, sessionId, autoTitle: title }
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }))
  },

  close(id) {
    const { tabs, activeId } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const tab = tabs[idx]
    if (tab.exitCode === undefined) window.devhub.pty.kill(tab.sessionId)
    const rest = tabs.filter((t) => t.id !== id)
    const nextActive = activeId === id ? (rest[idx] ?? rest[idx - 1])?.id : activeId
    set({ tabs: rest, activeId: nextActive, launcherOpen: rest.length === 0 })
  },

  closeOthers(id) {
    for (const t of get().tabs) if (t.id !== id) get().close(t.id)
    set({ activeId: id })
  },

  activate(id) {
    set({ activeId: id })
  },

  activateRelative(delta) {
    const { tabs, activeId } = get()
    if (tabs.length === 0) return
    const idx = tabs.findIndex((t) => t.id === activeId)
    set({ activeId: tabs[(idx + delta + tabs.length) % tabs.length].id })
  },

  rename(id, title) {
    const clean = title?.trim()
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, customTitle: clean || undefined } : t)) }))
  },

  setAutoTitle(id, title) {
    if (!title) return
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, autoTitle: title } : t)) }))
  },

  move(id, toIndex) {
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id)
      if (from < 0) return s
      const tabs = [...s.tabs]
      const [tab] = tabs.splice(from, 1)
      tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab)
      return { tabs }
    })
  },

  sessionExited(sessionId, code) {
    const tab = get().tabs.find((t) => t.sessionId === sessionId)
    if (!tab) return
    // Like Windows Terminal: a clean exit closes the tab, a failure keeps it open.
    if (code === 0) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, exitCode: code } : t)) }))
      get().close(tab.id)
    } else {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, exitCode: code } : t)) }))
    }
  },

  setLauncherOpen(open) {
    set({ launcherOpen: open })
  }
}))
