import { useCallback, useEffect, useState } from 'react'
import type { GitOpRequest, GitOpResult, GitStatus } from '@shared/types'
import { notify } from './Dialogs'
import { GitLogPane } from './GitLogPane'
import { BranchesView } from './GitBranches'
import { ChangesView } from './GitChanges'
import { pullRequest } from './GitPullRequest'

type View = 'history' | 'changes' | 'branches'

/** Runs a git operation with a busy label and a toast; the views refresh afterwards. */
export type GitRun = (label: string, req: GitOpRequest, success?: string) => Promise<GitOpResult>

/**
 * Git panel of a project: History (commit graph), Changes (stage / commit) and
 * Branches (switch, create, merge, feature worktrees), plus fetch / pull / push.
 */
export function GitPanel({ root, visible, openProject }: { root: string; visible: boolean; openProject: (path: string) => void }): React.JSX.Element {
  const [view, setView] = useState<View>('history')
  /** Bumped when the repository changed (refs, index, actions): every view reloads. */
  const [tick, setTick] = useState(0)
  /** Bumped by the status poll: only status and the open diff reload. */
  const [poll, setPoll] = useState(0)
  /** undefined: loading; null: not a git repository. */
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  /** Bumped by the Refresh button: the views show loading (spinners) until reloaded. */
  const [reset, setReset] = useState(0)
  const reload = (): void => {
    setStatus(undefined)
    setReset((r) => r + 1)
    refresh()
  }

  // Repository changes (commit, checkout, fetch, staging…) from any source refresh every view.
  useEffect(() => {
    window.ide.git.watch(root)
    const off = window.ide.git.onChanged((r) => {
      if (r === root) refresh()
    })
    return () => {
      off()
      window.ide.git.unwatch(root)
    }
  }, [root, refresh])

  useEffect(() => {
    let alive = true
    void window.ide.git.op(root, { op: 'status' }).then((r) => alive && setStatus(r.ok && r.status ? r.status : null))
    return () => {
      alive = false
    }
  }, [root, tick, poll])

  // File edits do not touch .git: poll the status while the panel is on screen.
  useEffect(() => {
    if (!visible) return
    const iv = setInterval(() => setPoll((p) => p + 1), 3000)
    return () => clearInterval(iv)
  }, [visible])

  const run: GitRun = useCallback(
    async (label, req, success) => {
      setBusy(label)
      const r = await window.ide.git.op(root, req)
      setBusy(null)
      if (!r.ok) notify(r.error ?? `${label} failed`, 'error')
      else if (success) notify(success, 'success')
      refresh()
      return r
    },
    [root, refresh]
  )

  const changes = status?.files.length ?? 0

  return (
    <div className="git-panel">
      <div className="pane-toolbar git-toolbar">
        <div className="subtabs" role="tablist" aria-label="Git views">
          {(['history', 'changes', 'branches'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {v === 'history' ? 'History' : v === 'changes' ? 'Changes' : 'Branches'}
              {v === 'changes' && changes > 0 && <span className="count">{changes}</span>}
            </button>
          ))}
        </div>
        {status?.branch && (
          <span className="ref-badge head" title={status.upstream ? `Tracking ${status.upstream}` : 'Not published'}>
            {status.branch}
          </span>
        )}
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="muted" title="Commits to push / to pull">
            {status.ahead > 0 && `↑${status.ahead}`} {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <span className="spacer" />
        {busy && <span className="muted busy">{busy}…</span>}
        {status && (
          <>
            <button className="tool-button" disabled={!!busy} title="Fetch all remotes" onClick={() => void run('Fetching', { op: 'fetch' }, 'Fetched')}>
              Fetch
            </button>
            <button
              className="tool-button"
              disabled={!!busy || !status.upstream}
              title="Pull from upstream"
              onClick={() => void run('Pulling', { op: 'pull' }, 'Pulled')}
            >
              Pull
            </button>
            <button
              className="tool-button"
              disabled={!!busy || !status.branch}
              title={status.upstream ? 'Push to upstream' : 'Publish this branch to origin'}
              onClick={() => void run('Pushing', { op: 'push' }, status.upstream ? 'Pushed' : `Published ${status.branch}`)}
            >
              {status.upstream ? 'Push' : 'Publish'}
            </button>
            <button
              className="tool-button"
              disabled={!!busy || !status.branch}
              title="Open this branch's pull request, or create one"
              onClick={() => void pullRequest(root, setBusy, run)}
            >
              Pull request
            </button>
          </>
        )}
        <button className="icon-button" title="Refresh" onClick={reload}>
          ⟳
        </button>
      </div>
      <div className="git-view">
        {view === 'history' && <GitLogPane root={root} visible={visible} tick={tick} reset={reset} />}
        {view === 'changes' && <ChangesView root={root} status={status} run={run} refreshKey={`${tick}:${poll}`} />}
        {view === 'branches' && <BranchesView root={root} status={status} run={run} tick={tick} openProject={openProject} />}
      </div>
    </div>
  )
}
