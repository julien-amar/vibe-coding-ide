import { execFile } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { GitCommit, GitLog } from '@shared/types'
import { which } from './profiles'

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

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      gitBinary(),
      ['-C', root, '-c', 'core.quotepath=off', '-c', 'log.showSignature=false', ...args],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout))
    )
  })
}

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
    raw = await git(root, [
      'log',
      '--all',
      '--date-order',
      `-n${MAX_COMMITS}`,
      `--format=%H${FIELD}%P${FIELD}%an${FIELD}%at${FIELD}%D${FIELD}%s${RECORD}`
    ])
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

/** Watches `.git` of each project root for ref/HEAD changes and notifies subscribed windows. */
export class GitWatcher {
  private watchers = new Map<string, { fsw: FSWatcher; subscribers: Set<WebContents>; timer?: NodeJS.Timeout }>()

  watch(root: string, wc: WebContents): void {
    let entry = this.watchers.get(root)
    if (!entry) {
      const gitDir = join(root, '.git')
      if (!existsSync(gitDir)) return
      let fsw: FSWatcher
      try {
        fsw = watch(gitDir, { recursive: true }, (_event, filename) => {
          const f = String(filename ?? '').replace(/\\/g, '/')
          // Only ref movements matter for the log; ignore index/object churn.
          if (!(f === 'HEAD' || f === 'packed-refs' || f.startsWith('refs/') || f === 'FETCH_HEAD' || f === 'ORIG_HEAD')) return
          const e = this.watchers.get(root)
          if (!e) return
          clearTimeout(e.timer)
          e.timer = setTimeout(() => e.subscribers.forEach((s) => !s.isDestroyed() && s.send('git:changed', root)), 300)
        })
      } catch {
        return // recursive watch unsupported: manual refresh only
      }
      entry = { fsw, subscribers: new Set() }
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
      entry.fsw.close()
      this.watchers.delete(root)
    }
  }
}
