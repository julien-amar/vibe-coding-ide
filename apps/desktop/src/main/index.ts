import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import type { PtyCreateRequest, PtyCreateResult } from '@shared/types'
import { findProfile, listProfiles } from './profiles'
import { PtyManager } from './pty-manager'

const ptys = new PtyManager()
const TITLEBAR_HEIGHT = 40

function overlayColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#1f1f1f', symbolColor: '#ffffff' }
    : { color: '#f3f3f3', symbolColor: '#1a1a1a' }
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
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
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // The app UI never navigates or opens windows itself.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  const onTheme = (): void => {
    if (!isMac && !win.isDestroyed()) win.setTitleBarOverlay(overlayColors())
  }
  nativeTheme.on('updated', onTheme)
  win.on('closed', () => {
    nativeTheme.off('updated', onTheme)
    ptys.reapOrphans()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function registerIpc(): void {
  ipcMain.handle('profiles:list', (_e, refresh?: boolean) => listProfiles(Boolean(refresh)))

  ipcMain.handle('pty:create', async (e, req: PtyCreateRequest): Promise<PtyCreateResult> => {
    const profile = await findProfile(req.profileId)
    if (!profile) throw new Error(`Unknown profile: ${req.profileId}`)
    const sessionId = ptys.create(profile, req.cols, req.rows, e.sender, req.cwd)
    return { sessionId, title: profile.name }
  })
  ipcMain.handle('pty:attach', (e, id: string) => ptys.attach(id, e.sender))
  ipcMain.on('pty:write', (e, id: string, data: string) => ptys.write(id, data, e.sender))
  ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows, e.sender))
  ipcMain.on('pty:kill', (e, id: string) => ptys.kill(id, e.sender))

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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => ptys.killAll())
