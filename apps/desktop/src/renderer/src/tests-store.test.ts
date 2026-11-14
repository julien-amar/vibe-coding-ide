import { beforeAll, describe, expect, it } from 'vitest'
import type { TestFramework, TestRunRequest, TestRunResult } from '@shared/types'

/** The main process, faked: each run takes a moment; what runs at once is recorded. */
const runs = { started: [] as string[], active: new Set<string>(), max: 0, dotnetAtOnce: 0, stopped: false }
let finish: ((id: string) => void) | undefined

beforeAll(() => {
  const noop = (): (() => void) => () => undefined
  ;(globalThis as unknown as { window: unknown }).window = {
    ide: {
      tests: {
        onOutput: noop,
        onProgress: noop,
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
