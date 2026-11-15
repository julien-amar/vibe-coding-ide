import { beforeAll, describe, expect, it } from 'vitest'
import type { TestFramework, TestResult, TestRunRequest, TestRunResult } from '@shared/types'

/** The main process, faked: each run takes a moment; what runs at once is recorded. */
const runs = { started: [] as string[], active: new Set<string>(), max: 0, dotnetAtOnce: 0, stopped: false }
let finish: ((id: string) => void) | undefined
/** A test's result as the main process reports it while a run goes on (the store's listener). */
let report: ((root: string, projectId: string, result: TestResult) => void) | undefined

beforeAll(() => {
  const noop = (): (() => void) => () => undefined
  ;(globalThis as unknown as { window: unknown }).window = {
    ide: {
      tests: {
        onOutput: noop,
        onProgress: (cb: typeof report) => {
          report = cb
          return () => undefined
        },
        onProject: noop,
        onStep: noop,
        discover: async () => [],
        stop: () => {
          runs.stopped = true
        },
        run: (_root: string, req: TestRunRequest): Promise<TestRunResult> => {
          runs.started.push(req.projectId)
          runs.active.add(req.projectId)
          runs.max = Math.max(runs.max, runs.active.size)
          runs.dotnetAtOnce = Math.max(runs.dotnetAtOnce, [...runs.active].filter((p) => p.startsWith('dotnet')).length)
          return new Promise((resolve) => {
            const done = (): void => {
              runs.active.delete(req.projectId)
              resolve({ ok: true, results: [], fileErrors: [] })
            }
            setTimeout(done, 20)
            finish?.(req.projectId)
          })
        }
      }
    }
  }
})

const project = (id: string): { req: TestRunRequest; testIds: string[]; framework: TestFramework } => ({
  req: { projectId: id },
  testIds: [],
  framework: id.split(':')[0] as TestFramework
})
const reset = (): void => {
  runs.started = []
  runs.active.clear()
  runs.max = 0
  runs.dotnetAtOnce = 0
  runs.stopped = false
  finish = undefined
}

describe('Tests panel: Run all', () => {
  const projects = ['vitest:web', 'jest:api', 'go:svc', 'dotnet:A.Tests', 'dotnet:B.Tests', 'cargo:core', 'pytest:tools'].map(project)

  it('runs the test projects in parallel, at most N at once; .NET ones one after the other', async () => {
    const { useTestsStore } = await import('./tests-store')
    reset()
    await useTestsStore.getState().runAll('/r1', projects, { runAll: 'parallel', parallelism: 3 })
    expect(new Set(runs.started)).toEqual(new Set(projects.map((p) => p.req.projectId)))
    expect(runs.max).toBe(3)
    expect(runs.dotnetAtOnce).toBe(1)
    expect(useTestsStore.getState().byRoot['/r1'].running).toBe(false)
  })

  it('runs them one after the other when asked (in the panel order)', async () => {
    const { useTestsStore } = await import('./tests-store')
    reset()
    await useTestsStore.getState().runAll('/r2', projects, { runAll: 'sequential', parallelism: 3 })
    expect(runs.started).toEqual(projects.map((p) => p.req.projectId))
    expect(runs.max).toBe(1)
  })

  it('Stop: the runs end and the projects not started yet are not', async () => {
    const { useTestsStore } = await import('./tests-store')
    reset()
    // Stopped as soon as the first two runs start.
    finish = () => {
      if (runs.started.length === 2) useTestsStore.getState().stop('/r3')
    }
    await useTestsStore.getState().runAll('/r3', projects, { runAll: 'parallel', parallelism: 2 })
    expect(runs.stopped).toBe(true)
    expect(runs.started).toHaveLength(2)
  })
})

describe('Tests panel: progress of the runs', () => {
  const withTests = (id: string, n: number): { req: TestRunRequest; testIds: string[]; framework: TestFramework } => ({
    ...project(id),
    testIds: Array.from({ length: n }, (_, i) => `t${i}`)
  })

  it('counts every project’s tests from the start; a project’s tests are done when its run ends; none after', async () => {
    const { useTestsStore } = await import('./tests-store')
    reset()
    const seen: (string | undefined)[] = []
    const progress = (): string | undefined => {
      const p = useTestsStore.getState().byRoot['/p1']?.progress
      return p && `${p.done}/${p.total}`
    }
    finish = () => seen.push(progress())
    await useTestsStore.getState().runAll('/p1', [withTests('vitest:a', 3), withTests('jest:b', 2)], { runAll: 'sequential', parallelism: 1 })
    expect(seen).toEqual(['0/5', '3/5'])
    expect(progress()).toBeUndefined()
  })

  it('counts a test as soon as its result is reported (not one outside the run)', async () => {
    const { useTestsStore } = await import('./tests-store')
    reset()
    const progress = (): string | undefined => {
      const p = useTestsStore.getState().byRoot['/p2']?.progress
      return p && `${p.done}/${p.total}`
    }
    const counts: (string | undefined)[] = []
    finish = (projectId) => {
      report?.('/p2', projectId, { id: 't0', status: 'passed' })
      counts.push(progress())
      // Another project's test: not one of this run.
      report?.('/p2', 'go:other', { id: 't9', status: 'passed' })
      counts.push(progress())
    }
    await useTestsStore.getState().run('/p2', { projectId: 'vitest:a' }, ['t0', 't1', 't2', 't3'])
    expect(counts).toEqual(['1/4', '1/4'])
    expect(progress()).toBeUndefined()
  })
})
