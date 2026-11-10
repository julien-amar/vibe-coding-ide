import { create } from 'zustand'
import type { TestCase, TestProject, TestResult, TestRunRequest, TestRunResult } from '@shared/types'

/**
 * Tests panel state per project root. Kept outside the panel component so a
 * collapsed / re-opened panel keeps its tests, results and output.
 */
export interface ProjectTestsState {
  projects?: TestProject[]
  discovering: boolean
  /** Results by `resultKey(projectId, testId)`, plus 'running' while a run includes the test. */
  results: Record<string, TestResult | { status: 'running' }>
  fileErrors: Record<string, TestRunResult['fileErrors']>
  running: boolean
  lastError?: string
  output: string
}

export const resultKey = (projectId: string, testId: string): string => `${projectId}|${testId}`

const MAX_OUTPUT = 300_000

const empty = (): ProjectTestsState => ({ discovering: false, results: {}, fileErrors: {}, running: false, output: '' })

/** Rebuild a test from its id (`file::suite > name[::project]`), for tests only a run reports (e.g. Vitest .skip). */
export function testFromId(id: string): TestCase {
  const [file, titles = '', projectName] = id.split('::')
  const parts = titles.split(' > ')
  return { id, file, suite: parts.slice(0, -1), name: parts[parts.length - 1], projectName }
}

interface TestsStore {
  byRoot: Record<string, ProjectTestsState>
  /** Find the tests; `reset` (the Refresh button): the list and its results emptied first (a spinner shows). */
  discover(root: string, opts?: { reset?: boolean }): Promise<void>
  /** Run `req`; `testIds` are the tests it covers (shown as running). */
  run(root: string, req: TestRunRequest, testIds: string[]): Promise<void>
  stop(root: string): void
  clearOutput(root: string): void
}

export const useTestsStore = create<TestsStore>((set, get) => {
  const patch = (root: string, f: (s: ProjectTestsState) => Partial<ProjectTestsState>): void =>
    set((st) => {
      const cur = st.byRoot[root] ?? empty()
      return { byRoot: { ...st.byRoot, [root]: { ...cur, ...f(cur) } } }
    })

  // Console output of runs, streamed from the main process.
  window.ide.tests.onOutput((root, text) => {
    if (!get().byRoot[root]) return
    patch(root, (s) => ({ output: (s.output + text).slice(-MAX_OUTPUT) }))
  })

  // Each test's result as soon as it finishes. A filtered run also reports the tests it did not
  // select (as skipped): only tests of the run (shown as running) or tests not listed yet are updated.
  window.ide.tests.onProgress((root, projectId, result) => {
    const s = get().byRoot[root]
    if (!s?.running) return
    const key = resultKey(projectId, result.id)
    const listed = s.projects?.find((p) => p.id === projectId)?.tests.some((t) => t.id === result.id)
    if (s.results[key]?.status !== 'running' && listed) return
    patch(root, (cur) => {
      const projects = listed ? cur.projects : cur.projects?.map((p) => (p.id === projectId ? { ...p, tests: [...p.tests, testFromId(result.id)] } : p))
      return { results: { ...cur.results, [key]: result }, projects }
    })
  })

  /** Projects of the discovery in progress, by their place in the panel (as they are listed). */
  const streamed = new Map<string, { project: TestProject; index: number }[]>()
  // A project as soon as its tests are listed: shown, in its place, while the others are still listed.
  window.ide.tests.onProject((root, project, index) => {
    const got = streamed.get(root)
    if (!got || !get().byRoot[root]?.discovering) return
    got.push({ project, index })
    const projects = [...got].sort((a, b) => a.index - b.index).map((p) => p.project)
    patch(root, () => ({ projects }))
  })

  return {
    byRoot: {},

    async discover(root, opts) {
      if (get().byRoot[root]?.discovering) return
      patch(root, () => ({ discovering: true, lastError: undefined, ...(opts?.reset ? { projects: undefined, results: {}, fileErrors: {} } : {}) }))
      streamed.set(root, [])
      try {
        // (Every project, once all are listed: the same as the ones streamed.)
        const projects = await window.ide.tests.discover(root)
        streamed.delete(root)
        patch(root, () => ({ projects, discovering: false }))
      } catch (err) {
        streamed.delete(root)
        patch(root, () => ({ discovering: false, lastError: (err as Error).message }))
      }
    },

    async run(root, req, testIds) {
      if (get().byRoot[root]?.running) return
      const { projectId } = req
      patch(root, (s) => {
        const results = { ...s.results }
        for (const id of testIds) results[resultKey(projectId, id)] = { status: 'running' }
        return { running: true, results, lastError: undefined, output: s.output ? s.output + '\n' : '' }
      })
      let res: TestRunResult
      try {
        res = await window.ide.tests.run(root, req)
      } catch (err) {
        res = { ok: false, error: (err as Error).message, results: [], fileErrors: [] }
      }
      patch(root, (s) => {
        const results = { ...s.results }
        // Tests of the run without a result (not run, or the run failed): back to unknown.
        for (const id of testIds) delete results[resultKey(projectId, id)]
        // A filtered run reports the other tests of its files as skipped: keep their earlier results.
        const scope = new Set(testIds)
        const listed = new Set(s.projects?.find((p) => p.id === projectId)?.tests.map((t) => t.id) ?? [])
        for (const r of res.results) if (scope.has(r.id) || !listed.has(r.id)) results[resultKey(projectId, r.id)] = r
        // Tests the listing did not include (e.g. skipped ones in Vitest) are added to the tree.
        const projects = s.projects?.map((p) => {
          if (p.id !== projectId) return p
          const known = new Set(p.tests.map((t) => t.id))
          const extra = res.results.filter((r) => !known.has(r.id)).map((r) => testFromId(r.id))
          return extra.length ? { ...p, tests: [...p.tests, ...extra] } : p
        })
        return {
          running: false,
          results,
          projects,
          fileErrors: { ...s.fileErrors, [projectId]: res.fileErrors },
          lastError: res.cancelled ? 'Run stopped.' : res.error
        }
      })
    },

    stop(root) {
      window.ide.tests.stop(root)
    },

    clearOutput(root) {
      patch(root, () => ({ output: '' }))
    }
  }
})

export const useProjectTests = (root: string): ProjectTestsState => useTestsStore((s) => s.byRoot[root]) ?? EMPTY
const EMPTY = empty()
