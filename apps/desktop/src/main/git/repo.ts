import { realpathSync } from 'node:fs'
import type { GitBranch, GitCommit, GitCommitFile, GitLog, GitStatus, GitStatusFile, GitWorktree } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { git } from './run'

/** Reading a repository (log, status, branches, worktrees, diffs) and validating values from the renderer. */

const MAX_COMMITS = 2000
const FIELD = '\x1f'
const RECORD = '\x1e'

// ---------- Log ----------

export async function gitLog(root: string): Promise<GitLog> {
  try {
    const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return { isRepo: false, commits: [] }
  } catch (err) {
    const msg = (err as Error).message
    if (/not a git repository/i.test(msg)) return { isRepo: false, commits: [] }
    return { isRepo: false, error: msg, commits: [] }
  }

  let branch: string | undefined
  try {
    branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    branch = undefined // no commits yet
  }

  let raw = ''
  try {
    raw = await git(root, ['log', '--all', '--date-order', `-n${MAX_COMMITS}`, `--format=%H${FIELD}%P${FIELD}%an${FIELD}%at${FIELD}%D${FIELD}%s${RECORD}`])
  } catch (err) {
    // An empty repository has no log yet.
    if (/does not have any commits|bad default revision/i.test((err as Error).message)) return { isRepo: true, branch, commits: [] }
    return { isRepo: true, branch, error: (err as Error).message, commits: [] }
  }

  const commits: GitCommit[] = []
  for (const rec of raw.split(RECORD)) {
    const line = rec.replace(/^\r?\n/, '')
    if (!line) continue
    const [hash, parents, author, date, refs, subject] = line.split(FIELD)
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      date: Number(date),
      refs: refs ? refs.split(', ').filter(Boolean) : [],
      subject: subject ?? ''
    })
  }
  return { isRepo: true, branch, commits }
}

// ---------- Status ----------

/** Parse `git status --porcelain=v1 -z --branch` output. */
export function parseStatus(raw: string): GitStatus {
  const parts = raw.split('\0')
  const status: GitStatus = { files: [], ahead: 0, behind: 0 }
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    if (entry.startsWith('## ')) {
      // "## main...origin/main [ahead 1, behind 2]" / "## No commits yet on main" / "## HEAD (no branch)"
      let head = entry.slice(3)
      const track = / \[(.*)\]$/.exec(head)
      if (track) head = head.slice(0, track.index)
      head = head.replace(/^(No commits yet on|Initial commit on) /, '')
      const [local, upstream] = head.split('...')
      status.branch = local.startsWith('HEAD') ? undefined : local
      status.upstream = upstream || undefined
      status.ahead = Number(/ahead (\d+)/.exec(track?.[1] ?? '')?.[1] ?? 0)
      status.behind = Number(/behind (\d+)/.exec(track?.[1] ?? '')?.[1] ?? 0)
      continue
    }
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const file: GitStatusFile = { path, index: x, worktree: y }
    // Renames/copies carry the original path as the next NUL-separated field.
    if (x === 'R' || x === 'C') file.origPath = parts[++i]
    status.files.push(file)
  }
  return status
}

export async function gitStatus(root: string): Promise<GitStatus> {
  return parseStatus(await git(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']))
}

// ---------- Branches & worktrees ----------

export async function gitBranches(root: string): Promise<GitBranch[]> {
  const raw = await git(root, [
    'for-each-ref',
    `--format=%(refname)${FIELD}%(refname:short)${FIELD}%(HEAD)${FIELD}%(upstream:short)${FIELD}%(upstream:track)${FIELD}%(committerdate:unix)${FIELD}%(subject)`,
    'refs/heads',
    'refs/remotes'
  ])
  const branches: GitBranch[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [ref, name, head, upstream, track, date, subject] = line.split(FIELD)
    if (ref.endsWith('/HEAD')) continue // origin/HEAD alias
    branches.push({
      name,
      remote: ref.startsWith('refs/remotes/'),
      current: head === '*',
      upstream: upstream || undefined,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      gone: track.includes('gone'),
      date: Number(date) || 0,
      subject: subject ?? ''
    })
  }
  return branches
}

/** Linux path of a worktree inside WSL → Windows path, so it can be opened as a project. */
export function toProjectPath(root: string, p: string): string {
  const wsl = process.platform === 'win32' ? parseWslPath(root) : undefined
  return wsl && p.startsWith('/') ? `\\\\wsl.localhost\\${wsl.distro}${p.replace(/\//g, '\\')}` : p.replace(/\//g, process.platform === 'win32' ? '\\' : '/')
}

export async function gitWorktrees(root: string): Promise<GitWorktree[]> {
  const raw = await git(root, ['worktree', 'list', '--porcelain'])
  const list: GitWorktree[] = []
  let cur: GitWorktree | undefined
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: toProjectPath(root, line.slice(9).trim()), main: list.length === 0 }
      list.push(cur)
    } else if (cur && line.startsWith('branch '))
      cur.branch = line
        .slice(7)
        .replace(/^refs\/heads\//, '')
        .trim()
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim()
    else if (cur && line === 'detached') cur.detached = true
    else if (cur && line.startsWith('locked')) cur.locked = true
    else if (cur && line.startsWith('prunable')) cur.prunable = true
  }
  return list
}

/**
 * Comparable form of a local path: resolves 8.3 short names (RUNNER~1) and symlinks
 * (/var -> /private/var on macOS) while the folder exists; case-insensitive on Windows.
 */
export function pathKey(p: string): string {
  let r = p
  if (!parseWslPath(p)) {
    try {
      r = realpathSync.native(p)
    } catch {
      /* gone or inaccessible: compare as given */
    }
  }
  r = r.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' || parseWslPath(p) ? r.toLowerCase() : r
}

/** Start point of a new branch / worktree: HEAD (current commit) or a validated branch name. */
export async function startPoint(root: string, v: unknown): Promise<string | undefined> {
  const s = String(v ?? '').trim()
  return !s || s === 'HEAD' ? undefined : validBranch(root, s)
}

/** Reject anything git would not accept as a branch name (also blocks option injection). */
export async function validBranch(root: string, name: unknown): Promise<string> {
  const n = String(name ?? '').trim()
  if (!n || n.startsWith('-')) throw new Error('Invalid branch name')
  await git(root, ['check-ref-format', '--branch', n]).catch(() => {
    throw new Error(`"${n}" is not a valid branch name`)
  })
  return n
}

export const pathList = (v: unknown): string[] => {
  const list = (Array.isArray(v) ? v : [v]).map((p) => String(p ?? '')).filter(Boolean)
  if (list.length === 0) throw new Error('No files given')
  return list
}

/** Commit ids from the renderer: hex object names only (never options or revision expressions). */
export function validHash(v: unknown): string {
  const h = String(v ?? '')
  if (!/^[0-9a-f]{4,64}$/i.test(h)) throw new Error('Invalid commit id')
  return h
}

/** Parse `--name-status -z` output: "M\0path\0" or "R100\0old\0new\0". */
export function parseNameStatus(raw: string): GitCommitFile[] {
  const parts = raw.split('\0')
  const files: GitCommitFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code) continue
    const status = code[0]
    if (status === 'R' || status === 'C') {
      files.push({ status, origPath: parts[i + 1], path: parts[i + 2] })
      i += 2
    } else {
      files.push({ status, path: parts[i + 1] })
      i += 1
    }
  }
  return files
}

/** Folder name for a new feature worktree: next to the repository, "<repo>-<feature>". */
export function worktreeDir(root: string, feature: string): string {
  const wsl = process.platform === 'win32' ? parseWslPath(root) : undefined
  const slug = feature.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'feature'
  if (wsl) {
    const parent = wsl.path.replace(/\/[^/]+\/?$/, '') || '/'
    const repo = wsl.path.split('/').filter(Boolean).pop() ?? 'repo'
    return `${parent === '/' ? '' : parent}/${repo}-${slug}`
  }
  const trimmed = root.replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const idx = trimmed.lastIndexOf(sep)
  return `${trimmed.slice(0, idx)}${sep}${trimmed.slice(idx + 1)}-${slug}`
}

/**
 * Diff options, whatever the user's git configuration: no colours or external diff tool, and the
 * usual a/ b/ prefixes (diff.noprefix / diff.mnemonicPrefix would break `git apply` of the lines).
 */
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']

/** A file's unstaged (worktree vs index) or staged (index vs HEAD) diff. */
export const fileDiff = (root: string, path: string, staged: boolean): Promise<string> =>
  git(root, ['diff', ...DIFF_FLAGS, ...(staged ? ['--cached'] : []), '--', path])
