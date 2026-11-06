import { join } from 'node:path'
import type { TestCase, TestResult, TestRunRequest } from '@shared/types'
import PYTEST_PLUGIN from '../test-helpers/vci_pytest.py?raw'
import { which } from '../profiles'
import { childPath, findUp, isWslDir, LiveOutput, programCommand, readText, runQuiet, tail, testId, type Adapter, type LiveLine } from './core'

/**
 * pytest: runs with the project's virtualenv (or Python on PATH). A small plugin
 * (test-helpers/vci_pytest.py) lists the tests and prints each result as it finishes.
 */

/** pytest configuration in one of its config files. */
function hasPytestConfig(dir: string, names: Set<string>): boolean {
  if (names.has('pytest.ini')) return true
  if (names.has('pyproject.toml') && /^\[tool\.pytest/m.test(readText(join(dir, 'pyproject.toml')))) return true
  if (names.has('setup.cfg') && /^\[tool:pytest\]/m.test(readText(join(dir, 'setup.cfg')))) return true
  if (names.has('tox.ini') && /^\[pytest\]/m.test(readText(join(dir, 'tox.ini')))) return true
  return false
}

/**
 * Python for a pytest project: a virtualenv in the folder or a parent (.venv, venv, env),
 * otherwise Python on PATH. Returns the program and arguments, as the test process sees them.
 */
export function findPython(dir: string): { program: string; args: string[]; venv?: string } {
  const posixVenv = isWslDir(dir) || process.platform !== 'win32'
  const candidates = ['.venv', 'venv', 'env'].map((v) => (posixVenv ? join(v, 'bin', 'python') : join(v, 'Scripts', 'python.exe')))
  const found = findUp(dir, candidates)
  if (found) return { program: childPath(dir, found), args: [], venv: join(found, '..', '..') }
  if (isWslDir(dir)) return { program: 'python3', args: [] }
  if (process.platform === 'win32') {
    const python = which('python')
    if (python && !/WindowsApps/i.test(python)) return { program: python, args: [] }
    const py = which('py')
    if (py) return { program: py, args: ['-3'] }
    return { program: python ?? 'python', args: [] }
  }
  return { program: which('python3') ?? which('python') ?? 'python3', args: [] }
}

/** A pytest node id (`path/test_x.py::Class::test_name[param]`) as a test of the panel. */
export function pytestCase(nodeid: string, line?: number): TestCase {
  const [file, ...parts] = nodeid.split('::')
  return { id: testId(file, parts), file, suite: parts.slice(0, -1), name: parts[parts.length - 1] ?? file, line }
}

export const pytestResult = (l: LiveLine): TestResult => ({
  id: pytestCase(l.nodeid ?? '').id,
  status: l.status ?? 'failed',
  duration: l.duration,
  message: l.message ?? undefined
})

/** Arguments of a run (after the Python program): node ids select a file, a class or a test. */
export function pytestRunArgs(req: TestRunRequest): string[] {
  const target = req.file ? [req.titlePath?.length ? [req.file, ...req.titlePath].join('::') : req.file] : []
  return ['-m', 'pytest', '-p', 'vci_pytest', '--rootdir=.', ...target]
}

/** pytest's environment: the plugin's folder on PYTHONPATH, unbuffered output for live results. */
function pytestEnv(dir: string, pluginDir: string): Record<string, string> {
  const sep = isWslDir(dir) || process.platform !== 'win32' ? ':' : ';'
  const extra = process.env.PYTHONPATH && !isWslDir(dir) ? `${sep}${process.env.PYTHONPATH}` : ''
  return { PYTHONPATH: childPath(dir, pluginDir) + extra, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
}

export const pytestAdapter: Adapter = {
  framework: 'pytest',
  detect: hasPytestConfig,

  async list(dir, work) {
    work.write('vci_pytest.py', PYTEST_PLUGIN)
    const python = findPython(dir)
    const lines: LiveLine[] = []
    const live = new LiveOutput(
      () => undefined,
      (l) => lines.push(l)
    )
    const cmd = programCommand(
      dir,
      python.program,
      [...python.args, '-m', 'pytest', '--collect-only', '-q', '-p', 'vci_pytest', '--rootdir=.'],
      pytestEnv(dir, work.dir)
    )
    const r = await runQuiet(dir, cmd, (t) => live.push(t))
    live.flush()
    const tests = lines.filter((l) => l.collected).map((l) => pytestCase(l.collected!, l.line ?? undefined))
    const errors = lines.filter((l) => l.collectError !== undefined).map((l) => `${l.collectError}\n${l.message ?? ''}`)
    // Exit code 5: no tests collected (not an error).
    if (tests.length === 0 && r.code !== 0 && r.code !== 5 && errors.length === 0)
      return { tests, error: tail(r.output) || `pytest failed (exit code ${r.code}).` }
    return { tests, error: errors.length ? errors.join('\n\n') : undefined }
  },

  async run(dir, req, ctx) {
    ctx.work.write('vci_pytest.py', PYTEST_PLUGIN)
    const python = findPython(dir)
    const args = pytestRunArgs(req)
    ctx.send(`$ pytest ${args.slice(5).join(' ')}\n`)
    // pytest has no report file: the plugin's lines are the results.
    const results = new Map<string, TestResult>()
    const fileErrors: { file: string; message: string }[] = []
    const live = new LiveOutput(ctx.send, (line) => {
      if (line.collectError !== undefined) return void fileErrors.push({ file: line.collectError, message: line.message ?? '' })
      const r = pytestResult(line)
      results.set(r.id, r)
      ctx.result(r)
    })
    const code = await ctx.exec(programCommand(dir, python.program, [...python.args, ...args], pytestEnv(dir, ctx.work.dir)), { stdout: (t) => live.push(t) })
    live.flush()
    // 0 all passed, 1 some failed, 5 nothing collected; anything else: pytest itself failed.
    const ok = code === 0 || code === 1 || code === 5
    return { ok, error: ok ? undefined : 'pytest failed: see the output.', results: [...results.values()], fileErrors }
  }
}
