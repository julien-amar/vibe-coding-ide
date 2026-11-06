import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type Rectangle, type WebContents } from 'electron'
import { mapPanes, sessionIdsOf } from '@shared/layout'
import type { Profile, TestRunRequest, GitOpRequest,LayoutNode, PtyCreateRequest, PtyCreateResult, TabSnapshot, WindowInit, WindowTabsState, PackageUpdateInfo } from '@shared/types'
import { gitLog, gitOp, GitWatcher } from './git'
import { loadLayout, saveLayout, visibleBounds, type SavedWindow } from './layout-store'
import { profileIcon } from './icons'
import { findProfile, listProfiles, wslAgents, wslHome } from './profiles'
import { recentProjects, touchProject } from './projects'
import { checkForUpdates, installUpdate, startUpdates, updateStatus } from './updater'
import { PtyManager } from './pty-manager'
import { checkUpdates, forgetUpdates, type UpdateTarget } from './package-updates'
import { parseWslPath } from '@shared/wsl-paths'
import { discoverTests, runTests, stopAllTests, stopTests } from './test-runner'
import { openInEditor } from './editor'
import {
  agentMajorVersion,
  agentOf,
  checkMcpServer,
  compileHarness,
  directLaunch,
  HARNESS_SUPPORT,
  harnessIsEmpty,
  listSkills,
  readProjectMcpJson,
  readSkillFile,
  sanitizeHarness,
  type CompiledHarness,
  type HarnessTarget
} from './harness'

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
  return nativeTheme.shouldUseDarkColors
    ? { color: '#1f1f1f', symbolColor: '#ffffff' }
    : { color: '#f3f3f3', symbolColor: '#1a1a1a' }
}

interface CreateOptions {
  bounds?: Partial<Rectangle>
  maximized?: boolean
  tabs?: TabSnapshot[]
  activeIndex?: number
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
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { ...overlayColors(), height: TITLEBAR_HEIGHT } }),
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
    createWindow({ bounds: visibleBounds(w.bounds) ?? { width: w.bounds.width, height: w.bounds.height }, maximized: w.maximized, tabs: w.tabs, activeIndex: w.activeIndex })
  }
}

// ---------- Validation of renderer input ----------

const PANE_TYPES = new Set(['terminal', 'agent', 'git', 'tests'])
const TAB_KINDS = new Set(['shell', 'wsl', 'agent', 'project'])

/** Validate a layout tree coming from a renderer (drops anything malformed). */
function sanitizeLayout(n: LayoutNode | undefined, depth = 0): LayoutNode | undefined {
  if (!n || typeof n !== 'object' || depth > 8) return undefined
  if (n.kind === 'split' && Array.isArray(n.children)) {
    const children = n.children.map((c) => sanitizeLayout(c, depth + 1)).filter((c): c is LayoutNode => !!c)
    if (children.length === 0) return undefined
    const sizes =
      Array.isArray(n.sizes) && n.sizes.length === children.length && n.sizes.every((v) => Number(v) > 0)
        ? n.sizes.map(Number)
        : children.map(() => 1 / children.length)
    return { kind: 'split', dir: n.dir === 'column' ? 'column' : 'row', sizes, children }
  }
  if (n.kind === 'pane' && PANE_TYPES.has(n.type)) {
    return {
      kind: 'pane',
      id: String(n.id),
      type: n.type,
      profileId: n.profileId ? String(n.profileId) : undefined,
      sessionId: n.sessionId ? String(n.sessionId) : undefined,
      collapsed: n.collapsed === true ? true : undefined,
      // AI agent panes keep their own settings.
      harness: n.type === 'agent' && n.harness && !harnessIsEmpty(sanitizeHarness(n.harness)) ? sanitizeHarness(n.harness) : undefined
    }
  }
  return undefined
}

function sanitizeTab(t: TabSnapshot): TabSnapshot {
  const layout = t.project && typeof t.project.root === 'string' ? sanitizeLayout(t.project.layout) : undefined
  return {
    kind: TAB_KINDS.has(t.kind) ? t.kind : 'shell',
    profileId: t.profileId ? String(t.profileId) : undefined,
    autoTitle: String(t.autoTitle ?? ''),
    customTitle: t.customTitle ? String(t.customTitle) : undefined,
    sessionId: t.sessionId ? String(t.sessionId) : undefined,
    project: t.project && layout ? { root: String(t.project.root), name: String(t.project.name ?? ''), layout } : undefined
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

const isDir = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle('profiles:list', (_e, refresh?: boolean) => listProfiles(Boolean(refresh)))
  ipcMain.handle('profiles:wslAgents', (_e, distro: string) => wslAgents(String(distro)))
  ipcMain.handle('profiles:icon', async (_e, id: string) => {
    const profile = await findProfile(String(id))
    return profile ? profileIcon(profile) : null
  })

  /**
   * An agent profile with its settings added. Host agents: arguments appended (npm command shims
   * launched directly: cmd.exe would mangle quotes and line breaks). WSL agents (… --exec bash -lic
   * 'exec <agent>'): the arguments go through "$@", one Linux argument each; environment variables
   * cross into the distribution through WSLENV.
   */
  const withHarness = (launch: Profile, extra: CompiledHarness): Profile => {
    const env = { ...(launch.env ?? {}), ...extra.env }
    if (launch.wslDistro) {
      const last = launch.args.length - 1
      const agentCmd = /^exec (\S+)$/.exec(launch.args[last] ?? '')?.[1]
      if (!agentCmd) return launch
      const names = Object.keys(extra.env)
      return {
        ...launch,
        args: [...launch.args.slice(0, last), `exec ${agentCmd} "$@"`, agentCmd, ...extra.args],
        env: names.length ? { ...env, WSLENV: [process.env.WSLENV, launch.env?.WSLENV, ...names].filter(Boolean).join(':') } : env
      }
    }
    const direct = extra.args.length ? directLaunch(launch.command, launch.args) : undefined
    return { ...launch, ...(direct ?? {}), args: [...(direct?.args ?? launch.args), ...extra.args], env }
  }

  ipcMain.handle('pty:create', async (e, req: PtyCreateRequest): Promise<PtyCreateResult> => {
    const profile = await findProfile(req.profileId)
    if (!profile) throw new Error(`Unknown profile: ${req.profileId}`)
    let launch = profile
    let cwd: string | undefined
    if (profile.wslDistro) {
      // WSL processes start in a Linux directory: a Linux path, or a \\wsl.localhost\<distro>\… path of the same distro.
      const wsl = req.cwd ? parseWslPath(req.cwd) : undefined
      const linuxDir = req.cwd?.startsWith('/') ? req.cwd : wsl && wsl.distro.toLowerCase() === profile.wslDistro.toLowerCase() ? wsl.path : undefined
      if (linuxDir) {
        const i = profile.args.indexOf('--cd')
        launch = { ...profile, args: i >= 0 ? profile.args.map((a, j) => (j === i + 1 ? linuxDir : a)) : ['--cd', linuxDir, ...profile.args] }
      }
    } else {
      cwd = req.cwd && isDir(req.cwd) ? req.cwd : undefined
    }
    // An AI agent pane's own settings (generated files in app data, passed with flags).
    const harness = req.harness ? sanitizeHarness(req.harness) : undefined
    if (profile.kind === 'agent' && harness && !harnessIsEmpty(harness)) {
      const root = req.harnessRoot && isDir(String(req.harnessRoot)) ? String(req.harnessRoot) : (cwd ?? homedir())
      const outDir = join(harnessRuns(), createHash('sha1').update(root + JSON.stringify(harness)).digest('hex').slice(0, 16))
      const agent = agentOf(profile.id)
      const outDirFor = join(outDir, `${agent ?? 'agent'}${profile.wslDistro ? `-${profile.wslDistro}` : ''}`)
      const target: HarnessTarget = profile.wslDistro ? { kind: 'wsl', distro: profile.wslDistro, home: await wslHome(profile.wslDistro) } : { kind: 'host' }
      // opencode 2 needs a private server for the panel's settings (opencode 1 does not know the flag).
      const opencodeMajor = agent === 'opencode' ? await agentMajorVersion(launch) : undefined
      const extra = compileHarness(agent, harness, root, outDirFor, target, { opencodeMajor })
      if (extra.args.length || Object.keys(extra.env).length) launch = withHarness(launch, extra)
    }
    const sessionId = ptys.create(launch, req.cols, req.rows, e.sender, cwd)
    // A shell starting: check (once, in the background) whether its system has package updates —
    // the WSL distribution for WSL shells, Windows (winget) for PowerShell / cmd / Git Bash…
    const target: UpdateTarget | undefined =
      profile.kind === 'wsl' && profile.wslDistro
        ? { kind: 'wsl', distro: profile.wslDistro }
        : profile.kind === 'shell' && process.platform === 'win32'
          ? { kind: 'windows' }
          : undefined
    if (target) {
      void checkUpdates(target).then((info) => {
        if (!info || !ptys.has(sessionId)) return
        sessionUpdates.set(sessionId, { info, target })
        ptys.notify(sessionId, 'pty:updates', info)
      })
    }
    return { sessionId, title: profile.name }
  })
  ipcMain.handle('pty:attach', (e, id: string) => ptys.attach(id, e.sender))
  ipcMain.on('pty:write', (e, id: string, data: string) => ptys.write(id, data, e.sender))
  ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows, e.sender))
  ipcMain.on('pty:kill', (e, id: string) => {
    ptys.kill(id, e.sender)
    sessionUpdates.delete(id)
  })
  ipcMain.handle('pty:updates', (e, id: string) => (ptys.isSubscribed(id, e.sender) ? (sessionUpdates.get(id)?.info ?? null) : null))
  ipcMain.on('pty:dismissUpdates', (e, id: string, accepted: boolean) => {
    const entry = sessionUpdates.get(id)
    if (!entry || !ptys.isSubscribed(id, e.sender)) return
    sessionUpdates.delete(id)
    if (accepted) forgetUpdates(entry.target)
  })

  ipcMain.handle('window:init', (e): WindowInit => {
    const entry = entryFor(e.sender)
    const init = entry?.pendingInit ?? { tabs: [], activeIndex: 0 }
    if (entry) entry.pendingInit = undefined // a reload must not re-create restored tabs
    return { windowId: entry?.win.id ?? -1, ...init }
  })

  ipcMain.on('window:state', (e, state: WindowTabsState) => {
    const entry = entryFor(e.sender)
    if (!entry || !Array.isArray(state?.tabs)) return
    entry.state = { tabs: state.tabs.map(sanitizeTab), activeIndex: Number(state.activeIndex) || 0 }
    scheduleSave()
  })

  ipcMain.handle('window:detach', (e, rawTab: TabSnapshot, screenX: number, screenY: number) => {
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
    e.sender.send('window:tabTransferred', tabKey(tab))
    return true
  })

  ipcMain.handle('window:adopt', (e, rawTab: TabSnapshot, fromWindowId: number) => {
    const tab = sanitizeTab(rawTab)
    const source = windows.get(Number(fromWindowId))
    const ids = liveSessions(tab)
    if (!source || !ids || source.win.webContents === e.sender) return false
    if (!transferAll(ids, source.win.webContents, e.sender)) return false
    source.win.webContents.send('window:tabTransferred', tabKey(tab))
    return true
  })

  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  ipcMain.handle('project:pickFolder', async (e, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const start = typeof defaultPath === 'string' && isDir(defaultPath) ? defaultPath : undefined
    const opts = { title: 'Open project folder', defaultPath: start, properties: ['openDirectory' as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
  ipcMain.handle('project:recent', () => recentProjects())
  ipcMain.on('project:touch', (_e, root: string) => touchProject(String(root)))

  ipcMain.handle('git:log', (_e, root: string) =>
    isDir(String(root)) ? gitLog(String(root)) : { isRepo: false, error: 'Folder not found', commits: [] }
  )
  ipcMain.handle('git:op', (_e, root: string, req: GitOpRequest) =>
    isDir(String(root)) ? gitOp(String(root), req ?? { op: 'status' }) : { ok: false, error: 'Folder not found' }
  )
  ipcMain.on('git:watch', (e, root: string) => {
    if (isDir(String(root))) gitWatcher.watch(String(root), e.sender)
  })
  ipcMain.on('git:unwatch', (e, root: string) => gitWatcher.unwatch(String(root), e.sender))

  ipcMain.handle('tests:discover', (_e, root: string) => (isDir(String(root)) ? discoverTests(String(root)) : []))
  ipcMain.handle('tests:run', (e, root: string, req: TestRunRequest) =>
    isDir(String(root))
      ? runTests(String(root), { ...req, projectId: String(req?.projectId ?? '') }, e.sender)
      : { ok: false, error: 'Folder not found', results: [], fileErrors: [] }
  )
  ipcMain.on('tests:stop', (_e, root: string) => stopTests(String(root)))

  ipcMain.handle('harness:check', (_e, root: string, server: unknown) => checkMcpServer(String(root), server))
  ipcMain.handle('harness:skills', (_e, root: string, harness: unknown) => (isDir(String(root)) ? listSkills(String(root), sanitizeHarness(harness)) : []))
  ipcMain.handle('harness:readSkill', (_e, path: string) => {
    try {
      return readSkillFile(String(path))
    } catch {
      return ''
    }
  })
  ipcMain.handle('harness:pickSkillFolder', async (e, root: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Choose a skill folder (with a SKILL.md), or a folder of skills', defaultPath: String(root), properties: ['openDirectory' as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
  ipcMain.handle('harness:projectMcp', (_e, root: string) => (isDir(String(root)) ? readProjectMcpJson(String(root)) : []))
  ipcMain.handle('harness:support', () => HARNESS_SUPPORT)

  ipcMain.handle('app:openInEditor', (_e, root: string, file: string, line?: number, column?: number, base?: string) =>
    isDir(String(root))
      ? openInEditor(String(root), String(file ?? ''), line, column, base ? String(base) : undefined)
      : { ok: false, error: 'Folder not found' }
  )

  ipcMain.handle('update:status', () => updateStatus())
  ipcMain.on('update:check', () => checkForUpdates())
  ipcMain.on('update:install', () => {
    // quitAndInstall closes the windows one by one: save them all first (like an explicit quit).
    saveNow(true)
    quitting = true
    installUpdate()
  })

  ipcMain.on('app:openExternal', (_e, url: string) => {
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
