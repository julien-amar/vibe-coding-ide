import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestCase, TestResult, TestRunRequest } from '@shared/types'
import {
  childPath,
  escapeRegex,
  findFiles,
  LineReader,
  lineOf,
  programCommand,
  readText,
  runQuiet,
  tail,
  testId,
  tool,
  xmlAttrs,
  xmlText,
  type Adapter
} from './core'

/**
 * .NET (xUnit, NUnit, MSTest through `dotnet test`): `--list-tests` lists the
 * tests by fully qualified name; a run prints "Passed / Failed / Skipped <name>"
 * per test (live results), and the TRX report gives the messages and stack traces.
 * Tests are grouped by class; their file and line come from a scan of the sources.
 */

const PROJECT = /\.(cs|fs|vb)proj$/
const TEST_PROJECT = /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true|\b(xunit|NUnit|MSTest)\b/i

const dotnetTool = (dir: string): string =>
  tool(dir, 'dotnet', ['C:\\Program Files\\dotnet\\dotnet.exe', '/usr/local/share/dotnet/dotnet', '/usr/share/dotnet/dotnet'])

/** The test project file in a folder. */
function projectFile(dir: string): string | undefined {
  try {
    return readdirSync(dir).find((f) => PROJECT.test(f) && TEST_PROJECT.test(readText(join(dir, f))))
  } catch {
    return undefined
  }
}

/**
 * A test's fully qualified name (`Ns.Class.Method`, `Ns.Class+Nested.Method(a: 1)`) as a test of
 * the panel: grouped by class, the method (with a data-driven case's arguments) as its name.
 */
export function dotnetCase(fullName: string): TestCase {
  const base = fullName.replace(/\(.*\)$/s, '')
  const dot = base.lastIndexOf('.')
  const cls = dot > 0 ? base.slice(0, dot) : '(tests)'
  const name = (dot > 0 ? base.slice(dot + 1) : base) + fullName.slice(base.length)
  return { id: testId(cls, [name]), file: cls, suite: [], name }
}

/** Names after "The following Tests are available:" (each test project prints its own list). */
export function parseDotnetList(out: string): string[] {
  const names: string[] = []
  let inList = false
  for (const line of out.split(/\r?\n/)) {
    if (/The following Tests are available:/.test(line)) inList = true
    else if (inList && /^\s{2,}\S/.test(line)) names.push(line.trim())
    else if (inList && line.trim()) inList = false
  }
  return names
}

/** "Passed Ns.Class.Method [12 ms]" lines of the console logger. */
export function parseDotnetLine(line: string): TestResult | undefined {
  const m = /^\s+(Passed|Failed|Skipped) (.+?) \[([^\]]*)\]\s*$/.exec(line)
  if (!m) return undefined
  return { id: dotnetCase(m[2]).id, status: m[1] === 'Passed' ? 'passed' : m[1] === 'Failed' ? 'failed' : 'skipped', duration: parseDuration(m[3]) }
}

/** "< 1 ms", "12 ms", "1 s", "1 m 3 s" → milliseconds. */
function parseDuration(s: string): number | undefined {
  if (/^<\s*1\s*ms$/.test(s.trim())) return 0
  let ms = 0
  let found = false
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/g)) {
    found = true
    ms += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h']
  }
  return found ? ms : undefined
}

/** Results of a TRX report (Visual Studio test results). */
export function parseTrx(xml: string): TestResult[] {
  // Test definitions give the class of runners whose result names are bare method names (MSTest).
  const classOf = new Map<string, string>()
  for (const m of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
    const id = xmlAttrs(m[1]).id
    const method = /<TestMethod\b([^>]*)\/?>/.exec(m[2])
    if (id && method) classOf.set(id, xmlAttrs(method[1]).className ?? '')
  }
  const results: TestResult[] = []
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const a = xmlAttrs(m[1])
    const inner = m[3] ?? ''
    let name = a.testName ?? ''
    const cls = classOf.get(a.testId ?? '')
    if (cls && !name.startsWith(cls + '.')) name = `${cls}.${name}`
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(inner)?.[1]
    const stack = /<StackTrace>([\s\S]*?)<\/StackTrace>/.exec(inner)?.[1]
    const outcome = a.outcome ?? ''
    results.push({
      id: dotnetCase(name).id,
      status: outcome === 'Passed' ? 'passed' : outcome === 'Failed' || outcome === 'Error' || outcome === 'Timeout' ? 'failed' : 'skipped',
      duration: a.duration ? parseTimeSpan(a.duration) : undefined,
      message:
        outcome === 'Passed'
          ? undefined
          : [message, stack]
              .filter(Boolean)
              .map((s) => xmlText(s!).trim())
              .join('\n') || undefined
    })
  }
  return results
}

/** "00:00:00.0123456" → milliseconds. */
const parseTimeSpan = (s: string): number | undefined => {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(s)
  return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : undefined
}

/** VSTest filter value: its special characters escaped. */
const filterValue = (s: string): string => s.replace(/[\\()&|=!~]/g, '\\$&')

/** `--filter` of a run: a class, or a test (all cases of a data-driven test). */
export function dotnetFilter(req: TestRunRequest): string[] {
  if (!req.file || req.file === '(tests)') return []
  if (!req.titlePath?.length) return ['--filter', `FullyQualifiedName~${filterValue(req.file + '.')}`]
  const method = req.titlePath[req.titlePath.length - 1].replace(/\(.*\)$/s, '')
  return ['--filter', `FullyQualifiedName=${filterValue(`${req.file}.${method}`)}`]
}

/** The source file and line of a test method: the class's file, else any file declaring the method. */
function locate(dir: string, files: string[], test: TestCase): { source?: string; line?: number } {
  const cls = test.file.split(/[.+]/).pop() ?? ''
  const method = test.name.replace(/\(.*\)$/s, '')
  const re = new RegExp(`\\b${escapeRegex(method)}\\s*\\(`)
  const declares = new RegExp(`\\b(class|record|module|type)\\s+${escapeRegex(cls)}\\b`)
  const ordered = [...files.filter((f) => declares.test(readText(join(dir, f)))), ...files]
  for (const f of ordered) {
    const text = readText(join(dir, f))
    // The method's declaration line (not a call): after a test attribute, or with a return type.
    const line = lineOf(text, new RegExp(`^(?!\\s*(//|return\\b)).*(void|Task|let|member|Sub|Function)\\b[^=;\\n]*${re.source}`, 'm'))
    if (line) return { source: f, line }
  }
  return {}
}

export const dotnetAdapter: Adapter = {
  framework: 'dotnet',
  detect: (dir, names) => [...names].some((n) => PROJECT.test(n)) && projectFile(dir) !== undefined,
  ownsSubfolders: true,

  async list(dir) {
    const proj = projectFile(dir)
    if (!proj) return { tests: [] }
    const r = await runQuiet(dir, programCommand(dir, dotnetTool(dir), ['test', proj, '--list-tests', '--nologo']))
    const names = parseDotnetList(r.stdout)
    if (names.length === 0 && r.code !== 0) return { tests: [], error: tail(r.output) || `dotnet test failed (exit code ${r.code}).` }
    const sources = findFiles(dir, ['.cs', '.fs', '.vb'])
    const tests = names.map((n) => {
      const t = dotnetCase(n)
      return { ...t, ...locate(dir, sources, t) }
    })
    return { tests }
  },

  async run(dir, req, ctx) {
    const proj = projectFile(dir)
    if (!proj) return { ok: false, error: 'Test project not found.', results: [], fileErrors: [] }
    const filter = dotnetFilter(req)
    const args = [
      'test',
      proj,
      '--nologo',
      '--results-directory',
      childPath(dir, ctx.work.dir),
      '--logger',
      'trx;LogFilePrefix=results',
      '--logger',
      'console;verbosity=normal',
      ...filter
    ]
    ctx.send(`$ dotnet test ${[proj, ...filter].join(' ')}\n`)
    const reader = new LineReader((line) => {
      const r = parseDotnetLine(line)
      if (r) ctx.result(r)
    })
    const code = await ctx.exec(programCommand(dir, dotnetTool(dir), args), {
      stdout: (t) => {
        ctx.send(t)
        reader.push(t)
      }
    })
    reader.flush()
    const reports = findFiles(ctx.work.dir, ['.trx'])
    if (reports.length === 0)
      return { ok: false, error: code === 0 ? undefined : 'The tests did not build or run: see the output.', results: [], fileErrors: [] }
    const results = reports.flatMap((f) => parseTrx(readText(join(ctx.work.dir, f))))
    return { ok: true, results, fileErrors: [] }
  }
}
