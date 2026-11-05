import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { WebContents } from 'electron'
import type { TestCase, TestFramework, TestProject, TestResult, TestRunRequest, TestRunResult } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { which } from './profiles'
// Helper scripts run by the project's own Node.js / Python (written to a temp folder at run time:
// an external process cannot read files inside the app's archive, and WSL reaches it via /mnt).
import VITEST_LIST from './test-helpers/vitest-list.mjs?raw'
import VITEST_REPORTER from './test-helpers/vitest-reporter.mjs?raw'
import JEST_REPORTER from './test-helpers/jest-reporter.cjs?raw'
import PLAYWRIGHT_REPORTER from './test-helpers/playwright-reporter.cjs?raw'
import PYTEST_PLUGIN from './test-helpers/vci_pytest.py?raw'

/**
 * Tests panel backend: finds test frameworks in a project (config files, also in
 * monorepo sub-folders), lists their tests, and runs them, streaming the console
 * output and each test's result as soon as it finishes (small reporters / a
 * pytest plugin print marked lines). JavaScript frameworks run from the
 * project's node_modules, pytest with the project's virtualenv (or Python on
 * PATH); WSL projects run inside their distribution.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage', 'target', '.next', '.nuxt', '.turbo', '.cache',
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.pytest_cache', 'site-packages', 'test-results', 'playwright-report',
  'fixtures', '__fixtures__'
])
const MAX_DEPTH = 4

const CONFIG_FILES: Partial<Record<TestFramework, RegExp>> = {
  vitest: /^vitest\.config\.[cm]?[jt]s$/,
  jest: /^jest\.config\.([cm]?[jt]s|json)$/,
  playwright: /^playwright\.config\.[cm]?[jt]s$/
}

/** npm packages providing each JavaScript framework's CLI, in order of preference, and the bin name. */
const CLI: Record<Exclude<TestFramework, 'pytest'>, { packages: string[]; bin: string }> = {
  vitest: { packages: ['vitest'], bin: 'vitest' },
  jest: { packages: ['jest'], bin: 'jest' },
  playwright: { packages: ['@playwright/test', 'playwright'], bin: 'playwright' }
}

const LIST_TIMEOUT = 180_000

/** Prefix of the lines printed by the live reporters (see test-helpers/). */
export const RESULT_MARK = '@@vibe-coding-ide:test '

// ---------------------------------------------------------------------------
// Detection

const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
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

/** pytest configuration in one of its config files. */
function hasPytestConfig(dir: string, names: Set<string>): boolean {
  if (names.has('pytest.ini')) return true
  if (names.has('pyproject.toml') && /^\[tool\.pytest/m.test(readText(join(dir, 'pyproject.toml')))) return true
  if (names.has('setup.cfg') && /^\[tool:pytest\]/m.test(readText(join(dir, 'setup.cfg')))) return true
  if (names.has('tox.ini') && /^\[pytest\]/m.test(readText(join(dir, 'tox.ini')))) return true
  return false
}

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
    const has = (f: TestFramework): boolean => [...names].some((n) => CONFIG_FILES[f]!.test(n))
    const pkg = names.has('package.json') ? packageJson(join(dir, 'package.json')) : undefined
    // Vitest and Jest also run without a config file: a package whose scripts call them
    // (Jest: or a "jest" section in package.json).
    if (has('vitest') || (pkg && scriptsMention(pkg, 'vitest'))) found.push({ framework: 'vitest', dir, relDir })
    if (has('jest') || (pkg && (pkg.jest !== undefined || scriptsMention(pkg, 'jest')))) found.push({ framework: 'jest', dir, relDir })
    if (has('playwright')) found.push({ framework: 'playwright', dir, relDir })
    if (hasPytestConfig(dir, names)) found.push({ framework: 'pytest', dir, relDir })
    if (depth >= MAX_DEPTH) return
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return found
}

/** The framework's CLI script inside node_modules, looking in the folder and its parents (hoisted installs). */
export function findCli(dir: string, framework: Exclude<TestFramework, 'pytest'>): string | undefined {
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

/** Exists, including WSL symlinks (a venv's bin/python points to a Linux path Windows cannot follow). */
const present = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Python for a pytest project: a virtualenv in the folder or a parent (.venv, venv, env),
 * otherwise Python on PATH. Returns the program and arguments, as the test process sees them.
 */
export function findPython(dir: string): { program: string; args: string[]; venv?: string } {
  const wsl = isWslDir(dir)
  const posixVenv = wsl || process.platform !== 'win32'
  for (let d = dir; ; d = dirname(d)) {
    for (const name of ['.venv', 'venv', 'env']) {
      const py = posixVenv ? join(d, name, 'bin', 'python') : join(d, name, 'Scripts', 'python.exe')
      if (present(py)) return { program: childPath(dir, py), args: [], venv: join(d, name) }
    }
    if (dirname(d) === d || (wsl && parseWslPath(dirname(d))?.path === '/')) break
  }
  if (wsl) return { program: 'python3', args: [] }
  if (process.platform === 'win32') {
    const python = which('python')
    if (python && !/WindowsApps/i.test(python)) return { program: python, args: [] }
    const py = which('py')
    if (py) return { program: py, args: ['-3'] }
    return { program: python ?? 'python', args: [] }
  }
  return { program: which('python3') ?? which('python') ?? 'python3', args: [] }
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

/** Test id: `<file>::<suite > … > name>[::<Playwright project>]` (same for listings, reports and live results). */
const testId = (file: string, titles: string[], projectName?: string): string =>
  `${file}::${titles.join(' > ')}${projectName ? `::${projectName}` : ''}`

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
interface JestReport {
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
interface PwReport {
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

/** A pytest node id (`path/test_x.py::Class::test_name[param]`) as a test of the panel. */
export function pytestCase(nodeid: string, line?: number): TestCase {
  const [file, ...parts] = nodeid.split('::')
  return { id: testId(file, parts), file, suite: parts.slice(0, -1), name: parts[parts.length - 1] ?? file, line }
}

/** A line printed by a live reporter / the pytest plugin (test-helpers/). */
export interface LiveLine {
  file?: string
  /** Vitest: "suite > test". */
  name?: string
  /** Jest / Playwright: describe titles and the test title. */
  titles?: string[]
  projectName?: string
  /** pytest: node id of a result. */
  nodeid?: string
  /** pytest --collect-only: a collected test. */
  collected?: string
  line?: number
  /** pytest: a file that failed to import. */
  collectError?: string
  status?: TestResult['status']
  duration?: number
  message?: string
}

/** A live result line as a TestResult with the same id as the listing / final report. */
export function liveResult(framework: TestFramework, dir: string, l: LiveLine): TestResult {
  const status = l.status ?? 'failed'
  if (framework === 'pytest') return { id: pytestCase(l.nodeid ?? '').id, status, duration: l.duration, message: l.message ?? undefined }
  const file = relFile(dir, l.file ?? '')
  const titles = framework === 'vitest' ? (l.name ?? '').split(' > ') : (l.titles ?? [])
  return { id: testId(file, titles, l.projectName), status, duration: l.duration, message: l.message ?? undefined }
}

/**
 * Separates the marked lines from the console output. Output is passed on line
 * by line (a partial line waits for its end, or for `flush`).
 */
export class LiveOutput {
  private pending = ''
  constructor(
    private onText: (text: string) => void,
    private onLine: (line: LiveLine) => void
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
        this.onLine(JSON.parse(line.slice(at + RESULT_MARK.length)) as LiveLine)
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

/** Files a run needs (as the test process sees them). */
export interface RunFiles {
  report: string
  live: string
}

/** Command-line arguments of a run, after the program (relative to the test project folder). */
export function runArgs(framework: TestFramework, req: TestRunRequest, files: RunFiles): string[] {
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
    case 'pytest': {
      // A pytest node id: file, then classes and the test, separated by ::
      const target = req.file ? [req.titlePath?.length ? [req.file, ...req.titlePath].join('::') : req.file] : []
      return ['-m', 'pytest', '-p', 'vci_pytest', '--rootdir=.', ...target]
    }
  }
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

/** A program run in the test project folder (program and args already as the child sees them). */
function programCommand(dir: string, program: string, args: string[], env: Record<string, string>): Command {
  const wsl = isWslDir(dir) ? parseWslPath(dir) : undefined
  if (wsl) {
    const wslExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
    // Login + interactive shell so tools installed by nvm / fnm / pyenv (set up in .bashrc) are on PATH.
    return {
      file: wslExe,
      args: ['-d', wsl.distro, '--cd', wsl.path, '--exec', 'bash', '-lic', 'exec "$@"', 'run', program, ...args],
      env: { ...env, WSLENV: [process.env.WSLENV, ...Object.keys(env)].filter(Boolean).join(':') }
    }
  }
  return { file: program, args, env }
}

/** `node <script> <args>` in the test project folder. */
function nodeCommand(dir: string, script: string, args: string[], env: Record<string, string>): Command {
  if (isWslDir(dir)) return programCommand(dir, 'node', [script, ...args], env)
  const node = which('node')
  // Without Node.js on PATH, Electron itself can run the CLI as plain Node.
  return node ? { file: node, args: [script, ...args], env } : { file: process.execPath, args: [script, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
}

/** Temp folder for a run: report file and helper scripts, shared with the child process. */
function workDir(): { dir: string; path: (name: string) => string; write: (name: string, content: string) => string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-tests-'))
  return {
    dir: tmp,
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

/** Run a listing command: its output, marked lines and report file. */
async function runQuiet(dir: string, cmd: Command, reportFile?: string): Promise<{ json?: unknown; lines: LiveLine[]; output: string; code: number | null }> {
  let output = ''
  const lines: LiveLine[] = []
  const live = new LiveOutput((t) => (output += t), (l) => lines.push(l))
  const { done } = exec({ ...cmd, env: { ...cmd.env, FORCE_COLOR: '0' } }, dir, (t) => live.push(t), (t) => (output += t), LIST_TIMEOUT)
  const code = await done
  live.flush()
  return { json: reportFile ? readJson<unknown>(reportFile) : undefined, lines, output, code }
}

/** pytest's environment: the plugin's folder on PYTHONPATH, unbuffered output for live results. */
function pytestEnv(dir: string, pluginDir: string): Record<string, string> {
  const sep = isWslDir(dir) || process.platform !== 'win32' ? ':' : ';'
  const extra = process.env.PYTHONPATH && !isWslDir(dir) ? `${sep}${process.env.PYTHONPATH}` : ''
  return { PYTHONPATH: childPath(dir, pluginDir) + extra, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
}

async function listTests(framework: TestFramework, dir: string): Promise<{ tests: TestCase[]; error?: string }> {
  const work = workDir()
  const report = work.path('list.json')
  const c = (p: string): string => childPath(dir, p)
  try {
    if (framework === 'pytest') {
      work.write('vci_pytest.py', PYTEST_PLUGIN)
      const python = findPython(dir)
      const cmd = programCommand(dir, python.program, [...python.args, '-m', 'pytest', '--collect-only', '-q', '-p', 'vci_pytest', '--rootdir=.'], pytestEnv(dir, work.dir))
      const r = await runQuiet(dir, cmd)
      const tests = r.lines.filter((l) => l.collected).map((l) => pytestCase(l.collected!, l.line ?? undefined))
      const errors = r.lines.filter((l) => l.collectError !== undefined).map((l) => `${l.collectError}\n${l.message ?? ''}`)
      // Exit code 5: no tests collected (not an error).
      if (tests.length === 0 && r.code !== 0 && r.code !== 5 && errors.length === 0) return { tests, error: tail(r.output) || `pytest failed (exit code ${r.code}).` }
      return { tests, error: errors.length ? errors.join('\n\n') : undefined }
    }

    const cli = findCli(dir, framework)
    if (!cli) return { tests: [], error: `${framework} is not installed (run your package manager's install first).` }

    if (framework === 'vitest') {
      // The helper also lists skipped tests; older Vitest versions without its Node API use `vitest list`.
      const helper = work.write('vitest-list.mjs', VITEST_LIST)
      const vitestNode = join(dirname(cli), 'dist', 'node.js')
      const viaHelper = await runQuiet(dir, nodeCommand(dir, c(helper), [c(vitestNode), c(report)], {}), report)
      const listed = viaHelper.json as { tests: VitestListed[]; errors: string[] } | undefined
      if (listed) return { tests: parseVitestList(dir, listed.tests), error: listed.errors.length ? listed.errors.join('\n\n') : undefined }
      const viaCli = await runQuiet(dir, nodeCommand(dir, c(cli), ['list', `--json=${c(report)}`], {}), report)
      if (viaCli.json === undefined) return { tests: [], error: tail(viaCli.output || viaHelper.output) || `Listing tests failed (exit code ${viaCli.code}).` }
      return { tests: parseVitestList(dir, viaCli.json as VitestListed[]) }
    }

    if (framework === 'jest') {
      // Jest has no listing command: run with a name pattern that matches nothing, so every test is
      // reported (as pending) without running its body.
      const args = ['--ci', '--json', `--outputFile=${c(report)}`, '--testLocationInResults', '--passWithNoTests', '--testNamePattern=(?!)']
      const r = await runQuiet(dir, nodeCommand(dir, c(cli), args, {}), report)
      if (r.json === undefined) return { tests: [], error: tail(r.output) || `Listing tests failed (exit code ${r.code}).` }
      const listed = parseJestListing(dir, r.json as JestReport)
      return { tests: listed.tests, error: listed.fileErrors.length ? listed.fileErrors.map((e) => `${e.file}\n${e.message}`).join('\n\n') : undefined }
    }

    const r = await runQuiet(dir, nodeCommand(dir, c(cli), ['test', '--list', '--reporter=json'], { PLAYWRIGHT_JSON_OUTPUT_FILE: c(report) }), report)
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

const LIVE_REPORTER: Record<Exclude<TestFramework, 'pytest'>, { name: string; content: string }> = {
  vitest: { name: 'live-reporter.mjs', content: VITEST_REPORTER },
  jest: { name: 'live-reporter.cjs', content: JEST_REPORTER },
  playwright: { name: 'live-reporter.cjs', content: PLAYWRIGHT_REPORTER }
}

export async function runTests(root: string, req: TestRunRequest, sender: WebContents): Promise<TestRunResult> {
  if (running.has(root)) return { ok: false, error: 'Tests are already running in this project.', results: [], fileErrors: [] }
  const project = detectTestProjects(root).find((p) => `${p.framework}:${p.relDir}` === req.projectId)
  if (!project) return { ok: false, error: 'Test project not found.', results: [], fileErrors: [] }
  const { framework, dir } = project
  const cli = framework === 'pytest' ? undefined : findCli(dir, framework)
  if (framework !== 'pytest' && !cli) return { ok: false, error: `${framework} is not installed.`, results: [], fileErrors: [] }

  const send = (text: string): void => {
    if (!sender.isDestroyed()) sender.send('tests:output', root, text)
  }
  // Results as they arrive (pytest has no report file: these are its results).
  const liveResults = new Map<string, TestResult>()
  const fileErrors: TestRunResult['fileErrors'] = []
  const live = new LiveOutput(send, (line) => {
    if (line.collectError !== undefined) {
      fileErrors.push({ file: line.collectError, message: line.message ?? '' })
      return
    }
    const result = liveResult(framework, dir, line)
    liveResults.set(result.id, result)
    if (!sender.isDestroyed()) sender.send('tests:progress', root, req.projectId, result)
  })
  const work = workDir()
  try {
    const c = (p: string): string => childPath(dir, p)
    let cmd: Command
    let args: string[]
    if (framework === 'pytest') {
      work.write('vci_pytest.py', PYTEST_PLUGIN)
      const python = findPython(dir)
      args = runArgs('pytest', req, { report: '', live: '' })
      cmd = programCommand(dir, python.program, [...python.args, ...args], pytestEnv(dir, work.dir))
    } else {
      const reporter = LIVE_REPORTER[framework]
      const files = { report: c(work.path('report.json')), live: c(work.write(reporter.name, reporter.content)) }
      args = runArgs(framework, req, files)
      const env: Record<string, string> = framework === 'playwright' ? { PLAYWRIGHT_JSON_OUTPUT_FILE: files.report } : {}
      cmd = nodeCommand(dir, c(cli!), args, env)
      // Shown command: without the app's own report / reporter arguments.
      args = args
        .filter((a) => !a.includes(files.report) && a !== `--reporter=${files.live}` && a !== `--reporters=${files.live}`)
        .map((a) => a.replace(`,${files.live}`, ''))
    }
    send(`$ ${framework} ${args.filter((a) => a !== '-p' && a !== 'vci_pytest').join(' ')}\n`)
    const { done, child } = exec(cmd, dir, (t) => live.push(t), send)
    const entry = { child, cancelled: false }
    running.set(root, entry)
    const code = await done
    live.flush()
    running.delete(root)
    send(`\n[exit code ${code ?? '?'}]\n`)
    if (entry.cancelled) return { ok: false, cancelled: true, results: [], fileErrors: [] }

    if (framework === 'pytest') {
      // 0 all passed, 1 some failed, 5 nothing collected; anything else: pytest itself failed.
      const ok = code === 0 || code === 1 || code === 5
      return { ok, error: ok ? undefined : 'pytest failed: see the output.', results: [...liveResults.values()], fileErrors }
    }
    const json = readJson<unknown>(work.path('report.json'))
    if (json === undefined) return { ok: false, error: 'The test run produced no report: see the output.', results: [...liveResults.values()], fileErrors }
    if (framework === 'vitest' || framework === 'jest') return { ok: true, ...parseJestReport(dir, json as JestReport) }
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
