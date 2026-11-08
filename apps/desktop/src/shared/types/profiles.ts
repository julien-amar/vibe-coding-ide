import type { Harness } from './harness'

/** Launchable profiles (shells, WSL distributions, AI agents, tools such as k9s) and terminal sessions. */

/** A launchable entry shown in the `+` launcher. */
export type ProfileKind = 'shell' | 'wsl' | 'agent' | 'tool'

export interface Profile {
  id: string
  name: string
  kind: ProfileKind
  command: string
  args: string[]
  /** Where the executable was found (for display). */
  source?: string
  /** Extra environment for the process (e.g. shell integration). */
  env?: Record<string, string>
  /** Runs inside this WSL distribution (WSL shells and agents installed in WSL). */
  wslDistro?: string
}

export interface PtyCreateRequest {
  profileId: string
  cols: number
  rows: number
  cwd?: string
  /** AI agent panes: the pane's own settings (MCP servers, skills, instructions), given to the agent at launch. */
  harness?: Harness
  /** Folder that relative skill paths of `harness` start from (the project). */
  harnessRoot?: string
  /** A project's panel (not a tab of its own): no package update check. */
  panel?: boolean
}

export interface PtyCreateResult {
  sessionId: string
  title: string
}
