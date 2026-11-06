import { useEffect, useMemo, useRef, useState } from 'react'
import { hunkLines, partialUnsupported } from '@shared/git-patch'

/** Git status letter → [short label, description] (shared by the Changes view and commit details). */
export const STATUS_LABEL: Record<string, [string, string]> = {
  M: ['M', 'modified'],
  A: ['A', 'added'],
  D: ['D', 'deleted'],
  R: ['R', 'renamed'],
  C: ['C', 'copied'],
  U: ['!', 'conflict'],
  '?': ['U', 'untracked'],
  T: ['T', 'type changed']
}

export type LineAction = 'stage' | 'unstage' | 'discard'

/** Partial staging in a diff of the Changes view. */
export interface DiffLineActions {
  /** The staged diff (actions: unstage) or the unstaged one (stage, discard). */
  staged: boolean
  /** Applies the action to these lines (indices in text.split('\n')); true when done. */
  apply(action: LineAction, lines: number[]): Promise<boolean>
}

const MAX_LINES = 5000

/**
 * Unified diff with coloured added / removed / hunk lines. With `actions`, each hunk can be
 * staged / unstaged / discarded, and changed lines can be selected (click, Shift+click for a range)
 * to act on just those lines.
 */
export function DiffView({ text, loading, actions }: { text: string; loading: boolean; actions?: DiffLineActions }): React.JSX.Element {
  const lines = useMemo(() => text.split('\n').slice(0, MAX_LINES), [text])
  const partial = useMemo(() => {
    if (!actions || text.split('\n').length > MAX_LINES) return undefined
    if (partialUnsupported(text)) return undefined
    const hunks = hunkLines(text)
    const hunkOf = new Map<number, number>()
    const changed = new Set<number>()
    // Hunk header line index → its changed lines.
    const byHeader = new Map<number, number[]>()
    const all = text.split('\n')
    let h = -1
    for (let i = 0; i < all.length; i++) {
      if (all[i].startsWith('@@')) {
        h++
        byHeader.set(i, hunks[h])
      }
    }
    hunks.forEach((ls, k) => ls.forEach((i) => (hunkOf.set(i, k), changed.add(i))))
    return { byHeader, changed }
  }, [text, actions])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const anchor = useRef<number | undefined>(undefined)

  // A new diff (another file, or the file changed): nothing selected.
  useEffect(() => {
    setSelected(new Set())
    anchor.current = undefined
  }, [text])

  if (loading) return <div className="pane-message">Loading diff…</div>
  if (!text.trim()) return <div className="pane-message">No textual changes (binary file or mode change).</div>

  const act = async (action: LineAction, which: number[]): Promise<void> => {
    if (!actions || busy || !which.length) return
    setBusy(true)
    try {
      if (await actions.apply(action, which)) setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  const click = (i: number, e: React.MouseEvent): void => {
    if (!partial?.changed.has(i)) return
    // Text selection (copying from the diff) is not a click on the line.
    if (window.getSelection()?.toString()) return
    const next = new Set(selected)
    if (e.shiftKey && anchor.current !== undefined) {
      const [a, b] = anchor.current < i ? [anchor.current, i] : [i, anchor.current]
      for (let k = a; k <= b; k++) if (partial.changed.has(k)) next.add(k)
    } else if (next.has(i)) next.delete(i)
    else next.add(i)
    anchor.current = i
    setSelected(next)
  }

  const buttons = (which: number[], what: string): React.ReactNode =>
    actions?.staged ? (
      <button className="tool-button" disabled={busy} title={`Unstage ${what}`} onClick={() => void act('unstage', which)}>
        − Unstage
      </button>
    ) : (
      <>
        <button className="tool-button" disabled={busy} title={`Discard ${what}`} onClick={() => void act('discard', which)}>
          ↺ Discard
        </button>
        <button className="tool-button" disabled={busy} title={`Stage ${what}`} onClick={() => void act('stage', which)}>
          + Stage
        </button>
      </>
    )

  return (
    <div className="diff-wrap">
      {partial && selected.size > 0 && (
        <div className="diff-selection-bar">
          <span>
            {selected.size} line{selected.size > 1 ? 's' : ''} selected
          </span>
          <button className="link-button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <span className="spacer" />
          {buttons([...selected].sort((a, b) => a - b), 'the selected lines')}
        </div>
      )}
      <pre className={`diff selectable${partial ? ' partial' : ''}`}>
        {lines.map((l, i) => {
          const cls = l.startsWith('@@')
            ? 'hunk'
            : l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('new file') || l.startsWith('deleted file')
              ? 'meta'
              : l.startsWith('+')
                ? 'add'
                : l.startsWith('-')
                  ? 'del'
                  : ''
          const hunk = partial?.byHeader.get(i)
          if (hunk) {
            return (
              <div key={i} className="diff-line hunk with-actions">
                <span className="hunk-text">{l}</span>
                <span className="hunk-actions">{buttons(hunk, 'this hunk')}</span>
              </div>
            )
          }
          const changed = partial?.changed.has(i)
          return (
            <div
              key={i}
              className={`diff-line ${cls}${changed ? ' selectable-line' : ''}${selected.has(i) ? ' line-selected' : ''}`}
              onClick={changed ? (e) => click(i, e) : undefined}
              title={changed ? 'Click to select this line (Shift+click: a range), then stage or discard just the selection' : undefined}
            >
              {l || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}
