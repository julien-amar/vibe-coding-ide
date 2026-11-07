import { useEffect, useRef, useState } from 'react'
import type { GitStatus, GitStatusFile } from '@shared/types'
import { confirmDialog } from './Dialogs'
import { DiffView, STATUS_LABEL, type DiffLineActions } from './GitDiff'
import type { GitRun as Run } from './GitPanel'

/** The Git panel's Changes view: staged / unstaged files, diffs with partial staging, commit. */

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

export function ChangesView({ root, status, run, refreshKey }: { root: string; status: GitStatus | null; run: Run; refreshKey: string }): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  /** The last commit's message, put in the box when amending (to edit it). */
  const lastMessage = useRef<string | undefined>(undefined)

  const toggleAmend = async (on: boolean): Promise<void> => {
    setAmend(on)
    if (on) {
      const r = await window.ide.git.op(root, { op: 'lastMessage' })
      lastMessage.current = r.ok ? r.text : undefined
      // Keep a message being written; otherwise start from the commit's own message.
      if (r.ok && r.text && !message.trim()) setMessage(r.text)
    } else if (message === lastMessage.current) setMessage('')
  }
  const [selected, setSelected] = useState<Selection>()
  const [diff, setDiff] = useState({ text: '', loading: false })

  const files = status?.files ?? []
  const staged = files.filter((f) => f.index !== ' ' && f.index !== '?')
  const unstaged = files.filter((f) => f.worktree !== ' ')

  // Drop the selection when its file is no longer in that list.
  useEffect(() => {
    if (!selected) return
    const list = selected.staged ? staged : unstaged
    const file = list.find((f) => f.path === selected.path)
    if (!file) setSelected(undefined)
    // An untracked file that got committed / added since (or the reverse): show its real diff.
    else if (!selected.staged && (file.worktree === '?') !== selected.untracked) setSelected({ ...selected, untracked: file.worktree === '?' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the selection is checked again when the status changes, not when it is changed here
  }, [status])

  useEffect(() => {
    if (!selected) return
    let alive = true
    setDiff((d) => ({ ...d, loading: d.text === '' }))
    void window.ide.git.op(root, { op: 'diff', path: selected.path, staged: selected.staged, untracked: selected.untracked }).then((r) => {
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

  /** Partial staging of the selected file's diff (not for untracked files: stage them whole). */
  const lineActions: DiffLineActions | undefined =
    selected && !selected.untracked && !diff.loading
      ? {
          staged: selected.staged,
          apply: async (action, lines) => {
            const n = lines.length
            if (
              action === 'discard' &&
              !(await confirmDialog('Discard changes?', `Your changes on ${n} line${n > 1 ? 's' : ''} of ${selected.path} will be lost.`, 'Discard', true))
            ) {
              return false
            }
            const label = action === 'stage' ? 'Staging' : action === 'unstage' ? 'Unstaging' : 'Discarding'
            const r = await run(label, { op: 'applyLines', path: selected.path, staged: selected.staged, action, lines, diffText: diff.text })
            return r.ok
          }
        }
      : undefined

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
              <input type="checkbox" checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} />
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
            <DiffView text={diff.text} loading={diff.loading} actions={lineActions} />
          </>
        ) : (
          <div className="pane-message">Select a file to see its changes.</div>
        )}
      </div>
    </div>
  )
}
