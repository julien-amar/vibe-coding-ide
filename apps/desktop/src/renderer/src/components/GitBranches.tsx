import { useEffect, useState } from 'react'
import type { GitBranch, GitStatus, GitWorktree } from '@shared/types'
import { useTabs } from '../store'
import { relativeTime } from '../time'
import { confirmDialog, notify, openDialog } from './Dialogs'
import type { GitRun as Run } from './GitPanel'

/** The Git panel's Branches view: switch, create, merge, delete, feature worktrees. */

export function BranchesView({
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
    void window.ide.git.op(root, { op: 'branches' }).then((r) => {
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
    const r = await window.ide.git.op(root, { op: 'deleteBranch', branch: b.name })
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
    const r = await window.ide.git.op(root, { op: 'removeWorktree', path: w.path })
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
