import { useEffect, useRef, useState } from 'react'
import type { GitBranch } from '@shared/types'
import type { GitRun } from './GitPanel'

/** The branch a repository was last rebased on (here), remembered per repository. */
const lastKey = (root: string): string => `git-rebase-on:${root}`
function lastBranch(root: string): string | undefined {
  try {
    return localStorage.getItem(lastKey(root)) ?? undefined
  } catch {
    return undefined
  }
}
function rememberBranch(root: string, branch: string): void {
  try {
    localStorage.setItem(lastKey(root), branch)
  } catch {
    /* not remembered */
  }
}

/**
 * Rebase the current branch on another: a split button. Its main part rebases on the branch used
 * last (or the only one); its ▾ (when there is more than one branch) lists them all.
 */
export function RebaseButton({ root, branches, busy, run }: { root: string; branches: GitBranch[]; busy: boolean; run: GitRun }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [last, setLast] = useState(() => lastBranch(root))
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => setLast(lastBranch(root)), [root])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Any other branch (local ones first).
  const choices = branches.filter((b) => !b.current).sort((a, b) => Number(a.remote) - Number(b.remote))
  if (choices.length === 0) return null
  const target = choices.find((b) => b.name === last)?.name ?? (choices.length === 1 ? choices[0].name : undefined)

  const rebase = (branch: string): void => {
    setOpen(false)
    rememberBranch(root, branch)
    setLast(branch)
    void run('Rebasing', { op: 'rebase', branch }, `Rebased on ${branch}`)
  }

  return (
    <div className="split-button" ref={rootRef}>
      <button
        className="tool-button split-main"
        disabled={busy}
        title={target ? `Rebase the current branch on ${target}` : 'Rebase the current branch on another (choose it)'}
        onClick={() => (target ? rebase(target) : setOpen(true))}
      >
        {target ? `Rebase on ${target}` : 'Rebase'}
      </button>
      {choices.length > 1 && (
        <button
          className="tool-button split-toggle"
          disabled={busy}
          title="Choose the branch to rebase on"
          aria-label="Choose the branch to rebase on"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {open && (
        <div className="profile-select-menu split-menu" role="listbox" aria-label="Rebase on">
          {choices.map((b) => (
            <button key={`${b.remote}:${b.name}`} role="option" aria-selected={b.name === target} className="launcher-item" onClick={() => rebase(b.name)}>
              <span className={`ref-badge ${b.remote ? 'remote' : 'branch'}`}>{b.name}</span>
              {b.name === target && <span className="profile-select-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
