import { appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, shell, type Rectangle, type WebContents } from 'electron'
import { mapPanes, sessionIdsOf } from '@shared/layout'
import type {
  GitOpRequest,
  PackageUpdateInfo,
  PtyCreateRequest,
  PtyCreateResult,
  TabSnapshot,
  TestRunRequest,
  WindowInit,
  WindowTabsState
} from '@shared/types'
import pkg from '../../package.json'
import { applySettings, getSettings, offeredProfiles, resetSettings, updateSettings } from './app-settings'
import { openInEditor } from './editor'
import { gitLog, gitOp, GitWatcher } from './git'
import { checkMcpServer, HARNESS_SUPPORT, listSkills, readProjectMcpJson, readSkillFile, sanitizeHarness } from './harness'
import { profileIcon } from './icons'
import { isDir, startIn, withAgentSettings } from './launch'
import { sanitizeTab } from './layout-sanitize'
import { loadLayout, saveLayout, visibleBounds, type SavedWindow } from './layout-store'
import { checkUpdates, forgetUpdates, type UpdateTarget } from './package-updates'
import { findProfile, listProfiles, wslAgents, wslTools } from './profiles'
import { registerContainerIpc } from './containers'
import { forgetProject, recentProjects, touchProject } from './projects'
import { PtyManager } from './pty-manager'
import { discoverTests, runTests, stopAllTests, stopTests } from './test-runner'
import { checkForUpdates, installUpdate, startUpdates, updateStatus } from './updater'
import { emit, handle, listen } from './ipc'

app.setName('vibe-coding-ide')
// VIBE_CODING_IDE_USER_DATA: run with a separate profile (layout, recent projects), e.g. for automated tests.
app.setPath('userData', process.env.VIBE_CODING_IDE_USER_DATA || join(app.getPath('appData'), 'vibe-coding-ide'))

const ptys = new PtyManager()
/** Pending package updates per session (and what was checked), until the user accepts or dismisses the bar. */
const sessionUpdates = new Map<string, { info: PackageUpdateInfo; target: UpdateTarget }>()
const gitWatcher = new GitWatcher()
/** Generated files of the AI agents' settings (one folder per distinct harness; sessions do not outlive the app). */
const harnessRuns = (): string => join(app.getPath('userData'), 'harness-runs')
const TITLEBAR_HEIGHT = 40
/** Expose debugging hooks to the UI (automated checks over DevTools). */
const DEBUG = app.commandLine.hasSwitch('remote-debugging-port') || process.env.VIBE_CODING_IDE_DEBUG === '1'

interface WindowEntry {
  win: BrowserWindow
  /** Tabs handed to the renderer on first `window:init` (restored or detached tabs). */
  pendingInit?: { tabs: TabSnapshot[]; activeIndex: number }
  /** Created from the saved layout (told to the renderer on its first `window:init`). */
  restored?: boolean
  state: WindowTabsState
}

/** Insertion order = window order in the saved layout. */
const windows = new Map<number, WindowEntry>()
let quitting = false
let saveTimer: NodeJS.Timeout | undefined

function entryFor(wc: WebContents): WindowEntry | undefined {
  for (const e of windows.values()) if (e.win.webContents === wc) return e
  return undefined
}

// ---------- Layout persistence ----------

function snapshotLayout(withScrollback: boolean): SavedWindow[] {
  return [...windows.values()]
    .filter((e) => !e.win.isDestroyed())
    .map((e) => ({
      bounds: e.win.isMaximized() ? e.win.getNormalBounds() : e.win.getBounds(),
      maximized: e.win.isMaximized(),
      activeIndex: e.state.activeIndex,
      tabs: e.state.tabs.map(({ sessionId, scrollback: _ignored, ...tab }) => {
        const saved = (id: string | undefined): string | undefined => (withScrollback && id ? ptys.tail(id) || undefined : undefined)
        const cwd = (id: string | undefined): string | undefined => (id ? ptys.cwd(id) : undefined)
        return {
          ...tab,
          scrollback: saved(sessionId),
          cwd: cwd(sessionId),
          project: tab.project && {
            ...tab.project,
            layout: mapPanes(tab.project.layout, ({ sessionId: paneSession, scrollback: _s, ...pane }) => ({
              ...pane,
              scrollback: saved(paneSession),
              cwd: cwd(paneSession)
            }))
          }
        }
      })
    }))
}

function saveNow(withScrollback: boolean): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (windows.size === 0) return // never overwrite the layout with "nothing"
  saveLayout(snapshotLayout(withScrollback))
}

function scheduleSave(): void {
  if (quitting) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveNow(false), 500)
}

// ---------- Windows ----------

function overlayColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors ? { color: '#1f1f1f', symbolColor: '#ffffff' } : { color: '#f3f3f3', symbolColor: '#1a1a1a' }
}

interface CreateOptions {
  bounds?: Partial<Rectangle>
  maximized?: boolean
  tabs?: TabSnapshot[]
  activeIndex?: number
  /** From the saved layout (even without tabs: its last tab was closed). */
  restored?: boolean
}

function createWindow(opts: CreateOptions = {}): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: opts.bounds?.width ?? 1200,
    height: opts.bounds?.height ?? 760,
    x: opts.bounds?.x,
    y: opts.bounds?.y,
    minWidth: 480,
    minHeight: 300,
    show: false,
    title: 'vibe-coding-ide',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f3f3f3',
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { ...overlayColors(), height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: DEBUG ? ['--vibe-coding-ide-debug'] : []
    }
  })

  const tabs = opts.tabs ?? []
  const activeIndex = opts.activeIndex ?? 0
  const entry: WindowEntry = {
    win,
    pendingInit: tabs.length ? { tabs, activeIndex } : undefined,
    restored: opts.restored,
    state: { tabs: tabs.map(({ scrollback: _s, ...t }) => t), activeIndex }
  }
  windows.set(win.id, entry)
  const id = win.id

  win.once('ready-to-show', () => {
    if (opts.maximized) win.maximize()
    win.show()
  })

  // The app UI never navigates or opens windows itself.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  for (const ev of ['move', 'resize', 'maximize', 'unmaximize'] as const) win.on(ev as 'move', scheduleSave)

  const onTheme = (): void => {
    if (!isMac && !win.isDestroyed()) win.setTitleBarOverlay(overlayColors())
  }
  nativeTheme.on('updated', onTheme)

  win.on('close', () => {
    // Closing the last window ends the session: save it (with scrollback) so it is restored next time.
    if (!quitting && windows.size === 1) saveNow(true)
  })
  win.on('closed', () => {
    nativeTheme.off('updated', onTheme)
    windows.delete(id)
    // Closing one of several windows removes it from the saved layout.
    if (!quitting && windows.size > 0) scheduleSave()
    ptys.reapOrphans()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function restoreOrCreate(): void {
  const saved = loadLayout()
  if (saved.length === 0) {
    createWindow()
    return
  }
  for (const w of saved) {
    createWindow({
      bounds: visibleBounds(w.bounds) ?? { width: w.bounds.width, height: w.bounds.height },
      maximized: w.maximized,
      tabs: w.tabs,
      activeIndex: w.activeIndex,
      restored: true
    })
  }
}

/** Stable identity of a moved tab, sent back to the source window so it can drop it. */
function tabKey(tab: TabSnapshot): string {
  return sessionIdsOf(tab)[0] ?? `project:${tab.project?.root ?? ''}`
}

/** Live sessions of a tab; a terminal tab must have exactly one. */
function liveSessions(tab: TabSnapshot): string[] | undefined {
  const ids = sessionIdsOf(tab).filter((id) => ptys.has(id))
  if (tab.kind !== 'project' && ids.length !== 1) return undefined
  return ids
}

/** Move all of a tab's sessions; roll back if any fails. */
function transferAll(ids: string[], from: WebContents, to: WebContents): boolean {
  const moved: string[] = []
  for (const id of ids) {
    if (ptys.transfer(id, from, to)) moved.push(id)
    else {
      for (const m of moved) ptys.transfer(m, to, from)
      return false
    }
  }
  return true
}

// ---------- IPC ----------

function registerIpc(): void {
  registerContainerIpc()
  handle('profiles:list', async (_e, refresh?: boolean) => offeredProfiles(await listProfiles(Boolean(refresh))))
  handle('profiles:all', () => listProfiles())
  handle('settings:get', () => getSettings())
  handle('settings:set', (_e, patch: unknown) => updateSettings(patch))
  handle('settings:reset', () => resetSettings())
  // The app's own version (built in: app.getVersion() gives Electron's when the app is not packaged).
  handle('app:version', () => pkg.version)
  handle('profiles:wslAgents', async (_e, distro: string) => offeredProfiles(await wslAgents(String(distro))))
  handle('profiles:wslTools', async (_e, all?: boolean) => offeredProfiles(await wslTools(Boolean(all))))
  handle('profiles:icon', async (_e, id: string) => {
    const profile = await findProfile(String(id))
    return profile ? profileIcon(profile) : null
  })

  handle('pty:create', async (e, req: PtyCreateRequest): Promise<PtyCreateResult> => {
    const profile = await findProfile(req.profileId)
    if (!profile) throw new Error(`Unknown profile: ${req.profileId}`)
    const start = startIn(profile, req.cwd)
    const cwd = start.cwd
    // An AI agent pane's own settings (generated files in app data, passed with flags).
    const launch = await withAgentSettings(start.launch, req, cwd, harnessRuns())
    const sessionId = ptys.create(launch, req.cols, req.rows, e.sender, cwd)
    // A shell tab starting: check (once, in the background) whether its system has package updates —
    // the WSL distribution for WSL shells, Windows (winget) for PowerShell / cmd / Git Bash… Not for a
    // project's terminal panels.
    const target: UpdateTarget | undefined =
      req.panel === true
        ? undefined
        : profile.kind === 'wsl' && profile.wslDistro
          ? { kind: 'wsl', distro: profile.wslDistro }
          : profile.kind === 'shell' && process.platform === 'win32'
            ? { kind: 'windows' }
            : undefined
    if (target) {
      void checkUpdates(target).then((info) => {
        if (!info || !ptys.has(sessionId)) return
        sessionUpdates.set(sessionId, { info, target })
        ptys.notifyUpdates(sessionId, info)
      })
    }
    return { sessionId, title: profile.name }
  })
  handle('pty:attach', (e, id: string) => ptys.attach(id, e.sender))
  listen('pty:write', (e, id: string, data: string) => ptys.write(id, data, e.sender))
  listen('pty:resize', (e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows, e.sender))
  listen('pty:kill', (e, id: string) => {
    ptys.kill(id, e.sender)
    sessionUpdates.delete(id)
  })
  handle('pty:updates', (e, id: string) => (ptys.isSubscribed(id, e.sender) ? (sessionUpdates.get(id)?.info ?? null) : null))
  listen('pty:dismissUpdates', (e, id: string, accepted: boolean) => {
    const entry = sessionUpdates.get(id)
    if (!entry || !ptys.isSubscribed(id, e.sender)) return
    sessionUpdates.delete(id)
    if (accepted) forgetUpdates(entry.target)
  })

  handle('window:init', (e): WindowInit => {
    const entry = entryFor(e.sender)
    const init = entry?.pendingInit ?? { tabs: [], activeIndex: 0 }
    const restored = entry?.restored === true
    if (entry) {
      entry.pendingInit = undefined // a reload must not re-create restored tabs
      entry.restored = undefined
    }
    return { windowId: entry?.win.id ?? -1, ...init, restored }
  })

  listen('window:state', (e, state: WindowTabsState) => {
    const entry = entryFor(e.sender)
    if (!entry || !Array.isArray(state?.tabs)) return
    entry.state = { tabs: state.tabs.map(sanitizeTab), activeIndex: Number(state.activeIndex) || 0 }
    scheduleSave()
  })

  handle('window:detach', (e, rawTab: TabSnapshot, screenX: number, screenY: number) => {
    const source = entryFor(e.sender)
    const tab = sanitizeTab(rawTab)
    const ids = liveSessions(tab)
    if (!source || !ids) return false
    const [width, height] = source.win.getSize()
    const win = createWindow({ bounds: { x: Math.round(screenX) - 120, y: Math.round(screenY) - 20, width, height }, tabs: [tab] })
    if (!transferAll(ids, e.sender, win.webContents)) {
      win.destroy()
      return false
    }
    emit(e.sender, 'window:tabTransferred', tabKey(tab))
    return true
  })

  handle('window:adopt', (e, rawTab: TabSnapshot, fromWindowId: number) => {
    const tab = sanitizeTab(rawTab)
    const source = windows.get(Number(fromWindowId))
    const ids = liveSessions(tab)
    if (!source || !ids || source.win.webContents === e.sender) return false
    if (!transferAll(ids, source.win.webContents, e.sender)) return false
    emit(source.win.webContents, 'window:tabTransferred', tabKey(tab))
    return true
  })

  listen('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  handle('project:pickFolder', async (e, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const start = typeof defaultPath === 'string' && isDir(defaultPath) ? defaultPath : undefined
    const opts = { title: 'Open project folder', defaultPath: start, properties: ['openDirectory' as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
  handle('project:recent', () => recentProjects())
  listen('project:touch', (_e, root: string) => touchProject(String(root)))
  handle('project:forget', (_e, root: string) => forgetProject(String(root)))

  handle('git:log', (_e, root: string) => (isDir(String(root)) ? gitLog(String(root)) : { isRepo: false, error: 'Folder not found', commits: [] }))
  handle('git:op', (_e, root: string, req: GitOpRequest) =>
    isDir(String(root)) ? gitOp(String(root), req ?? { op: 'status' }) : { ok: false, error: 'Folder not found' }
  )
  listen('git:watch', (e, root: string) => {
    if (isDir(String(root))) gitWatcher.watch(String(root), e.sender)
  })
  listen('git:unwatch', (e, root: string) => gitWatcher.unwatch(String(root), e.sender))

  handle('tests:discover', (_e, root: string) => (isDir(String(root)) ? discoverTests(String(root)) : []))
  handle('tests:run', (e, root: string, req: TestRunRequest) =>
    isDir(String(root))
      ? runTests(String(root), { ...req, projectId: String(req?.projectId ?? '') }, e.sender)
      : { ok: false, error: 'Folder not found', results: [], fileErrors: [] }
  )
  listen('tests:stop', (_e, root: string) => stopTests(String(root)))

  handle('harness:check', (_e, root: string, server: unknown) => checkMcpServer(String(root), server))
  handle('harness:skills', (_e, root: string, harness: unknown) => (isDir(String(root)) ? listSkills(String(root), sanitizeHarness(harness)) : []))
  handle('harness:readSkill', (_e, path: string) => {
    try {
      return readSkillFile(String(path))
    } catch {
      return ''
    }
  })
  handle('harness:pickSkillFolder', async (e, root: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Choose a skill folder (with a SKILL.md), or a folder of skills', defaultPath: String(root), properties: ['openDirectory' as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
  handle('harness:projectMcp', (_e, root: string) => (isDir(String(root)) ? readProjectMcpJson(String(root)) : []))
  handle('harness:support', () => HARNESS_SUPPORT)

  handle('app:openInEditor', (_e, root: string, file: string, line?: number, column?: number, base?: string) =>
    isDir(String(root))
      ? openInEditor(String(root), String(file ?? ''), line, column, base ? String(base) : undefined)
      : { ok: false, error: 'Folder not found' }
  )

  handle('update:status', () => updateStatus())
  listen('update:check', () => checkForUpdates())
  listen('update:install', () => {
    // quitAndInstall closes the windows one by one: save them all first (like an explicit quit).
    saveNow(true)
    quitting = true
    installUpdate()
  })

  listen('app:openExternal', (_e, url: string) => {
    try {
      const { protocol } = new URL(url)
      if (protocol !== 'http:' && protocol !== 'https:') return
      // End-to-end tests record the pages instead of opening a browser.
      if (process.env.VIBE_CODING_IDE_BROWSER_LOG) appendFileSync(process.env.VIBE_CODING_IDE_BROWSER_LOG, `${url}\n`)
      else void shell.openExternal(url)
    } catch {
      /* invalid URL */
    }
  })
}

app.whenReady().then(() => {
  // Generated agent settings of earlier runs (their agents are gone).
  rmSync(harnessRuns(), { recursive: true, force: true })
  applySettings()
  registerIpc()
  void listProfiles() // warm the cache
  restoreOrCreate()
  startUpdates().catch((err) => console.error('Updates unavailable:', err))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) restoreOrCreate()
  })
})

app.on('before-quit', () => {
  // Explicit quit (menu, Cmd+Q, OS shutdown) with windows still open: save them all.
  if (!quitting) saveNow(true)
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  ptys.killAll()
  stopAllTests()
})
