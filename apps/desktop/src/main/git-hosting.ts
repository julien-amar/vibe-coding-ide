/** Where a repository's remote is hosted, and that host's "new pull request" page. */

export type HostKind = 'github' | 'gitlab' | 'bitbucket' | 'azure'

export interface RemoteHost {
  kind: HostKind
  /** Web address of the repository, e.g. https://github.com/owner/repo */
  web: string
}

/**
 * Parses a remote URL: https://host/owner/repo(.git), git@host:owner/repo(.git),
 * ssh://git@host[:port]/owner/repo(.git). Self-hosted GitLab / GitHub Enterprise are recognised
 * from "gitlab" / "github" in the host name.
 */
export function parseRemote(url: string): RemoteHost | undefined {
  const u = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u)
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u)
  if (full) [host, path] = [full[1], full[2]]
  else if (scp) [host, path] = [scp[1], scp[2]]
  else return undefined
  path = path.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const h = host.toLowerCase()
  // Azure DevOps: dev.azure.com/org/project/_git/repo, ssh.dev.azure.com:v3/org/project/repo
  if (h === 'dev.azure.com' || h === 'ssh.dev.azure.com' || h.endsWith('.visualstudio.com')) {
    const parts = path.replace(/^v3\//, '').split('/')
    const git = parts.indexOf('_git')
    const [org, project, repo] = git >= 0 ? [parts[0], parts[git - 1], parts[git + 1]] : parts
    if (h.endsWith('.visualstudio.com')) return { kind: 'azure', web: `https://${h}/${parts.slice(0, git).join('/')}/_git/${parts[git + 1]}` }
    if (!org || !project || !repo) return undefined
    return { kind: 'azure', web: `https://dev.azure.com/${org}/${project}/_git/${repo}` }
  }
  if (!path.includes('/')) return undefined
  const kind: HostKind | undefined = h.includes('github') ? 'github' : h.includes('gitlab') ? 'gitlab' : h.includes('bitbucket') ? 'bitbucket' : undefined
  if (!kind) return undefined
  return { kind, web: `https://${h === 'ssh.github.com' ? 'github.com' : h}/${path}` }
}

/** The host's page to open a pull (merge) request from `head` into `base`. */
export function newPullRequestUrl(r: RemoteHost, base: string, head: string): string {
  const e = encodeURIComponent
  switch (r.kind) {
    case 'github':
      return `${r.web}/compare/${base.split('/').map(e).join('/')}...${head.split('/').map(e).join('/')}?expand=1`
    case 'gitlab':
      return `${r.web}/-/merge_requests/new?${e('merge_request[source_branch]')}=${e(head)}&${e('merge_request[target_branch]')}=${e(base)}`
    case 'bitbucket':
      return `${r.web}/pull-requests/new?source=${e(head)}&dest=${e(base)}`
    case 'azure':
      return `${r.web}/pullrequestcreate?sourceRef=${e(head)}&targetRef=${e(base)}`
  }
}

/** The first web address in a command's output (gh / glab print the new request's address). */
export const firstUrl = (text: string): string | undefined => /https?:\/\/\S+/.exec(text)?.[0]
