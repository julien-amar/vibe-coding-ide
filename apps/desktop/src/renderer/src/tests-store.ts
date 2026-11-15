import { create } from 'zustand'
import type { TestCase, TestFramework, TestProject, TestResult, TestRunRequest, TestRunResult, TestsPrefs } from '@shared/types'

/**
 * Tests panel state per project root. Kept outside the panel component so a
 * collapsed / re-opened panel keeps its tests, results and output.
 */
export interface ProjectTestsState {
  projects?: TestProject[]
  discovering: boolean
  /** What the discovery in progress is doing. */
  step?: string
  /** Results by `resultKey(projectId, testId)`, plus 'running' while a run includes the test. */
  results: Record<string, TestResult | { status: 'running' }>
  fileErrors: Record<string, TestRunResult['fileErrors']>
  /** Some tests run (runningProjects: the test projects running). */
  running: boolean
  runningProjects: string[]
  /** The runs in progress: tests executed (a result in) out of the tests they cover. */
  progress?: { done: number; total: number }
  lastError?: string
  output: string
}

export const resultKey = (projectId: string, testId: string): string => `${projectId}|${testId}`

const MAX_OUTPUT = 300_000

const empty = (): ProjectTestsState => ({ discovering: false, results: {}, fileErrors: {}, running: false, runningProjects: [], output: '' })

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
  /** Run `req`; `testIds` are the tests it covers (shown as running). Other test projects can run meanwhile. */
  run(root: string, req: TestRunRequest, testIds: string[]): Promise<void>
  /**
   * Run every test project: in parallel (`prefs.parallelism` at once; .NET projects one after the
   * other, they build), or one after the other. Stop ends the runs and the ones not started yet.
   */
  runAll(root: string, projects: { req: TestRunRequest; testIds: string[]; framework: TestFramework }[], prefs: TestsPrefs): Promise<void>
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
    markDone(root, [key])
  })

  /** Folders whose runs were stopped: Run all starts none of its remaining projects. */
  const stopped = new Set<string>()

  /**
   * Per folder, the round of runs in progress (Run all: every project's tests from the start; a single
   * run: its tests; a run started meanwhile: added): the tests it covers, those with a result.
   */
  const rounds = new Map<string, { keys: Set<string>; done: Set<string>; all: boolean }>()
  const showProgress = (root: string): void => {
    const r = rounds.get(root)
    patch(root, () => ({ progress: r ? { done: r.done.size, total: r.keys.size } : undefined }))
  }
  const addToRound = (root: string, keys: string[], all = false): void => {
    let r = rounds.get(root)
    if (!r) rounds.set(root, (r = { keys: new Set(), done: new Set(), all }))
    for (const k of keys) r.keys.add(k)
    showProgress(root)
  }
  const markDone = (root: string, keys: string[]): void => {
    const r = rounds.get(root)
    if (!r) return
    let changed = false
    for (const k of keys) {
      if (!r.keys.has(k) || r.done.has(k)) continue
      r.done.add(k)
      changed = true
    }
    if (changed) showProgress(root)
  }
  const endRound = (root: string): void => {
    rounds.delete(root)
    showProgress(root)
  }

  /** Projects of the discovery in progress, by their place in the panel (as they are listed). */
  const streamed = new Map<string, { project: TestProject; order: string }[]>()
  // A project as soon as its tests are listed: shown, in its place, while the others are still listed.
  window.ide.tests.onProject((root, project, order) => {
    const got = streamed.get(root)
    if (!got || !get().byRoot[root]?.discovering) return
    got.push({ project, order })
    const projects = [...got].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0)).map((p) => p.project)
    patch(root, () => ({ projects }))
  })

  window.ide.tests.onStep((root, step) => {
    if (!get().byRoot[root]?.discovering) return
    patch(root, () => ({ step: step ?? undefined }))
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
        patch(root, () => ({ projects, discovering: false, step: undefined }))
      } catch (err) {
        streamed.delete(root)
        patch(root, () => ({ discovering: false, step: undefined, lastError: (err as Error).message }))
      }
    },

    async run(root, req, testIds) {
      const { projectId } = req
      if (get().byRoot[root]?.runningProjects.includes(projectId)) return
      addToRound(
        root,
        testIds.map((id) => resultKey(projectId, id))
      )
      patch(root, (s) => {
        const results = { ...s.results }
        for (const id of testIds) results[resultKey(projectId, id)] = { status: 'running' }
        return {
          running: true,
          runningProjects: [...s.runningProjects, projectId],
          results,
          // A new round of runs: the last one's error is not this one's.
          ...(s.runningProjects.length ? {} : { lastError: undefined }),
          output: s.output ? s.output + '\n' : ''
        }
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
        const runningProjects = s.runningProjects.filter((p) => p !== projectId)
        return {
          running: runningProjects.length > 0,
          runningProjects,
          results,
          projects,
          fileErrors: { ...s.fileErrors, [projectId]: res.fileErrors },
          lastError: res.cancelled ? 'Run stopped.' : (res.error ?? s.lastError)
        }
      })
      // Every test of the run is executed now (a result, or none: not run); the round ends with its last run.
      markDone(
        root,
        testIds.map((id) => resultKey(projectId, id))
      )
      if (!get().byRoot[root]?.running && !rounds.get(root)?.all) endRound(root)
    },

    async runAll(root, projects, prefs) {
      stopped.delete(root)
      // A round of every project's tests (counted from the start, the queued ones too).
      rounds.delete(root)
      addToRound(
        root,
        projects.flatMap((p) => p.testIds.map((id) => resultKey(p.req.projectId, id))),
        true
      )
      // Work items: each test project, except the .NET ones, all in one (one after the other: running
      // them builds them, and they often share projects).
      const parallel = prefs.runAll === 'parallel'
      const dotnet = projects.filter((p) => p.framework === 'dotnet')
      const items = parallel ? [...projects.filter((p) => p.framework !== 'dotnet').map((p) => [p]), ...(dotnet.length ? [dotnet] : [])] : [projects]
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < items.length && !stopped.has(root)) {
          for (const p of items[next++]) {
            if (stopped.has(root)) return
            await get().run(root, p.req, p.testIds)
          }
        }
      }
      const workers = parallel ? Math.max(1, Math.min(prefs.parallelism, items.length)) : 1
      await Promise.all(Array.from({ length: workers }, worker))
      endRound(root)
    },

    stop(root) {
      stopped.add(root)
      window.ide.tests.stop(root)
    },

    clearOutput(root) {
      patch(root, () => ({ output: '' }))
    }
  }
})

export const useProjectTests = (root: string): ProjectTestsState => useTestsStore((s) => s.byRoot[root]) ?? EMPTY
const EMPTY = empty()
