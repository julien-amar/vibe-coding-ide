import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, screen, type Rectangle } from 'electron'
import type { TabSnapshot } from '@shared/types'

export interface SavedWindow {
  bounds: Rectangle
  maximized: boolean
  activeIndex: number
  tabs: TabSnapshot[]
}

interface LayoutFile {
  version: 1
  windows: SavedWindow[]
}

const file = (): string => join(app.getPath('userData'), 'layout.json')

export function loadLayout(): SavedWindow[] {
  try {
    const data = JSON.parse(readFileSync(file(), 'utf8')) as LayoutFile
    if (data.version !== 1 || !Array.isArray(data.windows)) return []
    return data.windows.filter((w) => Array.isArray(w.tabs))
  } catch {
    return []
  }
}

/** Atomic write: a crash mid-write never leaves a truncated layout file. */
export function saveLayout(windows: SavedWindow[]): void {
  const path = file()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ version: 1, windows } satisfies LayoutFile))
    renameSync(tmp, path)
  } catch (err) {
    console.error('Failed to save layout', err)
  }
}

/** Keep restored windows on a connected display. */
export function visibleBounds(bounds: Rectangle | undefined): Rectangle | undefined {
  if (!bounds) return undefined
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => {
    const x = Math.max(a.x, bounds.x)
    const y = Math.max(a.y, bounds.y)
    const w = Math.min(a.x + a.width, bounds.x + bounds.width) - x
    const h = Math.min(a.y + a.height, bounds.y + bounds.height) - y
    return w >= 100 && h >= 60
  })
  return onScreen ? bounds : undefined
}
