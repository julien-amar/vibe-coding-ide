import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TestCase, TestResult, TestRunRequest, TestRunResult } from '@shared/types'
import VITEST_LIST from '../test-helpers/vitest-list.mjs?raw'
import VITEST_REPORTER from '../test-helpers/vitest-reporter.mjs?raw'
import JEST_REPORTER from '../test-helpers/jest-reporter.cjs?raw'
import PLAYWRIGHT_REPORTER from '../test-helpers/playwright-reporter.cjs?raw'
import {
  childPath,
  escapeRegex,
  LiveOutput,
  nodeCommand,
  readJson,
  relFile,
  runQuiet,
  tail,
  testId,
  type Adapter,
  type LiveLine,
  type WorkDir
} from './core'

/**
 * Vitest, Jest and Playwright: run from the project's node_modules with Node.js.
 * Small reporters (test-helpers/) print each result as soon as the test finishes.
 */

type JsFramework = 'vitest' | 'jest' | 'playwright'

/** npm packages providing each framework's CLI, in order of preference, and the bin name. */
const CLI: Record<JsFramework, { packages: string[]; bin: string }> = {
  vitest: { packages: ['vitest'], bin: 'vitest' },
  jest: { packages: ['jest'], bin: 'jest' },
  playwright: { packages: ['@playwright/test', 'playwright'], bin: 'playwright' }
}

const CONFIG: Record<JsFramework, RegExp> = {
  vitest: /^vitest\.config\.[cm]?[jt]s$/,
  jest: /^jest\.config\.([cm]?[jt]s|json)$/,
  playwright: /^playwright\.config\.[cm]?[jt]s$/
}

function packageJson(file: string): { scripts?: Record<string, string>; jest?: unknown } {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string>; jest?: unknown }
  } catch {
    return {}
  }
}

const scriptsMention = (pkg: { scripts?: Record<string, string> }, word: string): boolean =>
  Object.values(pkg.scripts ?? {}).some((s) => new RegExp(`(^|[\\s/])${word}(\\s|$)`).test(s))

/** The framework's CLI script inside node_modules, looking in the folder and its parents (hoisted installs). */
export function findCli(dir: string, framework: JsFramework): string | undefined {
  const { packages, bin } = CLI[framework]
  for (let d = dir; ; d = dirname(d)) {
    for (const pkg of packages) {
      const pkgJson = join(d, 'node_modules', pkg, 'package.json')
      if (existsSync(pkgJson)) {
        try {
          const meta = JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin?: string | Record<string, string> }
          const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[bin]
          if (rel) return join(d, 'node_modules', pkg, rel)
        } catch {
          /* try the next one */
        }
      }
    }
    if (dirname(d) === d) return undefined
  }
}

// ---------------------------------------------------------------------------
// Parsers

interface VitestListed {
  name: string
  file: string
  location?: { line: number }
}

/** `vitest list --json` / the list helper: [{ name: "suite > test", file, location? }] */
export function parseVitestList(dir: string, list: VitestListed[]): TestCase[] {
  return list.map((t) => {
    const parts = t.name.split(' > ')
    const file = relFile(dir, t.file)
    return { id: testId(file, parts), file, suite: parts.slice(0, -1), name: parts[parts.length - 1], line: t.location?.line }
  })
}

/** Jest's JSON (Vitest's JSON reporter writes the same format). */
export interface JestReport {
  testResults?: {
    name: string
    status: string
    message?: string
    assertionResults: {
      ancestorTitles: string[]
      title: string
      status: string
      duration?: number | null
      failureMessages?: string[]
      location?: { line: number } | null
    }[]
  }[]
}

/** Results of a Jest-format report (Vitest's and Jest's JSON reporters). */
export function parseJestReport(dir: string, report: JestReport): Pick<TestRunResult, 'results' | 'fileErrors'> {
  const results: TestResult[] = []
  const fileErrors: TestRunResult['fileErrors'] = []
  for (const f of report.testResults ?? []) {
    const file = relFile(dir, f.name)
    if (f.status === 'failed' && f.message && f.assertionResults.every((a) => a.status !== 'failed')) fileErrors.push({ file, message: f.message })
    for (const a of f.assertionResults) {
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped'
      results.push({
        id: testId(file, [...a.ancestorTitles, a.title]),
        status,
        duration: a.duration ?? undefined,
        message: a.failureMessages?.length ? a.failureMessages.join('\n\n') : undefined
      })
    }
  }
  return { results, fileErrors }
}

/** Kept under its first name for the Vitest-specific callers and tests. */
export const parseVitestReport = parseJestReport

/** Tests of a Jest report from a listing run (a name pattern matching nothing: every test is "pending"). */
export function parseJestListing(dir: string, report: JestReport): { tests: TestCase[]; fileErrors: TestRunResult['fileErrors'] } {
  const tests: TestCase[] = []
  for (const f of report.testResults ?? []) {
    const file = relFile(dir, f.name)
    for (const a of f.assertionResults) {
      tests.push({ id: testId(file, [...a.ancestorTitles, a.title]), file, suite: a.ancestorTitles, name: a.title, line: a.location?.line })
    }
  }
  return { tests, fileErrors: parseJestReport(dir, report).fileErrors }
}

interface PwSuite {
  title: string
  file: string
  line?: number
  specs?: {
    title: string
    file: string
    line: number
    tests: {
      projectName?: string
      status?: string
      results?: { status?: string; duration?: number; error?: { message?: string; stack?: string }; errors?: { message?: string; stack?: string }[] }[]
    }[]
  }[]
  suites?: PwSuite[]
}
export interface PwReport {
  config?: { rootDir?: string }
  suites?: PwSuite[]
  errors?: { message?: string; stack?: string }[]
}

/** Playwright's JSON reporter (also used by `--list`): tests and, after a run, their results. */
export function parsePlaywrightReport(dir: string, report: PwReport): { tests: TestCase[]; results: TestResult[]; fileErrors: TestRunResult['fileErrors'] } {
  const tests: TestCase[] = []
  const results: TestResult[] = []
  const rootDir = (report.config?.rootDir ?? '').replace(/\\/g, '/')
  const fileOf = (f: string): string => relFile(dir, rootDir ? `${rootDir}/${f}` : f)
  const visit = (s: PwSuite, titles: string[]): void => {
    for (const spec of s.specs ?? []) {
      const file = fileOf(spec.file)
      for (const t of spec.tests) {
        const projectName = t.projectName || undefined
        const id = testId(file, [...titles, spec.title], projectName)
        tests.push({ id, file, suite: titles, name: spec.title, line: spec.line, projectName })
        const runs = t.results ?? []
        if (runs.length === 0) continue
        const errors = runs.flatMap((r) => r.errors ?? (r.error ? [r.error] : []))
        results.push({
          id,
          status: t.status === 'skipped' ? 'skipped' : t.status === 'expected' || t.status === 'flaky' ? 'passed' : 'failed',
          duration: runs.reduce((n, r) => n + (r.duration ?? 0), 0),
          message: t.status === 'unexpected' && errors.length ? errors.map((e) => e.stack ?? e.message ?? '').join('\n\n') : undefined,
          flaky: t.status === 'flaky' || undefined
        })
      }
    }
    for (const child of s.suites ?? []) visit(child, [...titles, child.title])
  }
  // Top-level suites are the files (their title is the file name, not a describe()).
  for (const fileSuite of report.suites ?? []) visit(fileSuite, [])
  const fileErrors = (report.errors ?? []).map((e) => ({ file: '', message: e.stack ?? e.message ?? 'Error' }))
  return { tests, results, fileErrors }
}

/** A live reporter line as a TestResult with the same id as the listing / final report. */
export function jsLiveResult(framework: JsFramework, dir: string, l: LiveLine): TestResult {
  const file = relFile(dir, l.file ?? '')
  const titles = framework === 'vitest' ? (l.name ?? '').split(' > ') : (l.titles ?? [])
  return { id: testId(file, titles, l.projectName), status: l.status ?? 'failed', duration: l.duration, message: l.message ?? undefined }
}

/** Files a run needs (as the test process sees them). */
export interface RunFiles {
  report: string
  live: string
}

/** Command-line arguments of a run (after the CLI script), relative to the test project folder. */
export function jsRunArgs(framework: JsFramework, req: TestRunRequest, files: RunFiles): string[] {
  switch (framework) {
    case 'vitest': {
      const args = ['run']
      if (req.file) args.push(req.file)
      // -t matches "suite > test" names: the item itself and everything under it.
      if (req.titlePath?.length) args.push('-t', `^${escapeRegex(req.titlePath.join(' > '))}( > |$)`)
      return [...args, '--reporter=default', '--reporter=json', `--reporter=${files.live}`, `--outputFile.json=${files.report}`]
    }
    case 'jest': {
      const args = ['--ci', '--json', `--outputFile=${files.report}`, '--testLocationInResults', '--reporters=default', `--reporters=${files.live}`]
      if (req.file) args.push('--runTestsByPath', req.file)
      // Jest's -t matches the titles joined with spaces.
      if (req.titlePath?.length) args.push('-t', `^${escapeRegex(req.titlePath.join(' '))}( |$)`)
      return args
    }
    case 'playwright': {
      const args = ['test']
      // A test runs by file:line; a describe() block (no line known) by its titles (--grep matches
      // "file describe… test" joined with spaces).
      if (req.file) args.push(req.line && req.titlePath?.length ? `${req.file}:${req.line}` : req.file)
      if (req.titlePath?.length && !req.line) args.push('-g', escapeRegex(req.titlePath.join(' ')))
      return [...args, `--reporter=list,json,${files.live}`]
    }
  }
}

// ---------------------------------------------------------------------------
// Adapters

async function list(framework: JsFramework, dir: string, work: WorkDir): Promise<{ tests: TestCase[]; error?: string }> {
  const cli = findCli(dir, framework)
  if (!cli) return { tests: [], error: `${framework} is not installed (run your package manager's install first).` }
  const c = (p: string): string => childPath(dir, p)
  const report = work.path('list.json')

  if (framework === 'vitest') {
    // The helper also lists skipped tests; older Vitest versions without its Node API use `vitest list`.
    const helper = work.write('vitest-list.mjs', VITEST_LIST)
    const vitestNode = join(dirname(cli), 'dist', 'node.js')
    const viaHelper = await runQuiet(dir, nodeCommand(dir, c(helper), [c(vitestNode), c(report)]))
    const listed = readJson<{ tests: VitestListed[]; errors: string[] }>(report)
    if (listed) return { tests: parseVitestList(dir, listed.tests), error: listed.errors.length ? listed.errors.join('\n\n') : undefined }
    const viaCli = await runQuiet(dir, nodeCommand(dir, c(cli), ['list', `--json=${c(report)}`]))
    const json = readJson<VitestListed[]>(report)
    if (!json) return { tests: [], error: tail(viaCli.output || viaHelper.output) || `Listing tests failed (exit code ${viaCli.code}).` }
    return { tests: parseVitestList(dir, json) }
  }

  if (framework === 'jest') {
    // Jest has no listing command: run with a name pattern that matches nothing, so every test is
    // reported (as pending) without running its body.
    const args = ['--ci', '--json', `--outputFile=${c(report)}`, '--testLocationInResults', '--passWithNoTests', '--testNamePattern=(?!)']
    const r = await runQuiet(dir, nodeCommand(dir, c(cli), args))
    const json = readJson<JestReport>(report)
    if (!json) return { tests: [], error: tail(r.output) || `Listing tests failed (exit code ${r.code}).` }
    const listed = parseJestListing(dir, json)
    return { tests: listed.tests, error: listed.fileErrors.length ? listed.fileErrors.map((e) => `${e.file}\n${e.message}`).join('\n\n') : undefined }
  }

  const r = await runQuiet(dir, nodeCommand(dir, c(cli), ['test', '--list', '--reporter=json'], { PLAYWRIGHT_JSON_OUTPUT_FILE: c(report) }))
  const json = readJson<PwReport>(report)
  if (!json) return { tests: [], error: tail(r.output) || `Listing tests failed (exit code ${r.code}).` }
  const pw = parsePlaywrightReport(dir, json)
  return { tests: pw.tests, error: pw.fileErrors.length ? pw.fileErrors.map((e) => e.message).join('\n') : undefined }
}

const LIVE_REPORTER: Record<JsFramework, { name: string; content: string }> = {
  vitest: { name: 'live-reporter.mjs', content: VITEST_REPORTER },
  jest: { name: 'live-reporter.cjs', content: JEST_REPORTER },
  playwright: { name: 'live-reporter.cjs', content: PLAYWRIGHT_REPORTER }
}

function adapter(framework: JsFramework): Adapter {
  return {
    framework,
    detect(dir, names) {
      if ([...names].some((n) => CONFIG[framework].test(n))) return true
      if (framework === 'playwright' || !names.has('package.json')) return false
      // Vitest and Jest also run without a config file: a package whose scripts call them
      // (Jest: or a "jest" section in package.json).
      const pkg = packageJson(join(dir, 'package.json'))
      return scriptsMention(pkg, framework) || (framework === 'jest' && pkg.jest !== undefined)
    },
    list: (dir, work) => list(framework, dir, work),
    async run(dir, req, ctx) {
      const cli = findCli(dir, framework)
      if (!cli) return { ok: false, error: `${framework} is not installed.`, results: [], fileErrors: [] }
      const c = (p: string): string => childPath(dir, p)
      const reporter = LIVE_REPORTER[framework]
      const files = { report: c(ctx.work.path('report.json')), live: c(ctx.work.write(reporter.name, reporter.content)) }
      const args = jsRunArgs(framework, req, files)
      const env: Record<string, string> = framework === 'playwright' ? { PLAYWRIGHT_JSON_OUTPUT_FILE: files.report } : {}
      // Shown command: without the app's own report / reporter arguments.
      const shown = args
        .filter((a) => !a.includes(files.report) && a !== `--reporter=${files.live}` && a !== `--reporters=${files.live}`)
        .map((a) => a.replace(`,${files.live}`, ''))
      ctx.send(`$ ${framework} ${shown.join(' ')}\n`)
      const live = new LiveOutput(ctx.send, (line) => ctx.result(jsLiveResult(framework, dir, line)))
      await ctx.exec(nodeCommand(dir, c(cli), args, env), { stdout: (t) => live.push(t) })
      live.flush()
      if (ctx.cancelled()) return { ok: false, results: [], fileErrors: [] }
      const json = readJson<unknown>(ctx.work.path('report.json'))
      if (json === undefined) return { ok: false, error: 'The test run produced no report: see the output.', results: [], fileErrors: [] }
      if (framework === 'playwright') {
        const pw = parsePlaywrightReport(dir, json as PwReport)
        return { ok: true, results: pw.results, fileErrors: pw.fileErrors }
      }
      return { ok: true, ...parseJestReport(dir, json as JestReport) }
    }
  }
}

export const vitestAdapter = adapter('vitest')
export const jestAdapter = adapter('jest')
export const playwrightAdapter = adapter('playwright')
