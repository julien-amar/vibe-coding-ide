import { useEffect, useMemo, useRef, useState } from 'react'
import type { TestCase, TestProject, TestResult, TestStatus } from '@shared/types'
import { sendToAgent } from '../agent-bridge'
import { fixPrompt, type Failure } from '../test-prompt'
import { aggregateStatus, buildTestTree, filterTestTree, formatDuration, splitLocations, stripAnsi, type TestTreeNode } from '../test-tree'
import { resultKey, useProjectTests, useTestsStore } from '../tests-store'
import { notify } from './Dialogs'

const STATUS_ICON: Record<TestStatus | 'none', string> = { passed: '✓', failed: '✗', skipped: '○', running: '◌', none: '·' }
const STATUS_TEXT: Record<TestStatus, string> = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', running: 'Running' }

function StatusIcon({ status }: { status?: TestStatus }): React.JSX.Element {
  return (
    <span className={`test-status st-${status ?? 'none'}`} aria-label={status ? STATUS_TEXT[status] : 'Not run'}>
      {STATUS_ICON[status ?? 'none']}
    </span>
  )
}

type StatusFilter = 'all' | 'passed' | 'skipped' | 'failed'

const STATUS_FILTERS: { value: StatusFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Show all tests' },
  { value: 'passed', label: 'Passed', title: 'Show passed tests' },
  { value: 'skipped', label: 'Skipped', title: 'Show skipped tests' },
  { value: 'failed', label: 'Failed', title: 'Show failed tests' }
]

interface Row {
  node: TestTreeNode
  depth: number
  status?: TestStatus
  expanded: boolean
}

/**
 * Tests panel of a project: the tests of every framework found in the folder
 * (Vitest, Playwright…), their last status, and buttons to run everything, a
 * file, a suite or a single test. The bottom area shows the selected test's
 * failure or the console output of the runs.
 */
export function TestPanel({ root, tabId, visible }: { root: string; tabId: string; visible: boolean }): React.JSX.Element {
  const st = useProjectTests(root)
  // eslint-disable-next-line react/hooks -- getState is a plain method of the zustand store, not a hook
  const { discover, run, stop, clearOutput } = useTestsStore.getState()
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string>()
  const [view, setView] = useState<'details' | 'output'>('details')
  // The details / output area opens when there is something to show (a selected test, the output).
  const [bottomOpen, setBottomOpen] = useState(false)
  /** Height of the opened Details / Output section, dragged by its top edge (remembered; default 45%). */
  const [bottomHeight, setBottomHeight] = useState<number | undefined>(() => {
    try {
      return Number(localStorage.getItem('tests-bottom-height')) || undefined
    } catch {
      return undefined
    }
  })
  const resizeBottom = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const section = e.currentTarget.parentElement!
    const panel = section.parentElement!
    const startY = e.clientY
    const startHeight = section.getBoundingClientRect().height
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing-row')
    let height = startHeight
    const onMove = (ev: PointerEvent): void => {
      // At least 110 px; the test list keeps 120 px.
      height = Math.round(Math.min(Math.max(startHeight - (ev.clientY - startY), 110), panel.getBoundingClientRect().height - 120))
      setBottomHeight(height)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('resizing-row')
      try {
        localStorage.setItem('tests-bottom-height', String(height))
      } catch {
        /* not remembered */
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }
  const show = (v: 'details' | 'output'): void => {
    setView(v)
    setBottomOpen(true)
  }
  const outputRef = useRef<HTMLPreElement>(null)

  // Discover when the panel is first shown.
  useEffect(() => {
    if (visible && !st.projects && !st.discovering) void discover(root)
  }, [visible, root, st.projects, st.discovering, discover])

  // Follow the output while it grows.
  useEffect(() => {
    const el = outputRef.current
    if (el && view === 'output') el.scrollTop = el.scrollHeight
  }, [st.output, view])

  const trees = useMemo(() => (st.projects ?? []).map(buildTestTree), [st.projects])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q && statusFilter === 'all') return trees
    return trees
      .map((tree) =>
        filterTestTree(tree, (t) => {
          if (statusFilter !== 'all' && st.results[resultKey(tree.projectId, t.id)]?.status !== statusFilter) return false
          return !q || [t.file, ...t.suite, t.name].some((s) => s.toLowerCase().includes(q))
        })
      )
      .filter((t): t is TestTreeNode => !!t && t.testIds.length > 0)
  }, [trees, filter, statusFilter, st.results])

  const searching = filter.trim() !== '' || statusFilter !== 'all'
  const rows: Row[] = []
  const walk = (node: TestTreeNode, depth: number): void => {
    const status = aggregateStatus(node.projectId, node.testIds, st.results)
    // Projects and suites start expanded; files start collapsed unless they hold a failure (or a search is on).
    const byDefault = node.kind !== 'file' || status === 'failed' || searching
    const isOpen = node.kind !== 'test' && (expanded[node.key] ?? byDefault)
    rows.push({ node, depth, status, expanded: isOpen })
    if (isOpen) node.children.forEach((c) => walk(c, depth + 1))
  }
  filtered.forEach((t) => walk(t, 0))

  const counts = { passed: 0, failed: 0, skipped: 0, total: 0 }
  for (const tree of trees) {
    for (const id of tree.testIds) {
      counts.total++
      const s = st.results[resultKey(tree.projectId, id)]?.status
      if (s === 'passed' || s === 'failed' || s === 'skipped') counts[s]++
    }
  }

  const runNode = (node: TestTreeNode): void => {
    setSelected(node.key)
    void run(root, node.req, node.testIds)
  }
  const runAll = async (): Promise<void> => {
    for (const tree of trees) await useTestsStore.getState().run(root, tree.req, tree.testIds)
  }

  const selectedRow = rows.find((r) => r.node.key === selected)?.node ?? findNode(trees, selected)

  return (
    <div className="tests-panel">
      <div className="pane-toolbar tests-toolbar">
        <button className="tool-button primary" disabled={st.running || counts.total === 0} title="Run every test of the project" onClick={() => void runAll()}>
          ▶ Run all
        </button>
        {st.running && (
          <button className="tool-button danger" title="Stop the running tests" onClick={() => stop(root)}>
            ■ Stop
          </button>
        )}
        <button
          className="tool-button"
          disabled={st.discovering || st.running}
          title="Find tests again (after adding or renaming tests)"
          onClick={() => void discover(root)}
        >
          ⟳
        </button>
        <span className="spacer" />
        <span className="tests-summary">
          {st.discovering ? <span className="busy">Finding tests…</span> : st.running ? <span className="busy">Running…</span> : null}
        </span>
      </div>

      <div className="pane-toolbar tests-filterbar">
        <div className="segmented tests-status-filter" role="radiogroup" aria-label="Show tests">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              role="radio"
              aria-checked={statusFilter === f.value}
              className={statusFilter === f.value ? 'active' : ''}
              title={f.title}
              aria-label={`${f.title} (${f.value === 'all' ? counts.total : counts[f.value]})`}
              data-filter={f.value}
              onClick={() => setStatusFilter(f.value)}
            >
              {f.value !== 'all' && <StatusIcon status={f.value} />}
              <span className="filter-label">{f.label}</span>
              <span className="count">{f.value === 'all' ? counts.total : counts[f.value]}</span>
            </button>
          ))}
        </div>
        <input className="tests-filter" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <div className="tests-tree" role="tree" aria-label="Tests">
        {st.projects && st.projects.length === 0 && !st.discovering && (
          <div className="tests-empty">
            <p>No test framework found in this folder.</p>
            <p className="muted">Supported: Vitest and Playwright (a vitest / playwright config file, also in sub-folders).</p>
          </div>
        )}
        {!st.projects && st.discovering && <div className="tests-empty muted">Finding tests…</div>}
        {rows.length === 0 && counts.total > 0 && (
          <div className="tests-empty muted">
            No {statusFilter === 'all' ? '' : `${statusFilter} `}tests{filter.trim() ? ` matching “${filter.trim()}”` : ''}.
          </div>
        )}
        {rows.map(({ node, depth, status, expanded: isOpen }) => {
          const project = st.projects?.find((p) => p.id === node.projectId)
          const result = node.test ? (st.results[resultKey(node.projectId, node.test.id)] as TestResult | undefined) : undefined
          return (
            <div key={node.key}>
              <div
                className={`test-row kind-${node.kind}${selected === node.key ? ' selected' : ''}`}
                role="treeitem"
                aria-expanded={node.kind === 'test' ? undefined : isOpen}
                style={{ paddingLeft: 6 + depth * 14 }}
                title={node.kind === 'file' && project ? `${project.relDir ? project.relDir + '/' : ''}${node.label}` : undefined}
                onClick={() => {
                  setSelected(node.key)
                  show('details')
                }}
                onDoubleClick={() => {
                  // A test opens in the editor at its line; a group folds / unfolds.
                  if (node.test) void openFile(root, project, node.test.source ?? node.test.file, node.test.line)
                  else setExpanded((e) => ({ ...e, [node.key]: !isOpen }))
                }}
              >
                <button
                  className="test-chevron"
                  tabIndex={-1}
                  style={{ visibility: node.kind === 'test' ? 'hidden' : undefined }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setExpanded((x) => ({ ...x, [node.key]: !isOpen }))
                  }}
                >
                  {isOpen ? '▾' : '▸'}
                </button>
                <StatusIcon status={status} />
                <span className="test-label">{node.label}</span>
                {node.kind !== 'test' && <span className="test-count">{node.testIds.length}</span>}
                {result && 'duration' in result && <span className="test-duration">{formatDuration(result.duration)}</span>}
                {result?.flaky && (
                  <span className="test-flaky" title="Passed after a retry">
                    flaky
                  </span>
                )}
                <button
                  className="test-run"
                  title={`Run ${node.kind === 'project' ? 'all tests' : node.kind === 'test' ? 'this test' : `this ${node.kind}`}`}
                  disabled={st.running}
                  onClick={(e) => {
                    e.stopPropagation()
                    runNode(node)
                  }}
                >
                  ▶
                </button>
              </div>
              {node.kind === 'project' && project?.error && <pre className="tests-error">{stripAnsi(project.error)}</pre>}
            </div>
          )
        })}
      </div>

      {/* Details / Output: the bar stays at the bottom, the content opens above it. */}
      <div className={`tests-bottom${bottomOpen ? ' open' : ''}`} style={bottomOpen && bottomHeight ? { height: bottomHeight } : undefined}>
        {bottomOpen && (
          <div
            className="tests-bottom-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize details"
            title="Drag to resize"
            onPointerDown={resizeBottom}
            onDoubleClick={() => {
              setBottomHeight(undefined)
              try {
                localStorage.removeItem('tests-bottom-height')
              } catch {
                /* nothing to forget */
              }
            }}
          />
        )}
        {bottomOpen && (
          <button
            className="icon-button pane-action tests-bottom-hide"
            title={view === 'output' ? 'Hide the output' : 'Hide details'}
            onClick={() => setBottomOpen(false)}
          >
            ▾
          </button>
        )}
        {!bottomOpen ? null : view === 'output' ? (
          <pre ref={outputRef} className="tests-output">
            {stripAnsi(st.output) || 'Run tests to see their output here.'}
          </pre>
        ) : (
          <TestDetails node={selectedRow} root={root} tabId={tabId} projects={st.projects ?? []} results={st.results} fileErrors={st.fileErrors} />
        )}
        <div className="pane-toolbar tests-bottom-bar">
          <div className="segmented" role="tablist">
            <button className={bottomOpen && view === 'details' ? 'active' : ''} onClick={() => show('details')}>
              Details
            </button>
            <button className={bottomOpen && view === 'output' ? 'active' : ''} onClick={() => show('output')}>
              Output
            </button>
          </div>
          {st.lastError && (
            <span className="tests-run-error" title={st.lastError}>
              {st.lastError}
            </span>
          )}
          <span className="spacer" />
          {bottomOpen && view === 'output' && (
            <button className="tool-button" disabled={!st.output} onClick={() => clearOutput(root)}>
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function findNode(trees: TestTreeNode[], key?: string): TestTreeNode | undefined {
  if (!key) return undefined
  for (const t of trees) {
    if (t.key === key) return t
    const found = findNode(t.children, key)
    if (found) return found
  }
  return undefined
}

/** Open a file of the project in the user's editor (relative paths: from the test project folder). */
async function openFile(root: string, project: TestProject | undefined, file: string, line?: number, column?: number): Promise<void> {
  const r = await window.ide.app.openInEditor(root, file, line, column, project?.dir)
  if (!r.ok) notify(r.error ?? `Cannot open ${file}`, 'error')
}

/** Text of a test failure, with its file locations as links that open the editor at that line. */
function LinkedText({ text, root, project }: { text: string; root: string; project?: TestProject }): React.JSX.Element {
  return (
    <pre className="tests-message">
      {splitLocations(stripAnsi(text)).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <a
            key={i}
            className="tests-location"
            href="#"
            title={`Open ${part.file} at line ${part.line}`}
            onClick={(e) => {
              e.preventDefault()
              void openFile(root, project, part.file, part.line, part.column)
            }}
          >
            {part.text}
          </a>
        )
      )}
    </pre>
  )
}

/** "Fix with agent" button: sends the failures to the project's AI agent panel. */
function FixButton({ tabId, project, failures }: { tabId: string; project?: TestProject; failures: Failure[] }): React.JSX.Element | null {
  const [sending, setSending] = useState(false)
  if (!project || failures.length === 0) return null
  const label = failures.length === 1 ? 'Fix with agent' : `Fix ${failures.length} failures with agent`
  return (
    <button
      className="tool-button primary tests-fix"
      disabled={sending}
      title="Send the failure to the project's AI agent panel (opens one if needed), with how to re-run the test"
      onClick={async () => {
        setSending(true)
        const r = await sendToAgent(tabId, fixPrompt(project, failures))
        setSending(false)
        notify(r.ok ? 'Sent to the AI agent' : (r.error ?? 'Could not reach the AI agent'), r.ok ? 'success' : 'error')
      }}
    >
      ✦ {sending ? 'Sending…' : label}
    </button>
  )
}

/** Failure (or status) of the selected test; for a group, its failed tests. */
function TestDetails({
  node,
  root,
  tabId,
  projects,
  results,
  fileErrors
}: {
  node?: TestTreeNode
  root: string
  tabId: string
  projects: TestProject[]
  results: ReturnType<typeof useProjectTests>['results']
  fileErrors: ReturnType<typeof useProjectTests>['fileErrors']
}): React.JSX.Element {
  if (!node) return <div className="tests-details muted">Select a test to see its result.</div>
  const project = projects.find((p) => p.id === node.projectId)
  const errors = (fileErrors[node.projectId] ?? []).filter((e) => node.kind === 'project' || (node.req.file && e.file === node.req.file))
  const testOf = (id: string): TestCase | undefined => project?.tests.find((t) => t.id === id)

  if (node.test) {
    const test = node.test
    const r = results[resultKey(node.projectId, test.id)]
    const message = r && 'message' in r ? r.message : undefined
    return (
      <div className="tests-details">
        <div className="tests-details-head">
          <StatusIcon status={r?.status} />
          <strong>{[...test.suite, test.name].join(' › ')}</strong>
          <span className="spacer" />
          {r?.status === 'failed' && <FixButton tabId={tabId} project={project} failures={[{ test, message }]} />}
        </div>
        <div className="muted">
          <a
            className="tests-location"
            href="#"
            title="Open in your editor"
            onClick={(e) => {
              e.preventDefault()
              void openFile(root, project, test.source ?? test.file, test.line)
            }}
          >
            {test.source ?? test.file}
            {test.line ? `:${test.line}` : ''}
          </a>
          {r && 'duration' in r && r.duration !== undefined ? ` · ${formatDuration(r.duration)}` : ''}
          {r && r.status !== 'running' && r.flaky ? ' · passed after a retry' : ''}
        </div>
        {!r && <p className="muted">Not run yet.</p>}
        {message && <LinkedText text={message} root={root} project={project} />}
        {errors.map((e, i) => (
          <LinkedText key={i} text={e.message} root={root} project={project} />
        ))}
      </div>
    )
  }

  const failed = node.testIds.filter((id) => results[resultKey(node.projectId, id)]?.status === 'failed')
  const failures: Failure[] = failed.flatMap((id) => {
    const test = testOf(id)
    const r = results[resultKey(node.projectId, id)] as TestResult
    return test ? [{ test, message: r.message }] : []
  })
  return (
    <div className="tests-details">
      <div className="tests-details-head">
        <strong>{node.label}</strong>
        <span className="spacer" />
        <FixButton tabId={tabId} project={project} failures={failures} />
      </div>
      {errors.map((e, i) => (
        <LinkedText key={`e${i}`} text={`${e.file ? `${e.file}\n` : ''}${e.message}`} root={root} project={project} />
      ))}
      {failed.length === 0 && errors.length === 0 && <p className="muted">{node.testIds.length} tests, no failures.</p>}
      {failed.map((id) => {
        const r = results[resultKey(node.projectId, id)] as TestResult
        return (
          <div key={id} className="tests-failure">
            <div>
              <StatusIcon status="failed" /> {id.split('::')[1]}
            </div>
            {r.message && <LinkedText text={r.message} root={root} project={project} />}
          </div>
        )
      })}
    </div>
  )
}
