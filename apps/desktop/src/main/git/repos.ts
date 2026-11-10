import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { GitRepo } from '@shared/types'
import { SKIP_DIRS } from '../tests/core'
import { git } from './run'

/** How deep below a project folder repositories are looked for, and how many folders at most. */
const MAX_DEPTH = 4
const MAX_DIRS = 20_000

/**
 * The git repositories of a project folder: the folder itself when it is in a repository (its own,
 * or one it is a sub-folder of), then every repository below it (a `.git` folder, or a `.git` file:
 * submodules, worktrees), a few levels deep; dependency and build folders are skipped.
 */
export async function findGitRepos(root: string): Promise<GitRepo[]> {
  const repos: GitRepo[] = []
  let inRepo = existsSync(join(root, '.git'))
  if (!inRepo) {
    try {
      inRepo = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
    } catch {
      inRepo = false
    }
  }
  if (inRepo) repos.push({ path: root, relPath: '' })

  let visited = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (++visited > MAX_DIRS) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (dir !== root && entries.some((e) => e.name === '.git')) repos.push({ path: dir, relPath: relative(root, dir).replace(/\\/g, '/') })
    if (depth >= MAX_DEPTH) return
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), depth + 1)
    }
  }
  await walk(root, 0)
  return repos.sort((a, b) => a.relPath.localeCompare(b.relPath))
}
