import type { GitOpRequest, GitPullRequestInfo, GitStatus } from '@shared/types'
import { firstUrl, newPullRequestUrl, parseRemote, type RemoteHost } from './hosting'
import { gitBranches, gitStatus } from './repo'
import { git, NETWORK, run, toolCommand, type RunOptions } from './run'

// ---------- Pull requests ----------

/** Runs gh / glab; undefined when it is not installed (on PATH, or in the WSL distribution). */
async function runTool(root: string, program: 'gh' | 'glab', args: string[], opts: RunOptions = {}): Promise<string | undefined> {
  const cmd = toolCommand(root, program, args)
  if (!cmd) return undefined
  try {
    return await run(cmd, program, { timeout: NETWORK.timeout, ...opts })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT' || /command not found|exec: .*: not found|No such file or directory/i.test(e.message)) return undefined
    throw err
  }
}

/** The remote the current branch tracks (else origin). */
async function remoteOf(root: string, status: GitStatus): Promise<string> {
  const tracked = status.upstream?.split('/')[0]
  if (tracked) return tracked
  const remotes = (await git(root, ['remote']).catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean)
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin')
}

export async function prInfo(root: string): Promise<GitPullRequestInfo & { remote: string; web?: RemoteHost }> {
  const status = await gitStatus(root)
  const branch = status.branch
  const remote = await remoteOf(root, status)
  const url = (await git(root, ['remote', 'get-url', remote]).catch(() => '')).trim()
  const host = url ? parseRemote(url) : undefined
  const prefix = `${remote}/`
  const remoteBranches = (await gitBranches(root)).filter((b) => b.remote && b.name.startsWith(prefix)).map((b) => b.name.slice(prefix.length))
  const head = (await git(root, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim()
  const defaultBase = (head.startsWith(prefix) ? head.slice(prefix.length) : undefined) ?? ['main', 'master', 'develop', 'trunk'].find((b) => remoteBranches.includes(b)) ?? remoteBranches[0]
  const bases = [...new Set([defaultBase, ...remoteBranches].filter((b): b is string => !!b && b !== branch))]
  const title = (await git(root, ['log', '-1', '--format=%s']).catch(() => '')).trim() || undefined
  const info: GitPullRequestInfo & { remote: string; web?: RemoteHost } = { host: host?.kind, branch, defaultBase, bases, title, remote, web: host }
  if (!branch || !host) return info
  try {
    if (host.kind === 'github') {
      const out = await runTool(root, 'gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url,title,state,isDraft', '--limit', '1'])
      if (out !== undefined) {
        info.tool = 'gh'
        const pr = (JSON.parse(out || '[]') as { number: number; url: string; title: string; state: string; isDraft?: boolean }[])[0]
        if (pr) info.existing = { number: pr.number, url: pr.url, title: pr.title, state: pr.state.toLowerCase(), draft: pr.isDraft }
      }
    } else if (host.kind === 'gitlab') {
      const out = await runTool(root, 'glab', ['mr', 'list', '--source-branch', branch, '--output', 'json'])
      if (out !== undefined) {
        info.tool = 'glab'
        const mr = (JSON.parse(out || '[]') as { iid: number; web_url: string; title: string; state: string; draft?: boolean }[])[0]
        if (mr) info.existing = { number: mr.iid, url: mr.web_url, title: mr.title, state: mr.state, draft: mr.draft }
      }
    }
  } catch (err) {
    // Installed but not usable (not logged in, no network…): the host's page still works.
    info.tool = undefined
    info.toolError = (err as Error).message.split('\n')[0]
  }
  return info
}

/**
 * Creates a pull (merge) request for the current branch: pushes it first (publishing it if
 * needed), then creates the request with gh / glab — or returns the host's "new pull request"
 * page when neither is available.
 */
export async function createPr(root: string, req: GitOpRequest): Promise<{ url: string; openPage?: boolean; text?: string }> {
  const info = await prInfo(root)
  if (!info.branch) throw new Error('Switch to a branch first.')
  if (!info.web) throw new Error('The remote is not on GitHub, GitLab, Bitbucket or Azure DevOps.')
  const base = String(req.base ?? info.defaultBase ?? '')
  if (!info.bases.includes(base)) throw new Error(`Unknown target branch "${base}"`)
  const title = String(req.title ?? '').trim()
  const body = String(req.body ?? '')
  if (info.tool && !title) throw new Error('Enter a title.')

  const status = await gitStatus(root)
  if (!status.upstream) await git(root, ['push', '--set-upstream', info.remote, 'HEAD'], NETWORK)
  else if (status.ahead > 0) await git(root, ['push'], NETWORK)

  if (info.tool === 'gh') {
    const out = await runTool(root, 'gh', ['pr', 'create', `--title=${title}`, `--body=${body}`, `--base=${base}`, `--head=${info.branch}`, ...(req.draft ? ['--draft'] : [])])
    const url = firstUrl(out ?? '')
    if (url) return { url, text: out?.trim() }
  } else if (info.tool === 'glab') {
    const out = await runTool(root, 'glab', [
      'mr',
      'create',
      `--title=${title}`,
      `--description=${body}`,
      `--target-branch=${base}`,
      `--source-branch=${info.branch}`,
      ...(req.draft ? ['--draft'] : []),
      '--yes'
    ])
    const url = firstUrl(out ?? '')
    if (url) return { url, text: out?.trim() }
  }
  return { url: newPullRequestUrl(info.web, base, info.branch), openPage: true }
}
