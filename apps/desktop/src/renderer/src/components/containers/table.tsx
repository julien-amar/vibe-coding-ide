import type { Selection } from './model'

/** The Containers tab's resource tables: a header (click a column to sort), then one row per item. */

/** A column of a resource table. */
export interface Column<T> {
  key: string
  label: string
  /** CSS grid track. */
  width: string
  cell: (x: T) => React.ReactNode
  /** Sort key (none: not sortable). */
  sort?: (x: T) => string | number
  className?: string
  align?: 'right'
}

/** The column the rows are sorted by (none: the engines' order). */
export interface SortState {
  key: string
  desc: boolean
}

/** A click on a column header: ascending, then descending, then unsorted. */
export function nextSort(cur: SortState | undefined, key: string): SortState | undefined {
  if (cur?.key !== key) return { key, desc: false }
  return cur.desc ? undefined : { key, desc: true }
}

/** The rows in the order of `sort` (numbers as numbers, text with numbers in natural order). */
export function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState | undefined): T[] {
  const col = columns.find((c) => c.key === sort?.key && c.sort)
  if (!col?.sort || !sort) return rows
  const by = col.sort
  return [...rows].sort((a, b) => {
    const x = by(a)
    const y = by(b)
    const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
    return sort.desc ? -r : r
  })
}

export interface TableProps<T> {
  label: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (x: T) => string
  /** The selection a click on a row makes (none: rows are not selectable). */
  selection?: (x: T) => Selection
  /** Last column: shown on hover (always with `actionsVisible`). */
  actions: (x: T) => React.ReactNode
  actionsWidth: number
  actionsVisible?: boolean
  /** In the actions column header (right-aligned). */
  headerExtra?: React.ReactNode
  sort: SortState | undefined
  onSort: (s: SortState | undefined) => void
  selected: Selection | undefined
  onSelect: (s: Selection) => void
}

export function ResourceTable<T>(p: TableProps<T>): React.JSX.Element {
  const rows = sortRows(p.rows, p.columns, p.sort)
  const template = { gridTemplateColumns: [...p.columns.map((c) => c.width), `${p.actionsWidth}px`].join(' ') }
  const isSelected = (s: Selection): boolean => p.selected?.engine === s.engine && p.selected.id === s.id
  return (
    <div className="ctr-table" role="table" aria-label={p.label}>
      <div className="ctr-thead" role="row" style={template}>
        {p.columns.map((c) => (
          <span
            key={c.key}
            role="columnheader"
            className={`ctr-th${c.align === 'right' ? ' right' : ''}`}
            aria-sort={p.sort?.key === c.key ? (p.sort.desc ? 'descending' : 'ascending') : undefined}
          >
            {c.sort ? (
              <button className="ctr-sort" onClick={() => p.onSort(nextSort(p.sort, c.key))}>
                {c.label}
                {p.sort?.key === c.key && <span aria-hidden>{p.sort.desc ? ' ▾' : ' ▴'}</span>}
              </button>
            ) : (
              c.label
            )}
          </span>
        ))}
        <span role="columnheader" className="ctr-th ctr-th-actions" aria-label={p.headerExtra ? undefined : 'Actions'}>
          {p.headerExtra}
        </span>
      </div>
      {rows.map((x) => {
        const sel = p.selection?.(x)
        return (
          <div
            key={p.rowKey(x)}
            role="row"
            className={`ctr-row${sel && isSelected(sel) ? ' selected' : ''}${sel ? '' : ' static'}`}
            style={template}
            onClick={sel ? () => p.onSelect(sel) : undefined}
          >
            {p.columns.map((c) => (
              <span key={c.key} role="cell" className={`ctr-td${c.className ? ` ${c.className}` : ''}${c.align === 'right' ? ' right' : ''}`}>
                {c.cell(x)}
              </span>
            ))}
            <span role="cell" className={`ctr-actions${p.actionsVisible ? ' visible' : ''}`} onClick={(e) => e.stopPropagation()}>
              {p.actions(x)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
