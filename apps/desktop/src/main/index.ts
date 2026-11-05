import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type Rectangle, type WebContents } from 'electron'
import { mapPanes, sessionIdsOf } from '@shared/layout'
import type { LayoutNode, PtyCreateRequest, PtyCreateResult, TabSnapshot, WindowInit, WindowTabsState } from '@shared/types'
import { gitLog, GitWatcher } from './git'
import { loadLayout, saveLayout, visibleBounds, type SavedWindow } from './layout-store'
import { profileIcon } from './icons'
import { findProfile, listProfiles } from './profiles'
import { recentProjects, touchProject } from './projects'
import { PtyManager } from './pty-manager'
import { parseWslPath } from './wsl-paths'

app.setName('DevHub')
app.setPath('userData', join(app.getPath('appData'), 'DevHub'))

const ptys = new PtyManager()
const gitWatcher = new GitWatcher()
const TITLEBAR_HEIGHT = 40
/** Expose debugging hooks to the UI (automated checks over DevTools). */
const DEBUG = app.commandLine.hasSwitch('remote-debugging-port') || process.env.DEVHUB_DEBUG === '1'

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
    title: 'DevHub',
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
      additionalArguments: DEBUG ? ['--devhub-debug'] : []
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

const PANE_TYPES = new Set(['terminal', 'agent', 'git'])
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
      collapsed: n.collapsed === true ? true : undefined
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
  ipcMain.handle('profiles:icon', async (_e, id: string) => {
    const profile = await findProfile(String(id))
    return profile ? profileIcon(profile) : null
  })

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
    const sessionId = ptys.create(launch, req.cols, req.rows, e.sender, cwd)
    return { sessionId, title: profile.name }
  })
  ipcMain.handle('pty:attach', (e, id: string) => ptys.attach(id, e.sender))
  ipcMain.on('pty:write', (e, id: string, data: string) => ptys.write(id, data, e.sender))
  ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows, e.sender))
  ipcMain.on('pty:kill', (e, id: string) => ptys.kill(id, e.sender))

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

  ipcMain.handle('project:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Open project folder', properties: ['openDirectory' as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
  ipcMain.handle('project:recent', () => recentProjects())
  ipcMain.on('project:touch', (_e, root: string) => touchProject(String(root)))

  ipcMain.handle('git:log', (_e, root: string) =>
    isDir(String(root)) ? gitLog(String(root)) : { isRepo: false, error: 'Folder not found', commits: [] }
  )
  ipcMain.on('git:watch', (e, root: string) => {
    if (isDir(String(root))) gitWatcher.watch(String(root), e.sender)
  })
  ipcMain.on('git:unwatch', (e, root: string) => gitWatcher.unwatch(String(root), e.sender))

  ipcMain.on('app:openExternal', (_e, url: string) => {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
    } catch {
      /* invalid URL */
    }
  })
}

app.whenReady().then(() => {
  registerIpc()
  void listProfiles() // warm the cache
  restoreOrCreate()
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

app.on('will-quit', () => ptys.killAll())
