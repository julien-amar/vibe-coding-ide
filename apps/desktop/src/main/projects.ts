import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import type { RecentProject } from '@shared/types'

const MAX_RECENT = 15
const file = (): string => join(app.getPath('userData'), 'projects.json')

function load(): RecentProject[] {
  try {
    const data = JSON.parse(readFileSync(file(), 'utf8')) as { recent?: RecentProject[] }
    return Array.isArray(data.recent) ? data.recent : []
  } catch {
    return []
  }
}

function save(recent: RecentProject[]): void {
  const path = file()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify({ recent }, null, 2))
    renameSync(`${path}.tmp`, path)
  } catch (err) {
    console.error('Failed to save projects', err)
  }
}

export function projectName(root: string): string {
  return basename(root.replace(/[\\/]+$/, '')) || root
}

/** Recent projects whose folder still exists, most recent first. */
export function recentProjects(): RecentProject[] {
  return load()
    .filter((p) => existsSync(p.root))
    .sort((a, b) => b.lastOpened - a.lastOpened)
}

export function touchProject(root: string): void {
  if (!root || !existsSync(root)) return
  const rest = load().filter((p) => p.root.toLowerCase() !== root.toLowerCase())
  save([{ root, name: projectName(root), lastOpened: Date.now() }, ...rest].slice(0, MAX_RECENT))
}
