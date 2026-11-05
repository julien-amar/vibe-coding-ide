import { join } from 'node:path'
import type { TestCase, TestResult, TestRunRequest } from '@shared/types'
import { escapeRegex, findFiles, hostPath, LineReader, lineOf, programCommand, readText, runQuiet, tail, testId, tool, type Adapter } from './core'

/**
 * Go: `go test -json` streams an event per test (subtests included), so results
 * arrive live without a helper. Tests are grouped by package folder; their
 * source file and line come from a quick scan of the package's *_test.go files.
 */

interface GoEvent {
  Action: string
  Package?: string
  Test?: string
  Output?: string
  Elapsed?: number
}

const goTool = (dir: string): string => tool(dir, 'go', ['C:\\Program Files\\Go\\bin\\go.exe', '/usr/local/go/bin/go'])

const moduleOf = (dir: string): string => /^module\s+(\S+)/m.exec(readText(join(dir, 'go.mod')))?.[1] ?? ''

/** Package import path → its folder relative to the module ('.' for the module root). */
export function packageDir(module: string, pkg: string): string {
  if (pkg === module) return '.'
  return pkg.startsWith(module + '/') ? pkg.slice(module.length + 1) : pkg
}

/** Test functions as `go test -list` prints them (also examples and fuzz tests, not benchmarks). */
const isTestName = (s: string): boolean => /^(Test|Example|Fuzz)\w*$/.test(s)

/** Where a test function is: its file (relative to the module) and line. */
function locate(dir: string, pkgDir: string, name: string): { source?: string; line?: number } {
  const files = findFiles(join(hostPath(dir, dir), pkgDir), ['.go'], 0).filter((f) => f.endsWith('_test.go'))
  for (const f of files) {
    const line = lineOf(readText(join(dir, pkgDir, f)), new RegExp(`^func\\s+${escapeRegex(name)}\\s*\\(`, 'm'))
    if (line) return { source: pkgDir === '.' ? f : `${pkgDir}/${f}`, line }
  }
  return {}
}

/** Tests from `go test -list . -json ./...`. */
export function parseGoList(module: string, json: string): { pkgDir: string; name: string }[] {
  const out: { pkgDir: string; name: string }[] = []
  for (const line of json.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try {
      const ev = JSON.parse(line) as GoEvent
      const name = ev.Output?.trim()
      if (ev.Action === 'output' && ev.Package && !ev.Test && name && isTestName(name)) out.push({ pkgDir: packageDir(module, ev.Package), name })
    } catch {
      /* not an event */
    }
  }
  return out
}

/** Arguments of a run: a package (or all), and -run with one anchored pattern per level (test/subtest). */
export function goRunArgs(req: TestRunRequest): string[] {
  const target = req.file ? (req.file === '.' ? '.' : `./${req.file}`) : './...'
  const run = req.titlePath?.length ? ['-run', req.titlePath.map((t) => `^${escapeRegex(t)}$`).join('/')] : []
  // -count=1: really run (not "cached" results).
  return ['test', '-json', '-count=1', target, ...run]
}

/** Failure output of a test: its lines without the === RUN / --- FAIL frames; file:line made relative to the module. */
const failureText = (pkgDir: string, lines: string[]): string =>
  lines
    .filter((l) => !/^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (FAIL|PASS|SKIP):)/.test(l))
    .map((l) => (pkgDir === '.' ? l : l.replace(/^(\s+)([\w.-]+\.go:\d+)/, `$1${pkgDir}/$2`)))
    .join('')
    .replace(/\s+$/, '')

export const goAdapter: Adapter = {
  framework: 'go',
  detect: (_dir, names) => names.has('go.mod'),

  async list(dir) {
    const r = await runQuiet(dir, programCommand(dir, goTool(dir), ['test', '-list', '.', '-json', './...']))
    const found = parseGoList(moduleOf(dir), r.stdout)
    if (found.length === 0 && r.code !== 0) return { tests: [], error: tail(r.output) || `go test failed (exit code ${r.code}).` }
    const tests: TestCase[] = found.map(({ pkgDir, name }) => ({ id: testId(pkgDir, [name]), file: pkgDir, suite: [], name, ...locate(dir, pkgDir, name) }))
    return { tests, error: r.code !== 0 ? tail(r.output) : undefined }
  },

  async run(dir, req, ctx) {
    const module = moduleOf(dir)
    const args = goRunArgs(req)
    ctx.send(`$ go ${args.filter((a) => a !== '-json').join(' ')}\n`)
    const results = new Map<string, TestResult>()
    const outputs = new Map<string, string[]>()
    const pkgOutput = new Map<string, string[]>()
    const failedPkgs = new Set<string>()
    const reader = new LineReader((line) => {
      let ev: GoEvent
      try {
        ev = JSON.parse(line) as GoEvent
      } catch {
        if (line.trim()) ctx.send(line + '\n')
        return
      }
      const pkgDir = packageDir(module, ev.Package ?? '')
      if (ev.Action === 'output' && ev.Output) {
        ctx.send(ev.Output)
        const key = ev.Test ? `${pkgDir}|${ev.Test}` : pkgDir
        const map = ev.Test ? outputs : pkgOutput
        if (!map.has(key)) map.set(key, [])
        map.get(key)!.push(ev.Output)
      } else if ((ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') && ev.Test) {
        const r: TestResult = {
          id: testId(pkgDir, ev.Test.split('/')),
          status: ev.Action === 'pass' ? 'passed' : ev.Action === 'fail' ? 'failed' : 'skipped',
          duration: ev.Elapsed !== undefined ? ev.Elapsed * 1000 : undefined,
          message: ev.Action === 'fail' || ev.Action === 'skip' ? failureText(pkgDir, outputs.get(`${pkgDir}|${ev.Test}`) ?? []) || undefined : undefined
        }
        results.set(r.id, r)
        ctx.result(r)
      } else if (ev.Action === 'fail' && !ev.Test) failedPkgs.add(pkgDir)
    })
    const code = await ctx.exec(programCommand(dir, goTool(dir), args), { stdout: (t) => reader.push(t) })
    reader.flush()
    // A package that failed without failing tests did not build (or panicked outside a test).
    const fileErrors = [...failedPkgs]
      .filter((p) => ![...results.values()].some((r) => r.id.startsWith(`${p}::`) && r.status === 'failed'))
      .map((p) => ({ file: p, message: (pkgOutput.get(p) ?? []).join('').trim() || 'The package failed to build: see the output.' }))
    return { ok: code === 0 || code === 1, error: code === 0 || code === 1 ? undefined : 'go test failed: see the output.', results: [...results.values()], fileErrors }
  }
}
