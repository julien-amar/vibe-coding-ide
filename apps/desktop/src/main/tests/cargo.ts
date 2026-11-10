import { dirname, join } from 'node:path'
import type { TestCase, TestResult } from '@shared/types'
import {
  escapeRegex,
  findFiles,
  hostPath,
  LineReader,
  lineOf,
  programCommand,
  readText,
  relFile,
  runQuiet,
  tail,
  testId,
  tool,
  type Adapter,
  type RunContext
} from './core'

/**
 * Rust: `cargo test --no-run --message-format=json` builds the test executables
 * and says which source file each comes from; each executable then lists its
 * tests (`--list`) and runs them, printing "test path ... ok" per test (live
 * results). Running the executables one by one also keeps going when one fails.
 */

interface Artifact {
  /** Source file of the target (lib.rs, tests/x.rs…), as cargo prints it. */
  src: string
  exe: string
  /** Folder of the crate's Cargo.toml (the tests' working directory and CARGO_MANIFEST_DIR). */
  manifestDir: string
}

const cargoTool = (dir: string): string => tool(dir, 'cargo', [join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin', 'cargo.exe')])

/** Test executables from `cargo test --no-run --message-format=json`, and the rendered compiler errors. */
export function parseCargoArtifacts(json: string): { artifacts: Artifact[]; diagnostics: string[] } {
  const artifacts: Artifact[] = []
  const diagnostics: string[] = []
  for (const line of json.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try {
      const m = JSON.parse(line) as {
        reason: string
        executable?: string | null
        profile?: { test?: boolean }
        target?: { src_path: string }
        manifest_path?: string
        message?: { rendered?: string; level?: string }
      }
      if (m.reason === 'compiler-artifact' && m.profile?.test && m.executable && m.target) {
        artifacts.push({ src: m.target.src_path, exe: m.executable, manifestDir: dirname(m.manifest_path ?? m.target.src_path) })
      } else if (m.reason === 'compiler-message' && m.message?.rendered && m.message.level === 'error') diagnostics.push(m.message.rendered)
    } catch {
      /* not a message */
    }
  }
  return { artifacts, diagnostics }
}

/** `<exe> --list --format terse`: "module::test: test" lines (benchmarks left out). */
export const parseCargoList = (out: string): string[] =>
  out
    .split(/\r?\n/)
    .map((l) => /^(.+): test$/.exec(l.trim())?.[1])
    .filter((x): x is string => !!x)

/** Results from libtest's output: "test path ... ok|FAILED|ignored", then the failures' output. */
export function parseCargoOutput(out: string): { path: string; status: TestResult['status']; message?: string }[] {
  const results = new Map<string, { path: string; status: TestResult['status']; message?: string }>()
  for (const m of out.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)\b/gm)) {
    results.set(m[1], { path: m[1], status: m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped' })
  }
  // ---- path stdout ---- … up to the next block, the "failures:" list or the summary.
  for (const m of out.matchAll(/^---- (\S+) stdout ----\r?\n([\s\S]*?)(?=^---- \S+ stdout ----|^failures:|^test result:)/gm)) {
    const r = results.get(m[1])
    if (r) r.message = m[2].trim()
  }
  return [...results.values()]
}

/** A test path (`tests::nested::works`) of a target as a test of the panel. */
function cargoCase(dir: string, file: string, src: string, path: string): TestCase {
  const parts = path.split('::')
  const name = parts[parts.length - 1]
  return { id: testId(file, parts), file, suite: parts.slice(0, -1), name, ...locate(dir, src, name) }
}

/** The test function in the target's source file, or another .rs file next to it. */
function locate(dir: string, src: string, name: string): { source?: string; line?: number } {
  const srcHost = hostPath(dir, src)
  const re = new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escapeRegex(name)}\\s*[(<]`, 'm')
  const first = lineOf(readText(srcHost), re)
  if (first) return { source: relFile(dir, src), line: first }
  const base = dirname(srcHost)
  for (const f of findFiles(base, ['.rs'])) {
    const line = lineOf(readText(join(base, f)), re)
    if (line) return { source: relFile(dir, join(dirname(src), f).replace(/\\/g, '/')), line }
  }
  return {}
}

/** Build the test executables (output to `send`, if given). */
async function build(dir: string, ctx?: RunContext): Promise<{ artifacts: Artifact[]; diagnostics: string[]; output: string; code: number | null }> {
  const cmd = programCommand(dir, cargoTool(dir), ['test', '--no-run', '--message-format=json'])
  if (!ctx) {
    const r = await runQuiet(dir, cmd)
    return { ...parseCargoArtifacts(r.stdout), output: r.output, code: r.code }
  }
  let stdout = ''
  // Compiler progress (stderr) goes to the output as it comes.
  const code = await ctx.exec(cmd, { stdout: (t) => (stdout += t), stderr: ctx.send })
  const parsed = parseCargoArtifacts(stdout)
  for (const d of parsed.diagnostics) ctx.send(d)
  return { ...parsed, output: stdout, code }
}

const exeCommand = (dir: string, a: Artifact, args: string[]) =>
  programCommand(dir, a.exe, args, { CARGO_MANIFEST_DIR: a.manifestDir, RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? '0' })

export const cargoAdapter: Adapter = {
  framework: 'cargo',
  detect: (_dir, names) => names.has('Cargo.toml'),
  ownsSubfolders: true,

  async list(dir) {
    const b = await build(dir)
    if (b.artifacts.length === 0) return { tests: [], error: b.diagnostics.join('\n') || (b.code !== 0 ? tail(b.output) : undefined) }
    // Each test binary lists its tests: all at once (in the artifacts' order).
    const lists = await Promise.all(b.artifacts.map((a) => runQuiet(dir, exeCommand(dir, a, ['--list', '--format', 'terse']))))
    const tests: TestCase[] = []
    b.artifacts.forEach((a, k) => {
      const file = relFile(dir, a.src)
      for (const path of parseCargoList(lists[k].stdout)) tests.push(cargoCase(dir, file, a.src, path))
    })
    return { tests }
  },

  async run(dir, req, ctx) {
    ctx.send(`$ cargo test${req.file ? ` (${req.file})` : ''}${req.titlePath?.length ? ` ${req.titlePath.join('::')}` : ''}\n`)
    const b = await build(dir, ctx)
    if (ctx.cancelled()) return { ok: false, results: [], fileErrors: [] }
    if (b.code !== 0)
      return {
        ok: false,
        error: 'The tests did not build: see the output.',
        results: [],
        fileErrors: b.diagnostics.map((message) => ({ file: req.file ?? '', message }))
      }
    const targets = b.artifacts.filter((a) => !req.file || relFile(dir, a.src) === req.file)
    const results: TestResult[] = []
    for (const a of targets) {
      if (ctx.cancelled()) break
      const file = relFile(dir, a.src)
      // A test runs exactly; a module runs everything under it.
      let filter: string[] = []
      if (req.titlePath?.length) {
        const path = req.titlePath.join('::')
        const listed = parseCargoList((await runQuiet(dir, exeCommand(dir, a, ['--list', '--format', 'terse']))).stdout)
        filter = listed.includes(path) ? [path, '--exact'] : [`${path}::`]
      }
      let out = ''
      const reader = new LineReader((line) => {
        const m = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/.exec(line)
        if (m) ctx.result({ id: testId(file, m[1].split('::')), status: m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped' })
      })
      await ctx.exec(exeCommand(dir, a, filter), {
        stdout: (t) => {
          out += t
          ctx.send(t)
          reader.push(t)
        }
      })
      reader.flush()
      for (const r of parseCargoOutput(out)) {
        const result: TestResult = { id: testId(file, r.path.split('::')), status: r.status, message: r.message }
        results.push(result)
        // Failures again, now with their output.
        if (result.message) ctx.result(result)
      }
    }
    return { ok: true, results, fileErrors: [] }
  }
}
