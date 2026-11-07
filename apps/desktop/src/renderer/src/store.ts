import { create } from 'zustand'
import { appendPane, insertPane, mapPanes, movePane, newPaneId, panesOf, removePane, sessionIdsOf, type DropSide, type PaneNode } from '@shared/layout'
import { harnessIsEmpty } from '@shared/harness'
import type { AppSettings, Harness, LayoutNode, PaneType, Profile, ProjectSnapshot, TabKind, TabSnapshot } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { loadProfiles } from './profiles'

export interface Tab {
  id: string
  kind: TabKind
  /** Terminal-like tabs. */
  profileId?: string
  sessionId?: string
  /** Title set by the shell (OSC title), the profile or the project name. */
  autoTitle: string
  /** Title set by the user; overrides autoTitle when present. */
  customTitle?: string
  exitCode?: number
  /** Output saved from the previous app session, shown above the new shell. */
  restoredScrollback?: string
  /** Project tabs: folder and pane layout (pane.scrollback = restored output). */
  project?: ProjectSnapshot
}

export interface DropTarget {
  tabId: string
  side: 'before' | 'after'
}

/** Where a dragged project pane would land. */
export interface PaneDropTarget {
  paneId: string
  side: DropSide
}

export const tabTitle = (t: Tab): string => t.customTitle ?? t.autoTitle

export const toSnapshot = (t: Tab): TabSnapshot => ({
  kind: t.kind,
  profileId: t.profileId,
  autoTitle: t.autoTitle,
  customTitle: t.customTitle,
  sessionId: t.sessionId,
  project: t.project && { ...t.project, layout: mapPanes(t.project.layout, ({ scrollback: _s, ...p }) => p) }
})

/** Key the main process uses to tell a window which tab moved away. */
const tabKey = (t: Tab): string => sessionIdsOf(toSnapshot(t))[0] ?? `project:${t.project?.root ?? ''}`

interface State {
  windowId: number
  ready: boolean
  tabs: Tab[]
  activeId?: string
  launcherOpen: boolean
  drop?: DropTarget
  /** Exit codes of project pane sessions. */
  paneExit: Record<string, number>
  /** AI agent sessions started before their pane's settings changed (restart to apply). */
  harnessStale: Record<string, true>
  paneDrop?: PaneDropTarget
  init(): Promise<void>
  openProfile(profile: Profile): Promise<void>
  /** The Containers tab (one per window: focused when already open). */
  openContainers(): void
  openProject(root: string): Promise<void>
  /** Add a tab whose sessions already exist (moved from another window). */
  insertExisting(snapshot: TabSnapshot, index?: number): void
  /** Remove a tab whose sessions now belong to another window (no kill). */
  removeTransferred(key: string): void
  close(id: string): void
  closeOthers(id: string): void
  activate(id: string): void
  activateRelative(delta: number): void
  rename(id: string, title: string | undefined): void
  setAutoTitle(id: string, title: string): void
  move(id: string, toIndex: number): void
  sessionExited(sessionId: string, code: number): void
  setLauncherOpen(open: boolean): void
  setDrop(drop: DropTarget | undefined): void
  setLayout(tabId: string, layout: LayoutNode): void
  /**
   * A project tab rebuilt as a new one for its folder: the default panels (Git, Tests, terminal,
   * AI agent) with new processes; the previous panels' processes stop and their agent settings go.
   */
  resetLayout(tabId: string): Promise<void>
  /** Collapse a project pane into the side rail, or bring it back. */
  setPaneCollapsed(tabId: string, paneId: string, collapsed: boolean): void
  /** (Re)start a project pane, optionally with another profile (e.g. switch agent). */
  restartPane(tabId: string, paneId: string, profileId?: string): Promise<void>
  /** Add a panel to a project: next to `target` on `side`, or on the right edge. */
  addPane(tabId: string, type: PaneType, opts?: { target?: string; side?: DropSide; profileId?: string }): Promise<void>
  /** Close a project panel (stops its process). */
  closePane(tabId: string, paneId: string): void
  /** Move a project panel next to another one. */
  movePane(tabId: string, paneId: string, targetId: string, side: DropSide): void
  setPaneDrop(drop: PaneDropTarget | undefined): void
  /** Change an AI agent pane's own settings (MCP servers, skills, instructions); its running agent is marked stale. */
  setPaneHarness(tabId: string, paneId: string, harness: Harness): void
}

let nextId = 1
const newTabId = (): string => `tab-${nextId++}`

async function profiles(): Promise<Profile[]> {
  return window.ide.profiles.list()
}

/** Default shell and AI agent chosen in Settings (kept current: loaded at start, updated on change). */
let preferred: { shell?: string; agent?: string } = {}
const setPreferred = (s: AppSettings): void => {
  preferred = { shell: s.defaultShell, agent: s.defaultAgent }
}
void window.ide.settings.get().then(setPreferred)
window.ide.settings.onChanged(setPreferred)

/** Shell for a folder: the distro's own shell for folders inside WSL, else the default (Settings), else the first shell. */
const defaultShell = (list: Profile[], root?: string): Profile | undefined => {
  const distro = root && parseWslPath(root)?.distro.toLowerCase()
  return (
    (distro && list.find((p) => p.kind === 'wsl' && p.wslDistro?.toLowerCase() === distro)) ||
    list.find((p) => p.id === preferred.shell && p.kind !== 'agent') ||
    list.find((p) => p.kind === 'shell') ||
    list[0]
  )
}

/** Agent for a folder: one installed in the folder's WSL distro if any, else the default (Settings), else the first agent. */
const defaultAgent = (list: Profile[], root?: string): Profile | undefined => {
  const distro = root && parseWslPath(root)?.distro.toLowerCase()
  return (
    (distro && list.find((p) => p.kind === 'agent' && p.wslDistro?.toLowerCase() === distro)) ||
    list.find((p) => p.id === preferred.agent && p.kind === 'agent') ||
    list.find((p) => p.kind === 'agent' && !p.wslDistro)
  )
}

/** Profiles, including agents installed in the WSL distro of `root` (discovered on first use). */
async function profilesFor(root: string): Promise<Profile[]> {
  const wsl = parseWslPath(root)
  if (wsl) {
    await window.ide.profiles.wslAgents(wsl.distro)
    return loadProfiles(true)
  }
  return profiles()
}

async function createSession(
  profileId: string,
  cwd?: string,
  harnessRoot?: string,
  harness?: Harness
): Promise<{ sessionId: string; title: string } | undefined> {
  try {
    // harness: an AI agent pane's own settings (relative skill paths start from harnessRoot, the project).
    // Panels of a project (they have its folder) get no package update check (a tab's business).
    return await window.ide.pty.create({ profileId, cols: 80, rows: 24, cwd, harnessRoot, harness, panel: harnessRoot !== undefined })
  } catch {
    return undefined
  }
}

/** Start sessions for every terminal/agent pane that has none (new or restored project). */
async function startPaneSessions(layout: LayoutNode, cwd: string): Promise<LayoutNode> {
  const started = new Map<string, string>()
  for (const p of panesOf(layout)) {
    if ((p.type !== 'terminal' && p.type !== 'agent') || p.sessionId || !p.profileId) continue
    const s = await createSession(p.profileId, p.cwd ?? cwd, cwd, p.harness)
    if (s) started.set(p.id, s.sessionId)
  }
  return mapPanes(layout, (p) => (started.has(p.id) ? { ...p, sessionId: started.get(p.id) } : p))
}

function defaultProjectLayout(shell?: Profile, agent?: Profile): LayoutNode {
  const git: PaneNode = { kind: 'pane', id: 'git', type: 'git' }
  const term: PaneNode = { kind: 'pane', id: 'terminal', type: 'terminal', profileId: shell?.id }
  const ai: PaneNode = { kind: 'pane', id: 'agent', type: 'agent', profileId: agent?.id }
  // Tests start collapsed in the side rail (discovery runs the project's test tools: only on demand).
  const tests: PaneNode = { kind: 'pane', id: 'tests', type: 'tests', collapsed: true }
  return {
    kind: 'split',
    dir: 'row',
    sizes: [0.6, 0.4],
    // Shown, Tests gets the largest share of the column (a test tree needs height); hidden, its
    // share goes to the other panels.
    children: [{ kind: 'split', dir: 'column', sizes: [0.33, 0.42, 0.25], children: [git, tests, term] }, ai]
  }
}

function projectName(root: string): string {
  return (
    root
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || root
  )
}

async function openDefaultShell(): Promise<void> {
  const shell = defaultShell(await profiles())
  if (shell) await useTabs.getState().openProfile(shell)
  else useTabs.getState().setLauncherOpen(true)
}

function tabFromLiveSnapshot(snap: TabSnapshot): Tab {
  return {
    id: newTabId(),
    kind: snap.kind,
    profileId: snap.profileId,
    sessionId: snap.sessionId,
    autoTitle: snap.autoTitle,
    customTitle: snap.customTitle,
    project: snap.project
  }
}

export const useTabs = create<State>((set, get) => ({
  windowId: -1,
  ready: false,
  tabs: [],
  activeId: undefined,
  launcherOpen: false,
  drop: undefined,
  paneExit: {},
  harnessStale: {},

  async init() {
    const init = await window.ide.window.init()
    set({ windowId: init.windowId })
    const list = await profiles()
    const tabs: Tab[] = []
    for (const snap of init.tabs) {
      if (sessionIdsOf(snap).length > 0) {
        // Live sessions handed over by another window.
        tabs.push(tabFromLiveSnapshot(snap))
        continue
      }
      if (snap.project) {
        // Restored project: start fresh sessions in the project folder; panes keep their saved output.
        if (parseWslPath(snap.project.root)) await profilesFor(snap.project.root) // agents installed in WSL
        const layout = await startPaneSessions(snap.project.layout, snap.project.root)
        tabs.push({ id: newTabId(), kind: 'project', autoTitle: snap.project.name, customTitle: snap.customTitle, project: { ...snap.project, layout } })
        continue
      }
      if (snap.kind === 'containers') {
        tabs.push({ id: newTabId(), kind: 'containers', profileId: snap.profileId, autoTitle: 'Containers', customTitle: snap.customTitle })
        continue
      }
      // Restored terminal tab: start a fresh session with the same profile.
      const profile = list.find((p) => p.id === snap.profileId)
      if (!profile) continue
      const s = await createSession(profile.id, snap.cwd)
      if (!s) continue
      tabs.push({
        id: newTabId(),
        kind: profile.kind,
        profileId: profile.id,
        sessionId: s.sessionId,
        autoTitle: s.title,
        customTitle: snap.customTitle,
        restoredScrollback: snap.scrollback
      })
    }
    const active = tabs[Math.min(init.activeIndex, tabs.length - 1)]
    set({ tabs, activeId: active?.id, ready: true })
    // Nothing to restore: a window whose last tab was closed shows the welcome screen; a first
    // window (nothing saved yet) opens a shell.
    if (tabs.length === 0 && !init.restored) await openDefaultShell()
  },

  openContainers() {
    set({ launcherOpen: false })
    const existing = get().tabs.find((t) => t.kind === 'containers')
    if (existing) return set({ activeId: existing.id })
    const tab: Tab = { id: newTabId(), kind: 'containers', autoTitle: 'Containers' }
    set((st) => ({ tabs: [...st.tabs, tab], activeId: tab.id }))
  },

  async openProfile(profile) {
    set({ launcherOpen: false })
    const s = await createSession(profile.id)
    if (!s) return
    const tab: Tab = { id: newTabId(), kind: profile.kind, profileId: profile.id, sessionId: s.sessionId, autoTitle: s.title }
    set((st) => ({ tabs: [...st.tabs, tab], activeId: tab.id }))
  },

  async openProject(root) {
    set({ launcherOpen: false })
    if (!root.trim()) return
    // Re-opening an already open project just focuses it.
    const existing = get().tabs.find((t) => t.project?.root.toLowerCase() === root.toLowerCase())
    if (existing) {
      set({ activeId: existing.id })
      return
    }
    const list = await profilesFor(root)
    const layout = await startPaneSessions(defaultProjectLayout(defaultShell(list, root), defaultAgent(list, root)), root)
    const name = projectName(root)
    const tab: Tab = { id: newTabId(), kind: 'project', autoTitle: name, project: { root, name, layout } }
    window.ide.project.touch(root)
    set((st) => ({ tabs: [...st.tabs, tab], activeId: tab.id }))
  },

  insertExisting(snap, index) {
    const tab = tabFromLiveSnapshot(snap)
    set((s) => {
      const tabs = [...s.tabs]
      tabs.splice(index ?? tabs.length, 0, tab)
      return { tabs, activeId: tab.id }
    })
  },

  removeTransferred(key) {
    const { tabs, activeId } = get()
    const idx = tabs.findIndex((t) => tabKey(t) === key)
    if (idx < 0) return
    const rest = tabs.filter((_, i) => i !== idx)
    const nextActive = activeId === tabs[idx].id ? (rest[idx] ?? rest[idx - 1])?.id : activeId
    set({ tabs: rest, activeId: nextActive })
    // The last tab left this window: the window has nothing to show anymore.
    // After the tab list is reported (queued as a microtask above): the saved layout has the window
    // without tabs, so the next start shows the welcome screen instead of restoring a closed tab.
    if (rest.length === 0) queueMicrotask(() => window.ide.window.close())
  },

  close(id) {
    const { tabs, activeId, paneExit } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const tab = tabs[idx]
    for (const sid of sessionIdsOf(toSnapshot(tab))) {
      if (tab.exitCode === undefined && paneExit[sid] === undefined) window.ide.pty.kill(sid)
    }
    const rest = tabs.filter((t) => t.id !== id)
    const nextActive = activeId === id ? (rest[idx] ?? rest[idx - 1])?.id : activeId
    set({ tabs: rest, activeId: nextActive })
    // Like Windows Terminal: closing the last tab closes the window.
    // After the tab list is reported (queued as a microtask above): the saved layout has the window
    // without tabs, so the next start shows the welcome screen instead of restoring a closed tab.
    if (rest.length === 0) queueMicrotask(() => window.ide.window.close())
  },

  closeOthers(id) {
    for (const t of get().tabs) if (t.id !== id) get().close(t.id)
    set({ activeId: id, launcherOpen: false })
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
    // Windows shells often set the title to their own executable path; keep the profile name instead.
    if (/^[a-z]:\\.*\.exe$/i.test(title.trim())) return
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.kind !== 'project' ? { ...t, autoTitle: title } : t)) }))
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
    if (tab) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, exitCode: code } : t)) }))
      // Like Windows Terminal: a clean exit closes the tab, a failure keeps it open.
      if (code === 0) get().close(tab.id)
      return
    }
    // A project pane: keep the pane, offer a restart.
    if (get().tabs.some((t) => t.project && panesOf(t.project.layout).some((p) => p.sessionId === sessionId))) {
      set((s) => ({ paneExit: { ...s.paneExit, [sessionId]: code } }))
    }
  },

  setLauncherOpen(open) {
    set({ launcherOpen: open })
  },

  setDrop(drop) {
    const cur = get().drop
    if (cur?.tabId === drop?.tabId && cur?.side === drop?.side) return
    set({ drop })
  },

  async resetLayout(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.project) return
    const { root, layout } = tab.project
    // Every panel's process stops (its settings with it)...
    const { paneExit } = get()
    for (const p of panesOf(layout)) if (p.sessionId && paneExit[p.sessionId] === undefined) window.ide.pty.kill(p.sessionId)
    // ...and the tab gets what a new project tab for the folder gets (new panel ids: new views).
    const list = await profilesFor(root)
    const fresh = mapPanes(defaultProjectLayout(defaultShell(list, root), defaultAgent(list, root)), (p) => ({ ...p, id: newPaneId() }))
    get().setLayout(tabId, await startPaneSessions(fresh, root))
  },

  setLayout(tabId, layout) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.project ? { ...t, project: { ...t.project, layout } } : t)) }))
  },

  setPaneCollapsed(tabId, paneId, collapsed) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.project) return
    get().setLayout(
      tabId,
      mapPanes(tab.project.layout, (p) => (p.id === paneId ? { ...p, collapsed: collapsed || undefined } : p))
    )
  },

  async addPane(tabId, type, opts = {}) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.project) return
    const list = await profilesFor(tab.project.root)
    const root = tab.project.root
    const profileId =
      type !== 'terminal' && type !== 'agent' ? undefined : (opts.profileId ?? (type === 'agent' ? defaultAgent(list, root) : defaultShell(list, root))?.id)
    const pane: PaneNode = { kind: 'pane', id: newPaneId(), type, profileId }
    if (profileId) {
      const s = await createSession(profileId, tab.project.root, tab.project.root)
      pane.sessionId = s?.sessionId
    }
    const cur = get().tabs.find((t) => t.id === tabId)
    if (!cur?.project) return
    const layout = opts.target && opts.side ? insertPane(cur.project.layout, opts.target, pane, opts.side) : appendPane(cur.project.layout, pane)
    get().setLayout(tabId, layout)
  },

  closePane(tabId, paneId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    const pane = tab?.project && panesOf(tab.project.layout).find((p) => p.id === paneId)
    if (!tab?.project || !pane) return
    const rest = removePane(tab.project.layout, paneId)
    if (!rest) return // a project keeps at least one panel
    if (pane.sessionId && get().paneExit[pane.sessionId] === undefined) window.ide.pty.kill(pane.sessionId)
    get().setLayout(tabId, rest)
  },

  movePane(tabId, paneId, targetId, side) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.project) return
    get().setLayout(tabId, movePane(tab.project.layout, paneId, targetId, side))
  },

  setPaneHarness(tabId, paneId, harness) {
    const tab = get().tabs.find((t) => t.id === tabId)
    const pane = tab?.project && panesOf(tab.project.layout).find((p) => p.id === paneId)
    if (!tab?.project || !pane) return
    get().setLayout(
      tabId,
      mapPanes(tab.project.layout, (p) => (p.id === paneId ? { ...p, harness: harnessIsEmpty(harness) ? undefined : harness } : p))
    )
    // Its running agent started with the previous settings.
    if (pane.sessionId && get().paneExit[pane.sessionId] === undefined) set((st) => ({ harnessStale: { ...st.harnessStale, [pane.sessionId!]: true } }))
  },

  setPaneDrop(drop) {
    const cur = get().paneDrop
    if (cur?.paneId === drop?.paneId && cur?.side === drop?.side) return
    set({ paneDrop: drop })
  },

  async restartPane(tabId, paneId, profileId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    const pane = tab?.project && panesOf(tab.project.layout).find((p) => p.id === paneId)
    if (!tab?.project || !pane) return
    const nextProfile = profileId ?? pane.profileId
    if (!nextProfile) return
    if (pane.sessionId && get().paneExit[pane.sessionId] === undefined) window.ide.pty.kill(pane.sessionId)
    const s = await createSession(nextProfile, tab.project.root, tab.project.root, pane.harness)
    const cur = get().tabs.find((t) => t.id === tabId)
    if (!cur?.project) return
    get().setLayout(
      tabId,
      mapPanes(cur.project.layout, (p) => (p.id === paneId ? { ...p, profileId: nextProfile, sessionId: s?.sessionId, scrollback: undefined } : p))
    )
  }
}))

// Report tab layout to the main process (it persists the layout to disk).
let reportQueued = false
useTabs.subscribe((s, prev) => {
  if (!s.ready || (s.tabs === prev.tabs && s.activeId === prev.activeId) || reportQueued) return
  reportQueued = true
  queueMicrotask(() => {
    reportQueued = false
    const { tabs, activeId } = useTabs.getState()
    window.ide.window.reportState({
      tabs: tabs.map(toSnapshot),
      activeIndex: Math.max(
        0,
        tabs.findIndex((t) => t.id === activeId)
      )
    })
  })
})

window.ide.window.onTabTransferred((key) => useTabs.getState().removeTransferred(key))

// Debugging aid for automated UI checks over DevTools (only with remote debugging / VIBE_CODING_IDE_DEBUG=1).
if (window.ide.debug) (window as unknown as { __vibeIdeTabs: typeof useTabs }).__vibeIdeTabs = useTabs
