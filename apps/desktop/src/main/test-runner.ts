import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { WebContents } from 'electron'
import type { TestFramework, TestProject, TestResult, TestRunRequest, TestRunResult } from '@shared/types'
import { cargoAdapter } from './tests/cargo'
import { exec, killTree, SKIP_DIRS, workDir, type Adapter, type ListOptions, type LiveLine, type RunContext } from './tests/core'
import { buildDotnetSolutions, dotnetAdapter } from './tests/dotnet'
import { goAdapter } from './tests/go'
import { jestAdapter, jsLiveResult, jsRunArgs, playwrightAdapter, vitestAdapter, type RunFiles } from './tests/js'
import { gradleAdapter, mavenAdapter } from './tests/jvm'
import { pytestAdapter, pytestResult, pytestRunArgs } from './tests/pytest'
import { emit } from './ipc'

/**
 * Tests panel backend: finds test frameworks in a project (also in monorepo
 * sub-folders), lists their tests, and runs them with each framework's adapter
 * (tests/), streaming the console output and each result as soon as it is known.
 * Tools run from the project (node_modules, virtualenv, wrappers) or PATH; WSL
 * projects run inside their distribution.
 */

/** Detection order (also the order of the panel's groups). */
const ADAPTERS: Adapter[] = [vitestAdapter, jestAdapter, playwrightAdapter, pytestAdapter, goAdapter, cargoAdapter, dotnetAdapter, mavenAdapter, gradleAdapter]
const adapterFor = (f: TestFramework): Adapter => ADAPTERS.find((a) => a.framework === f)!

const MAX_DEPTH = 4

/** A test project found in a folder. */
type FoundProject = { framework: TestFramework; dir: string; relDir: string }

/**
 * A test project's place in the panel: by folder, depth first (a folder before its sub-folders,
 * folders by name), then by framework (detection order) — the same whatever order they are found in.
 */
export const projectOrder = (p: { framework: TestFramework; relDir: string }): string =>
  `${p.relDir ? p.relDir.split('/').join('\u0000') : ''}\u0001${String(ADAPTERS.findIndex((a) => a.framework === p.framework)).padStart(2, '0')}`

/**
 * Folders (up to a few levels deep) with a test framework, in the panel's order (projectOrder).
 * Sub-folders are read at the same time, and `onFound` gets each project as soon as it is found.
 * Asynchronous: a large folder (or a WSL one) does not hold up the main process.
 */
export async function detectTestProjects(root: string, onFound?: (project: FoundProject) => void): Promise<FoundProject[]> {
  const found: FoundProject[] = []
  const walk = async (dir: string, depth: number, covered: ReadonlySet<TestFramework>): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name))
    const relDir = relative(root, dir).replace(/\\/g, '/')
    // A Cargo / Maven / Gradle / .NET project covers the sub-folders (modules, crates) of its own
    // framework; other frameworks are still looked for below it (a Gradle build file that only
    // wraps CI around .NET test projects, for instance).
    const next = new Set(covered)
    for (const a of ADAPTERS) {
      if (covered.has(a.framework) || !a.detect(dir, names)) continue
      const project = { framework: a.framework, dir, relDir }
      found.push(project)
      onFound?.(project)
      if (a.ownsSubfolders) next.add(a.framework)
    }
    if (depth >= MAX_DEPTH) return
    // Every sub-folder at once (their reads overlap).
    await Promise.all(
      entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')).map((e) => walk(join(dir, e.name), depth + 1, next))
    )
  }
  await walk(root, 0, new Set())
  const key = new Map(found.map((p) => [p, projectOrder(p)]))
  return found.sort((a, b) => (key.get(a)! < key.get(b)! ? -1 : key.get(a)! > key.get(b)! ? 1 : 0))
}

/** The tests, each id once (the first). */
export function uniqueTests<T extends { id: string }>(tests: T[]): T[] {
  const seen = new Set<string>()
  return tests.filter((t) => !seen.has(t.id) && !!seen.add(t.id))
}

const FRAMEWORK_NAME: Record<TestFramework, string> = {
  vitest: 'Vitest',
  jest: 'Jest',
  playwright: 'Playwright',
  pytest: 'pytest',
  go: 'Go',
  cargo: 'Rust',
  dotnet: '.NET',
  maven: 'Maven',
  gradle: 'Gradle'
}

/** What listing a project does, told while it runs ("Building and listing Rust tests in crates/core"). */
export function stepLabel(p: { framework: TestFramework; relDir: string }, prebuilt = false): string {
  // Go and Rust compile their tests to list them; .NET builds its project (unless its solution was).
  const builds = p.framework === 'cargo' || p.framework === 'go' || (p.framework === 'dotnet' && !prebuilt)
  return `${builds ? 'Building and listing' : 'Discovering'} ${FRAMEWORK_NAME[p.framework]} tests${p.relDir ? ` in ${p.relDir}` : ''}`
}

/** Shown in the panel: a project with tests, or with a listing error to show. */
const worthShowing = (p: TestProject): boolean => p.tests.length > 0 || !!p.error

/**
 * Lists the tests of every test project of a folder: each project (whatever its framework) as soon
 * as the folder walk finds it, all at the same time; `onProject` gets each one (worth showing) as
 * soon as it is listed, with its place in the panel (projectOrder). .NET: once the walk is over (its
 * test projects are grouped by solution), each solution is built once (its test projects are then
 * listed without a build); test projects without one are listed — and built — one at a time.
 */
export async function discoverTests(
  root: string,
  onProject?: (project: TestProject, order: string) => void,
  onStep?: (step: string | undefined) => void
): Promise<TestProject[]> {
  // What is being done (several projects at once: the oldest step still going, and how many more).
  const steps = new Map<number, string>()
  let nextStep = 0
  const tell = (): void => {
    const all = [...steps.values()]
    onStep?.(all.length ? `${all[0]}${all.length > 1 ? ` (+${all.length - 1} more)` : ''}` : undefined)
  }
  const step = (label: string): (() => void) => {
    const id = nextStep++
    steps.set(id, label)
    tell()
    return () => {
      steps.delete(id)
      tell()
    }
  }

  /** .NET test projects listed with a build: one after the other. */
  let dotnetTurn: Promise<unknown> = Promise.resolve()

  const listOne = async ({ framework, dir, relDir }: FoundProject, opts?: ListOptions): Promise<TestProject> => {
    const id = `${framework}:${relDir}`
    const done = step(stepLabel({ framework, relDir }, !!opts?.prebuilt))
    const work = workDir()
    try {
      const { tests: listed, error, projectFile } = await adapterFor(framework).list(dir, work, opts)
      // A test listed more than once (.NET: once per target framework; data-driven cases shown with
      // the same name) is one test of the panel.
      return { id, framework, dir, relDir, tests: uniqueTests(listed), error, ...(projectFile ? { projectFile } : {}) }
    } catch (err) {
      return { id, framework, dir, relDir, tests: [], error: (err as Error).message }
    } finally {
      work.cleanup()
      done()
    }
  }

  const listings: Promise<TestProject>[] = []
  const listed = (p: FoundProject, listing: Promise<TestProject>): void => {
    listings.push(
      listing.then((project) => {
        if (worthShowing(project)) onProject?.(project, projectOrder(p))
        return project
      })
    )
  }

  // Listed as soon as found (.NET: after the walk).
  const walked = step('Finding test projects')
  const found = await detectTestProjects(root, (p) => {
    if (p.framework !== 'dotnet') listed(p, listOne(p))
  })
  walked()
  const dotnet = found.filter((p) => p.framework === 'dotnet')
  if (dotnet.length) {
    let building: (() => void) | undefined
    const built = await buildDotnetSolutions(
      root,
      dotnet.map((p) => p.dir),
      (sln) => {
        building?.()
        building = sln ? step(`Building ${basename(sln)}`) : undefined
      }
    )
    for (const p of dotnet) {
      if (built.has(p.dir)) listed(p, listOne(p, { prebuilt: true }))
      else {
        const turn = dotnetTurn.then(() => listOne(p))
        dotnetTurn = turn.catch(() => undefined)
        listed(p, turn)
      }
    }
  }

  const projects = await Promise.all(listings)
  onStep?.(undefined)
  // In the panel's order (they finish in any order).
  const order = new Map(found.map((p, i) => [`${p.framework}:${p.relDir}`, i]))
  return projects.filter(worthShowing).sort((a, b) => order.get(a.id)! - order.get(b.id)!)
}

/** Runs in progress, one per project root. */
const running = new Map<string, { child?: ChildProcess; cancelled: boolean }>()

export async function runTests(root: string, req: TestRunRequest, sender: WebContents): Promise<TestRunResult> {
  if (running.has(root)) return { ok: false, error: 'Tests are already running in this project.', results: [], fileErrors: [] }
  const project = (await detectTestProjects(root)).find((p) => `${p.framework}:${p.relDir}` === req.projectId)
  if (!project) return { ok: false, error: 'Test project not found.', results: [], fileErrors: [] }
  const { framework, dir } = project

  const state: { child?: ChildProcess; cancelled: boolean } = { cancelled: false }
  running.set(root, state)
  const work = workDir()
  const send = (text: string): void => {
    emit(sender, 'tests:output', root, text)
  }
  const ctx: RunContext = {
    send,
    result: (r: TestResult) => {
      emit(sender, 'tests:progress', root, req.projectId, r)
    },
    async exec(cmd, out) {
      if (state.cancelled) return null
      const p = exec(cmd, dir, out?.stdout ?? send, out?.stderr ?? send)
      state.child = p.child
      const code = await p.done
      state.child = undefined
      return code
    },
    cancelled: () => state.cancelled,
    work
  }
  try {
    const result = await adapterFor(framework).run(dir, req, ctx)
    send(`\n[${state.cancelled ? 'stopped' : 'done'}]\n`)
    return state.cancelled ? { ok: false, cancelled: true, results: [], fileErrors: [] } : result
  } catch (err) {
    return { ok: false, error: (err as Error).message, results: [], fileErrors: [] }
  } finally {
    running.delete(root)
    work.cleanup()
  }
}

export function stopTests(root: string): void {
  const r = running.get(root)
  if (!r) return
  r.cancelled = true
  if (r.child) killTree(r.child)
}

export function stopAllTests(): void {
  for (const r of running.values()) {
    r.cancelled = true
    if (r.child) killTree(r.child)
  }
}

// ---------------------------------------------------------------------------
// Parsers and helpers, re-exported for the unit tests (and earlier callers).

export { escapeRegex, LiveOutput, relFile, RESULT_MARK, toWslPath } from './tests/core'
export { findCli, parseJestListing, parseJestReport, parsePlaywrightReport, parseVitestList, parseVitestReport } from './tests/js'
export { findPython, pytestCase } from './tests/pytest'

/** Command-line arguments of a JavaScript / pytest run (after the program). */
export function runArgs(framework: TestFramework, req: TestRunRequest, files: RunFiles): string[] {
  if (framework === 'pytest') return pytestRunArgs(req)
  return jsRunArgs(framework as 'vitest' | 'jest' | 'playwright', req, files)
}

/** A live reporter / pytest plugin line as a TestResult. */
export function liveResult(framework: TestFramework, dir: string, l: LiveLine): TestResult {
  return framework === 'pytest' ? pytestResult(l) : jsLiveResult(framework as 'vitest' | 'jest' | 'playwright', dir, l)
}
