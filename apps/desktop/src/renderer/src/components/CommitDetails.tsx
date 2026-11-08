import { useEffect, useState } from 'react'
import type { GitCommit, GitCommitFile } from '@shared/types'
import { relativeTime } from '../time'
import { DiffView, STATUS_LABEL } from './GitDiff'
import { Spinner } from './Spinner'

/**
 * Details of a commit selected in the History view: message, metadata, the
 * files it changed (compared with its first parent) and the diff of the
 * selected file.
 */
export function CommitDetails({ root, commit, onClose }: { root: string; commit: GitCommit; onClose: () => void }): React.JSX.Element {
  const [files, setFiles] = useState<GitCommitFile[] | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<GitCommitFile>()
  const [diff, setDiff] = useState({ text: '', loading: false })
  const parent = commit.parents[0]

  useEffect(() => {
    let alive = true
    setFiles(null)
    setSelected(undefined)
    setError(undefined)
    void window.ide.git.op(root, { op: 'commitFiles', hash: commit.hash, parent }).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        setFiles([])
        return
      }
      setFiles(r.files ?? [])
      setMessage(r.text ?? commit.subject)
      // Show the first file right away: one click on a commit shows a diff.
      if (r.files?.length) setSelected(r.files[0])
    })
    return () => {
      alive = false
    }
  }, [root, commit.hash, commit.subject, parent])

  useEffect(() => {
    if (!selected) return
    let alive = true
    setDiff({ text: '', loading: true })
    void window.ide.git
      .op(root, { op: 'commitDiff', hash: commit.hash, parent, path: selected.path, origPath: selected.origPath })
      .then((r) => alive && setDiff({ text: r.ok ? (r.text ?? '') : (r.error ?? ''), loading: false }))
    return () => {
      alive = false
    }
  }, [root, commit.hash, parent, selected])

  const [subject, ...body] = message.split('\n')

  return (
    <div className="commit-details">
      <div className="commit-header">
        <div className="commit-meta">
          <div className="commit-subject selectable">{subject || commit.subject}</div>
          {body.join('\n').trim() && <pre className="commit-body selectable">{body.join('\n').trim()}</pre>}
          <div className="muted">
            <span className="git-hash selectable">{commit.hash.slice(0, 10)}</span> · {commit.author} · {new Date(commit.date * 1000).toLocaleString()} (
            {relativeTime(commit.date)}){commit.parents.length > 1 && ` · merge — changes shown against ${commit.parents[0].slice(0, 7)} (first parent)`}
            {commit.parents.length === 0 && ' · initial commit'}
          </div>
        </div>
        <button className="icon-button" title="Close commit details" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="commit-body-grid">
        <div className="commit-files">
          <div className="file-group-header">
            <span>Changed files</span>
            {files && <span className="count">{files.length}</span>}
          </div>
          {files === null && <Spinner label="Loading the changed files" />}
          {error && <div className="pane-message error">{error}</div>}
          {files?.length === 0 && !error && <div className="file-empty">No file changes</div>}
          {files?.map((f) => {
            const [letter, label] = STATUS_LABEL[f.status] ?? [f.status, 'changed']
            const slash = f.path.lastIndexOf('/')
            return (
              <div
                key={`${f.origPath ?? ''}>${f.path}`}
                className={`file-row${selected === f ? ' selected' : ''}`}
                onClick={() => setSelected(f)}
                title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
              >
                <span className={`file-status s-${label.replace(' ', '-')}`} title={label}>
                  {letter}
                </span>
                <span className="file-name">{f.path.slice(slash + 1)}</span>
                <span className="file-dir">{f.origPath ? `← ${f.origPath}` : slash >= 0 ? f.path.slice(0, slash) : ''}</span>
              </div>
            )
          })}
        </div>
        <div className="changes-diff">
          {selected ? <DiffView text={diff.text} loading={diff.loading} /> : <div className="pane-message">Select a file to see what changed.</div>}
        </div>
      </div>
    </div>
  )
}
