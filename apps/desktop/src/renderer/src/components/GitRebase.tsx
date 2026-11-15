import { useEffect, useRef, useState } from 'react'
import type { GitBranch } from '@shared/types'
import type { GitRun } from './GitPanel'

/** The branch an action (rebase on, pull from) last used in a repository, remembered per repository. */
function lastBranch(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}
function rememberBranch(key: string, branch: string): void {
  try {
    localStorage.setItem(key, branch)
  } catch {
    /* not remembered */
  }
}

/**
 * A git action on a branch (Rebase on, Pull from) as a split button: its main part acts on the branch
 * used last for the repository (else `fallback`, else the only one); its ▾ (when there is more than
 * one branch) lists them all. The branch shows as its tag.
 */
function BranchSplitButton({
  className,
  label,
  menuName,
  storageKey,
  choices,
  fallback,
  busy,
  disabledTitle,
  describe,
  onRun
}: {
  className: string
  label: string
  /** The list of branches' name ("Rebase on"). */
  menuName: string
  storageKey: string
  /** The branches offered, in their order. */
  choices: GitBranch[]
  /** The branch used when none was chosen yet (Pull: the upstream). */
  fallback?: string
  busy: boolean
  /** Shown (the button disabled) when there is no branch to choose. */
  disabledTitle: string
  /** The main part's title and accessible name ("Rebase the current branch on main", "Rebase on main"). */
  describe: (branch?: string) => { title: string; name: string }
  onRun: (branch: GitBranch) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [last, setLast] = useState(() => lastBranch(storageKey))
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => setLast(lastBranch(storageKey)), [storageKey])
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

  const target = choices.find((b) => b.name === last) ?? choices.find((b) => b.name === fallback) ?? (choices.length === 1 ? choices[0] : undefined)
  const act = (branch: GitBranch): void => {
    setOpen(false)
    rememberBranch(storageKey, branch.name)
    setLast(branch.name)
    onRun(branch)
  }
  const { title, name } = describe(target?.name)

  return (
    <div className={`split-button ${className}`} ref={rootRef}>
      <button
        className="tool-button split-main"
        disabled={busy || choices.length === 0}
        title={choices.length === 0 ? disabledTitle : title}
        aria-label={name}
        onClick={() => (target ? act(target) : setOpen(true))}
      >
        {label}
        {/* The branch: its tag (as in the history). */}
        {target && <span className={`ref-badge ${target.remote ? 'remote' : 'branch'}`}>{target.name}</span>}
      </button>
      {choices.length > 1 && (
        <button
          className="tool-button split-toggle"
          disabled={busy}
          title={`Choose the branch (${label})`}
          aria-label={`Choose the branch to ${label.toLowerCase()} ${label === 'Pull' ? 'from' : 'on'}`}
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
        <div className="profile-select-menu split-menu" role="listbox" aria-label={menuName}>
          {choices.map((b) => (
            <button key={`${b.remote}:${b.name}`} role="option" aria-selected={b.name === target?.name} className="launcher-item" onClick={() => act(b)}>
              <span className={`ref-badge ${b.remote ? 'remote' : 'branch'}`}>{b.name}</span>
              {b.name === target?.name && <span className="profile-select-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Rebase the current branch on another (any other branch, local ones first). */
export function RebaseButton({ root, branches, busy, run }: { root: string; branches: GitBranch[]; busy: boolean; run: GitRun }): React.JSX.Element | null {
  const choices = branches.filter((b) => !b.current).sort((a, b) => Number(a.remote) - Number(b.remote))
  if (choices.length === 0) return null
  return (
    <BranchSplitButton
      className="rebase-button"
      label="Rebase"
      menuName="Rebase on"
      storageKey={`git-rebase-on:${root}`}
      choices={choices}
      busy={busy}
      disabledTitle="No other branch to rebase on"
      describe={(b) =>
        b
          ? { title: `Rebase the current branch on ${b}`, name: `Rebase on ${b}` }
          : { title: 'Rebase the current branch on another (choose it)', name: 'Rebase' }
      }
      onRun={(b) => void run('Rebasing', { op: 'rebase', branch: b.name }, `Rebased on ${b.name}`)}
    />
  )
}

/**
 * Pull into the current branch: from its upstream by default, or from the branch chosen (remote
 * branches first; a local one is merged in).
 */
export function PullButton({
  root,
  branches,
  upstream,
  busy,
  run
}: {
  root: string
  branches: GitBranch[]
  upstream?: string
  busy: boolean
  run: GitRun
}): React.JSX.Element {
  const choices = branches.filter((b) => !b.current).sort((a, b) => Number(b.remote) - Number(a.remote))
  return (
    <BranchSplitButton
      className="pull-button"
      label="Pull"
      menuName="Pull from"
      storageKey={`git-pull-from:${root}`}
      choices={choices}
      fallback={upstream}
      busy={busy}
      disabledTitle="No branch to pull from"
      describe={(b) =>
        b ? { title: `Pull from ${b} into the current branch`, name: `Pull from ${b}` } : { title: 'Pull from a branch (choose it)', name: 'Pull' }
      }
      // The upstream: a plain git pull; another branch: pulled from its remote (a local one: merged in).
      onRun={(b) => void run('Pulling', b.name === upstream ? { op: 'pull' } : { op: 'pull', branch: b.name, remote: b.remote }, `Pulled from ${b.name}`)}
    />
  )
}
