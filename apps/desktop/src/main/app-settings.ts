import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, nativeTheme } from 'electron'
import type { AppSettings, Profile } from '@shared/types'
import { setWslEnabled } from './profiles'

/** Application-wide settings: <userData>/settings.json, applied at start and on each change. */

const DEFAULTS: AppSettings = { theme: 'system', wsl: true, hiddenProfiles: [] }

let current: AppSettings | undefined

const file = (): string => join(app.getPath('userData'), 'settings.json')

/** Settings from untrusted JSON (the file, or the renderer): only known, well-typed values. */
export function sanitizeSettings(input: unknown, base: AppSettings = DEFAULTS): AppSettings {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return {
    theme: s.theme === 'light' || s.theme === 'dark' || s.theme === 'system' ? s.theme : base.theme,
    wsl: typeof s.wsl === 'boolean' ? s.wsl : base.wsl,
    hiddenProfiles: Array.isArray(s.hiddenProfiles) ? [...new Set(s.hiddenProfiles.filter((x): x is string => typeof x === 'string'))] : base.hiddenProfiles,
    // A profile id, or null / '' for "the first found".
    defaultShell: 'defaultShell' in s ? (typeof s.defaultShell === 'string' && s.defaultShell ? s.defaultShell : undefined) : base.defaultShell,
    defaultAgent: 'defaultAgent' in s ? (typeof s.defaultAgent === 'string' && s.defaultAgent ? s.defaultAgent : undefined) : base.defaultAgent
  }
}

export function getSettings(): AppSettings {
  if (!current) {
    try {
      current = sanitizeSettings(JSON.parse(readFileSync(file(), 'utf8')))
    } catch {
      current = { ...DEFAULTS }
    }
  }
  return current
}

function apply(s: AppSettings): void {
  // The renderers' prefers-color-scheme (CSS, terminals) and the window frames follow this.
  nativeTheme.themeSource = s.theme
  setWslEnabled(s.wsl)
}

/** Applies the saved settings (at start, before the first window). */
export function applySettings(): void {
  apply(getSettings())
}

/** Every setting back to its default. */
export const resetSettings = (): AppSettings => updateSettings(DEFAULTS, DEFAULTS)

export function updateSettings(patch: unknown, base: AppSettings = getSettings()): AppSettings {
  const next = sanitizeSettings(patch, base)
  current = next
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2))
  } catch {
    /* kept for this run */
  }
  apply(next)
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('settings:changed', next)
  return next
}

/** The profiles offered: hidden ones left out. */
export const offeredProfiles = (list: Profile[]): Profile[] => {
  const hidden = new Set(getSettings().hiddenProfiles)
  return list.filter((p) => !hidden.has(p.id))
}
