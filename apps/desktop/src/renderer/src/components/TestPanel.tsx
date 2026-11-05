import { useEffect, useMemo, useRef, useState } from 'react'
import type { TestResult, TestStatus } from '@shared/types'
import { aggregateStatus, buildTestTree, filterTestTree, formatDuration, stripAnsi, type TestTreeNode } from '../test-tree'
import { resultKey, useProjectTests, useTestsStore } from '../tests-store'

const STATUS_ICON: Record<TestStatus | 'none', string> = { passed: '✓', failed: '✗', skipped: '○', running: '◌', none: '·' }
const STATUS_TEXT: Record<TestStatus, string> = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', running: 'Running' }

function StatusIcon({ status }: { status?: TestStatus }): React.JSX.Element {
  return (
    <span className={`test-status st-${status ?? 'none'}`} aria-label={status ? STATUS_TEXT[status] : 'Not run'}>
      {STATUS_ICON[status ?? 'none']}
    </span>
  )
}

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
export function TestPanel({ root, visible }: { root: string; visible: boolean }): React.JSX.Element {
  const st = useProjectTests(root)
  const { discover, run, stop, clearOutput } = useTestsStore.getState()
  const [filter, setFilter] = useState('')
  const [failedOnly, setFailedOnly] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string>()
  const [view, setView] = useState<'details' | 'output'>('details')
  // The details / output area opens when there is something to show (a selected test, the output).
  const [bottomOpen, setBottomOpen] = useState(false)
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
    if (!q && !failedOnly) return trees
    return trees
      .map((tree) =>
        filterTestTree(tree, (t) => {
          if (failedOnly && st.results[resultKey(tree.projectId, t.id)]?.status !== 'failed') return false
          return !q || [t.file, ...t.suite, t.name].some((s) => s.toLowerCase().includes(q))
        })
      )
      .filter((t): t is TestTreeNode => !!t)
  }, [trees, filter, failedOnly, st.results])

  const searching = filter.trim() !== '' || failedOnly
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
        <button className="tool-button" disabled={st.discovering || st.running} title="Find tests again (after adding or renaming tests)" onClick={() => void discover(root)}>
          ⟳
        </button>
        <input className="tests-filter" placeholder="Filter tests" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="tests-failed-only" title="Show failed tests only">
          <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed
        </label>
        <span className="spacer" />
        <span className="tests-summary">
          {st.discovering ? (
            <span className="busy">Finding tests…</span>
          ) : st.running ? (
            <span className="busy">Running…</span>
          ) : (
            <>
              {counts.failed > 0 && <span className="st-failed">{counts.failed} failed</span>}
              {counts.passed > 0 && <span className="st-passed">{counts.passed} passed</span>}
              {counts.skipped > 0 && <span className="st-skipped">{counts.skipped} skipped</span>}
              <span>{counts.total} tests</span>
            </>
          )}
        </span>
      </div>

      <div className="tests-tree" role="tree" aria-label="Tests">
        {st.projects && st.projects.length === 0 && !st.discovering && (
          <div className="tests-empty">
            <p>No test framework found in this folder.</p>
            <p className="muted">Supported: Vitest and Playwright (a vitest / playwright config file, also in sub-folders).</p>
          </div>
        )}
        {!st.projects && st.discovering && <div className="tests-empty muted">Finding tests…</div>}
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
                onDoubleClick={() => node.kind !== 'test' && setExpanded((e) => ({ ...e, [node.key]: !isOpen }))}
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
                {result?.flaky && <span className="test-flaky" title="Passed after a retry">flaky</span>}
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

      <div className={`tests-bottom${bottomOpen ? ' open' : ''}`}>
        <div className="pane-toolbar tests-bottom-bar">
          <div className="segmented" role="tablist">
            <button className={bottomOpen && view === 'details' ? 'active' : ''} onClick={() => show('details')}>
              Details
            </button>
            <button className={bottomOpen && view === 'output' ? 'active' : ''} onClick={() => show('output')}>
              Output
            </button>
          </div>
          {st.lastError && <span className="tests-run-error" title={st.lastError}>{st.lastError}</span>}
          <span className="spacer" />
          {bottomOpen && view === 'output' && (
            <button className="tool-button" disabled={!st.output} onClick={() => clearOutput(root)}>
              Clear
            </button>
          )}
          {bottomOpen && (
            <button className="icon-button pane-action" title="Hide details" onClick={() => setBottomOpen(false)}>
              ▾
            </button>
          )}
        </div>
        {!bottomOpen ? null : view === 'output' ? (
          <pre ref={outputRef} className="tests-output">
            {stripAnsi(st.output) || 'Run tests to see their output here.'}
          </pre>
        ) : (
          <TestDetails node={selectedRow} results={st.results} fileErrors={st.fileErrors} />
        )}
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

/** Failure (or status) of the selected test; for a group, its failed tests. */
function TestDetails({
  node,
  results,
  fileErrors
}: {
  node?: TestTreeNode
  results: ReturnType<typeof useProjectTests>['results']
  fileErrors: ReturnType<typeof useProjectTests>['fileErrors']
}): React.JSX.Element {
  if (!node) return <div className="tests-details muted">Select a test to see its result.</div>
  const errors = (fileErrors[node.projectId] ?? []).filter((e) => node.kind === 'project' || (node.req.file && e.file === node.req.file))
  if (node.test) {
    const r = results[resultKey(node.projectId, node.test.id)]
    return (
      <div className="tests-details">
        <div className="tests-details-head">
          <StatusIcon status={r?.status} />
          <strong>{[...node.test.suite, node.test.name].join(' › ')}</strong>
        </div>
        <div className="muted">
          {node.test.file}
          {node.test.line ? `:${node.test.line}` : ''}
          {r && 'duration' in r && r.duration !== undefined ? ` · ${formatDuration(r.duration)}` : ''}
          {r && r.status !== 'running' && r.flaky ? ' · passed after a retry' : ''}
        </div>
        {!r && <p className="muted">Not run yet.</p>}
        {r && 'message' in r && r.message && <pre className="tests-message">{stripAnsi(r.message)}</pre>}
        {errors.map((e, i) => (
          <pre key={i} className="tests-message">
            {stripAnsi(e.message)}
          </pre>
        ))}
      </div>
    )
  }
  const failed = node.testIds.filter((id) => results[resultKey(node.projectId, id)]?.status === 'failed')
  return (
    <div className="tests-details">
      <div className="tests-details-head">
        <strong>{node.label}</strong>
      </div>
      {errors.map((e, i) => (
        <pre key={`e${i}`} className="tests-message">
          {e.file ? `${e.file}\n` : ''}
          {stripAnsi(e.message)}
        </pre>
      ))}
      {failed.length === 0 && errors.length === 0 && <p className="muted">{node.testIds.length} tests, no failures.</p>}
      {failed.map((id) => {
        const r = results[resultKey(node.projectId, id)] as TestResult
        return (
          <div key={id} className="tests-failure">
            <div>
              <StatusIcon status="failed" /> {id.split('::')[1]}
            </div>
            {r.message && <pre className="tests-message">{stripAnsi(r.message)}</pre>}
          </div>
        )
      })}
    </div>
  )
}
