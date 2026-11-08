# Contributing to vibe-coding-ide

How to build, run and test the app, how the code is organised, and how CI and releases work. What the app does: [README.md](README.md); its design: [PLAN.md](PLAN.md).

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

## Code layout
Everything lives in `apps/desktop/src`:

| Folder | What |
|---|---|
| `main/index.ts` | Electron entry: windows, layout saving, IPC handlers (thin: they call the modules below) |
| `shared/ipc.ts`, `main/ipc.ts`, `preload/` | The window ↔ main process contract: every channel and event, typed from the `IdeApi` (a misspelt channel or a wrong argument does not compile); `handle` / `listen` / `emit` in the main process, `invoke` / `send` / `on` in the preload script |
| `main/launch.ts`, `main/layout-sanitize.ts` | How a panel's process starts (folder, an agent's settings); validation of tabs and layouts from the renderer |
| `main/git/` | Git panel backend: `run` (git / gh / glab, also inside WSL), `repo` (log, status, branches), `ops` (every action), `pull-requests`, `hosting`, `watcher` |
| `main/harness/` | AI agent panel settings: `model`, `support` (what each agent gets), `compile` (into each agent's flags and files), `skills`, `mcp` (health check), `launch` (npm shims, versions), `target` (host or WSL paths) |
| `main/tests/` | Tests panel adapters (Vitest/Jest/Playwright, pytest, Go, Rust, .NET, Maven/Gradle) on `core.ts`; reporters injected at run time in `main/test-helpers/` |
| `main/wsl.ts`, `main/profiles.ts` | Running programs in WSL distributions; shells, distributions and agents found on the machine |
| `main/containers/` | Containers tab backend: `engine` (Docker Engine API client: endpoints, streams), `engine-backend` (Docker, Podman), `wslc-backend` (wslc CLI), `index` (IPC, CLI jobs, shell / login terminals) |
| `main/updater.ts`, `main/package-updates.ts` | The app's own updates; package updates of the systems shells run on |
| `shared/` | Types by area in `shared/types/` (profiles, layout, git, tests, harness, containers, settings, the `IdeApi`; imported as `@shared/types`), settings defaults, and pure helpers used by both sides (layout tree, WSL paths, partial staging patches, agent settings) |
| `renderer/src/` | React UI: `store.ts` (tabs, layouts), `components/` (one file per panel or view: `GitPanel` + `GitChanges` / `GitBranches` / `GitPullRequest`, `HarnessDialog` + `HarnessMcp` / `HarnessSkills` / `HarnessInstructions`, `TestPanel`…), `components/containers/` (the Containers tab: `ContainersView`, `lists` on the sortable `table`, the details — logs, stats, terminal, files, `SpecViews` for volumes / ports / environment — and dialogs; pure logic in `model`, `spec-rows`, `volume-settings`), `Modal` (every dialog's frame: backdrop, Escape for the top dialog only) |

## Tests
```sh
pnpm typecheck   # TypeScript 7 (tsc)
pnpm lint        # Oxlint (apps/desktop/.oxlintrc.json): correctness rules, React hooks; no warnings allowed
pnpm format      # Prettier (apps/desktop/.prettierrc.json); CI runs pnpm format:check
pnpm test        # unit tests (Vitest): layout tree, git / winget / shell parsers, git operations on a real repo
pnpm build
pnpm test:e2e    # end-to-end tests (Playwright): launches the built app with throwaway profiles and repos
```

Lint: `react-hooks/exhaustive-deps` is an error; each suppression in the code says why. Off: the rules made for the React Compiler (`react/immutability`, `react/preserve-manual-memoization`, `react/set-state-in-effect`, `react/exhaustive-effect-dependencies`), which the app does not use — they flag dependencies used on purpose as triggers (`[reload]`, `[attempt]`).
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

## README screenshots

`docs/screenshots/*.png` are taken by a Playwright script, in dark mode, from a demo project, the fake AI agent and the fake container engine (no personal paths or data on screen). On Windows:

```sh
cd apps/desktop
pnpm build
README_SCREENSHOTS=1 pnpm exec playwright test e2e/readme-screenshots.spec.ts
```
