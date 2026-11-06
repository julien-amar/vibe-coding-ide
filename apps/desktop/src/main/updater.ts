import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { UpdateStatus } from '@shared/types'
import { updateMode, type UpdateMode } from './update-mode'

const RELEASES = 'https://github.com/julien-amar/vibe-coding-ide/releases'
const FIRST_CHECK = 15_000
const EVERY = 6 * 60 * 60 * 1000

let status: UpdateStatus = { state: 'idle' }
let mode: UpdateMode = 'off'
let updater: typeof import('electron-updater').autoUpdater | undefined

export const updateStatus = (): UpdateStatus => status

function set(s: UpdateStatus): void {
  status = s
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('update:status', s)
}

/** Build information written by the release workflow into package.json (signed macOS build…). */
function buildInfo(): { macSigned?: boolean } {
  try {
    return (JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { vibeCodingIde?: { macSigned?: boolean } }).vibeCodingIde ?? {}
  } catch {
    return {}
  }
}

export async function startUpdates(): Promise<void> {
  mode = updateMode(process.platform, { packaged: app.isPackaged, disabled: !!process.env.VIBE_CODING_IDE_NO_UPDATE, macSigned: !!buildInfo().macSigned })
  if (mode === 'off') return
  // electron-updater (CommonJS) defines autoUpdater as a lazy getter, which import() does not
  // expose as a named export: it is on the default export.
  const mod = (await import('electron-updater')) as typeof import('electron-updater') & { default?: typeof import('electron-updater') }
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!autoUpdater) throw new Error('electron-updater did not load')
  updater = autoUpdater
  autoUpdater.autoDownload = mode === 'auto'
  autoUpdater.autoInstallOnAppQuit = mode === 'auto'
  autoUpdater.logger = null
  // Testing the update flow: another update server (a folder with latest*.yml and the installers).
  if (process.env.VIBE_CODING_IDE_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.VIBE_CODING_IDE_UPDATE_URL })
  autoUpdater.on('checking-for-update', () => status.state !== 'ready' && set({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => set({ state: 'none' }))
  autoUpdater.on('update-available', (info) =>
    set(
      mode === 'auto'
        ? { state: 'downloading', version: info.version, percent: 0 }
        : { state: 'available', version: info.version, manual: true, url: `${RELEASES}/tag/v${info.version}` }
    )
  )
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', version: status.version, percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    // Offline, GitHub unavailable, no release yet…: try again at the next check, quietly.
    if (status.state !== 'ready') set({ state: 'error', error: err.message.split('\n')[0] })
  })
  const check = (): void => {
    if (status.state === 'ready' || status.state === 'downloading') return
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
  setTimeout(check, FIRST_CHECK)
  setInterval(check, EVERY).unref()
}

/** Checks now (from the window). */
export function checkForUpdates(): void {
  if (mode === 'off') set({ state: 'none', error: 'Updates are off in this build.' })
  else void updater?.checkForUpdates().catch(() => undefined)
}

/** Restarts into the downloaded update. */
export function installUpdate(): void {
  if (status.state === 'ready') updater?.quitAndInstall(false, true)
}
