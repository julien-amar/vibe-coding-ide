# vibe-coding-ide (prototype)

A tabbed development environment — see [PLAN.md](PLAN.md) for the full design.

## Features

### Tabs, shells & windows
- Tab strip with rename (double-click / context menu), drag to reorder, close (×, middle-click, Ctrl+Shift+W); each tab shows the icon of its shell, distribution or agent.
- `+` launcher (Ctrl+Shift+T): projects, shells found on PATH, Git Bash, WSL distributions, AI agent CLIs (claude, codex, gemini, opencode, pi).
- Terminal tabs (xterm.js + node-pty), copy/paste (Ctrl+C with selection, Ctrl+V, right-click), clickable links, light/dark theme following the OS.
- Drag a tab out of the window to open it in a new window, or onto another vibe-coding-ide window to move it there (also: right-click → **Move to new window**). Processes keep running. A window closes when its last tab closes or moves away.
- **Package updates:** when a shell starts, vibe-coding-ide checks once whether its system has pending package updates — **Windows via winget** for PowerShell, cmd, Git Bash and other Windows shells; the **distribution** for WSL shells (apt, dnf, pacman, apk or zypper, using the cached package lists). If so, a status bar under the terminal offers **Update now**, which types the update command (`winget upgrade --all`, `sudo apt update && sudo apt upgrade -y`, …) into that terminal, where you follow the progress and answer prompts (sudo password, UAC); **×** dismisses it.
- Icons: the real icon of the installed software where Windows provides one (executable icon, the distro's own `shortcut.ico`, Git for Windows' icon), otherwise a small coloured monogram unique to that entry.

### Layout restore
- Window positions/sizes, tabs, custom names, the active tab, project layouts and collapsed panels are saved to `%APPDATA%/vibe-coding-ide/layout.json` (`~/Library/Application Support/vibe-coding-ide`, `~/.config/vibe-coding-ide`) and restored on start.
- Each shell restarts **in the folder it was in** (PowerShell, cmd, Git Bash and bash in WSL report their working directory to vibe-coding-ide) and shows its previous output above a "restored from previous session" marker.

### Project tabs
`+` → **Projects** → *Open folder…*, *Open folder in &lt;WSL distro&gt;…*, or a recent project.

- **Panels:** Git, Terminal and AI agent to start with, plus Tests in the side rail. Every panel header can **split** it right/down, **collapse** it to the side rail (its process keeps running — click it in the rail to bring it back) or **close** it. The rail's **+** adds a Terminal, AI agent, Git or Tests panel. **Drag a panel by its header** onto another panel to dock it to that edge. Drag the dividers to resize.
- **Terminal / AI agent panels** run in the project folder; switch the shell or agent from the header (with icons). A panel whose process exits shows a **Restart** button.
- **Git panel:**
  - *History* — all branches with a commit graph, branch/tag badges, commit details on click.
  - *Changes* — staged and unstaged files with diffs; stage / unstage / discard per file or all, **per hunk** (buttons on each `@@` line) or **per line** (click changed lines, Shift+click for a range, then Stage / Unstage / Discard); commit or amend (Ctrl+Enter).
  - *Branches* — switch, create, rename, merge into the current branch, delete (with a confirmation for unmerged branches), check out remote branches.
  - **New feature…** — creates `feature/<name>` in its own folder next to the repository (a git worktree) and opens it as a new project with its own terminal and agent, so you can work on it in parallel. Worktrees can be reopened or removed from the Branches view.
  - Fetch / Pull / Push (Publish for a branch without upstream), ahead/behind counts. Refreshes automatically when the repository changes.
  - **Pull request** — opens the branch's open pull (merge) request, or creates one: pushes the branch first, then creates it with **GitHub CLI** (`gh`) or **glab** when installed and logged in (title, Markdown description, target branch, draft), otherwise opens the host's "new pull request" page (GitHub, GitLab, Bitbucket, Azure DevOps). WSL projects use the `gh` / `glab` of the distribution.
- **Tests panel:** finds the project's tests, also in sub-folders of a monorepo, and lists them by file and `describe()` block / module / class:

  | Framework | Found from | Grouped by | Runs with |
  |---|---|---|---|
  | **Vitest**, **Jest**, **Playwright** | `vitest.config.*`, `jest.config.*` (or a `jest` section / script in package.json), `playwright.config.*` | file, `describe()` | the project's `node_modules` |
  | **pytest** | `pytest.ini`, `pyproject.toml`, `setup.cfg`, `tox.ini` | file, class | the project's virtualenv (`.venv`, `venv`, `env`) or Python on PATH |
  | **Go** | `go.mod` | package, test → subtests | `go test` |
  | **Rust** | `Cargo.toml` | source file (lib, integration tests), module | `cargo test` |
  | **.NET** (xUnit, NUnit, MSTest) | a test project (`*.csproj` / `*.fsproj` referencing a test SDK) | class | `dotnet test` |
  | **Java** (JUnit 4/5, TestNG) | `pom.xml` (Maven) or `build.gradle(.kts)` (Gradle) | class (nested classes too) | `mvnw` / `gradlew` if present, else `mvn` / `gradle` |

  Java tests are listed from the sources (test annotations), before any build; Go subtests appear once they have run. **Run all**, or hover any project, file, suite or test and click **▶**; each test turns passed / failed / skipped **as soon as it finishes**, with its duration, and files with failures open automatically. Skipped tests are listed too. Click a test for its error and stack trace; **Output** shows the console output of the runs. Connected filter buttons show **All**, **✓ Passed**, **○ Skipped** or **✗ Failed** tests (with their counts), combined with a name filter; **■ Stop** ends a run. WSL projects run their tests inside the distribution.
  - **✦ Fix with agent** on a failed test (or a file / suite with failures) sends the failure to the project's **AI agent** panel — the test, its file and line, the error and the command that re-runs just that test — opening an agent panel first if none is running.
  - **Open in your editor:** the `file:line` under a test, every location in an error's stack trace, and double-clicking a test open that file at that line in **VS Code**, Cursor, Windsurf, VSCodium, Zed or Sublime Text (the first one found on PATH; otherwise the system's default app).
- **AI agent settings (⚙ in each AI agent panel's header):** every agent panel has its own MCP servers, skills and instructions — independent of the other panels and projects, kept with the panel in vibe-coding-ide's layout (restored on restart; nothing is written into the repository). The ⚙ shows how many settings are in use.
  - **MCP servers** — a command the agent starts (stdio) or an HTTP endpoint, with environment / headers; enable or disable each; **Check** starts the server and lists its tools (or shows its error and output); **Import from .mcp.json** takes the repository's servers; **Only these servers** makes the agent ignore other MCP configurations.
  - **Skills** — add folders with a `SKILL.md` (or folders of skills), enable or disable them, preview them; the skills Claude Code already loads from the repository's `.claude/skills` and `~/.claude/skills` are listed too.
  - **Instructions** — added to the agent's system prompt.
  - Applied when the agent starts, in each agent's own format — generated files and flags for that session only (your agent configuration and the repository are not changed); the dialog shows what the panel's agent gets:

    | Agent | MCP servers | Skills | Instructions | Only these servers | Only these skills |
    |---|---|---|---|---|---|
    | **Claude Code** | `--mcp-config` | `--plugin-dir` (a session-only plugin) | `--append-system-prompt-file` | `--strict-mcp-config` | `--settings`: your and the repository's skills `off`, bundled skills disabled (installed plugins' skills stay) |
    | **Codex CLI** | `-c mcp_servers.<name>…` | listed in its instructions (name, description, `SKILL.md` location) | `-c developer_instructions` | ✓ (replaces the server list) | `-c skills.config` turns off its skills (bundled, `~/.codex`, `~/.agents`, the repository) |
    | **opencode** | `OPENCODE_CONFIG` (an extra config file); opencode 2 also gets `--standalone`, a private server (its shared background service would not see the panel's config) | `skills.paths` | `instructions` | ✗ (your and the repository's servers always apply) | `permission.skill`: deny all but the panel's |
    | **pi** | a session-only extension (`--extension`) calling `pi.registerMcpServer` (pi 1.5+) | `--skill` | `--append-system-prompt` | ✗ (`~/.pi/agent/mcp.json` and `.pi/mcp.json` always apply) | `--no-skills` |
    | **Gemini CLI** | ✗ | ✗ | ✗ | Gemini only reads `~/.gemini` or the repository's `.gemini` | ✗ |

    Agents running **inside WSL** get the same, with paths written for Linux (`/mnt/c/…`, the project's Linux path), MCP server commands run in the distribution (as typed), and **Check** starting servers there too. Checked against Claude Code 2.1, Codex CLI 0.166, opencode 2.2 (and 1.19), pi 1.5 and Gemini CLI 0.67. Agents installed with npm on Windows are started directly (not through their `.cmd` shim), so arguments keep their quotes and line breaks. After a change, the running agent shows **Restart** to apply it.
- **WSL projects** (`\\wsl.localhost\<distro>\...`): git runs inside the distribution, the terminal opens the distro's shell in the project folder, and the agent defaults to one installed inside the distro (e.g. `claude` in Ubuntu), falling back to the Windows one.
- Project tabs move between windows like any other tab and are restored on start.

**Known limits:** SSH and dev-container projects are not supported yet; closing one of several windows drops it from the saved layout — only the last window / app quit is saved (same as Windows Terminal). WSL's `/tmp` is not visible from Windows, so WSL projects must live elsewhere (e.g. under your home).

## Requirements
Node 22+, pnpm, Git. Windows also needs WSL for WSL tabs and projects.

## Run
```sh
pnpm install
pnpm dev        # development with hot reload
pnpm build      # production build into apps/desktop/out
pnpm start      # run the production build
```
If Electron fails to start because its binary is missing, run `pnpm run ensure-electron`.

Automated UI checks: set `VIBE_CODING_IDE_USER_DATA=<folder>` to run with a separate profile (layout, recent projects), and start the app with `--remote-debugging-port=<port>` (or `VIBE_CODING_IDE_DEBUG=1`) to expose `window.__vibeIdeTabs` and `.terminal-host.__xterm` for scripted checks over the DevTools protocol.

## Tests
```sh
pnpm test        # unit tests (Vitest): layout tree, git / winget / shell parsers, git operations on a real repo
pnpm build
pnpm test:e2e    # end-to-end tests (Playwright): launches the built app with throwaway profiles and repos
```
Unit tests live next to the code (`src/**/*.test.ts`), end-to-end tests in `apps/desktop/e2e/`.
The Tests panel is tested on two sample projects in `apps/desktop/e2e/fixtures/`: `sample-tests` (Vitest, Jest, Playwright, pytest) and `polyglot-tests` (Go, Rust, .NET, Java with Maven). Each framework's tests run with its real tool and are skipped when the tool is not installed (CI installs them all). The pytest tests need a virtualenv in `sample-tests`:
```sh
cd apps/desktop/e2e/fixtures/sample-tests
python -m venv .venv && .venv/Scripts/python -m pip install pytest   # macOS / Linux: .venv/bin/python
```
End-to-end tests put fake `claude` and `code` commands first on PATH (`e2e/fixtures/fake-tools`), so they never start a real AI agent or open your editor.

## CI & releases (GitHub Actions)
- **CI** (`.github/workflows/ci.yml`): on every push and pull request, type-check, unit tests, build and end-to-end tests on Windows, macOS and Linux.
- **Release** (`.github/workflows/release.yml`): push a version tag to build the installers on all three platforms and publish them as a GitHub Release:
  ```sh
  git tag v0.2.0
  git push origin v0.2.0
  ```
  Installers: Windows `.exe` (NSIS), macOS `.dmg` / `.zip` (Apple Silicon), Linux `.AppImage` / `.deb`. You can also release from *Actions → Release → Run workflow* by entering the tag (e.g. `v0.2.0`): it is created on the selected branch's commit. Leave the tag empty to only build the installers as downloadable artifacts.
- **Auto-update:** installed apps check the latest GitHub Release at start and every 6 hours. On Windows and Linux the update downloads in the background and the title bar shows **Restart to update** (also installed when you quit). A signed macOS build does the same; an unsigned one shows **Version x is available**, linking to the release page (macOS refuses unsigned updates). `VIBE_CODING_IDE_NO_UPDATE=1` turns it off.
- **Signing:** installers are signed when the repository has these secrets (*Settings → Secrets and variables → Actions*); without them they are unsigned (Windows SmartScreen and macOS Gatekeeper warn).

  | Platform | Secrets | Variables |
  |---|---|---|
  | Windows — code signing certificate | `WIN_CSC_LINK` (base64 `.pfx`), `WIN_CSC_KEY_PASSWORD` | |
  | Windows — Azure Trusted Signing | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `AZURE_SIGNING_PUBLISHER` |
  | macOS — Developer ID (+ notarization) | `MAC_CSC_LINK` (base64 `.p12`), `MAC_CSC_KEY_PASSWORD` (+ `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) | |

  `node apps/desktop/scripts/release-build.cjs --dry-run` shows what a build would use.
- Local installer for the current OS: `pnpm --filter @vibe-coding-ide/desktop dist` (output in `apps/desktop/dist`).

## Shortcuts
| Keys | Action |
|---|---|
| Ctrl+Shift+T / Ctrl+Shift+Space | Open launcher |
| Ctrl+Shift+W | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Alt+1…9 | Go to tab N (9 = last) |
| Ctrl+Enter (commit message) | Commit |
