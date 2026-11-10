import type {
  ContainerAction,
  ContainerBackendId,
  ContainerBackendInfo,
  ContainerFileEntry,
  ContainerJob,
  ContainerListKind,
  ContainerListResult,
  ContainerSpec,
  ContainerStreamEvent,
  ContainerTarget,
  CreateOptions,
  ImageSuggestion
} from './containers'
import type { GitLog, GitLogPage, GitOpRequest, GitOpResult, GitRepo } from './git'
import type { AgentHarnessSupport, Harness, McpCheckResult, McpServer, SkillInfo } from './harness'
import type { RecentProject, TabSnapshot, WindowInit, WindowTabsState } from './layout'
import type { Profile, PtyCreateRequest, PtyCreateResult } from './profiles'
import type { AppSettings } from './settings'
import type { TestProject, TestResult, TestRunRequest, TestRunResult } from './tests'
import type { PackageUpdateInfo, UpdateStatus } from './updates'

/** The API the preload script exposes on `window.ide`. */

/** API exposed by the preload script on `window.ide`. */
export interface IdeApi {
  platform: NodeJS.Platform
  /** Debugging hooks for automated UI checks are exposed (remote debugging or VIBE_CODING_IDE_DEBUG=1). */
  debug: boolean
  profiles: {
    /** The profiles offered (hidden ones and, with WSL off, distributions left out). */
    list(refresh?: boolean): Promise<Profile[]>
    /** Every profile found, hidden ones included (Settings screen). */
    all(): Promise<Profile[]>
    /** Icon of the installed shell/distro/agent as a data: URL, or null (draw a monogram). */
    icon(profileId: string): Promise<string | null>
    /** Agent CLIs installed inside a WSL distribution (starts the distro; cached). */
    wslAgents(distro: string): Promise<Profile[]>
    /** Tools (k9s) inside WSL distributions: looked for once, at app start (resolves when done). */
    wslTools(): Promise<Profile[]>
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
    /** Removes a project from the recent list. */
    forget(root: string): Promise<void>
  }
  git: {
    /** The history (all branches, newest first), a page at a time (default: the first 1000 commits). */
    log(root: string, page?: GitLogPage): Promise<GitLog>
    /** The git repositories of a project folder (itself, and those below it). */
    repos(root: string): Promise<GitRepo[]>
    /** Status, diffs and repository actions (see GitOpRequest). */
    op(root: string, req: GitOpRequest): Promise<GitOpResult>
    watch(root: string): void
    unwatch(root: string): void
    onChanged(cb: (root: string) => void): () => void
  }
  tests: {
    /** Find test frameworks in the project and list their tests (each project also through onProject, as soon as listed). */
    discover(root: string): Promise<TestProject[]>
    /** A test project of a discovery in progress, as soon as its tests are listed (`index`: its place in the panel). */
    onProject(cb: (root: string, project: TestProject, index: number) => void): () => void
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
  containers: {
    /** The engines found (Docker, Podman, wslc) and whether they answer. */
    backends(): Promise<ContainerBackendInfo[]>
    list(backend: ContainerBackendId, kind: ContainerListKind): Promise<ContainerListResult>
    action(backend: ContainerBackendId, target: ContainerTarget, id: string, action: ContainerAction): Promise<{ ok: boolean; error?: string }>
    /** Removes the unused images / volumes / networks, or the stopped containers. */
    prune(backend: ContainerBackendId, target: ContainerTarget): Promise<{ ok: boolean; error?: string; text?: string }>
    /** A volume or network; `name` empty: the engine names it (volumes). */
    create(backend: ContainerBackendId, target: 'volume' | 'network', name: string, options?: CreateOptions): Promise<{ ok: boolean; error?: string }>
    inspect(backend: ContainerBackendId, target: ContainerTarget, id: string): Promise<{ ok: boolean; error?: string; text?: string }>
    /** Streams (a container's logs or stats, a job's output): events arrive through onStream. */
    logs(backend: ContainerBackendId, id: string): Promise<string>
    stats(backend: ContainerBackendId, id: string): Promise<string>
    job(backend: ContainerBackendId, job: ContainerJob): Promise<string>
    stopStream(stream: string): void
    onStream(cb: (e: ContainerStreamEvent) => void): () => void
    /** A terminal profile running a shell in a container, or the engine's registry login. */
    shellProfile(backend: ContainerBackendId, id: string, name?: string): Promise<Profile | null>
    loginProfile(backend: ContainerBackendId, registry: string): Promise<Profile | null>
    /** A container's editable settings: environment, mounts, published ports. */
    spec(backend: ContainerBackendId, id: string): Promise<{ ok: boolean; spec?: ContainerSpec; error?: string }>
    /** Recreates a container with some settings changed (Docker, Podman); the new container's id. */
    recreate(
      backend: ContainerBackendId,
      id: string,
      change: Partial<Pick<ContainerSpec, 'env' | 'mounts' | 'ports'>>
    ): Promise<{ ok: boolean; id?: string; error?: string }>
    /** Suggestions for "Pull an image" (registry search; tags after a colon). */
    searchImages(backend: ContainerBackendId, input: string): Promise<{ ok: boolean; items: ImageSuggestion[]; error?: string }>
    /** A folder of a running container. */
    listFiles(backend: ContainerBackendId, id: string, path: string): Promise<{ ok: boolean; path: string; entries?: ContainerFileEntry[]; error?: string }>
    /** The beginning of a file of a running container (text), or `binary`. */
    readFile(
      backend: ContainerBackendId,
      id: string,
      path: string
    ): Promise<{ ok: boolean; text?: string; truncated?: boolean; binary?: boolean; error?: string }>
    /** Copies a file of a running container to this machine (asks where); null if cancelled. */
    saveFile(backend: ContainerBackendId, id: string, path: string): Promise<{ ok: boolean; error?: string; savedTo?: string } | null>
  }
  settings: {
    get(): Promise<AppSettings>
    /** Changes some settings; every window gets the result through onChanged. */
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    onChanged(cb: (s: AppSettings) => void): () => void
    /** Every setting back to its default. */
    reset(): Promise<AppSettings>
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
    /** The application's version (package.json). */
    version(): Promise<string>
    openExternal(url: string): void
    /**
     * Open a file of the project at a line in the user's code editor (VS Code, Cursor, Zed…;
     * otherwise the system's default app). `file` may be relative to `base` (default: root).
     */
    openInEditor(root: string, file: string, line?: number, column?: number, base?: string): Promise<{ ok: boolean; error?: string }>
  }
}
