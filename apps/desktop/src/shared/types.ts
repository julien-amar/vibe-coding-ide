/** A launchable entry shown in the `+` launcher. */
export type ProfileKind = 'shell' | 'wsl' | 'agent'

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
}

/** Pending package updates of the system a shell runs on (shown as a status bar on its terminal). */
export interface PackageUpdateInfo {
  /** "Windows" or the WSL distribution name. */
  system: string
  /** winget, apt, dnf, pacman, apk, zypper */
  manager: string
  count: number
  /** Typed into the terminal when the user accepts. */
  command: string
}

export interface PtyCreateResult {
  sessionId: string
  title: string
}

/** Kinds of top-level tabs. Terminal-like tabs reuse the profile kind. */
export type TabKind = ProfileKind | 'project'

export type PaneType = 'terminal' | 'agent' | 'git' | 'tests'

/** Test frameworks the Tests panel can discover and run. */
export type TestFramework = 'vitest' | 'playwright'

/** A test (one per Playwright project when a config defines several). */
export interface TestCase {
  /** Stable id: framework-specific, unique within its TestProject. */
  id: string
  /** File relative to the test project's folder, with forward slashes. */
  file: string
  /** Enclosing describe() titles, outermost first. */
  suite: string[]
  name: string
  line?: number
  /** Playwright project name (several projects run the same spec). */
  projectName?: string
}

/** A folder with a test framework config (a repo can hold several, e.g. in a monorepo). */
export interface TestProject {
  /** `<framework>:<folder relative to the project root>` */
  id: string
  framework: TestFramework
  /** Absolute folder (Windows or \\wsl.localhost path). */
  dir: string
  /** Folder relative to the project root ('' = the root). */
  relDir: string
  tests: TestCase[]
  /** Discovery failed (output of the listing command). */
  error?: string
}

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'running'

export interface TestResult {
  id: string
  status: Exclude<TestStatus, 'running'>
  /** Milliseconds. */
  duration?: number
  /** Failure message and stack (plain text). */
  message?: string
  /** Passed only after a retry. */
  flaky?: boolean
}

/** What to run: a whole test project, a file, or a suite / test inside a file. */
export interface TestRunRequest {
  projectId: string
  file?: string
  /** Suite titles (and the test name last, for a single test) inside `file`. */
  titlePath?: string[]
  /** Line of the suite / test (Playwright runs by file:line). */
  line?: number
}

export interface TestRunResult {
  ok: boolean
  /** The run could not start or produced no report. */
  error?: string
  results: TestResult[]
  /** Files that failed before running their tests (syntax error, failing import…). */
  fileErrors: { file: string; message: string }[]
  cancelled?: boolean
}

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

export interface GitCommit {
  hash: string
  parents: string[]
  author: string
  /** Unix seconds. */
  date: number
  refs: string[]
  subject: string
}

export interface GitLog {
  isRepo: boolean
  error?: string
  branch?: string
  commits: GitCommit[]
}

export interface GitStatusFile {
  path: string
  /** Original path of a rename/copy. */
  origPath?: string
  /** Staged state (porcelain X): ' ', M, A, D, R, C, U, ? */
  index: string
  /** Working-tree state (porcelain Y): ' ', M, D, U, ? */
  worktree: string
}

export interface GitStatus {
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  files: GitStatusFile[]
}

export interface GitBranch {
  name: string
  remote: boolean
  current: boolean
  upstream?: string
  ahead: number
  behind: number
  /** Upstream branch was deleted on the remote. */
  gone: boolean
  /** Unix seconds of the tip commit. */
  date: number
  subject: string
}

export interface GitWorktree {
  path: string
  branch?: string
  head?: string
  main: boolean
  detached?: boolean
  locked?: boolean
  prunable?: boolean
}

export type GitOp =
  | 'status'
  | 'diff'
  | 'stage'
  | 'unstage'
  | 'discard'
  | 'commit'
  | 'branches'
  | 'switch'
  | 'createBranch'
  | 'renameBranch'
  | 'deleteBranch'
  | 'merge'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'addWorktree'
  | 'removeWorktree'
  | 'commitFiles'
  | 'commitDiff'

export interface GitOpRequest {
  op: GitOp
  path?: string
  paths?: string[]
  staged?: boolean
  untracked?: boolean
  message?: string
  amend?: boolean
  branch?: string
  newName?: string
  start?: string
  checkout?: boolean
  remote?: boolean
  force?: boolean
  /** commitFiles / commitDiff: the commit, and the parent to compare with (none = root commit). */
  hash?: string
  parent?: string
  /** commitDiff: previous path of a renamed file. */
  origPath?: string
}

/** A file changed by a commit. */
export interface GitCommitFile {
  path: string
  origPath?: string
  /** A, M, D, R, C, T */
  status: string
}

export interface GitOpResult {
  ok: boolean
  error?: string
  /** Command output (diff text, commit summary…). */
  text?: string
  status?: GitStatus
  branches?: GitBranch[]
  worktrees?: GitWorktree[]
  /** New worktree folder (addWorktree). */
  path?: string
  /** commitFiles: files changed by the commit (text = full commit message). */
  files?: GitCommitFile[]
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

/** API exposed by the preload script on `window.ide`. */
export interface IdeApi {
  platform: NodeJS.Platform
  /** Debugging hooks for automated UI checks are exposed (remote debugging or VIBE_CODING_IDE_DEBUG=1). */
  debug: boolean
  profiles: {
    list(refresh?: boolean): Promise<Profile[]>
    /** Icon of the installed shell/distro/agent as a data: URL, or null (draw a monogram). */
    icon(profileId: string): Promise<string | null>
    /** Agent CLIs installed inside a WSL distribution (starts the distro; cached). */
    wslAgents(distro: string): Promise<Profile[]>
  }
  pty: {
    create(req: PtyCreateRequest): Promise<PtyCreateResult>
    /** Subscribe this window to a session; returns the buffered output so far. */
    attach(sessionId: string): Promise<string>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    kill(sessionId: string): void
    onData(cb: (sessionId: string, data: string) => void): () => void
    onExit(cb: (sessionId: string, exitCode: number) => void): () => void
    /** Pending package updates for a session's system (null if none / not checked / dismissed). */
    updates(sessionId: string): Promise<PackageUpdateInfo | null>
    /** Hide the update bar of a session; `accepted` = the user ran the update. */
    dismissUpdates(sessionId: string, accepted: boolean): void
    onUpdates(cb: (sessionId: string, info: PackageUpdateInfo) => void): () => void
  }
  window: {
    init(): Promise<WindowInit>
    reportState(state: WindowTabsState): void
    /** Move a tab into a brand-new window at the given screen position. */
    detachTab(tab: TabSnapshot, screenX: number, screenY: number): Promise<boolean>
    /** Take over a tab dragged from another window. */
    adoptTab(tab: TabSnapshot, fromWindowId: number): Promise<boolean>
    /** Fired when one of this window's tabs was moved to another window. */
    onTabTransferred(cb: (key: string) => void): () => void
    close(): void
  }
  project: {
    /** Folder picker; `defaultPath` is where it starts (e.g. a WSL home). */
    pickFolder(defaultPath?: string): Promise<string | null>
    recent(): Promise<RecentProject[]>
    touch(root: string): void
  }
  git: {
    log(root: string): Promise<GitLog>
    /** Status, diffs and repository actions (see GitOpRequest). */
    op(root: string, req: GitOpRequest): Promise<GitOpResult>
    watch(root: string): void
    unwatch(root: string): void
    onChanged(cb: (root: string) => void): () => void
  }
  tests: {
    /** Find test frameworks in the project and list their tests. */
    discover(root: string): Promise<TestProject[]>
    /** Run tests (one run per project root at a time); output streams through onOutput. */
    run(root: string, req: TestRunRequest): Promise<TestRunResult>
    stop(root: string): void
    onOutput(cb: (root: string, text: string) => void): () => void
  }
  app: {
    openExternal(url: string): void
  }
}
