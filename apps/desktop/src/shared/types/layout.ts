import type { Harness } from './harness'
import type { ProfileKind } from './profiles'

/** Tabs, panes and windows: what is saved and restored, and moved between windows. */

/** Kinds of top-level tabs. Terminal-like tabs reuse the profile kind. */
export type TabKind = ProfileKind | 'project' | 'containers'

export type PaneType = 'terminal' | 'agent' | 'git' | 'tests'

/** Layout tree inside a tab: splits containing panes. */
export type LayoutNode =
  | { kind: 'split'; dir: 'row' | 'column'; sizes: number[]; children: LayoutNode[] }
  | {
      kind: 'pane'
      id: string
      type: PaneType
      /** Terminal/agent panes: the profile to launch. */
      profileId?: string
      /** Live session (absent when restoring from disk). */
      sessionId?: string
      /** Saved output, replayed when restoring from disk. */
      scrollback?: string
      /** Hidden from the layout and shown as a button in the project's side rail. */
      collapsed?: boolean
      /** Last known working directory (saved on exit, used on restore). */
      cwd?: string
      /** AI agent panes: this pane's own MCP servers, skills and instructions. */
      harness?: Harness
    }

export interface ProjectSnapshot {
  root: string
  name: string
  layout: LayoutNode
}

export interface RecentProject {
  root: string
  name: string
  lastOpened: number
}

/** Serializable description of a tab, used for moving tabs between windows and for layout restore. */
export interface TabSnapshot {
  kind: TabKind
  /** Terminal-like tabs: the profile to launch. */
  profileId?: string
  autoTitle: string
  customTitle?: string
  /** Live session (tab moved between windows). Absent when restoring from disk. */
  sessionId?: string
  /** Saved terminal output, replayed when restoring from disk. */
  scrollback?: string
  /** Project tabs: folder and pane layout. */
  project?: ProjectSnapshot
  /** Last known working directory of a terminal tab (saved on exit, used on restore). */
  cwd?: string
}

/** What a window should show when it starts. */
export interface WindowInit {
  windowId: number
  tabs: TabSnapshot[]
  activeIndex: number
  /**
   * The window comes from the saved layout: without tabs to restore (its last tab was closed), it
   * shows the welcome screen. A first window (nothing saved) opens a shell.
   */
  restored?: boolean
}

/** Tab state a window reports to the main process (for layout persistence). */
export interface WindowTabsState {
  tabs: TabSnapshot[]
  activeIndex: number
}

/** Payload carried by a tab drag (HTML5 drag and drop, works across app windows). */
export interface TabDragPayload {
  windowId: number
  tabId: string
  tab: TabSnapshot
}
