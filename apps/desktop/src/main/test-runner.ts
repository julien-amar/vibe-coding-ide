import { readdirSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { WebContents } from 'electron'
import type { TestFramework, TestProject, TestResult, TestRunRequest, TestRunResult } from '@shared/types'
import { cargoAdapter } from './tests/cargo'
import { exec, killTree, SKIP_DIRS, workDir, type Adapter, type LiveLine, type RunContext } from './tests/core'
import { dotnetAdapter } from './tests/dotnet'
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

/** Folders (up to a few levels deep) with a test framework. */
export function detectTestProjects(root: string): { framework: TestFramework; dir: string; relDir: string }[] {
  const found: { framework: TestFramework; dir: string; relDir: string }[] = []
  const walk = (dir: string, depth: number, covered: ReadonlySet<TestFramework>): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
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
      found.push({ framework: a.framework, dir, relDir })
      if (a.ownsSubfolders) next.add(a.framework)
    }
    if (depth >= MAX_DEPTH) return
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1, next)
    }
  }
  walk(root, 0, new Set())
  return found
}

export async function discoverTests(root: string): Promise<TestProject[]> {
  const projects = await Promise.all(
    detectTestProjects(root).map(async ({ framework, dir, relDir }) => {
      const work = workDir()
      try {
        const { tests, error, projectFile } = await adapterFor(framework).list(dir, work)
        return { id: `${framework}:${relDir}`, framework, dir, relDir, tests, error, ...(projectFile ? { projectFile } : {}) }
      } catch (err) {
        return { id: `${framework}:${relDir}`, framework, dir, relDir, tests: [], error: (err as Error).message }
      } finally {
        work.cleanup()
      }
    })
  )
  // A project without any test (and without a listing error to show) is not worth a node of the tree.
  return projects.filter((p) => p.tests.length > 0 || p.error)
}

/** Runs in progress, one per project root. */
const running = new Map<string, { child?: ChildProcess; cancelled: boolean }>()

export async function runTests(root: string, req: TestRunRequest, sender: WebContents): Promise<TestRunResult> {
  if (running.has(root)) return { ok: false, error: 'Tests are already running in this project.', results: [], fileErrors: [] }
  const project = detectTestProjects(root).find((p) => `${p.framework}:${p.relDir}` === req.projectId)
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
