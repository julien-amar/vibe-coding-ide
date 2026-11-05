import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { WebContents } from 'electron'
import type { TestCase, TestFramework, TestProject, TestResult, TestRunRequest, TestRunResult } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { which } from './profiles'
// Helper scripts run by the project's Node.js (written to a temp folder at run time: an external
// Node cannot read files inside the app's archive, and WSL reaches the temp folder via /mnt).
import VITEST_LIST from './test-helpers/vitest-list.mjs?raw'
import VITEST_REPORTER from './test-helpers/vitest-reporter.mjs?raw'
import PLAYWRIGHT_REPORTER from './test-helpers/playwright-reporter.cjs?raw'

/**
 * Tests panel backend: finds test frameworks in a project (config files, also in
 * monorepo sub-folders), lists their tests, and runs them with the framework's
 * JSON reporter plus a small live reporter (each result as soon as the test
 * finishes), streaming the console output. Frameworks run from the project's
 * node_modules (no global install needed); WSL projects run inside their distribution.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage', 'target', '.next', '.nuxt', '.turbo', '.cache',
  '.venv', 'venv', 'test-results', 'playwright-report', 'fixtures', '__fixtures__'
])
const MAX_DEPTH = 4

const CONFIG_FILES: Record<TestFramework, RegExp> = {
  vitest: /^vitest\.config\.[cm]?[jt]s$/,
  playwright: /^playwright\.config\.[cm]?[jt]s$/
}

/** npm packages providing each framework's CLI, in order of preference, and the bin name. */
const CLI: Record<TestFramework, { packages: string[]; bin: string }> = {
  vitest: { packages: ['vitest'], bin: 'vitest' },
  playwright: { packages: ['@playwright/test', 'playwright'], bin: 'playwright' }
}

const LIST_TIMEOUT = 180_000

/** Prefix of the lines printed by the live reporters (see test-helpers/). */
export const RESULT_MARK = '@@vibe-coding-ide:test '

// ---------------------------------------------------------------------------
// Detection

/** Folders (up to a few levels deep) with a test framework config. */
export function detectTestProjects(root: string): { framework: TestFramework; dir: string; relDir: string }[] {
  const found: { framework: TestFramework; dir: string; relDir: string }[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name))
    const relDir = relative(root, dir).replace(/\\/g, '/')
    let vitest = [...names].some((n) => CONFIG_FILES.vitest.test(n))
    // Vitest also runs without a config file: a package whose scripts call it.
    if (!vitest && names.has('package.json')) vitest = scriptsMention(join(dir, 'package.json'), 'vitest')
    if (vitest) found.push({ framework: 'vitest', dir, relDir })
    if ([...names].some((n) => CONFIG_FILES.playwright.test(n))) found.push({ framework: 'playwright', dir, relDir })
    if (depth >= MAX_DEPTH) return
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return found
}

function scriptsMention(pkgFile: string, word: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }
    return Object.values(pkg.scripts ?? {}).some((s) => new RegExp(`(^|[\\s/])${word}(\\s|$)`).test(s))
  } catch {
    return false
  }
}

/** The framework's CLI script inside node_modules, looking in the folder and its parents (hoisted installs). */
export function findCli(dir: string, framework: TestFramework): string | undefined {
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
// Parsers (pure, unit-tested)

/** Path of a reported test file relative to the test project folder (forward slashes). */
export function relFile(dir: string, file: string): string {
  const base = (parseWslPath(dir)?.path ?? dir).replace(/\\/g, '/').replace(/\/+$/, '')
  const f = file.replace(/\\/g, '/')
  const caseless = /^[a-z]:\//i.test(base)
  const starts = caseless ? f.toLowerCase().startsWith(base.toLowerCase() + '/') : f.startsWith(base + '/')
  return starts ? f.slice(base.length + 1) : f
}

const vitestId = (file: string, titles: string[]): string => `${file}::${titles.join(' > ')}`

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
    return { id: vitestId(file, parts), file, suite: parts.slice(0, -1), name: parts[parts.length - 1], line: t.location?.line }
  })
}

interface VitestReport {
  testResults?: {
    name: string
    status: string
    message?: string
    assertionResults: { ancestorTitles: string[]; title: string; status: string; duration?: number | null; failureMessages?: string[] }[]
  }[]
}

/** Vitest's JSON reporter (Jest-compatible format). */
export function parseVitestReport(dir: string, report: VitestReport): Pick<TestRunResult, 'results' | 'fileErrors'> {
  const results: TestResult[] = []
  const fileErrors: TestRunResult['fileErrors'] = []
  for (const f of report.testResults ?? []) {
    const file = relFile(dir, f.name)
    if (f.status === 'failed' && f.message) fileErrors.push({ file, message: f.message })
    for (const a of f.assertionResults) {
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped'
      results.push({
        id: vitestId(file, [...a.ancestorTitles, a.title]),
        status,
        duration: a.duration ?? undefined,
        message: a.failureMessages?.length ? a.failureMessages.join('\n\n') : undefined
      })
    }
  }
  return { results, fileErrors }
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
interface PwReport {
  config?: { rootDir?: string }
  suites?: PwSuite[]
  errors?: { message?: string; stack?: string }[]
}

const pwId = (file: string, titles: string[], projectName?: string): string =>
  `${file}::${titles.join(' > ')}${projectName ? `::${projectName}` : ''}`

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
        const id = pwId(file, [...titles, spec.title], projectName)
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

/** A line printed by a live reporter (test-helpers/*-reporter). */
interface LiveLine {
  file: string
  /** Vitest: "suite > test". */
  name?: string
  /** Playwright: describe titles and the test title. */
  titles?: string[]
  projectName?: string
  status: TestResult['status']
  duration?: number
  message?: string
}

/** A live reporter line as a TestResult with the same id as the listing / final report. */
export function liveResult(framework: TestFramework, dir: string, l: LiveLine): TestResult {
  const file = relFile(dir, l.file)
  const id = framework === 'vitest' ? vitestId(file, (l.name ?? '').split(' > ')) : pwId(file, l.titles ?? [], l.projectName)
  return { id, status: l.status, duration: l.duration, message: l.message }
}

/**
 * Separates the live reporters' marked lines from the console output. Output is
 * passed on line by line (a partial line waits for its end, or for `flush`).
 */
export class LiveOutput {
  private pending = ''
  constructor(
    private onText: (text: string) => void,
    private onResult: (line: LiveLine) => void
  ) {}

  push(chunk: string): void {
    const text = this.pending + chunk
    const end = text.lastIndexOf('\n')
    if (end < 0) {
      this.pending = text
      return
    }
    this.pending = text.slice(end + 1)
    let out = ''
    for (const line of text.slice(0, end + 1).split(/(?<=\n)/)) {
      const at = line.indexOf(RESULT_MARK)
      if (at < 0) {
        out += line
        continue
      }
      out += line.slice(0, at)
      try {
        this.onResult(JSON.parse(line.slice(at + RESULT_MARK.length)) as LiveLine)
      } catch {
        out += line.slice(at)
      }
    }
    if (out) this.onText(out)
  }

  flush(): void {
    if (this.pending) this.onText(this.pending)
    this.pending = ''
  }
}

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Command-line arguments of a run (relative to the test project folder). */
export function runArgs(framework: TestFramework, req: TestRunRequest, reportFile: string, liveReporter?: string): string[] {
  if (framework === 'vitest') {
    const args = ['run']
    if (req.file) args.push(req.file)
    // -t matches "suite > test" names: the item itself and everything under it.
    if (req.titlePath?.length) args.push('-t', `^${escapeRegex(req.titlePath.join(' > '))}( > |$)`)
    const live = liveReporter ? [`--reporter=${liveReporter}`] : []
    return [...args, '--reporter=default', '--reporter=json', ...live, `--outputFile.json=${reportFile}`]
  }
  const args = ['test']
  // A test runs by file:line; a describe() block (no line known) by its titles (--grep matches
  // "file describe… test" joined with spaces).
  if (req.file) args.push(req.line && req.titlePath?.length ? `${req.file}:${req.line}` : req.file)
  if (req.titlePath?.length && !req.line) args.push('-g', escapeRegex(req.titlePath.join(' ')))
  return [...args, `--reporter=list,json${liveReporter ? `,${liveReporter}` : ''}`]
}

// ---------------------------------------------------------------------------
// Processes

interface Command {
  file: string
  args: string[]
  env: Record<string, string>
}

/** Windows path as seen from WSL (/mnt/c/...). */
export const toWslPath = (p: string): string => p.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')

const isWslDir = (dir: string): boolean => process.platform === 'win32' && parseWslPath(dir) !== undefined

/** A path as the test process sees it: inside WSL, \\wsl.localhost paths and C:\ paths become Linux paths. */
function childPath(dir: string, p: string): string {
  if (!isWslDir(dir)) return p
  return parseWslPath(p)?.path ?? toWslPath(p)
}

/** `node <script> <args>` in the test project folder (script and args already as the child sees them). */
function nodeCommand(dir: string, script: string, args: string[], env: Record<string, string>): Command {
  const wsl = isWslDir(dir) ? parseWslPath(dir) : undefined
  if (wsl) {
    const wslExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
    // Login + interactive shell so node installed by nvm / fnm (set up in .bashrc) is on PATH.
    const names = Object.keys(env)
    return {
      file: wslExe,
      args: ['-d', wsl.distro, '--cd', wsl.path, '--exec', 'bash', '-lic', 'exec node "$@"', 'node', script, ...args],
      env: { ...env, WSLENV: [process.env.WSLENV, ...names].filter(Boolean).join(':') }
    }
  }
  const node = which('node')
  // Without Node.js on PATH, Electron itself can run the CLI as plain Node.
  return node ? { file: node, args: [script, ...args], env } : { file: process.execPath, args: [script, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
}

/** Temp folder for a run: report file and helper scripts, shared with the child process. */
function workDir(): { path: (name: string) => string; write: (name: string, content: string) => string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-tests-'))
  return {
    path: (name) => join(tmp, name),
    write: (name, content) => {
      writeFileSync(join(tmp, name), content)
      return join(tmp, name)
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true })
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

function exec(
  cmd: Command,
  cwd: string,
  onStdout: (text: string) => void,
  onStderr: (text: string) => void,
  timeout?: number
): { done: Promise<number | null>; child: ChildProcess } {
  const child = spawn(cmd.file, cmd.args, {
    cwd: parseWslPath(cwd) ? undefined : cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...cmd.env }
  })
  const timer = timeout ? setTimeout(() => killTree(child), timeout) : undefined
  child.stdout?.on('data', (b: Buffer) => onStdout(b.toString('utf8')))
  child.stderr?.on('data', (b: Buffer) => onStderr(b.toString('utf8')))
  const done = new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      onStderr(`\n${err.message}\n`)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  return { done, child }
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Last lines of a command's output, for error messages. */
const tail = (s: string, n = 30): string => s.trim().split(/\r?\n/).slice(-n).join('\n')

async function runForJson(dir: string, script: string, args: string[], env: Record<string, string>, reportFile: string): Promise<{ json?: unknown; output: string; code: number | null }> {
  let output = ''
  const collect = (t: string): void => {
    output += t
  }
  const { done } = exec(nodeCommand(dir, script, args, { ...env, FORCE_COLOR: '0' }), dir, collect, collect, LIST_TIMEOUT)
  const code = await done
  return { json: readJson<unknown>(reportFile), output, code }
}

async function listTests(framework: TestFramework, dir: string): Promise<{ tests: TestCase[]; error?: string }> {
  const cli = findCli(dir, framework)
  if (!cli) return { tests: [], error: `${framework} is not installed (run your package manager's install first).` }
  const work = workDir()
  const report = work.path('list.json')
  try {
    if (framework === 'vitest') {
      // The helper also lists skipped tests; older Vitest versions without its Node API use `vitest list`.
      const helper = work.write('vitest-list.mjs', VITEST_LIST)
      const vitestNode = join(dirname(cli), 'dist', 'node.js')
      const viaHelper = await runForJson(dir, childPath(dir, helper), [childPath(dir, vitestNode), childPath(dir, report)], {}, report)
      const listed = viaHelper.json as { tests: VitestListed[]; errors: string[] } | undefined
      if (listed) return { tests: parseVitestList(dir, listed.tests), error: listed.errors.length ? listed.errors.join('\n\n') : undefined }
      const viaCli = await runForJson(dir, childPath(dir, cli), ['list', `--json=${childPath(dir, report)}`], {}, report)
      if (viaCli.json === undefined) return { tests: [], error: tail(viaCli.output || viaHelper.output) || `Listing tests failed (exit code ${viaCli.code}).` }
      return { tests: parseVitestList(dir, viaCli.json as VitestListed[]) }
    }
    const r = await runForJson(dir, childPath(dir, cli), ['test', '--list', '--reporter=json'], { PLAYWRIGHT_JSON_OUTPUT_FILE: childPath(dir, report) }, report)
    if (r.json === undefined) return { tests: [], error: tail(r.output) || `Listing tests failed (exit code ${r.code}).` }
    const pw = parsePlaywrightReport(dir, r.json as PwReport)
    return { tests: pw.tests, error: pw.fileErrors.length ? pw.fileErrors.map((e) => e.message).join('\n') : undefined }
  } finally {
    work.cleanup()
  }
}

export async function discoverTests(root: string): Promise<TestProject[]> {
  const found = detectTestProjects(root)
  return Promise.all(
    found.map(async ({ framework, dir, relDir }) => {
      const { tests, error } = await listTests(framework, dir)
      return { id: `${framework}:${relDir}`, framework, dir, relDir, tests, error }
    })
  )
}

/** Runs in progress, one per project root. */
const running = new Map<string, { child: ChildProcess; cancelled: boolean }>()

export async function runTests(root: string, req: TestRunRequest, sender: WebContents): Promise<TestRunResult> {
  if (running.has(root)) return { ok: false, error: 'Tests are already running in this project.', results: [], fileErrors: [] }
  const project = detectTestProjects(root).find((p) => `${p.framework}:${p.relDir}` === req.projectId)
  if (!project) return { ok: false, error: 'Test project not found.', results: [], fileErrors: [] }
  const { framework, dir } = project
  const cli = findCli(dir, framework)
  if (!cli) return { ok: false, error: `${framework} is not installed.`, results: [], fileErrors: [] }

  const send = (text: string): void => {
    if (!sender.isDestroyed()) sender.send('tests:output', root, text)
  }
  const live = new LiveOutput(send, (line) => {
    if (!sender.isDestroyed()) sender.send('tests:progress', root, req.projectId, liveResult(framework, dir, line))
  })
  const work = workDir()
  try {
    const report = childPath(dir, work.path('report.json'))
    const reporter = childPath(dir, work.write(framework === 'vitest' ? 'live-reporter.mjs' : 'live-reporter.cjs', framework === 'vitest' ? VITEST_REPORTER : PLAYWRIGHT_REPORTER))
    const args = runArgs(framework, req, report, reporter)
    const env: Record<string, string> = framework === 'playwright' ? { PLAYWRIGHT_JSON_OUTPUT_FILE: report } : {}
    const shown = args.filter((a) => !a.startsWith('--outputFile') && a !== `--reporter=${reporter}`).map((a) => a.replace(`,${reporter}`, ''))
    send(`$ ${framework} ${shown.join(' ')}\n`)
    const { done, child } = exec(nodeCommand(dir, childPath(dir, cli), args, env), dir, (t) => live.push(t), send)
    const entry = { child, cancelled: false }
    running.set(root, entry)
    const code = await done
    live.flush()
    running.delete(root)
    send(`\n[exit code ${code ?? '?'}]\n`)
    if (entry.cancelled) return { ok: false, cancelled: true, results: [], fileErrors: [] }
    const json = readJson<unknown>(work.path('report.json'))
    if (json === undefined) return { ok: false, error: 'The test run produced no report: see the output.', results: [], fileErrors: [] }
    if (framework === 'vitest') return { ok: true, ...parseVitestReport(dir, json as VitestReport) }
    const pw = parsePlaywrightReport(dir, json as PwReport)
    return { ok: true, results: pw.results, fileErrors: pw.fileErrors }
  } finally {
    running.delete(root)
    work.cleanup()
  }
}

export function stopTests(root: string): void {
  const r = running.get(root)
  if (!r) return
  r.cancelled = true
  killTree(r.child)
}

export function stopAllTests(): void {
  for (const r of running.values()) killTree(r.child)
}
