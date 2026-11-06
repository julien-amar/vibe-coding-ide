import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative } from 'node:path'
import type { TestCase, TestFramework, TestResult, TestRunRequest, TestRunResult } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { launchSpec, which } from '../profiles'
import { wslenvWith, wslExe, wslLogin } from '../wsl'

/**
 * Shared pieces of the Tests panel backend: the adapter interface every
 * framework implements, process helpers (local and inside WSL), and parsers.
 */

/** A test project's runs: output, live results, and processes the Stop button can end. */
export interface RunContext {
  /** Console output for the panel. */
  send(text: string): void
  /** A test's result as soon as it is known (sent to the panel; may be sent again, e.g. with its message). */
  result(r: TestResult): void
  /** Run a process in the test project folder; Stop kills it. Resolves with its exit code. */
  exec(cmd: Command, out?: { stdout?: (text: string) => void; stderr?: (text: string) => void }): Promise<number | null>
  /** The user pressed Stop. */
  cancelled(): boolean
  work: WorkDir
}

export interface Adapter {
  framework: TestFramework
  /** Is `dir` (holding the files `names`) a test project of this framework? */
  detect(dir: string, names: Set<string>): boolean
  /** One build covers the sub-folders (Cargo, Maven, Gradle, .NET project): do not look further down. */
  ownsSubfolders?: boolean
  list(dir: string, work: WorkDir): Promise<{ tests: TestCase[]; error?: string }>
  run(dir: string, req: TestRunRequest, ctx: RunContext): Promise<Omit<TestRunResult, 'cancelled'>>
}

export const LIST_TIMEOUT = 300_000

/** Prefix of the lines printed by the live reporters (see test-helpers/). */
export const RESULT_MARK = '@@vibe-coding-ide:test '

// ---------------------------------------------------------------------------
// Files

export const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Exists, including WSL symlinks (a venv's bin/python points to a Linux path Windows cannot follow). */
export const present = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Folders never searched for tests or sources. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage', 'target', 'bin', 'obj', 'vendor', '.next', '.nuxt', '.turbo',
  '.cache', '.gradle', '.venv', 'venv', 'env', '__pycache__', '.tox', '.pytest_cache', 'site-packages', 'test-results',
  'playwright-report', 'fixtures', '__fixtures__'
])

/** Files under `dir` with one of `exts` (skipping SKIP_DIRS), relative paths with forward slashes. */
export function findFiles(dir: string, exts: string[], maxDepth = 12): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), depth + 1)
      } else if (exts.includes(extname(e.name))) out.push(relative(dir, join(d, e.name)).replace(/\\/g, '/'))
    }
  }
  walk(dir, 0)
  return out
}

/** Line (1-based) of the first match of `re` in `text`, or undefined. */
export function lineOf(text: string, re: RegExp): number | undefined {
  // CRLF files (a Windows checkout): in multiline mode `^` also matches between \r and \n, so a
  // pattern starting with \s* would begin on the line before. Count on LF-only text.
  const lf = text.replace(/\r\n?/g, '\n')
  const m = re.exec(lf)
  return m ? lf.slice(0, m.index + (m[0].length - m[0].trimStart().length)).split('\n').length : undefined
}

// ---------------------------------------------------------------------------
// Ids and paths

/** Path of a reported test file relative to the test project folder (forward slashes). */
export function relFile(dir: string, file: string): string {
  const base = (parseWslPath(dir)?.path ?? dir).replace(/\\/g, '/').replace(/\/+$/, '')
  const f = file.replace(/\\/g, '/')
  const caseless = /^[a-z]:\//i.test(base)
  const starts = caseless ? f.toLowerCase().startsWith(base.toLowerCase() + '/') : f.startsWith(base + '/')
  return starts ? f.slice(base.length + 1) : f
}

/** Test id: `<file>::<suite > … > name>[::<Playwright project>]` (same for listings, reports and live results). */
export const testId = (file: string, titles: string[], projectName?: string): string =>
  `${file}::${titles.join(' > ')}${projectName ? `::${projectName}` : ''}`

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Last lines of a command's output, for error messages. */
export const tail = (s: string, n = 30): string => s.trim().split(/\r?\n/).slice(-n).join('\n')

/** Windows path as seen from WSL (/mnt/c/...). */
export const toWslPath = (p: string): string => p.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')

export const isWslDir = (dir: string): boolean => process.platform === 'win32' && parseWslPath(dir) !== undefined

/** A path as the test process sees it: inside WSL, \\wsl.localhost paths and C:\ paths become Linux paths. */
export function childPath(dir: string, p: string): string {
  if (!isWslDir(dir)) return p
  return parseWslPath(p)?.path ?? toWslPath(p)
}

/** A path printed by the test process (Linux path in WSL) as a Windows / UNC path. */
export function hostPath(dir: string, p: string): string {
  const wsl = isWslDir(dir) ? parseWslPath(dir) : undefined
  if (!wsl || !p.startsWith('/')) return p
  const prefix = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/][^\\/]+/i.exec(dir)![0]
  return prefix + p.replace(/\//g, '\\')
}

/** Search `name` in the folder and its parents (e.g. a wrapper script or a virtualenv). */
export function findUp(dir: string, names: string[]): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    for (const n of names) if (present(join(d, n))) return join(d, n)
    if (dirname(d) === d || parseWslPath(dirname(d))?.path === '/') return undefined
  }
}

// ---------------------------------------------------------------------------
// Processes

export interface Command {
  file: string
  args: string[]
  env: Record<string, string>
}

/**
 * A program run in the test project folder (program and args as the child sees them). Inside
 * WSL through a login shell, so tools set up in .bashrc / .profile (nvm, pyenv, cargo, go…) are found.
 */
export function programCommand(dir: string, program: string, args: string[], env: Record<string, string> = {}): Command {
  const wsl = isWslDir(dir) ? parseWslPath(dir) : undefined
  if (wsl) {
    return {
      file: wslExe(),
      args: wslLogin(wsl.distro, program, args, { cd: wsl.path, interactive: true }),
      env: { ...env, WSLENV: wslenvWith(...Object.keys(env)) }
    }
  }
  // Windows .cmd / .bat scripts (mvn, gradlew.bat…) run through cmd.exe.
  const spec = launchSpec(program, args)
  return { file: spec.command, args: spec.args, env }
}

/** A tool for a local or WSL project: the full path when found on PATH (or in `extra` places), else its name. */
export function tool(dir: string, name: string, extra: string[] = []): string {
  if (isWslDir(dir)) return name
  return which(name) ?? extra.find((p) => existsSync(p)) ?? name
}

/** `node <script> <args>` in the test project folder. */
export function nodeCommand(dir: string, script: string, args: string[], env: Record<string, string> = {}): Command {
  if (isWslDir(dir)) return programCommand(dir, 'node', [script, ...args], env)
  const node = which('node')
  // Without Node.js on PATH, Electron itself can run the CLI as plain Node.
  return node ? { file: node, args: [script, ...args], env } : { file: process.execPath, args: [script, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
}

export interface WorkDir {
  dir: string
  path(name: string): string
  write(name: string, content: string): string
  cleanup(): void
}

/** Temp folder for a listing / run: reports and helper scripts, shared with the child process. */
export function workDir(): WorkDir {
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

export function killTree(child: ChildProcess): void {
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

export function exec(
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
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    child.on('error', (err) => {
      onStderr(`\n${err.message}\n`)
      finish(null)
    })
    child.on('close', finish)
    // A build tool can leave a background process (the Gradle daemon) holding the output pipes:
    // 'close' would never come. Once the process itself has exited, wait briefly for its last
    // output, then finish.
    child.on('exit', (code) => setTimeout(() => finish(code), 1500))
  })
  return { done, child }
}

/** Run a listing command: its output (stdout / both) and exit code. */
export async function runQuiet(dir: string, cmd: Command, onStdout?: (t: string) => void): Promise<{ output: string; stdout: string; code: number | null }> {
  let output = ''
  let stdout = ''
  const { done } = exec(
    { ...cmd, env: { ...cmd.env, FORCE_COLOR: '0', NO_COLOR: '1' } },
    dir,
    (t) => {
      stdout += t
      output += t
      onStdout?.(t)
    },
    (t) => (output += t),
    LIST_TIMEOUT
  )
  const code = await done
  return { output, stdout, code }
}

/** Calls `onLine` for each complete line of a stream (a partial line waits for its end, or `flush`). */
export class LineReader {
  private pending = ''
  constructor(private onLine: (line: string) => void) {}

  push(chunk: string): void {
    const text = this.pending + chunk
    const lines = text.split(/\r?\n/)
    this.pending = lines.pop() ?? ''
    for (const l of lines) this.onLine(l)
  }

  flush(): void {
    if (this.pending) this.onLine(this.pending)
    this.pending = ''
  }
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

// ---------------------------------------------------------------------------
// JUnit XML (Maven Surefire, Gradle; the shape most tools can write)

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')

/** Attributes of an XML start tag. */
export function xmlAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeXml(m[3] ?? m[4] ?? '')
  return out
}

/** Text content of an element: tags removed, entities decoded, CDATA sections kept as is. */
export function xmlText(inner: string): string {
  const plain = (s: string): string => decodeXml(s.replace(/<[^>]+>/g, ''))
  let out = ''
  let last = 0
  for (const m of inner.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    out += plain(inner.slice(last, m.index)) + m[1]
    last = m.index + m[0].length
  }
  return out + plain(inner.slice(last))
}

export interface JUnitCase {
  classname: string
  name: string
  /** Seconds. */
  time?: number
  status: TestResult['status']
  message?: string
}

/** Test cases of a JUnit XML report. */
export function parseJUnitXml(xml: string): JUnitCase[] {
  const out: JUnitCase[] = []
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = xmlAttrs(m[1])
    const inner = m[3] ?? ''
    const fail = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(inner)
    const skipped = /<skipped\b/.test(inner)
    let message: string | undefined
    if (fail) {
      const fa = xmlAttrs(fail[2])
      const body = xmlText(fail[4] ?? '').trim()
      message = [fa.message && !body.includes(fa.message) ? fa.message : '', body].filter(Boolean).join('\n')
    }
    out.push({
      classname: a.classname ?? '',
      name: a.name ?? '',
      time: a.time ? Number(a.time) : undefined,
      status: fail ? 'failed' : skipped ? 'skipped' : 'passed',
      message
    })
  }
  return out
}
