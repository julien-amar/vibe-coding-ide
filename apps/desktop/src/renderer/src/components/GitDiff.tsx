import { useMemo } from 'react'

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

/** Unified diff with coloured added / removed / hunk lines. */
export function DiffView({ text, loading }: { text: string; loading: boolean }): React.JSX.Element {
  const lines = useMemo(() => text.split('\n').slice(0, 5000), [text])
  if (loading) return <div className="pane-message">Loading diff…</div>
  if (!text.trim()) return <div className="pane-message">No textual changes (binary file or mode change).</div>
  return (
    <pre className="diff selectable">
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
        return (
          <div key={i} className={`diff-line ${cls}`}>
            {l || ' '}
          </div>
        )
      })}
    </pre>
  )
}
