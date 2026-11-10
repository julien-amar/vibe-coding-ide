import { useEffect, useMemo, useRef, useState } from 'react'
import { hunkLines, partialUnsupported } from '@shared/git-patch'
import { Spinner } from './Spinner'

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
 * staged / unstaged / discarded, and changed lines can be selected (click, Shift+click for a range,
 * or a drag over the lines with the button held) to act on just those lines.
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
  /**
   * A drag with the (left) button held from a changed line: the line it started on, the selection
   * before it, whether it selects (started on an unselected line) or unselects lines, and whether
   * it has left its first line yet (until then, it may be a plain click).
   */
  const drag = useRef<{ from: number; base: Set<number>; select: boolean; moved: boolean } | undefined>(undefined)
  /** The click that ends a drag is not a click on a line. */
  const dragEnded = useRef(false)

  // A new diff (another file, or the file changed): nothing selected.
  useEffect(() => {
    setSelected(new Set())
    anchor.current = undefined
    drag.current = undefined
  }, [text])

  // The drag ends wherever the button is released (outside the diff too).
  useEffect(() => {
    const end = (e: MouseEvent): void => {
      if (e.button !== 0 || !drag.current) return
      dragEnded.current = drag.current.moved
      drag.current = undefined
    }
    window.addEventListener('mouseup', end)
    return () => window.removeEventListener('mouseup', end)
  }, [])

  if (loading) return <Spinner label="Loading the diff" />
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
    // The end of a drag over several lines (they are selected already).
    if (dragEnded.current) return void (dragEnded.current = false)
    // Text selection (copying from the diff) is not a click on the line; Shift+click is always a
    // range of lines (the browser would also extend the text selection: dropped).
    if (e.shiftKey) window.getSelection()?.removeAllRanges()
    else if (window.getSelection()?.toString()) return
    const next = new Set(selected)
    if (e.shiftKey && anchor.current !== undefined) {
      const [a, b] = anchor.current < i ? [anchor.current, i] : [i, anchor.current]
      for (let k = a; k <= b; k++) if (partial.changed.has(k)) next.add(k)
    } else if (next.has(i)) next.delete(i)
    else next.add(i)
    anchor.current = i
    setSelected(next)
  }

  /** The changed lines from the drag's start to line `i`, selected (or unselected) on top of the selection it started from. */
  const dragTo = (i: number): void => {
    const d = drag.current
    if (!d || !partial) return
    const next = new Set(d.base)
    const [a, b] = d.from < i ? [d.from, i] : [i, d.from]
    for (let k = a; k <= b; k++) {
      if (!partial.changed.has(k)) continue
      if (d.select) next.add(k)
      else next.delete(k)
    }
    anchor.current = i
    setSelected(next)
  }
  /** The line under the pointer (any line of the diff: hunk headers and context lines are crossed too). */
  const lineAt = (e: React.MouseEvent): number | undefined => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')
    return el ? Number(el.dataset.line) : undefined
  }
  const dragHandlers = partial
    ? {
        // Button held on a changed line: the lines it then moves over (up or down) are selected
        // (released on the same line: a click). Lines, not text: no text selection from there.
        onMouseDown: (e: React.MouseEvent): void => {
          dragEnded.current = false
          const i = lineAt(e)
          if (e.button !== 0 || e.shiftKey || i === undefined || !partial.changed.has(i)) return
          e.preventDefault()
          window.getSelection()?.removeAllRanges()
          drag.current = { from: i, base: selected, select: !selected.has(i), moved: false }
        },
        onMouseOver: (e: React.MouseEvent): void => {
          const d = drag.current
          if (!d) return
          // Released outside the window: the drag is over.
          if (!(e.buttons & 1)) return void (drag.current = undefined)
          const i = lineAt(e)
          if (i === undefined || (!d.moved && i === d.from)) return
          d.moved = true
          dragTo(i)
        }
      }
    : {}

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
      <pre className={`diff selectable${partial ? ' partial' : ''}`} {...dragHandlers}>
        {lines.map((l, i) => {
          const cls = l.startsWith('@@')
            ? 'hunk'
            : l.startsWith('+++') ||
                l.startsWith('---') ||
                l.startsWith('diff ') ||
                l.startsWith('index ') ||
                l.startsWith('new file') ||
                l.startsWith('deleted file')
              ? 'meta'
              : l.startsWith('+')
                ? 'add'
                : l.startsWith('-')
                  ? 'del'
                  : ''
          const hunk = partial?.byHeader.get(i)
          if (hunk) {
            return (
              <div key={i} className="diff-line hunk with-actions" data-line={i}>
                <span className="hunk-text">{l}</span>
                <span className="hunk-actions">{buttons(hunk, 'this hunk')}</span>
              </div>
            )
          }
          const changed = partial?.changed.has(i)
          return (
            <div
              key={i}
              data-line={i}
              className={`diff-line ${cls}${changed ? ' selectable-line' : ''}${selected.has(i) ? ' line-selected' : ''}`}
              onClick={changed ? (e) => click(i, e) : undefined}
              // Shift+click selects a range of lines, not text.
              onMouseDown={changed ? (e) => e.shiftKey && e.preventDefault() : undefined}
              title={changed ? 'Click to select this line (drag over lines, or Shift+click: a range), then stage or discard just the selection' : undefined}
            >
              {l || ' '}
            </div>
          )
        })}
      </pre>
      {/* Below the diff, always in view: the selection, and what to do with it. */}
      {partial && selected.size > 0 && (
        <div className="diff-selection-bar">
          <span>
            {selected.size} line{selected.size > 1 ? 's' : ''} selected
          </span>
          <button className="link-button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <span className="spacer" />
          {buttons(
            [...selected].sort((a, b) => a - b),
            'the selected lines'
          )}
        </div>
      )}
    </div>
  )
}
