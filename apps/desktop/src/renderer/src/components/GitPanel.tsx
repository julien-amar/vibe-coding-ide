import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, GitBranch, GitOpRequest, GitOpResult, GitPrefs, GitStatus } from '@shared/types'
import { DEFAULT_GIT_PREFS, ignoresWhitespace } from '@shared/settings-defaults'
import { useGitRepos, useGitReposStore } from '../git-repos'
import { notify } from './Dialogs'
import { GitLogPane } from './GitLogPane'
import { BranchesView } from './GitBranches'
import { ChangesView } from './GitChanges'
import { pullRequest } from './GitPullRequest'
import { RebaseButton } from './GitRebase'
import { GitSettings } from './GitSettings'
import { MenuSelect } from './MenuSelect'

type View = 'history' | 'changes' | 'branches'

/** A repository: a folder with a branch. */
function RepoIcon(): React.JSX.Element {
  return (
    <svg
      className="profile-icon repo-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    >
      <circle cx="5" cy="4" r="1.6" />
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="11" cy="6" r="1.6" />
      <path d="M5 5.6v4.8M11 7.6c0 2-2 2.4-4.6 3.4" />
    </svg>
  )
}

/** Runs a git operation with a busy label and a toast; the views refresh afterwards. */
export type GitRun = (label: string, req: GitOpRequest, success?: string) => Promise<GitOpResult>

/** The repository each project's Git panel shows (kept when the panel is moved or reopened). */
const chosenRepo = new Map<string, string>()

/**
 * Git panel of a project: History (commit graph), Changes (stage / commit) and
 * Branches (switch, create, merge, feature worktrees), plus fetch / pull / push. A project folder
 * with several repositories (itself, sub-folders): one at a time, chosen in the toolbar.
 */
export function GitPanel({
  root: projectRoot,
  visible,
  openProject
}: {
  root: string
  visible: boolean
  openProject: (path: string) => void
}): React.JSX.Element {
  const repos = useGitRepos(projectRoot)
  const [chosen, setChosen] = useState(() => chosenRepo.get(projectRoot))
  const root = repos?.find((r) => r.path === chosen)?.path ?? repos?.[0]?.path ?? projectRoot
  const choose = (path: string): void => {
    chosenRepo.set(projectRoot, path)
    setChosen(path)
  }
  useEffect(() => {
    if (!repos) void useGitReposStore.getState().load(projectRoot)
  }, [repos, projectRoot])
  const projectName =
    projectRoot
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || projectRoot
  const [view, setView] = useState<View>('history')
  /** The Git panel's options (every project); changed: the views reload (diffs shown differently). */
  const [prefs, setPrefs] = useState<GitPrefs>(DEFAULT_GIT_PREFS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    void window.ide.settings.get().then((s) => setPrefs(s.git ?? DEFAULT_GIT_PREFS))
    return window.ide.settings.onChanged((s: AppSettings) => setPrefs(s.git ?? DEFAULT_GIT_PREFS))
  }, [])
  const prefsKey = `${prefs.contextLines}:${prefs.whitespace}:${prefs.ignoreBlankLines}`
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
    // Repositories added (git init, a clone) or removed since.
    void useGitReposStore.getState().load(projectRoot)
  }
  // Another repository: its status, not the previous one's.
  useEffect(() => setStatus(undefined), [root])

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

  // The branches (History's Rebase button), reloaded with the views.
  const [branches, setBranches] = useState<GitBranch[]>([])
  useEffect(() => {
    if (view !== 'history') return
    let alive = true
    void window.ide.git.op(root, { op: 'branches' }).then((r) => alive && setBranches(r.ok ? (r.branches ?? []) : []))
    return () => {
      alive = false
    }
  }, [root, view, tick])

  return (
    <div className="git-panel">
      <div className="pane-toolbar git-toolbar">
        {repos && repos.length > 1 && (
          <MenuSelect
            className="git-repo-select"
            label="Repository"
            title="The repository shown (the project folder has several)"
            value={root}
            placeholder={projectName}
            choices={repos.map((r) => ({ value: r.path, label: r.relPath || projectName, icon: <RepoIcon />, title: r.path }))}
            onChange={choose}
          />
        )}
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
        {status?.rebasing && (
          // A rebase stopped halfway: resolve the conflicts (Changes), then continue — or abort it.
          <span className="git-rebasing" role="status">
            <span className="ref-badge head" title="A rebase stopped on conflicts: resolve them in Changes (stage the files), then continue">
              Rebasing
            </span>
            <button
              className="tool-button"
              disabled={!!busy}
              title="Continue the rebase (the conflicts resolved and staged)"
              onClick={() => void run('Continuing the rebase', { op: 'rebaseContinue' }, 'Rebased')}
            >
              Continue
            </button>
            <button
              className="tool-button"
              disabled={!!busy}
              title="Abort the rebase: the branch as it was before"
              onClick={() => void run('Aborting the rebase', { op: 'rebaseAbort' }, 'Rebase aborted')}
            >
              Abort
            </button>
          </span>
        )}
        {view === 'history' && status && !status.rebasing && status.branch && <RebaseButton root={root} branches={branches} busy={!!busy} run={run} />}
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
            {prefs.pushCommand ? (
              // The push command of the settings (e.g. git review): whatever the upstream.
              <button
                className="tool-button"
                disabled={!!busy || !status.branch}
                title={`Push: ${prefs.pushCommand} (Git settings)`}
                onClick={() => void run('Pushing', { op: 'push' }, 'Pushed')}
              >
                Push
              </button>
            ) : (
              <button
                className="tool-button"
                disabled={!!busy || !status.branch}
                title={status.upstream ? 'Push to upstream' : 'Publish this branch to origin'}
                onClick={() => void run('Pushing', { op: 'push' }, status.upstream ? 'Pushed' : `Published ${status.branch}`)}
              >
                {status.upstream ? 'Push' : 'Publish'}
              </button>
            )}
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
        <button className="icon-button" title="Git settings" aria-label="Git settings" onClick={() => setSettingsOpen(true)}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            aria-hidden
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* A gear (as the launcher's Settings). */}
            <path d="M6.8 1.5h2.4l.4 1.9a5 5 0 011.3.75l1.8-.6 1.2 2.1-1.4 1.3a5 5 0 010 1.5l1.4 1.3-1.2 2.1-1.8-.6a5 5 0 01-1.3.75l-.4 1.9H6.8l-.4-1.9a5 5 0 01-1.3-.75l-1.8.6-1.2-2.1 1.4-1.3a5 5 0 010-1.5L2.1 5.65l1.2-2.1 1.8.6a5 5 0 011.3-.75z" />
            <circle cx="8" cy="8" r="2.1" />
          </svg>
        </button>
      </div>
      <div className="git-view" key={root}>
        {view === 'history' && <GitLogPane root={root} visible={visible} tick={tick} reset={reset} />}
        {view === 'changes' && (
          <ChangesView root={root} status={status} run={run} refreshKey={`${tick}:${poll}:${prefsKey}`} partialStaging={!ignoresWhitespace(prefs)} />
        )}
        {view === 'branches' && <BranchesView root={root} status={status} run={run} tick={tick} openProject={openProject} />}
      </div>
      {settingsOpen && <GitSettings prefs={prefs} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
