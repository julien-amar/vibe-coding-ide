import { useEffect, useRef, useState } from 'react'
import type { GitStatus, GitStatusFile } from '@shared/types'
import { confirmDialog } from './Dialogs'
import { DiffView, STATUS_LABEL, type DiffLineActions } from './GitDiff'
import type { GitRun as Run } from './GitPanel'
import { Spinner } from './Spinner'

/** The Git panel's Changes view: staged / unstaged files, diffs with partial staging, commit. */

/** A selected file: in the Staged list or the Changes list. */
interface Selection {
  path: string
  staged: boolean
  untracked: boolean
}

const keyOf = (s: { path: string; staged: boolean }): string => `${s.staged ? 's' : 'u'}:${s.path}`

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
  onSelect: (e: React.MouseEvent) => void
  actions: React.ReactNode
}): React.JSX.Element {
  const [letter, label] = STATUS_LABEL[code] ?? [code, 'changed']
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const dir = slash >= 0 ? file.path.slice(0, slash) : ''
  return (
    <div
      className={`file-row${selected ? ' selected' : ''}`}
      aria-selected={selected}
      onClick={onSelect}
      // Shift+click selects a range of files, not text.
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      title={`${file.origPath ? `${file.origPath} → ${file.path}` : file.path}\n(Ctrl+click: add to the selection, Shift+click: a range)`}
    >
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

/** A selected file's diff (its own title), with partial staging (not for untracked files: stage them whole). */
function FileDiff({
  root,
  file,
  run,
  refreshKey,
  partialStaging
}: {
  root: string
  file: Selection
  run: Run
  refreshKey: string
  /** Hunks and lines can be staged (not while diffs ignore whitespace). */
  partialStaging: boolean
}): React.JSX.Element {
  const [diff, setDiff] = useState({ text: '', loading: true })

  useEffect(() => {
    let alive = true
    setDiff((d) => ({ ...d, loading: d.text === '' }))
    void window.ide.git.op(root, { op: 'diff', path: file.path, staged: file.staged, untracked: file.untracked }).then((r) => {
      if (alive) setDiff({ text: r.ok ? (r.text ?? '') : (r.error ?? ''), loading: false })
    })
    return () => {
      alive = false
    }
  }, [root, file.path, file.staged, file.untracked, refreshKey])

  const lineActions: DiffLineActions | undefined =
    partialStaging && !file.untracked && !diff.loading
      ? {
          staged: file.staged,
          apply: async (action, lines) => {
            const n = lines.length
            if (
              action === 'discard' &&
              !(await confirmDialog('Discard changes?', `Your changes on ${n} line${n > 1 ? 's' : ''} of ${file.path} will be lost.`, 'Discard', true))
            ) {
              return false
            }
            const label = action === 'stage' ? 'Staging' : action === 'unstage' ? 'Unstaging' : 'Discarding'
            const r = await run(label, { op: 'applyLines', path: file.path, staged: file.staged, action, lines, diffText: diff.text })
            return r.ok
          }
        }
      : undefined

  return (
    <div className="file-diff">
      <div className="diff-title">
        <span className="file-name">{file.path}</span>
        <span className="muted">{file.staged ? 'staged' : file.untracked ? 'untracked' : 'not staged'}</span>
        {!partialStaging && (
          <span className="muted diff-note" title="The diff leaves whitespace out (Git settings): hunks and lines cannot be staged separately.">
            whitespace ignored
          </span>
        )}
      </div>
      <DiffView text={diff.text} loading={diff.loading} actions={lineActions} />
    </div>
  )
}

/** The file list's size, remembered: its width (list beside the diff), or its height (list above). */
const SIZE_KEYS = { width: 'git-changes-list-width', height: 'git-changes-list-height' } as const
const savedSize = (key: string): number | undefined => {
  try {
    return Number(localStorage.getItem(key)) || undefined
  } catch {
    return undefined
  }
}
const saveSize = (key: string, value: number | undefined): void => {
  try {
    if (value) localStorage.setItem(key, String(value))
    else localStorage.removeItem(key)
  } catch {
    /* not remembered */
  }
}

/**
 * The bar between the file list and the diff: dragged, it resizes the list (its width beside the
 * diff, its height above it in a narrow panel); double-clicked, the list gets its default size.
 */
function ListResizer({ onWidth, onHeight }: { onWidth: (px: number | undefined) => void; onHeight: (px: number | undefined) => void }): React.JSX.Element {
  const start = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    const view = handle.parentElement!
    const side = view.querySelector<HTMLElement>('.changes-side')!
    const bar = handle.getBoundingClientRect()
    // A bar wider than high: the list is above the diff (narrow panel).
    const stacked = bar.width > bar.height
    const from = stacked ? e.clientY : e.clientX
    const size0 = stacked ? side.getBoundingClientRect().height : side.getBoundingClientRect().width
    const viewRect = view.getBoundingClientRect()
    let size = size0
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add(stacked ? 'resizing-row' : 'resizing-col')
    const onMove = (ev: PointerEvent): void => {
      const delta = (stacked ? ev.clientY : ev.clientX) - from
      // The list keeps 200 px (120 px high); the diff keeps 260 px.
      size = Math.round(stacked ? Math.max(120, size0 + delta) : Math.min(Math.max(200, size0 + delta), viewRect.width - 260))
      ;(stacked ? onHeight : onWidth)(size)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('resizing-row', 'resizing-col')
      saveSize(stacked ? SIZE_KEYS.height : SIZE_KEYS.width, size)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }
  return (
    <div
      className="changes-resizer"
      role="separator"
      aria-label="Resize the file list"
      title="Drag to resize (double-click: default size)"
      onPointerDown={start}
      onDoubleClick={() => {
        onWidth(undefined)
        onHeight(undefined)
        saveSize(SIZE_KEYS.width, undefined)
        saveSize(SIZE_KEYS.height, undefined)
      }}
    />
  )
}

export function ChangesView({
  root,
  status,
  run,
  refreshKey,
  partialStaging = true
}: {
  root: string
  status: GitStatus | null | undefined
  run: Run
  refreshKey: string
  /** Hunks and lines can be staged (not while diffs ignore whitespace). */
  partialStaging?: boolean
}): React.JSX.Element {
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
  /** The selected files, in the order of the lists (their diffs are shown in that order). */
  const [selected, setSelected] = useState<Selection[]>([])
  /** Where a Shift+click range starts: the last file clicked (or Ctrl+clicked). */
  const anchor = useRef<string | undefined>(undefined)
  /** The file list's size set by its resizer (else the layout's default). */
  const [listWidth, setListWidth] = useState(() => savedSize(SIZE_KEYS.width))
  const [listHeight, setListHeight] = useState(() => savedSize(SIZE_KEYS.height))

  const files = status?.files ?? []
  const staged = files.filter((f) => f.index !== ' ' && f.index !== '?')
  const unstaged = files.filter((f) => f.worktree !== ' ')
  /** Every row, Staged then Changes (a range can span both lists). */
  const rows: Selection[] = [
    ...staged.map((f) => ({ path: f.path, staged: true, untracked: false })),
    ...unstaged.map((f) => ({ path: f.path, staged: false, untracked: f.worktree === '?' }))
  ]
  const rowKeys = rows.map(keyOf)

  // Files no longer in their list are dropped from the selection; an untracked file that got
  // committed / added since (or the reverse) shows its real diff.
  useEffect(() => {
    if (!selected.length) return
    const now = new Map(rows.map((r) => [keyOf(r), r]))
    const next = selected.flatMap((s) => {
      const r = now.get(keyOf(s))
      return r ? [r] : []
    })
    if (next.length !== selected.length || next.some((r, i) => r.untracked !== selected[i].untracked)) setSelected(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the selection is checked again when the status changes, not when it is changed here
  }, [status])

  /** A click on a file: it alone; Ctrl (⌘): added / removed; Shift: the files from the last one clicked. */
  const select = (row: Selection, e: React.MouseEvent): void => {
    const key = keyOf(row)
    const byOrder = (list: Selection[]): Selection[] => list.sort((a, b) => rowKeys.indexOf(keyOf(a)) - rowKeys.indexOf(keyOf(b)))
    if (e.shiftKey && anchor.current && rowKeys.includes(anchor.current)) {
      window.getSelection()?.removeAllRanges()
      const [a, b] = [rowKeys.indexOf(anchor.current), rowKeys.indexOf(key)].sort((x, y) => x - y)
      setSelected(rows.slice(a, b + 1))
      return
    }
    anchor.current = key
    if (e.ctrlKey || e.metaKey) {
      setSelected((cur) => (cur.some((s) => keyOf(s) === key) ? cur.filter((s) => keyOf(s) !== key) : byOrder([...cur, row])))
      return
    }
    setSelected([row])
  }
  const isSelected = (row: { path: string; staged: boolean }): boolean => selected.some((s) => keyOf(s) === keyOf(row))

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

  if (status === undefined) return <Spinner />
  if (!status) return <div className="pane-message">This folder is not a git repository.</div>

  const canCommit = (staged.length > 0 || amend) && (message.trim().length > 0 || amend)

  const sizes = {
    ...(listWidth ? { '--list-width': `${listWidth}px` } : {}),
    ...(listHeight ? { '--list-height': `${listHeight}px` } : {})
  } as React.CSSProperties

  return (
    <div className="changes-view" style={sizes}>
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

        <div className="file-lists" role="listbox" aria-multiselectable aria-label="Changed files">
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
              selected={isSelected({ path: f.path, staged: true })}
              onSelect={(e) => select({ path: f.path, staged: true, untracked: false }, e)}
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
              selected={isSelected({ path: f.path, staged: false })}
              onSelect={(e) => select({ path: f.path, staged: false, untracked: f.worktree === '?' }, e)}
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
      <ListResizer onWidth={setListWidth} onHeight={setListHeight} />
      <div className={`changes-diff${selected.length > 1 ? ' multi' : ''}`}>
        {selected.length === 0 && <div className="pane-message">Select a file to see its changes (Ctrl+click or Shift+click: several).</div>}
        {selected.length === 1 && (
          <FileDiff key={keyOf(selected[0])} root={root} file={selected[0]} run={run} refreshKey={refreshKey} partialStaging={partialStaging} />
        )}
        {selected.length > 1 && (
          // Several files: their diffs one below the other, in one scroll.
          <div className="file-diffs">
            {selected.map((s) => (
              <FileDiff key={keyOf(s)} root={root} file={s} run={run} refreshKey={refreshKey} partialStaging={partialStaging} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
