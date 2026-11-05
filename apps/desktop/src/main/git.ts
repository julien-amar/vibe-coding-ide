import { spawn } from 'node:child_process'
import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { GitBranch, GitCommit, GitCommitFile, GitLog, GitOpRequest, GitOpResult, GitStatus, GitStatusFile, GitWorktree } from '@shared/types'
import { which } from './profiles'
import { parseWslPath } from '@shared/wsl-paths'

const MAX_COMMITS = 2000
const FIELD = '\x1f'
const RECORD = '\x1e'

function gitBinary(): string {
  const onPath = which('git')
  if (onPath) return onPath
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
      const candidate = base && join(base, 'Git', 'cmd', 'git.exe')
      if (candidate && existsSync(candidate)) return candidate
    }
  }
  return 'git'
}

const BASE_CONFIG = ['-c', 'core.quotepath=off', '-c', 'log.showSignature=false', '-c', 'color.ui=false']

/**
 * How to run git for a project root. Repos inside WSL (\\wsl.localhost\<distro>\…)
 * run the distro's own git through wsl.exe — faster and correct (permissions,
 * symlinks, line endings) compared to Windows git over the network share.
 * --exec runs git directly: without it wsl.exe passes the command line through
 * the distro shell, which would mangle arguments such as --format=%(refname).
 */
function gitCommand(root: string, args: string[]): { file: string; args: string[] } {
  const wsl = process.platform === 'win32' ? parseWslPath(root) : undefined
  if (wsl) {
    const wslExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
    return { file: wslExe, args: ['-d', wsl.distro, '--cd', wsl.path, '--exec', 'git', ...BASE_CONFIG, ...args] }
  }
  return { file: gitBinary(), args: ['-C', root, ...BASE_CONFIG, ...args] }
}

interface RunOptions {
  timeout?: number
  input?: string
  /** Exit codes that are not errors (e.g. 1 for `git diff --no-index` with differences). */
  okCodes?: number[]
}

function git(root: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const cmd = gitCommand(root, args)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, {
      windowsHide: true,
      // Never block on a terminal credential prompt; credential managers (GUI) still work.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8' }
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    child.stdout.on('data', (b: Buffer) => {
      size += b.length
      if (size <= 64 * 1024 * 1024) out.push(b)
    })
    child.stderr.on('data', (b: Buffer) => err.push(b))
    const timer = setTimeout(() => child.kill(), opts.timeout ?? 20000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      if (code === 0 || (code !== null && opts.okCodes?.includes(code))) resolve(stdout)
      else reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git ${args[0]} failed (exit ${code})`))
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

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

async function gitBranches(root: string): Promise<GitBranch[]> {
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
function toProjectPath(root: string, p: string): string {
  const wsl = process.platform === 'win32' ? parseWslPath(root) : undefined
  return wsl && p.startsWith('/') ? `\\\\wsl.localhost\\${wsl.distro}${p.replace(/\//g, '\\')}` : p.replace(/\//g, process.platform === 'win32' ? '\\' : '/')
}

async function gitWorktrees(root: string): Promise<GitWorktree[]> {
  const raw = await git(root, ['worktree', 'list', '--porcelain'])
  const list: GitWorktree[] = []
  let cur: GitWorktree | undefined
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: toProjectPath(root, line.slice(9).trim()), main: list.length === 0 }
      list.push(cur)
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '').trim()
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
function pathKey(p: string): string {
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
async function startPoint(root: string, v: unknown): Promise<string | undefined> {
  const s = String(v ?? '').trim()
  return !s || s === 'HEAD' ? undefined : validBranch(root, s)
}

/** Reject anything git would not accept as a branch name (also blocks option injection). */
async function validBranch(root: string, name: unknown): Promise<string> {
  const n = String(name ?? '').trim()
  if (!n || n.startsWith('-')) throw new Error('Invalid branch name')
  await git(root, ['check-ref-format', '--branch', n]).catch(() => {
    throw new Error(`"${n}" is not a valid branch name`)
  })
  return n
}

const pathList = (v: unknown): string[] => {
  const list = (Array.isArray(v) ? v : [v]).map((p) => String(p ?? '')).filter(Boolean)
  if (list.length === 0) throw new Error('No files given')
  return list
}

const NETWORK = { timeout: 180000 }

/** Commit ids from the renderer: hex object names only (never options or revision expressions). */
function validHash(v: unknown): string {
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
 * All write/read actions the Git panel can perform. Each maps to a fixed git
 * command line; user-provided values are validated and passed after `--`
 * where git allows it, so a renderer can never inject arbitrary git options.
 */
export async function gitOp(root: string, req: GitOpRequest): Promise<GitOpResult> {
  try {
    switch (req.op) {
      case 'status':
        return { ok: true, status: await gitStatus(root) }
      case 'diff': {
        const path = pathList(req.path)[0]
        let text: string
        if (req.untracked) text = await git(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', path], { okCodes: [1] })
        else text = await git(root, ['diff', '--no-color', ...(req.staged ? ['--cached'] : []), '--', path])
        return { ok: true, text }
      }
      case 'stage':
        await git(root, ['add', '-A', '--', ...pathList(req.paths)])
        return { ok: true }
      case 'unstage':
        await git(root, ['restore', '--staged', '--', ...pathList(req.paths)]).catch(async () => {
          // No commit yet: there is no HEAD to restore from.
          await git(root, ['rm', '-r', '-q', '--cached', '--', ...pathList(req.paths)])
        })
        return { ok: true }
      case 'discard':
        // Untracked files are deleted; tracked files go back to their staged/committed content.
        if (req.untracked) await git(root, ['clean', '-f', '-q', '--', ...pathList(req.paths)])
        else await git(root, ['restore', '--worktree', '--', ...pathList(req.paths)])
        return { ok: true }
      case 'commit': {
        const message = String(req.message ?? '')
        if (!message.trim() && !req.amend) throw new Error('Enter a commit message')
        const args = ['commit', '--cleanup=strip']
        if (req.amend) args.push('--amend')
        if (message.trim()) args.push('-F', '-')
        else args.push('--no-edit')
        const out = await git(root, args, { input: message.trim() ? message : undefined, timeout: 60000 })
        return { ok: true, text: out }
      }
      case 'branches':
        return { ok: true, branches: await gitBranches(root), worktrees: await gitWorktrees(root) }
      case 'switch': {
        const name = await validBranch(root, req.branch)
        // Switching to "origin/x" creates (or reuses) a local tracking branch "x".
        if (req.remote) {
          const local = name.replace(/^[^/]+\//, '')
          const exists = (await gitBranches(root)).some((b) => !b.remote && b.name === local)
          await git(root, exists ? ['switch', local] : ['switch', '--track', name])
        } else await git(root, ['switch', name])
        return { ok: true }
      }
      case 'createBranch': {
        const name = await validBranch(root, req.branch)
        const start = await startPoint(root, req.start)
        await git(root, req.checkout === false ? ['branch', name, ...(start ? [start] : [])] : ['switch', '-c', name, ...(start ? [start] : [])])
        return { ok: true }
      }
      case 'renameBranch': {
        const from = await validBranch(root, req.branch)
        const to = await validBranch(root, req.newName)
        await git(root, ['branch', '-m', from, to])
        return { ok: true }
      }
      case 'deleteBranch': {
        const name = await validBranch(root, req.branch)
        if (req.remote) {
          const [remote, ...rest] = name.split('/')
          await git(root, ['push', remote, '--delete', rest.join('/')], NETWORK)
        } else await git(root, ['branch', req.force ? '-D' : '-d', name])
        return { ok: true }
      }
      case 'commitFiles': {
        // Files changed by a commit, compared with its first parent (root commit: everything added).
        const hash = validHash(req.hash)
        const raw = req.parent
          ? await git(root, ['diff', '--no-color', '--name-status', '-z', '-M', validHash(req.parent), hash])
          : await git(root, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', hash])
        const message = await git(root, ['show', '-s', '--format=%B', hash])
        return { ok: true, files: parseNameStatus(raw), text: message.trim() }
      }
      case 'commitDiff': {
        const hash = validHash(req.hash)
        const paths = [pathList(req.path)[0], ...(req.origPath ? [String(req.origPath)] : [])]
        const text = req.parent
          ? await git(root, ['diff', '--no-color', '-M', validHash(req.parent), hash, '--', ...paths])
          : await git(root, ['show', '--no-color', '--format=', hash, '--', ...paths])
        return { ok: true, text }
      }
      case 'merge': {
        const name = await validBranch(root, req.branch)
        const out = await git(root, ['merge', '--no-edit', name], { timeout: 60000 })
        return { ok: true, text: out }
      }
      case 'fetch':
        await git(root, ['fetch', '--all', '--prune'], NETWORK)
        return { ok: true }
      case 'pull': {
        const out = await git(root, ['pull', '--no-edit'], NETWORK)
        return { ok: true, text: out }
      }
      case 'push': {
        const status = await gitStatus(root)
        // First push of a branch: publish it and set its upstream.
        const args = status.upstream ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD']
        await git(root, args, NETWORK)
        return { ok: true }
      }
      case 'addWorktree': {
        const feature = String(req.branch ?? '').trim()
        const branch = await validBranch(root, feature.includes('/') ? feature : `feature/${feature}`)
        const base = (await startPoint(root, req.start)) ?? 'HEAD'
        const dir = worktreeDir(root, feature.split('/').pop() ?? feature)
        await git(root, ['worktree', 'add', '-b', branch, '--', dir, base], { timeout: 120000 })
        return { ok: true, path: toProjectPath(root, dir), text: branch }
      }
      case 'removeWorktree': {
        const target = String(req.path ?? '')
        const key = pathKey(target)
        const wt = (await gitWorktrees(root)).find((w) => pathKey(w.path) === key)
        if (!wt || wt.main) throw new Error('Unknown worktree')
        const wsl = parseWslPath(wt.path)
        try {
          await git(root, ['worktree', 'remove', ...(req.force ? ['--force'] : []), '--', wsl ? wsl.path : wt.path], { timeout: 60000 })
        } catch (err) {
          // Windows: git unregisters the worktree and deletes its files, but cannot delete a folder a
          // process still has open. If the worktree is gone from git, that is a success with a note.
          const stillThere = (await gitWorktrees(root)).some((w) => w.path === wt.path)
          if (stillThere) throw err
          return { ok: true, text: `The worktree was removed, but the folder ${wt.path} is still in use and could not be deleted. Delete it once nothing uses it.` }
        }
        return { ok: true }
      }
      default:
        throw new Error('Unknown git operation')
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Notifies subscribed windows when a repository's refs change (commit,
 * checkout, fetch…). Local repos use a file watcher on `.git`; WSL repos (no
 * reliable file events over \\wsl.localhost) are polled.
 */
export class GitWatcher {
  private watchers = new Map<string, { stop: () => void; subscribers: Set<WebContents>; timer?: NodeJS.Timeout }>()

  private notify(root: string): void {
    const e = this.watchers.get(root)
    if (!e) return
    clearTimeout(e.timer)
    e.timer = setTimeout(() => e.subscribers.forEach((s) => !s.isDestroyed() && s.send('git:changed', root)), 300)
  }

  private start(root: string): (() => void) | undefined {
    if (parseWslPath(root)) {
      let last = ''
      let busy = false
      const poll = async (): Promise<void> => {
        if (busy) return
        busy = true
        try {
          const sig = await git(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']).then(
            async (refs) => refs + (await git(root, ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD']).catch(() => ''))
          )
          if (last && sig !== last) this.notify(root)
          last = sig
        } catch {
          /* repo temporarily unavailable */
        } finally {
          busy = false
        }
      }
      void poll()
      const iv = setInterval(() => void poll(), 4000)
      return () => clearInterval(iv)
    }
    const gitDir = join(root, '.git')
    if (!existsSync(gitDir)) return undefined
    let fsw: FSWatcher
    try {
      fsw = watch(gitDir, { recursive: true }, (_event, filename) => {
        const f = String(filename ?? '').replace(/\\/g, '/')
        // Ref movements matter for the log; the index for the changes view.
        if (f === 'HEAD' || f === 'index' || f === 'packed-refs' || f.startsWith('refs/') || f === 'FETCH_HEAD' || f === 'ORIG_HEAD') this.notify(root)
      })
    } catch {
      return undefined // recursive watch unsupported: manual refresh only
    }
    return () => fsw.close()
  }

  watch(root: string, wc: WebContents): void {
    let entry = this.watchers.get(root)
    if (!entry) {
      const stop = this.start(root)
      if (!stop) return
      entry = { stop, subscribers: new Set() }
      this.watchers.set(root, entry)
    }
    if (!entry.subscribers.has(wc)) {
      entry.subscribers.add(wc)
      wc.once('destroyed', () => this.unwatch(root, wc))
    }
  }

  unwatch(root: string, wc: WebContents): void {
    const entry = this.watchers.get(root)
    if (!entry) return
    entry.subscribers.delete(wc)
    if (entry.subscribers.size === 0) {
      clearTimeout(entry.timer)
      entry.stop()
      this.watchers.delete(root)
    }
  }
}
