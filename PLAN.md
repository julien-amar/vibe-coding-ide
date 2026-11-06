# vibe-coding-ide — Project Plan

> **vibe-coding-ide** (working name). An open-source, cross-platform application that hosts a complete development environment as isolated, tabbed workspaces — inspired by Windows Terminal's tab model, extended with project workspaces (git, editor, terminal, AI agents, tests, harness), containers, file transfer, browsing and messaging.

---

## 0. Decisions log

| Topic | Decision |
|---|---|
| Name | **vibe-coding-ide** (placeholder; appId `io.github.julien-amar.vibe-coding-ide`, config dir `vibe-coding-ide`) |
| License | **MIT**, public GitHub repository |
| Platforms | **Windows, macOS and Linux from day one** |
| Stack | Electron + TypeScript, **React** renderer |
| Tooling | **pnpm** workspaces + **electron-vite**; `electron-builder` for packaging |
| CI / release | **GitHub Actions** 3-OS matrix, **signed** installers, auto-update via GitHub Releases |
| Project locations | **Local, WSL, remote SSH, dev container** — all four in the project-tab phase |
| Editor | **Full editor with LSP via embedded OpenVSCode Server** running on the project's target |
| AI panel v1 | **Agent CLI in a terminal pane** |
| Agents supported first | **Claude Code, pi, OpenAI Codex CLI, Gemini CLI, opencode** |
| Test frameworks (first release) | **Vitest, Jest, pytest, .NET, Go, Rust, JVM (Gradle/Maven)** |
| SSH auth | **Keys + ssh-agent, password, `~/.ssh/config`, FIDO2 hardware keys & certificates** |
| Browser extras | **Bookmarks, Chrome extensions (Electron subset), password autofill, ad/tracker blocking** |
| Container extras | **Compose up/down/logs, live stats, registry login, image build** |
| Extension API | **Public from Phase 1** — built-in tab types are implemented on the same API |
| i18n | **English only, i18n-ready strings** from day one |
| Priority after core | **Project tab (targets, git, editor, AI, tests, harness)** |

---

## 1. Goals

1. **Tabbed application** — tabs can be renamed, reordered, and dragged out into their own window (and back).
2. **`+` launcher tab** — always present; opens a picker for the tab type to create.
3. **Isolated tabs** — no tab can interact with another tab (storage, IPC, sessions, extensions).
4. **Layout restore** — windows, tabs, splits and sub-tabs are restored on restart.
5. **Project workspaces** — a project tab contains sub-tabs / split panes: git, editor, terminal, AI agent, tests, harness — wherever the project lives (local, WSL, SSH, container).
6. **Extensible** — third parties can add tab and pane types through a public API.
7. **One app for the whole dev workflow**, on all three desktop OSes.

### Non-goals (initially)
- OS-level sandboxing of shell processes (see §8.3).
- Mobile / web-hosted version.
- Settings sync across machines (later, possibly via a gist/git repo).

---

## 2. Tab types

| Type | Description | Key building blocks |
|---|---|---|
| **Shell** | Any shell found on the machine, WSL distros on Windows, SSH hosts | `xterm.js`, `node-pty`, system OpenSSH |
| **Project** | Composite workspace bound to a folder on an execution target (§5, §6) | Layout tree + pane types |
| **S/FTP client** | Remote file manager, drag & drop upload/download, favorites | SSH layer (§5.3), `basic-ftp` |
| **Web browser** | Full Chromium browser tab with bookmarks, extensions, autofill, ad-blocking | Electron `WebContentsView` |
| **Messaging** | Slack, WhatsApp, Teams, Discord… via their web apps | Isolated `WebContentsView` + presets |
| **Containers** | wslc / Docker / Podman — containers, images, volumes, networks, compose, stats, build | `dockerode`, `wslc.exe` wrapper |
| **AI session** | Terminal running the user's preferred agent CLI | Shell pane + agent registry |

### 2.1 Shell discovery
- Scan `PATH` for known shells: `pwsh`, `powershell`, `cmd`, `bash`, `zsh`, `fish`, `nu`, `sh`, `elvish`, `xonsh`.
- Windows: detect Git Bash (`%ProgramFiles%\Git\bin\bash.exe`), MSYS2, Cygwin; WSL distros via `wsl.exe -l -q` (**output is UTF-16LE**), launched with `wsl.exe -d <distro> --cd <path>`.
- macOS/Linux: read `/etc/shells`, `$SHELL` as default, login shell semantics (`-l`) on macOS.
- SSH hosts from `~/.ssh/config` (`Host` entries, excluding wildcards).
- User-defined custom profiles (command, args, cwd, env, icon, target).

### 2.2 S/FTP client
- Protocols: SFTP (primary), FTP/FTPS.
- Dual-pane view local ↔ remote; HTML5 drag & drop from OS file manager into remote pane; drag remote → local to download.
- Transfer queue: progress, pause/cancel, retry, conflict policy (overwrite / skip / rename / newer only).
- **Favorites**: host or `~/.ssh/config` alias, port, user, auth method, default remote path, default local path.
- Auth via the shared SSH layer (§5.3) — all methods incl. FIDO2 and certificates.
- FTP/FTPS passwords in OS keychain.

### 2.3 Web browser
- One `WebContentsView` per tab with its own session partition (`persist:tab-<id>`), or a user-chosen **browser profile** shared by several browser tabs (explicit opt-in; still isolated from all other tab types).
- Address bar, back/forward/reload, history, downloads, find-in-page, zoom, devtools, print.
- **Bookmarks**: bar + folders, import from Chrome/Edge/Firefox bookmark files, export as HTML.
- **Chrome extensions**: load unpacked / from CRX via `session.loadExtension`. Electron supports only a **subset** of `chrome.*` APIs (MV3 partially); maintain a compatibility list and surface "unsupported API" warnings. Evaluate `electron-chrome-extensions` to fill gaps (tabs, browserAction/action popups).
- **Password autofill** (security-sensitive — see §8.5):
  - Vault encrypted with a key protected by OS keychain (`safeStorage`); optional master password.
  - Login-form detection in an **isolated-world preload**; fill only on explicit user action, exact origin match (eTLD+1 + scheme), never in cross-origin iframes without confirmation.
  - Save/update prompts; generator; import from Chrome/Bitwarden CSV.
  - Optional integration with external managers via CLI (Bitwarden `bw`, 1Password `op`) as alternative backends.
- **Ad/tracker blocking**: `@ghostery/adblocker-electron` with EasyList/EasyPrivacy, per-site allowlist, toggle per profile.
- Security: sandboxed, `contextIsolation: true`, `nodeIntegration: false`, permission prompts (camera, mic, notifications, geolocation) per partition.

### 2.4 Messaging
- Presets: Slack, WhatsApp Web, Microsoft Teams, Discord, Telegram Web, Google Chat; custom URL presets.
- Built on the browser tab with a persistent partition per account → multi-account.
- Web notifications → native notifications; unread badge on tab (from title / favicon / notification count).
- Standard Chrome user agent; some services may still break — documented per preset.

### 2.5 Container manager
- Backends behind one `ContainerBackend` interface:
  - **Docker** — Docker Engine API (`//./pipe/docker_engine`, `/var/run/docker.sock`, `DOCKER_HOST`, docker contexts).
  - **Podman** — Docker-compatible API (podman machine pipe / `podman.sock`) → same client (`dockerode`).
  - **wslc** — CLI-only preview: wrap `wslc.exe`, parse output; surface per-user/per-elevation sessions.
  - Backends can run on any execution target (e.g. Docker on an SSH host).
- **Containers**: list, start/stop/restart/pause/remove, status, published ports (open in browser tab), shell into container (shell tab), live logs with auto-follow/search, inspect, **live stats** (CPU, memory, network, block I/O charts).
- **Images**: list, pull (progress), run dialog (ports, volumes, env, network, restart policy), remove, prune, **build** from Dockerfile with live output (build args, target, tags), push.
- **Volumes / networks**: create, inspect, remove, prune.
- **Compose**: detect compose projects, `up` / `down` / `restart` / `pull` / `logs` per project and per service (docker compose, podman compose, wslc-compose).
- **Registry login**: credentials stored in OS keychain, applied per backend.

### 2.6 AI session
- A shell pane pre-configured to launch an agent from the **agent registry** (§6.5) in a chosen folder on a target, with a harness applied (§6.7).

---

## 3. Architecture

### 3.1 Stack
- **Electron + TypeScript** (main, preload, renderer, utility processes).
- **React** renderer; Fluent UI React v9 (Windows look) with a platform-neutral theme layer for macOS/Linux; docking via custom split/tab layout (or `dockview`, evaluate).
- Terminal: `xterm.js` + addons (`fit`, `webgl`, `serialize`, `search`, `web-links`, `unicode11`, `image`).
- PTY: `node-pty` (prebuilt binaries).
- State: Zustand (renderer) + authoritative state in main.
- i18n: `i18next` / `react-i18next`; all user-visible strings through keys from day one.
- Packaging: `electron-builder` — Windows NSIS (per-user) + MSIX optional; macOS dmg (universal: x64 + arm64); Linux AppImage, deb, rpm.

**Why Electron:** a full browser with extensions, messaging tabs, per-tab storage partitions and moving live web views between windows require real, consistent Chromium on all three OSes.

### 3.2 Process model
```
Main process (window/tab manager, layout store, IPC router, keychain, permissions)
├── Utility: pty-host          (all local PTYs)
├── Utility: target-host       (execution targets: WSL / SSH / container connections, helper agents)
├── Utility: transfer-host     (SFTP/FTP queues)
├── Utility: container-host    (docker / podman / wslc clients)
├── Utility: project-host      (git, test runners, watchers, project MCP servers) — one per project
├── Utility: extension-host    (third-party extension code) — one per extension
└── Windows (BaseWindow)
    ├── Chrome renderer (tab strip, launcher, pane chrome)
    ├── WebContentsView per web / messaging / editor pane (sandboxed, own partition)
    └── Sandboxed view per extension UI
```
- **Sessions live outside windows.** Windows only *view* sessions → lossless tear-out.
- Each session has an id; renderers subscribe to session streams via the main IPC router, which enforces ownership.

### 3.3 Layout model
Every tab is a layout tree (a plain tab is a tree with one leaf):
```ts
type LayoutNode =
  | { kind: "split"; dir: "h" | "v"; sizes: number[]; children: LayoutNode[] }
  | { kind: "tabs";  active: number; children: LayoutNode[] }      // sub-tabs
  | { kind: "pane";  typeId: string; sessionId: string; title?: string };

interface TabState {
  id: string; title: string; customTitle?: boolean;
  root: LayoutNode;
  projectId?: string;
}

interface WindowState {
  id: string; bounds: Rect; maximized: boolean; display?: string;
  tabs: TabState[]; activeTab: string;
}
```

---

## 4. Extension API (public from Phase 1)

All built-in tab/pane types are implemented on this API ("dogfooding"), which keeps it honest and stable.

### 4.1 Contract
```ts
// vibe-coding-ide-extension manifest (package.json "vibe-coding-ide" field)
{
  "name": "vibe-coding-ide-ext-example",
  "engines": { "vibe-coding-ide": "^1.0.0" },        // semver API version
  "contributes": {
    "tabTypes": [{ "id": "example.kanban", "label": "Kanban", "icon": "board.svg" }],
    "paneTypes": [{ "id": "example.notes", "label": "Notes", "projectScoped": true }],
    "commands": [{ "id": "example.hello", "title": "Say hello" }],
    "settings": { /* JSON schema */ }
  },
  "permissions": ["project.read", "net:api.example.com", "exec"]
}
```
```ts
interface TabType {
  id: string; label: string; icon: string;
  discover?(): Promise<Variant[]>;               // variants shown in the `+` launcher
  create(opts: CreateOptions): Promise<TabSession>;
  serialize(s: TabSession): object;              // layout restore
  restore(data: object): Promise<TabSession>;
  dispose(s: TabSession): Promise<void>;
}
```

### 4.2 Isolation of extensions
- Extension code runs in its **own extension-host utility process**; UI runs in a **sandboxed view** talking to the host via a typed message channel (no Node in UI).
- **Declared permissions** (manifest) — shown at install, enforced by the main process: `exec`, `fs:<scope>`, `net:<host>`, `project.read`, `project.write`, `secrets`, `clipboard`, `notifications`.
- An extension's sessions follow the same tab-isolation rules as built-in ones.

### 4.3 Versioning & distribution
- `@vibe-coding-ide/extension-api` npm package (types + helpers), semver; deprecations kept for one major version.
- Install from: local folder (dev mode with reload), `.vibe-coding-ideext` archive, npm package; marketplace later.
- `create-vibe-coding-ide-extension` scaffolder; API docs generated from types.

---

## 5. Execution targets

Git, tests, terminals, agents, editor and container backends all run **where the files are**. An execution target abstracts that location.

### 5.1 Interface
```ts
type TargetRef =
  | { kind: "local" }
  | { kind: "wsl"; distro: string }
  | { kind: "ssh"; host: string /* ~/.ssh/config alias or user@host:port */ }
  | { kind: "container"; backend: string; container?: string; devcontainer?: string /* path to devcontainer.json */ };

interface ExecTarget {
  ref: TargetRef;
  info(): Promise<{ os: "linux" | "windows" | "darwin"; arch: string; home: string; shell: string }>;
  exec(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;     // buffered
  spawn(cmd: string, args: string[], opts?: ExecOpts): ChildStream;            // streamed
  pty(opts: PtyOpts): PtySession;
  fs: { stat; readFile; writeFile; readdir; mkdir; rm; rename; watch(path, cb): Disposable };
  forwardPort(remotePort: number): Promise<{ localPort: number } & Disposable>;
  toLocalPath?(p: string): string;      // e.g. WSL → \\wsl.localhost\<distro>\...
}
```

### 5.2 Implementations
| Target | Exec / PTY | File system & watch | Port forwarding |
|---|---|---|---|
| **Local** | `child_process` / `node-pty` | Node `fs` + `@parcel/watcher` | n/a |
| **WSL** | `wsl.exe -d <distro> --cd <path> -- <cmd>` | **helper agent inside the distro** (watching over `\\wsl$` is slow/unreliable) | WSL2 localhost forwarding; fallback via helper |
| **SSH** | system OpenSSH (§5.3) + helper agent | helper agent | helper-multiplexed tunnels |
| **Dev container** | `@devcontainers/cli` (`up`, `exec`) / `docker exec` | helper agent inside container | via backend / helper |

### 5.3 SSH layer
- Use the **system OpenSSH client** (`ssh`) as transport: it natively supports `~/.ssh/config` (Include, ProxyJump, Match), ssh-agent / Pageant / 1Password & Windows OpenSSH agent, **FIDO2 `sk-*` keys**, and **certificates** — features the pure-JS `ssh2` library lacks (notably FIDO2).
- **One persistent connection per host** carrying the helper agent's multiplexed protocol over stdio (Windows OpenSSH has no `ControlMaster`, so multiplexing is done by the helper, VS Code Remote-style).
- **Password / passphrase / FIDO touch prompts**: supplied via `SSH_ASKPASS` pointing to a vibe-coding-ide askpass helper that shows a native dialog; passwords optionally saved in OS keychain.
- Host key verification delegated to OpenSSH (`known_hosts`), with a vibe-coding-ide prompt for unknown hosts.
- **SFTP tab**: run the SFTP protocol over `ssh -s <host> sftp` stdio (servers where a helper can't be installed, e.g. shared hosting). ⚠️ Spike needed: confirm an SFTP client library usable over an arbitrary stream; fallback `ssh2` library for key/password auth when FIDO2 isn't required.

### 5.4 Helper agent (`vibe-coding-ide-agent`)
- Small binary deployed to WSL / SSH hosts / containers on first connect (checksummed, versioned, under `~/.vibe-coding-ide/agent/<version>/`), started over stdio.
- Provides: multiplexed channels (exec, PTY, fs, watch, port tunnels), efficient file watching, process cleanup on disconnect, reconnect with session resume.
- ⚠️ **Open decision — implementation language**: **Go** (recommended: static cross-compiled binaries for linux/amd64, arm64, darwin, windows; no runtime dependency) vs Node SEA (same language as app, larger binary).
- Linux targets: glibc and musl (Alpine containers) builds.

---

## 6. Project tab

A project is bound to a root folder on an execution target and gives every pane a shared `ProjectContext`.

```ts
interface ProjectContext {
  id: string;
  name: string;
  target: TargetRef;               // §5
  root: string;                    // path on the target
  env?: Record<string, string>;
  defaultShell?: string;
  favoriteAgent?: string;          // agent registry id
  harnessId?: string;              // §6.7
  activeWorktree?: string;         // feature worktree path (§6.2)
}
```

### 6.1 Default layout
```
┌ Project: my-app  (ssh: build-box) ────────────────────────────────────┐
│ [Editor] [Git] [Tests] [Harness] [+]       │ [AI: claude] [pi] [+]    │
│                                            │                          │
│   (OpenVSCode Server)                      │  > claude                │
│                                            │                          │
├────────────────────────────────────────────┴──────────────────────────┤
│ [bash ~/my-app] [bash ~/my-app-feat-login] [+]                        │
└───────────────────────────────────────────────────────────────────────┘
```
Fully rearrangeable (splits / sub-tabs), persisted per project. "Open project" flow: pick target (local / WSL distro / SSH host / dev container) → pick folder → choose layout template.

### 6.2 Git panel — log + branch / feature / commit management
- **Engine:** `git` CLI executed on the project's target (respects user config, hooks, credential helpers). Minimum git version detected and reported.
- **Log:**
  - Data via `git log --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s -z` (streamed, paginated).
  - Lane-assignment algorithm for the commit graph (custom).
  - Virtualized list (100k+ commits).
  - Filters: branch, author, path, message, date range.
  - Commit details: metadata, changed files, diff (opens in editor diff view or built-in viewer).
  - Auto-refresh by watching `.git/HEAD`, `.git/refs`, `.git/index`, `packed-refs` via target watcher.
- **Branches:** create, checkout, rename, delete, set upstream, fetch/pull/push, ahead/behind, remotes, tags.
- **Features (git worktrees):**
  - "New feature" → `git worktree add ../<repo>-<feature> -b feature/<name> <base>`.
  - Each feature gets its own terminal, editor window and AI agent → parallel work without conflicts.
  - "Finish feature" → merge / rebase / squash into base, remove worktree, delete branch, optionally open PR via `gh` / `glab`.
- **Commits:** status, stage/unstage per file and per hunk (`git apply --cached`), commit (with template/sign-off/GPG/SSH signing honored), amend, stash, cherry-pick, revert.
- **Safety:** confirmation for destructive ops (force push, branch delete, `reset --hard`, worktree remove with changes).
- **Deferred:** interactive rebase UI; merge conflicts delegated to the editor's merge editor.

### 6.3 Editor panel — OpenVSCode Server
- Run **OpenVSCode Server** (MIT, Gitpod) **on the project's target**, so language servers, debuggers and extensions run next to the code.
- Lifecycle: download the matching release (OS/arch, glibc/musl) via helper agent → start bound to `127.0.0.1` on target with a random **connection token** → `forwardPort` → load in a dedicated, sandboxed `WebContentsView` partition per project.
- One server per target+user; one editor window per project/worktree (`?folder=<path>`).
- Extensions from **Open VSX** (the Microsoft Marketplace is not licensed for third-party products).
- Integration ("open at location"): from git (diff, file at commit), tests (failure location), agent output — via the server's CLI / URL scheme. ⚠️ Spike: confirm the reliable mechanism to open file:line in a running OpenVSCode Server instance.
- Settings/extensions persisted per target in `~/.vibe-coding-ide/editor/`.
- Pinned server version; upgrade managed by vibe-coding-ide.

### 6.4 Terminal panel
- PTY on the project's target in `root` (or active feature worktree) with project env.
- Multiple terminals as sub-tabs; shell choice per terminal (shells discovered on the target).

### 6.5 AI panel — favorite agent
**Agent registry** (built-in + user-defined):
```ts
interface AgentDef {
  id: string;            // "claude", "pi", "codex", "gemini", "opencode", …
  label: string;
  cmd: string;
  args?: string[];
  detect: string;        // e.g. "claude --version" (run on the target)
  install?: string;      // suggested install command if missing
  resumeArgs?: string[]; // resume last conversation, if supported
  capabilities: { mcp: boolean; skills: boolean; instructions: boolean; permissions: boolean };
  compileHarness(h: ResolvedHarness, ctx: ProjectContext): LaunchSpec;   // §6.7
}
```
- **First-class agents:** Claude Code, pi, OpenAI Codex CLI, Gemini CLI, opencode.
- v1: agent runs in a PTY pane on the project's target, in the root / worktree; project remembers its favorite agent; multiple agents side by side as sub-tabs.
- Later: optional richer chat UI built on provider SDKs (e.g. Claude Agent SDK).
- **Cross-pane integration:** "Send to agent" (failing test, commit, diff, editor selection) and the project MCP server (§6.8).

### 6.6 Test panel — discovery, status, run
```ts
interface TestAdapter {
  id: string;
  detect(target: ExecTarget, root: string): Promise<boolean>;
  discover(target: ExecTarget, root: string): Promise<TestNode[]>;
  run(ids: string[], opts: { watch?: boolean; debug?: boolean }): AsyncIterable<TestEvent>;
}
```

| Ecosystem | Detect | Discover | Results |
|---|---|---|---|
| Vitest | `vitest.config.*` / dependency | `vitest list --json` | JSON reporter |
| Jest | `jest.config.*` / dependency | `jest --listTests` + AST parse for test names | JSON reporter |
| pytest | `pyproject.toml`, `pytest.ini`, `conftest.py` | `pytest --collect-only -q` | `--junitxml` |
| .NET | `*.csproj` / `*.sln` | `dotnet test --list-tests` | `.trx` / JUnit logger |
| Go | `go.mod` | `go test -list . ./...` | `go test -json` |
| Rust | `Cargo.toml` | `cargo test -- --list` | libtest output (JSON where available) |
| JVM | `build.gradle(.kts)` / `pom.xml` | Gradle test task / Surefire | JUnit XML |

- All seven adapters are in scope for the first test-panel release.
- Multiple adapters active simultaneously (monorepos); per-adapter config overrides (command, args, env).
- **UI:** tree (folder → file → suite → test) with status (unknown / queued / running / passed / failed / skipped) and duration; run / debug one test, a file, or all; re-run failed; watch mode; per-test output; open failure location in editor.
- **Debug:** delegates to the editor's debugger (launch config generated per adapter).
- **Integrations:** failing test → "Ask agent to fix"; failures exposed via project MCP server.
- JUnit XML as universal fallback reporter.

### 6.7 Harness — MCP servers & skills per project
An app-owned, agent-agnostic configuration compiled into each agent's native format at launch.

```ts
interface Harness {
  id: string;
  name: string;                       // "web-dev", "review", "infra"…
  extends?: string[];
  mcpServers: Record<string, {
    transport: "stdio" | "http" | "sse";
    command?: string; args?: string[]; url?: string;
    env?: Record<string, SecretRef | string>;   // secrets resolved from OS keychain
    enabled: boolean;
  }>;
  skills: SkillRef[];                 // folders containing SKILL.md
  instructions?: string;
  permissions?: { allow?: string[]; deny?: string[] };
  perAgent?: Record<string, object>;
}
```
- **Layering:** global library → project harness → per-pane variant.
- Built-in **project MCP server** (§6.8) always injected.
- Generated configs written to an app-managed dir **on the target** and passed via flags/env — the repo is not modified by default. **"Export to repo"** for team sharing (`.mcp.json`, `.claude/skills/`, `AGENTS.md`, …).
- **Per-agent compilers** (all five first-class agents):

| Agent | MCP | Skills | Instructions | Permissions |
|---|---|---|---|---|
| Claude Code | `--mcp-config` (+ `--strict-mcp-config`) | `.claude/skills/` or plugin dir | `--append-system-prompt` / `CLAUDE.md` | settings file |
| Codex CLI | `config.toml` `[mcp_servers]` (via profile / `CODEX_HOME`) | skills dir if supported | `AGENTS.md` | approval/sandbox modes |
| Gemini CLI | `settings.json` `mcpServers` | extensions | `GEMINI.md` | settings |
| opencode | `opencode.json` `mcp` | if supported | `AGENTS.md` | config |
| pi | extension/config mechanism | skills (Agent Skills format) | `AGENTS.md` | if supported |

> ⚠️ Every cell above must be verified against the agent version targeted before implementing its compiler; the capability matrix is surfaced in the UI ("pi: skills ✓, MCP ✗") instead of silently dropping config.

- **Harness panel UI:** MCP servers (library / custom, enable/disable, **health check**: spawn on target, list tools, show errors), skills (browse, preview `SKILL.md`, enable/disable), instructions & permissions editors. Changes mark running agents stale → "Restart agent with new harness" (resume where supported).

### 6.8 Project MCP server (built-in)
Local MCP server scoped to one project, exposed to agents on the target (stdio via helper or forwarded HTTP):
- Current branch, selected commit, current diff / editor selection.
- Test tree, failing tests with output and locations.
- Container status for the project's compose project.
- Actions requiring user confirmation: run tests, open file in editor, create feature worktree.

---

## 7. Core behaviors

### 7.1 Tabs & windows
- Rename (double-click / context menu), reorder by drag, close, duplicate, color/icon, pin.
- **Tear-out:** drag outside the strip → new window at drop position; drag onto another window's strip → re-attach.
  - Terminals: PTY stays in its host; renderer re-subscribes; scrollback via `addon-serialize`.
  - Web / editor panes: move the `WebContentsView` to the target `BaseWindow` (no reload).
- In a project: drag a pane to an edge (split) or onto a sub-tab bar; dragging a pane out of the project makes a standalone tab (loses project channels — confirm).
- Configurable keybindings; defaults similar to Windows Terminal, platform-appropriate on macOS (Cmd).
- Multi-monitor: restore windows on the right display; fall back to primary if missing.

### 7.2 `+` launcher
- Always the last item in the tab strip.
- Searchable picker grouped by type: Shells, WSL distros, SSH hosts, Projects (recent + "Open…"), S/FTP favorites, Browser profiles, Messaging presets, Containers, AI agents, extension-contributed types.
- Command palette (Ctrl/Cmd+Shift+P) exposes the same entries plus commands.

### 7.3 Layout restore
- Persist `WindowState[]` + per-session `serialize()` to `layout.json` (debounced, atomic rename, versioned schema + migrations).
- On restart:
  - **Shell:** re-spawn same profile/target in same cwd; show saved scrollback above a "session restored" marker.
  - **Browser/Messaging:** reopen URL; partition keeps logins.
  - **S/FTP:** lazy reconnect on focus.
  - **Containers:** reconnect backend.
  - **Project:** restore layout, reconnect target (lazy for SSH), restart editor server, agents restart (resume where supported).
  - **Extensions:** `restore()` with their serialized data.
- Crash safety: periodic snapshots; restore last good file if current is corrupt.

---

## 8. Isolation & security

### 8.1 Between tabs / projects / extensions (enforced)
- Web, messaging, editor and extension UIs: own partition, sandboxed renderer, `contextIsolation`, no Node, strict CSP for app UI.
- IPC router delivers messages only to the owning session; no cross-tab channels.
- Project-host and MCP servers spawned **per project**.
- Extensions limited to declared, user-approved permissions.

### 8.2 Within a project (intentional sharing)
- Panes share context only via the project bus (git selection, test results, "send to agent"). No direct pane-to-pane calls.

### 8.3 What isolation does *not* cover
- Shells and agents run as the user on their target and share its filesystem. Stronger boundaries: dev-container targets, dedicated WSL distro per project, feature worktrees for agents.

### 8.4 Secrets
- OS keychain via `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret/kwallet — warn if Linux falls back to plaintext `basic_text`).
- Injected only as env vars into the process that needs them; never written to layout, harness JSON or exported config.

### 8.5 Browser password vault
- Encrypted at rest (AES-256-GCM, key wrapped by `safeStorage`; optional master password with Argon2id).
- Autofill only on user action, exact origin match, top-level frames by default; clipboard auto-clear for copied passwords.
- Threat model documented; external security review before enabling by default.

### 8.6 Other
- SSH host keys via OpenSSH `known_hosts`.
- Helper agent and OpenVSCode Server downloads verified by checksum; signatures where available.
- Signed builds, auto-update with signature verification.
- No telemetry by default (opt-in crash reports only, later).
- `SECURITY.md` with private vulnerability reporting (GitHub advisories).

---

## 9. Configuration & storage

| File | Content |
|---|---|
| `settings.json` | Global settings, keybindings, theme, shell profiles |
| `layout.json` | Windows / tabs / layout trees / serialized sessions |
| `projects.json` | Known projects and their `ProjectContext` |
| `targets.json` | Saved targets (WSL, SSH, containers) |
| `harnesses/` | Harness library (JSON) |
| `skills/` | Skill library (folders with `SKILL.md`) |
| `agents.json` | User-defined agent registry entries |
| `bookmarks.json`, `vault.bin` | Browser bookmarks, encrypted password vault |
| `extensions/` | Installed extensions |
| OS keychain | All secrets |

Location: `%APPDATA%\vibe-coding-ide` (Windows), `~/Library/Application Support/vibe-coding-ide` (macOS), `$XDG_CONFIG_HOME/vibe-coding-ide` (Linux). JSON schemas published for editor validation.

---

## 10. UI / UX
- Windows: Mica/Acrylic, Segoe UI Variable + Cascadia Mono. macOS: vibrancy, SF fonts, traffic-light inset tab strip. Linux: neutral theme, client-side decorations optional.
- Light/dark follows system; custom themes (JSON tokens).
- Command palette, configurable keybindings, keyboard-only navigation, screen-reader labels, high-contrast support.
- Tab badges: activity/bell (shell), unread (messaging), failed tests (project), running containers.
- Status bar: active project + target, branch, test summary, agent state.
- i18n-ready: all strings via `i18next` keys; English only at first; RTL-safe CSS (logical properties) to ease future translations.

---

## 11. Engineering

### 11.1 Repository layout (pnpm workspace)
```
dev-environment/
├── PLAN.md
├── LICENSE                      # MIT
├── README.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md
├── pnpm-workspace.yaml
├── electron.vite.config.ts
├── electron-builder.yml
├── apps/
│   └── desktop/                 # Electron app
│       └── src/
│           ├── main/            # window/tab manager, layout store, IPC router, keychain, permissions
│           ├── preload/
│           ├── renderer/        # React: tab strip, launcher, pane chrome, panels
│           └── hosts/           # utility processes: pty, target, transfer, container, project, extension
├── packages/
│   ├── extension-api/           # @vibe-coding-ide/extension-api (public, semver)
│   ├── shared/                  # types, schemas, IPC contracts
│   ├── targets/                 # local / wsl / ssh / container ExecTarget implementations
│   ├── git/                     # git CLI wrapper, log parser, lane algorithm
│   ├── tests/                   # test adapters
│   ├── agents/                  # agent registry + harness compilers
│   ├── mcp-project/             # project MCP server
│   └── create-vibe-coding-ide-extension/ # scaffolder
├── extensions/                  # built-in tab/pane types, built on the public API
│   ├── shell/  project/  editor/  git/  tests/  ai/  harness/
│   ├── browser/  messaging/  containers/  sftp/
├── agent/                       # vibe-coding-ide-agent helper (Go, if chosen)
└── test/                        # e2e (Playwright for Electron)
```

### 11.2 Quality
- TypeScript strict, ESLint, Prettier; Vitest unit tests; Playwright (`_electron`) e2e on all three OSes.
- Integration tests for targets: WSL (Windows runner), SSH (containerized sshd), dev containers (Docker on Linux runner).
- Conventional commits, Changesets for `@vibe-coding-ide/extension-api` versioning.

### 11.3 CI / release (GitHub Actions)
- Matrix: `windows-latest`, `macos-latest` (arm64 + x64), `ubuntu-latest` — lint, typecheck, unit, e2e, build.
- Signing:
  - **Windows**: Azure Trusted Signing (or OV/EV certificate) via electron-builder.
  - **macOS**: Developer ID + notarization (requires Apple Developer account, $99/yr).
  - **Linux**: GPG-signed AppImage/deb/rpm checksums.
- Releases to GitHub Releases; `electron-updater` auto-update (stable / beta channels).
- Helper agent cross-compiled in the same pipeline and attached to releases.

---

## 12. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Foundation** | pnpm workspace, electron-vite, React shell, i18n setup, lint/test, 3-OS CI, signing & auto-update pipeline, OSS docs (LICENSE, CONTRIBUTING, SECURITY) | Signed "hello window" auto-updates on all 3 OSes |
| **1. Core + extension API** | Window/tab manager, rename/reorder, tear-out & re-attach, `+` launcher, layout tree (splits, sub-tabs), layout restore, command palette, **public extension API v0** (extension host, permissions, sandboxed UI), shell tab type built as an extension (PATH + WSL + `/etc/shells` discovery) | Daily-usable terminal on 3 OSes; tabs survive tear-out & restart; sample third-party extension works |
| **2. Execution targets + project tab** | `ExecTarget` for **local, WSL, SSH, dev container**; `vibe-coding-ide-agent` helper; SSH layer (OpenSSH, askpass, FIDO2, certs, config); project open flow; terminal pane on target; agent registry with **Claude Code, pi, Codex, Gemini, opencode**; AI pane | Open a project on each of the 4 target kinds with terminal + favorite agent |
| **3. Git** | Read-only log with graph → status, staging (file/hunk), commit/amend, branches, fetch/pull/push, stash, feature worktrees, PR via `gh`/`glab` | Full branch/feature/commit workflow on any target |
| **4. Editor** | OpenVSCode Server lifecycle on targets, port forwarding, editor pane, Open VSX, open-at-location integration from git | Edit + LSP + debug on local, WSL, SSH and container projects |
| **5. Tests** | Adapter framework + Vitest, Jest, pytest, .NET, Go, Rust, JVM; run/debug/watch; editor integration | Discover & run tests for all 7 ecosystems on any target |
| **6. Harness + project MCP** | Harness model & library, compilers for 5 agents, capability matrix, harness panel + health checks, project MCP server, "send to agent" | Agent launched with project-specific MCP + skills; agent reads failing tests via MCP |
| **7. Containers** | Docker + Podman (Engine API), wslc wrapper; containers/images/volumes/networks, logs, stats, build, compose, registry login; backends on remote targets | Docker-Desktop-like management for all 3 backends — *local engines done (Containers tab); pending: backends on remote targets, image push, compose logs per service* |
| **8. Browser & messaging** | Browser tab, profiles/partitions, downloads, bookmarks (+import), ad-blocking, Chrome extensions subset, password vault + autofill (after security review), messaging presets, notifications/badges | Daily browsing + Slack/WhatsApp in isolated tabs |
| **9. S/FTP** | SFTP over SSH layer, FTP/FTPS, favorites, dual pane, drag & drop, transfer queue | Drag & drop transfer to a saved server incl. FIDO2-key hosts |
| **10. Polish → 1.0** | Themes, settings UI, accessibility pass, extension API 1.0 freeze, docs site, marketplace design | Public 1.0 |

Phase 2 is the largest and riskiest (four targets + helper agent); start it with the spikes in §14.

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scope — every tab type is a product | Extension architecture + strict phasing; project tab before other tab types |
| Public API from Phase 1 → churn | Version as `0.x` until Phase 10; built-in types dogfood it; deprecation policy |
| Four execution targets at once | Shared helper agent; integration test matrix per target; local first within Phase 2 |
| Tear-out with live sessions | Sessions in utility processes; windows are views only; e2e tests early |
| FIDO2 / SSH on Windows (no ControlMaster) | System OpenSSH + helper multiplexing; askpass helper |
| OpenVSCode Server version drift / licensing | Pin versions; Open VSX only; checksum downloads |
| Chrome extension API gaps in Electron | Compatibility list; `electron-chrome-extensions`; built-in vault instead of relying on PM extensions |
| Password vault security | Threat model, isolated-world preload, external review before default-on |
| Messaging apps blocking embedded browsers | Chrome UA, persistent partitions; document per-service status |
| wslc preview CLI changes | Isolated backend; tolerant parsing; version detection |
| Agent CLIs change flags/config formats | Per-agent compilers with version detection; capability matrix |
| Memory (many Chromium views + editor servers) | Suspend/discard background web views; stop idle editor servers |
| Code signing costs / process (OSS) | Azure Trusted Signing; Apple Developer account; SignPath (free for OSS) as alternative |
| Native modules (`node-pty`) on 3 OSes | Prebuilt binaries; CI per platform/arch |

---

## 14. Spikes before / during Phase 2
1. **Tear-out prototype**: move a live `WebContentsView` + xterm session between two `BaseWindow`s on all 3 OSes.
2. **Helper agent language**: Go vs Node SEA — binary size, startup, cross-compilation, musl support.
3. **SSH transport**: system OpenSSH + stdio multiplexing on Windows; askpass + FIDO2 touch flow.
4. **SFTP over system ssh stdio**: library supporting an arbitrary duplex stream.
5. **OpenVSCode Server**: start on remote target, port-forward, embed, open file:line from outside.
6. **Agent harness flags**: verify MCP/skills/instructions mechanisms for Claude Code, pi, Codex, Gemini, opencode.

---

## 15. Open questions
- Helper agent implementation language (Go recommended) — decide after spike 2.
- Final product name and domain (before Phase 10; affects appId and config paths — plan a migration).
- Marketplace hosting for extensions (GitHub-based index vs dedicated service).
- Optional settings sync mechanism.
- Governance: maintainers, contribution/review policy, roadmap visibility (GitHub Projects).

---

## 16. Prior art to study
- **Windows Terminal** — tab model, tear-out, profiles, actions.
- **VS Code Remote (SSH / WSL / Containers)** & **OpenVSCode Server** — remote helper model, port forwarding.
- **Tabby** — Electron terminal + SSH/SFTP.
- **Wave Terminal** — terminal + browser + AI blocks.
- **Ferdium** — messaging web apps in isolated views.
- **WSLC Desktop**, **WSL UI** — wslc containers, WSL distro management.
- **VS Code Test Explorer** — test tree UX and adapter model.
- **Dev Containers spec / CLI** — `devcontainer.json` lifecycle.
