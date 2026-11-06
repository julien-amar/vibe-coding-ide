import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitCommit, GitLog } from '@shared/types'
import { computeGraph, laneColor, type GraphRow } from '../git-graph'
import { relativeTime } from '../time'
import { CommitDetails } from './CommitDetails'

const ROW_H = 26
const LANE_W = 14
const GRAPH_PAD = 8

const laneX = (j: number): number => GRAPH_PAD + j * LANE_W + LANE_W / 2

function edge(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`
  const my = (y1 + y2) / 2
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`
}

function GraphCell({ row, width, isHead }: { row: GraphRow; width: number; isHead: boolean }): React.JSX.Element {
  const mid = ROW_H / 2
  const cx = laneX(row.col)
  const paths: React.JSX.Element[] = []
  row.before.forEach((h, j) => {
    if (h === null) return
    if (j === row.col) {
      if (row.hasChild) paths.push(<path key={`t${j}`} d={edge(cx, 0, cx, mid)} stroke={laneColor(j)} />)
    } else if (row.converging.includes(j)) {
      paths.push(<path key={`c${j}`} d={edge(laneX(j), 0, cx, mid)} stroke={laneColor(j)} />)
    } else {
      paths.push(<path key={`p${j}`} d={edge(laneX(j), 0, laneX(j), ROW_H)} stroke={laneColor(j)} />)
    }
  })
  row.parentCols.forEach((pc, i) => {
    paths.push(<path key={`b${i}`} d={edge(cx, mid, laneX(pc), ROW_H)} stroke={laneColor(pc)} />)
  })
  return (
    <svg className="git-graph" width={width} height={ROW_H} aria-hidden>
      <g fill="none" strokeWidth={2}>
        {paths}
      </g>
      <circle cx={cx} cy={mid} r={isHead ? 5 : 4} fill={isHead ? 'var(--bg)' : laneColor(row.col)} stroke={laneColor(row.col)} strokeWidth={2} />
    </svg>
  )
}

function RefBadges({ refs }: { refs: string[] }): React.JSX.Element {
  return (
    <>
      {refs.map((r) => {
        if (r.startsWith('HEAD -> ')) {
          return (
            <span key={r} className="ref-badge head" title="Current branch">
              {r.slice(8)}
            </span>
          )
        }
        if (r === 'HEAD')
          return (
            <span key={r} className="ref-badge head">
              HEAD
            </span>
          )
        if (r.startsWith('tag: '))
          return (
            <span key={r} className="ref-badge tag">
              {r.slice(5)}
            </span>
          )
        const remote = r.includes('/')
        return (
          <span key={r} className={`ref-badge ${remote ? 'remote' : 'branch'}`}>
            {r}
          </span>
        )
      })}
    </>
  )
}

/** History view of the Git panel: all branches with a commit graph. Reloads when `tick` changes. */
export function GitLogPane({ root, visible, tick }: { root: string; visible: boolean; tick: number }): React.JSX.Element {
  const [log, setLog] = useState<GitLog | null>(null)
  const [selected, setSelected] = useState<string>()
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(400)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    void window.ide.git.log(root).then(setLog)
  }, [root])

  useEffect(() => {
    load()
  }, [load, tick])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 400))
    ro.observe(el)
    return () => ro.disconnect()
  }, [log])

  // Refresh when the tab comes back into view (cheap, catches changes made while hidden).
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) load()
    wasVisible.current = visible
  }, [visible, load])

  const commits = useMemo(() => log?.commits ?? [], [log])
  const graph = useMemo(() => computeGraph(commits), [commits])

  // Opening the details panel shortens the list: keep the selected commit in view.
  const selectedIndex = selected ? commits.findIndex((c) => c.hash === selected) : -1
  useEffect(() => {
    const el = scrollRef.current
    if (!el || selectedIndex < 0) return
    const top = selectedIndex * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
  }, [selectedIndex, viewH])
  const graphWidth = GRAPH_PAD * 2 + graph.maxLanes * LANE_W
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10)
  const last = Math.min(commits.length, Math.ceil((scrollTop + viewH) / ROW_H) + 10)
  const sel: GitCommit | undefined = commits.find((c) => c.hash === selected)

  return (
    <div className="git-pane">
      {log && !log.isRepo && (
        <div className="pane-message">{log.error ? <p className="error">{log.error}</p> : <p>This folder is not a git repository.</p>}</div>
      )}
      {log?.isRepo && log.error && <div className="pane-message error">{log.error}</div>}
      {log?.isRepo && !log.error && commits.length === 0 && <div className="pane-message">No commits yet.</div>}

      {commits.length > 0 && (
        <div className="git-rows" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ height: commits.length * ROW_H, position: 'relative' }}>
            {commits.slice(first, last).map((c, i) => {
              const idx = first + i
              const isHead = c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> '))
              return (
                <div
                  key={c.hash}
                  className={`git-row${c.hash === selected ? ' selected' : ''}`}
                  style={{ top: idx * ROW_H, height: ROW_H }}
                  onClick={() => setSelected(c.hash === selected ? undefined : c.hash)}
                  title={`${c.hash}\n${c.author}\n${new Date(c.date * 1000).toLocaleString()}`}
                >
                  <GraphCell row={graph.rows[idx]} width={graphWidth} isHead={isHead} />
                  <span className="git-subject">
                    <RefBadges refs={c.refs} />
                    {c.subject}
                  </span>
                  <span className="git-author">{c.author}</span>
                  <span className="git-date">{relativeTime(c.date)}</span>
                  <span className="git-hash">{c.hash.slice(0, 7)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {sel && <CommitDetails key={sel.hash} root={root} commit={sel} onClose={() => setSelected(undefined)} />}
    </div>
  )
}
