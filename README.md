# DevHub (prototype)

A tabbed development environment — see [PLAN.md](PLAN.md) for the full design.

## Prototype status

### Step 1 — tabs & shells
- Tab strip with rename (double-click / context menu), drag to reorder, close (×, middle-click, Ctrl+Shift+W)
- `+` launcher (Ctrl+Shift+T): shells found on PATH, Git Bash, WSL distributions, AI agent CLIs (claude, codex, gemini, opencode, pi)
- Terminal tabs (xterm.js + node-pty), copy/paste (Ctrl+C with selection, Ctrl+V, right-click), clickable links
- Light/dark theme following the OS

### Step 2 — windows & restore
- Drag a tab to reorder it; drop it on another DevHub window to move it there; release it outside any DevHub window to open it in a new window (also: right-click → **Move to new window**). The shell keeps running throughout.
- A window closes when its last tab closes or moves away.
- Layout restore: window positions/sizes, tabs, custom names and the active tab are saved to `%APPDATA%/DevHub/layout.json` (`~/Library/Application Support/DevHub`, `~/.config/DevHub`) and restored on start. Each tab starts a fresh shell and shows its previous output above a "restored from previous session" marker.

### Step 3 — project tabs
- `+` → **Projects** → *Open folder…* (or a recent project) opens a project tab with three resizable panes:
  - **Git** — log of all branches with a commit graph, branch/tag badges, commit details on click; refreshes automatically when refs change (commit, checkout, fetch…).
  - **Terminal** — a shell started in the project folder (switch shell from the pane header).
  - **AI agent** — your agent CLI (Claude Code, Codex, Gemini, opencode, pi — whichever is installed) started in the project folder; switch agents from the pane header.
- A pane whose process exits shows a **Restart** button; drag the dividers to resize panes.
- Each panel has a **collapse** button (⇤ in its header): the panel moves to a slim rail on the left of the project and the remaining panels take its space. Click it in the rail to bring it back. Its process keeps running while collapsed, and collapsed panels are remembered (moving the tab, restarting the app).
- Project tabs move between windows like any other tab (all their processes keep running) and are restored on start: same folder, layout and pane sizes, fresh processes, previous output shown above the restore marker.

**Known limits:** projects are local folders only (WSL/SSH/container projects come with the execution-target layer); git is read-only for now; a restored terminal tab starts in the home folder (working directory is not tracked yet); closing one of several windows drops it from the saved layout, only the last window / app quit is saved (same as Windows Terminal); `window.__devhubTabs` and `.terminal-host.__xterm` are debugging hooks for automated UI checks.

## Requirements
Node 22+, pnpm, Git. Windows also needs WSL for WSL tabs.

## Run
```sh
pnpm install
pnpm dev        # development with hot reload
pnpm build      # production build into apps/desktop/out
pnpm start      # run the production build
```
If Electron fails to start because its binary is missing, run `pnpm run ensure-electron`.

## Shortcuts
| Keys | Action |
|---|---|
| Ctrl+Shift+T / Ctrl+Shift+Space | Open launcher |
| Ctrl+Shift+W | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Alt+1…9 | Go to tab N (9 = last) |
