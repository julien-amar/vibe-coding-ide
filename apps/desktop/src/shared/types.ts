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
  /** AI agent panes: the pane's own settings (MCP servers, skills, instructions), given to the agent at launch. */
  harness?: Harness
  /** Folder that relative skill paths of `harness` start from (the project). */
  harnessRoot?: string
}

/** An MCP server of a harness. */
export interface McpServer {
  /** Unique within the harness (the server's name for the agent). */
  name: string
  /** stdio: a command the agent starts; http: a Streamable HTTP endpoint; sse: legacy HTTP + Server-Sent Events. */
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  /** stdio: environment variables of the server process. */
  env?: Record<string, string>
  url?: string
  /** http / sse: request headers (e.g. Authorization). */
  headers?: Record<string, string>
  enabled: boolean
}

/** A skill of a harness: a folder with a SKILL.md (or a folder of such folders). */
export interface HarnessSkill {
  path: string
  enabled: boolean
}

/**
 * Settings of one AI agent pane (kept with the pane in the app's layout, not in the repository):
 * MCP servers, skills and instructions, given to the agent in its own format at launch.
 */
export interface Harness {
  mcpServers: McpServer[]
  skills: HarnessSkill[]
  /** Added to the agent's system prompt. */
  instructions: string
  /** Use only the harness's MCP servers (not the user's or the repository's .mcp.json). */
  strictMcp?: boolean
  /** Use only the harness's skills (not the user's, the repository's or the agent's bundled ones). */
  strictSkills?: boolean
}

/** Result of starting an MCP server and listing its tools. */
export interface McpCheckResult {
  ok: boolean
  error?: string
  server?: { name?: string; version?: string }
  tools?: { name: string; description?: string }[]
  /** Last lines the server printed on stderr (stdio). */
  log?: string
}

/** A skill found on disk (SKILL.md front matter). */
export interface SkillInfo {
  path: string
  name: string
  description?: string
  /** harness: added to this project's harness; project: the repository's .claude/skills; user: ~/.claude/skills. */
  source: 'harness' | 'project' | 'user'
  /** Harness skills: the folder has no SKILL.md (moved or deleted). */
  missing?: boolean
}

/** What an agent supports of a harness. */
export interface AgentHarnessSupport {
  agent: string
  label: string
  mcp: boolean
  skills: boolean
  instructions: boolean
  /** "Only these servers": the agent can be made to ignore its other MCP configurations. */
  strictMcp: boolean
  /** "Only these skills": the agent can be made to ignore its other skills. */
  strictSkills: boolean
  /** How the settings reach the agent, or why they do not. */
  note?: string
}

/** Pending package updates of the system a shell runs on (shown as a status bar on its terminal). */
/** The app's own update (from GitHub Releases). */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  /** downloading: 0–100. */
  percent?: number
  /** available: the app cannot update itself (unsigned macOS app): download it from url. */
  manual?: boolean
  url?: string
  error?: string
}

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
export type TestFramework = 'vitest' | 'jest' | 'playwright' | 'pytest' | 'go' | 'cargo' | 'dotnet' | 'maven' | 'gradle'

/** A test (one per Playwright project when a config defines several). */
export interface TestCase {
  /** Stable id: framework-specific, unique within its TestProject. */
  id: string
  /**
   * First level of the tree, relative to the test project's folder with forward slashes: the
   * test file — or, where tests are not grouped by file, the Go package folder or the
   * .NET / JVM class.
   */
  file: string
  /** Enclosing describe() titles / modules / nested classes, outermost first. */
  suite: string[]
  name: string
  /** Line of the test in `source` (or `file`). */
  line?: number
  /** Source file of the test when `file` is not one (Go package, .NET / JVM class). */
  source?: string
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
  | 'applyLines'
  | 'prInfo'
  | 'createPr'

/** Where the repository is hosted and how pull requests are made (prInfo). */
export interface GitPullRequestInfo {
  /** The remote's host; undefined when it is not a known host (GitHub, GitLab, Bitbucket, Azure DevOps). */
  host?: 'github' | 'gitlab' | 'bitbucket' | 'azure'
  /** Command line tool creating the request in the app (gh / glab); without it, the host's page opens. */
  tool?: 'gh' | 'glab'
  /** Why the tool cannot be used (not logged in…). */
  toolError?: string
  branch?: string
  /** The remote's default branch (the usual target). */
  defaultBase?: string
  /** Remote branches a request can target. */
  bases: string[]
  /** Title proposed for a new request: the branch's last commit subject. */
  title?: string
  /** The open request of the branch, if any. */
  existing?: { number: number; url: string; title: string; state: string; draft?: boolean }
}

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
  /**
   * applyLines: stage / unstage / discard some changed lines of the file's diff (`staged`: the
   * staged diff). `lines` are indices in diffText.split('\n'); `diffText` is the diff shown, which
   * must still be the file's diff.
   */
  action?: 'stage' | 'unstage' | 'discard'
  lines?: number[]
  diffText?: string
  /** createPr: the request. */
  title?: string
  body?: string
  base?: string
  draft?: boolean
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
  /** prInfo: pull requests of the repository. */
  pr?: GitPullRequestInfo
  /** createPr: the new request's address (created by gh / glab), or the host's page to open. */
  url?: string
  /** createPr: the url is the host's "new pull request" page (no gh / glab), not a created request. */
  openPage?: boolean
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
    /** A test's result as soon as it finishes (the final report follows when the run ends). */
    onProgress(cb: (root: string, projectId: string, result: TestResult) => void): () => void
  }
  /** AI agent pane settings (each pane has its own harness, kept in the layout). */
  harness: {
    /** Start an MCP server (stdio) or call its endpoint (http) and list its tools. */
    check(root: string, server: McpServer): Promise<McpCheckResult>
    /** Skills of a harness, plus those the agent already finds in the repository and the user's folder. */
    skills(root: string, harness: Harness): Promise<SkillInfo[]>
    /** Contents of a skill's SKILL.md (for the preview). */
    readSkill(path: string): Promise<string>
    /** Folder picker for a skill (or a folder of skills). */
    pickSkillFolder(root: string): Promise<string | null>
    /** MCP servers of the repository's .mcp.json (to import). */
    projectMcpServers(root: string): Promise<McpServer[]>
    /** Which agents support which parts of a harness. */
    support(): Promise<AgentHarnessSupport[]>
  }
  update: {
    /** The current state (the window asks at start; changes arrive through onStatus). */
    status(): Promise<UpdateStatus>
    onStatus(cb: (s: UpdateStatus) => void): () => void
    check(): void
    /** Restart into the downloaded update. */
    install(): void
  }
  app: {
    openExternal(url: string): void
    /**
     * Open a file of the project at a line in the user's code editor (VS Code, Cursor, Zed…;
     * otherwise the system's default app). `file` may be relative to `base` (default: root).
     */
    openInEditor(root: string, file: string, line?: number, column?: number, base?: string): Promise<{ ok: boolean; error?: string }>
  }
}
