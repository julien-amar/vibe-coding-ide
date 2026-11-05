import { useCallback, useEffect, useState } from 'react'
import type { GitBranch, GitOpRequest, GitOpResult, GitStatus, GitStatusFile, GitWorktree } from '@shared/types'
import { useTabs } from '../store'
import { relativeTime } from '../time'
import { confirmDialog, notify, openDialog } from './Dialogs'
import { DiffView, STATUS_LABEL } from './GitDiff'
import { GitLogPane } from './GitLogPane'

type View = 'history' | 'changes' | 'branches'
type Run = (label: string, req: GitOpRequest, success?: string) => Promise<GitOpResult>

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
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  // Repository changes (commit, checkout, fetch, staging…) from any source refresh every view.
  useEffect(() => {
    window.devhub.git.watch(root)
    const off = window.devhub.git.onChanged((r) => {
      if (r === root) refresh()
    })
    return () => {
      off()
      window.devhub.git.unwatch(root)
    }
  }, [root, refresh])

  useEffect(() => {
    let alive = true
    void window.devhub.git.op(root, { op: 'status' }).then((r) => alive && setStatus(r.ok && r.status ? r.status : null))
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

  const run: Run = useCallback(
    async (label, req, success) => {
      setBusy(label)
      const r = await window.devhub.git.op(root, req)
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
        <div className="segmented" role="tablist">
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
            <button className="tool-button" disabled={!!busy || !status.upstream} title="Pull from upstream" onClick={() => void run('Pulling', { op: 'pull' }, 'Pulled')}>
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
          </>
        )}
        <button className="icon-button" title="Refresh" onClick={refresh}>
          ⟳
        </button>
      </div>
      <div className="git-view">
        {view === 'history' && <GitLogPane root={root} visible={visible} tick={tick} />}
        {view === 'changes' && <ChangesView root={root} status={status} run={run} refreshKey={`${tick}:${poll}`} />}
        {view === 'branches' && <BranchesView root={root} status={status} run={run} tick={tick} openProject={openProject} />}
      </div>
    </div>
  )
}

// ---------- Changes ----------

interface Selection {
  path: string
  staged: boolean
  untracked: boolean
}

function FileRow({
  file,
  code,
  selected,
  onSelect,
  actions
}: {
  file: GitStatusFile
  code: string
  selected: boolean
  onSelect: () => void
  actions: React.ReactNode
}): React.JSX.Element {
  const [letter, label] = STATUS_LABEL[code] ?? [code, 'changed']
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const dir = slash >= 0 ? file.path.slice(0, slash) : ''
  return (
    <div className={`file-row${selected ? ' selected' : ''}`} onClick={onSelect} title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
      <span className={`file-status s-${label.replace(' ', '-')}`} title={label}>
        {letter}
      </span>
      <span className="file-name">{name}</span>
      <span className="file-dir">{dir}</span>
      <span className="file-actions" onClick={(e) => e.stopPropagation()}>
        {actions}
      </span>
    </div>
  )
}

function ChangesView({ root, status, run, refreshKey }: { root: string; status: GitStatus | null; run: Run; refreshKey: string }): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [selected, setSelected] = useState<Selection>()
  const [diff, setDiff] = useState({ text: '', loading: false })

  const files = status?.files ?? []
  const staged = files.filter((f) => f.index !== ' ' && f.index !== '?')
  const unstaged = files.filter((f) => f.worktree !== ' ')

  // Drop the selection when its file is no longer in that list.
  useEffect(() => {
    if (!selected) return
    const list = selected.staged ? staged : unstaged
    if (!list.some((f) => f.path === selected.path)) setSelected(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  useEffect(() => {
    if (!selected) return
    let alive = true
    setDiff((d) => ({ ...d, loading: d.text === '' }))
    void window.devhub.git.op(root, { op: 'diff', path: selected.path, staged: selected.staged, untracked: selected.untracked }).then((r) => {
      if (alive) setDiff({ text: r.ok ? (r.text ?? '') : (r.error ?? ''), loading: false })
    })
    return () => {
      alive = false
    }
  }, [root, selected, refreshKey])

  const commit = async (): Promise<void> => {
    const r = await run(amend ? 'Amending' : 'Committing', { op: 'commit', message, amend }, amend ? 'Commit amended' : 'Committed')
    if (r.ok) {
      setMessage('')
      setAmend(false)
    }
  }

  const discard = async (f: GitStatusFile): Promise<void> => {
    const untracked = f.worktree === '?'
    const ok = await confirmDialog(
      untracked ? 'Delete file?' : 'Discard changes?',
      untracked ? `${f.path} is not tracked by git and will be deleted.` : `Your changes to ${f.path} will be lost.`,
      untracked ? 'Delete' : 'Discard',
      true
    )
    if (ok) await run('Discarding', { op: 'discard', paths: [f.path], untracked })
  }

  if (!status) return <div className="pane-message">This folder is not a git repository.</div>

  const canCommit = (staged.length > 0 || amend) && (message.trim().length > 0 || amend)

  return (
    <div className="changes-view">
      <div className="changes-side">
        <div className="commit-box">
          <textarea
            className="selectable"
            placeholder={staged.length ? `Message (Ctrl+Enter to commit on ${status.branch ?? 'HEAD'})` : 'Stage changes to commit them'}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) void commit()
            }}
            rows={2}
          />
          <div className="commit-row">
            <label className="dialog-check" title="Replace the last commit with the staged changes (and the new message, if any)">
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
              Amend last commit
            </label>
            <button className="primary" disabled={!canCommit} onClick={() => void commit()}>
              {amend ? 'Amend' : 'Commit'}
              {staged.length > 0 && ` (${staged.length})`}
            </button>
          </div>
        </div>

        <div className="file-lists">
          <div className="file-group-header">
            <span>Staged</span>
            <span className="count">{staged.length}</span>
            <span className="spacer" />
            {staged.length > 0 && (
              <button className="link-button" onClick={() => void run('Unstaging', { op: 'unstage', paths: staged.map((f) => f.path) })}>
                Unstage all
              </button>
            )}
          </div>
          {staged.map((f) => (
            <FileRow
              key={`s:${f.path}`}
              file={f}
              code={f.index}
              selected={selected?.staged === true && selected.path === f.path}
              onSelect={() => setSelected({ path: f.path, staged: true, untracked: false })}
              actions={
                <button className="icon-button" title="Unstage" onClick={() => void run('Unstaging', { op: 'unstage', paths: [f.path] })}>
                  −
                </button>
              }
            />
          ))}
          {staged.length === 0 && <div className="file-empty">Nothing staged</div>}

          <div className="file-group-header">
            <span>Changes</span>
            <span className="count">{unstaged.length}</span>
            <span className="spacer" />
            {unstaged.length > 0 && (
              <button className="link-button" onClick={() => void run('Staging', { op: 'stage', paths: unstaged.map((f) => f.path) })}>
                Stage all
              </button>
            )}
          </div>
          {unstaged.map((f) => (
            <FileRow
              key={`u:${f.path}`}
              file={f}
              code={f.worktree}
              selected={selected?.staged === false && selected.path === f.path}
              onSelect={() => setSelected({ path: f.path, staged: false, untracked: f.worktree === '?' })}
              actions={
                <>
                  <button className="icon-button" title={f.worktree === '?' ? 'Delete file' : 'Discard changes'} onClick={() => void discard(f)}>
                    ↺
                  </button>
                  <button className="icon-button" title="Stage" onClick={() => void run('Staging', { op: 'stage', paths: [f.path] })}>
                    +
                  </button>
                </>
              }
            />
          ))}
          {unstaged.length === 0 && <div className="file-empty">Working tree clean</div>}
        </div>
      </div>
      <div className="changes-diff">
        {selected ? (
          <>
            <div className="diff-title">
              <span className="file-name">{selected.path}</span>
              <span className="muted">{selected.staged ? 'staged' : selected.untracked ? 'untracked' : 'not staged'}</span>
            </div>
            <DiffView text={diff.text} loading={diff.loading} />
          </>
        ) : (
          <div className="pane-message">Select a file to see its changes.</div>
        )}
      </div>
    </div>
  )
}

// ---------- Branches ----------

function BranchesView({
  root,
  status,
  run,
  tick,
  openProject
}: {
  root: string
  status: GitStatus | null
  run: Run
  tick: number
  openProject: (path: string) => void
}): React.JSX.Element {
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [showRemote, setShowRemote] = useState(false)

  useEffect(() => {
    let alive = true
    void window.devhub.git.op(root, { op: 'branches' }).then((r) => {
      if (!alive || !r.ok) return
      setBranches(r.branches ?? [])
      setWorktrees(r.worktrees ?? [])
    })
    return () => {
      alive = false
    }
  }, [root, tick])

  if (!status) return <div className="pane-message">This folder is not a git repository.</div>

  const local = branches.filter((b) => !b.remote).sort((a, b) => Number(b.current) - Number(a.current) || b.date - a.date)
  const remote = branches.filter((b) => b.remote).sort((a, b) => b.date - a.date)
  const current = local.find((b) => b.current)?.name
  // Branches checked out in another worktree cannot be switched to here.
  const inWorktree = new Map(worktrees.filter((w) => !w.main && w.branch).map((w) => [w.branch!, w.path]))

  const newBranch = async (): Promise<void> => {
    const r = await openDialog({
      title: 'New branch',
      fields: [
        { name: 'name', label: 'Branch name', placeholder: 'fix/login-redirect' },
        { name: 'start', label: 'Start from', options: [current ?? 'HEAD', ...local.filter((b) => !b.current).map((b) => b.name), ...remote.map((b) => b.name)] },
        { name: 'checkout', label: 'Switch to the new branch', kind: 'checkbox', value: 'true' }
      ],
      confirmLabel: 'Create'
    })
    if (!r || !String(r.name).trim()) return
    await run('Creating branch', { op: 'createBranch', branch: String(r.name).trim(), start: String(r.start), checkout: Boolean(r.checkout) }, `Created ${String(r.name).trim()}`)
  }

  const newFeature = async (): Promise<void> => {
    const r = await openDialog({
      title: 'New feature',
      message: 'Creates the branch feature/<name> in its own folder (git worktree) next to this repository and opens it as a new project, with its own terminal and AI agent — so you can work on it in parallel.',
      fields: [
        { name: 'name', label: 'Feature name', placeholder: 'login-page' },
        { name: 'base', label: 'Based on', options: [current ?? 'HEAD', ...local.filter((b) => !b.current).map((b) => b.name)] }
      ],
      confirmLabel: 'Create & open'
    })
    const name = r && String(r.name).trim()
    if (!r || !name) return
    const res = await run('Creating feature', { op: 'addWorktree', branch: name, start: String(r.base) })
    if (res.ok && res.path) {
      notify(`Created ${res.text} in ${res.path}`, 'success')
      openProject(res.path)
    }
  }

  const rename = async (b: GitBranch): Promise<void> => {
    const r = await openDialog({ title: 'Rename branch', fields: [{ name: 'name', label: 'New name', value: b.name }], confirmLabel: 'Rename' })
    const name = r && String(r.name).trim()
    if (name && name !== b.name) await run('Renaming', { op: 'renameBranch', branch: b.name, newName: name }, `Renamed to ${name}`)
  }

  const remove = async (b: GitBranch): Promise<void> => {
    if (b.remote) {
      if (await confirmDialog('Delete remote branch?', `${b.name} will be deleted on the remote for everyone.`, 'Delete', true)) {
        await run('Deleting', { op: 'deleteBranch', branch: b.name, remote: true }, `Deleted ${b.name}`)
      }
      return
    }
    if (!(await confirmDialog('Delete branch?', `Delete the local branch ${b.name}?`, 'Delete', true))) return
    const r = await window.devhub.git.op(root, { op: 'deleteBranch', branch: b.name })
    if (r.ok) {
      notify(`Deleted ${b.name}`, 'success')
      await run('Refreshing', { op: 'status' })
    } else if (/not fully merged/i.test(r.error ?? '')) {
      if (await confirmDialog('Branch not merged', `${b.name} has commits that are not merged anywhere. Delete it anyway? Those commits will be lost.`, 'Delete anyway', true)) {
        await run('Deleting', { op: 'deleteBranch', branch: b.name, force: true }, `Deleted ${b.name}`)
      }
    } else notify(r.error ?? 'Delete failed', 'error')
  }

  const removeWorktree = async (w: GitWorktree): Promise<void> => {
    // A project tab open on the worktree keeps processes in that folder, which blocks deleting it on Windows.
    const same = (a?: string): boolean => !!a && a.replace(/[\\/]+$/, '').toLowerCase() === w.path.replace(/[\\/]+$/, '').toLowerCase()
    const openTab = useTabs.getState().tabs.find((t) => same(t.project?.root))
    const note = openTab ? ' Its project tab will be closed (terminals and agent stop).' : ''
    if (!(await confirmDialog('Remove worktree?', `The folder ${w.path} will be deleted. The branch ${w.branch ?? ''} is kept.${note}`, 'Remove', true))) return
    if (openTab) {
      useTabs.getState().close(openTab.id)
      await new Promise((r) => setTimeout(r, 1500)) // let the processes exit and release the folder
    }
    const r = await window.devhub.git.op(root, { op: 'removeWorktree', path: w.path })
    if (!r.ok && /permission denied|being used|resource busy/i.test(r.error ?? '')) {
      notify(`${w.path} is in use by another program (a terminal, editor or explorer window). Close it and try again.`, 'error')
      return
    }
    if (r.ok) {
      notify(r.text ?? 'Worktree removed', r.text ? 'info' : 'success')
      await run('Refreshing', { op: 'status' })
    } else if (/modified or untracked files|is dirty|contains modified/i.test(r.error ?? '')) {
      if (await confirmDialog('Worktree has changes', `${w.path} has uncommitted changes. Remove it anyway? They will be lost.`, 'Remove anyway', true)) {
        await run('Removing', { op: 'removeWorktree', path: w.path, force: true }, 'Worktree removed')
      }
    } else notify(r.error ?? 'Remove failed', 'error')
  }

  return (
    <div className="branches-view">
      <div className="branches-actions">
        <button className="primary" onClick={() => void newFeature()} title="Branch + separate folder + new project tab">
          New feature…
        </button>
        <button onClick={() => void newBranch()}>New branch…</button>
      </div>

      <div className="file-group-header">
        <span>Local branches</span>
        <span className="count">{local.length}</span>
      </div>
      {local.map((b) => {
        const wt = inWorktree.get(b.name)
        return (
          <div key={b.name} className={`branch-row${b.current ? ' current' : ''}`}>
            <span className="branch-mark">{b.current ? '●' : ''}</span>
            <span className="branch-name">{b.name}</span>
            {b.upstream && (
              <span className="muted" title={`Tracking ${b.upstream}`}>
                {b.gone ? 'upstream gone' : `${b.ahead ? `↑${b.ahead} ` : ''}${b.behind ? `↓${b.behind}` : ''}`}
              </span>
            )}
            {wt && (
              <span className="ref-badge remote" title={wt}>
                worktree
              </span>
            )}
            <span className="branch-subject">{b.subject}</span>
            <span className="git-date">{relativeTime(b.date)}</span>
            <span className="file-actions">
              {!b.current && !wt && (
                <button className="tool-button" onClick={() => void run('Switching', { op: 'switch', branch: b.name }, `Switched to ${b.name}`)}>
                  Switch
                </button>
              )}
              {wt && (
                <button className="tool-button" onClick={() => openProject(wt)}>
                  Open
                </button>
              )}
              {!b.current && current && (
                <button className="tool-button" title={`Merge ${b.name} into ${current}`} onClick={() => void run('Merging', { op: 'merge', branch: b.name }, `Merged ${b.name} into ${current}`)}>
                  Merge
                </button>
              )}
              <button className="icon-button" title="Rename" onClick={() => void rename(b)}>
                ✎
              </button>
              {!b.current && (
                <button className="icon-button" title="Delete" onClick={() => void remove(b)}>
                  🗑
                </button>
              )}
            </span>
          </div>
        )
      })}

      {worktrees.length > 1 && (
        <>
          <div className="file-group-header">
            <span>Feature worktrees</span>
            <span className="count">{worktrees.length - 1}</span>
          </div>
          {worktrees
            .filter((w) => !w.main)
            .map((w) => (
              <div key={w.path} className="branch-row">
                <span className="branch-mark">⎇</span>
                <span className="branch-name">{w.branch ?? (w.detached ? 'detached' : '?')}</span>
                <span className="branch-subject" title={w.path}>
                  {w.path}
                </span>
                <span className="file-actions">
                  <button className="tool-button" onClick={() => openProject(w.path)}>
                    Open
                  </button>
                  <button className="icon-button" title="Remove worktree (keeps the branch)" onClick={() => void removeWorktree(w)}>
                    🗑
                  </button>
                </span>
              </div>
            ))}
        </>
      )}

      <div className="file-group-header clickable" onClick={() => setShowRemote(!showRemote)}>
        <span>{showRemote ? '▾' : '▸'} Remote branches</span>
        <span className="count">{remote.length}</span>
      </div>
      {showRemote &&
        remote.map((b) => (
          <div key={b.name} className="branch-row">
            <span className="branch-mark" />
            <span className="branch-name">{b.name}</span>
            <span className="branch-subject">{b.subject}</span>
            <span className="git-date">{relativeTime(b.date)}</span>
            <span className="file-actions">
              <button className="tool-button" title="Check out as a local tracking branch" onClick={() => void run('Switching', { op: 'switch', branch: b.name, remote: true }, `Switched to ${b.name.replace(/^[^/]+\//, '')}`)}>
                Switch
              </button>
              <button className="icon-button" title="Delete on the remote" onClick={() => void remove(b)}>
                🗑
              </button>
            </span>
          </div>
        ))}
      {showRemote && remote.length === 0 && <div className="file-empty">No remote branches (fetch first?)</div>}
    </div>
  )
}
