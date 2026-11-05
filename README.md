# DevHub (prototype)

A tabbed development environment — see [PLAN.md](PLAN.md) for the full design.

## Features

### Tabs, shells & windows
- Tab strip with rename (double-click / context menu), drag to reorder, close (×, middle-click, Ctrl+Shift+W); each tab shows the icon of its shell, distribution or agent.
- `+` launcher (Ctrl+Shift+T): projects, shells found on PATH, Git Bash, WSL distributions, AI agent CLIs (claude, codex, gemini, opencode, pi).
- Terminal tabs (xterm.js + node-pty), copy/paste (Ctrl+C with selection, Ctrl+V, right-click), clickable links, light/dark theme following the OS.
- Drag a tab out of the window to open it in a new window, or onto another DevHub window to move it there (also: right-click → **Move to new window**). Processes keep running. A window closes when its last tab closes or moves away.
- Icons: the real icon of the installed software where Windows provides one (executable icon, the distro's own `shortcut.ico`, Git for Windows' icon), otherwise a small coloured monogram unique to that entry.

### Layout restore
- Window positions/sizes, tabs, custom names, the active tab, project layouts and collapsed panels are saved to `%APPDATA%/DevHub/layout.json` (`~/Library/Application Support/DevHub`, `~/.config/DevHub`) and restored on start.
- Each shell restarts **in the folder it was in** (PowerShell, cmd, Git Bash and bash in WSL report their working directory to DevHub) and shows its previous output above a "restored from previous session" marker.

### Project tabs
`+` → **Projects** → *Open folder…*, *Open folder in &lt;WSL distro&gt;…*, or a recent project.

- **Panels:** Git, Terminal and AI agent to start with. Every panel header can **split** it right/down, **collapse** it to the side rail (its process keeps running — click it in the rail to bring it back) or **close** it. The rail's **+** adds a Terminal, AI agent or Git panel. **Drag a panel by its header** onto another panel to dock it to that edge. Drag the dividers to resize.
- **Terminal / AI agent panels** run in the project folder; switch the shell or agent from the header (with icons). A panel whose process exits shows a **Restart** button.
- **Git panel:**
  - *History* — all branches with a commit graph, branch/tag badges, commit details on click.
  - *Changes* — staged and unstaged files with diffs; stage / unstage / discard per file or all; commit or amend (Ctrl+Enter).
  - *Branches* — switch, create, rename, merge into the current branch, delete (with a confirmation for unmerged branches), check out remote branches.
  - **New feature…** — creates `feature/<name>` in its own folder next to the repository (a git worktree) and opens it as a new project with its own terminal and agent, so you can work on it in parallel. Worktrees can be reopened or removed from the Branches view.
  - Fetch / Pull / Push (Publish for a branch without upstream), ahead/behind counts. Refreshes automatically when the repository changes.
- **WSL projects** (`\\wsl.localhost\<distro>\...`): git runs inside the distribution, the terminal opens the distro's shell in the project folder, and the agent defaults to one installed inside the distro (e.g. `claude` in Ubuntu), falling back to the Windows one.
- Project tabs move between windows like any other tab and are restored on start.

**Known limits:** SSH and dev-container projects are not supported yet; staging is per file (no partial hunks); closing one of several windows drops it from the saved layout — only the last window / app quit is saved (same as Windows Terminal). WSL's `/tmp` is not visible from Windows, so WSL projects must live elsewhere (e.g. under your home).

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

Automated UI checks: start the app with `--remote-debugging-port=<port>` (or `DEVHUB_DEBUG=1`) to expose `window.__devhubTabs` and `.terminal-host.__xterm` for scripted checks over the DevTools protocol.

## Shortcuts
| Keys | Action |
|---|---|
| Ctrl+Shift+T / Ctrl+Shift+Space | Open launcher |
| Ctrl+Shift+W | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Alt+1…9 | Go to tab N (9 = last) |
| Ctrl+Enter (commit message) | Commit |
