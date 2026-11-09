import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import { afterAll, describe, expect, it } from 'vitest'
import {
  detectTestProjects,
  discoverTests,
  escapeRegex,
  findCli,
  liveResult,
  LiveOutput,
  parsePlaywrightReport,
  RESULT_MARK,
  toWslPath,
  parseVitestList,
  parseVitestReport,
  relFile,
  runArgs,
  runTests,
  parseJestListing,
  pytestCase,
  findPython
} from './test-runner'

const FIXTURE = resolve(__dirname, '../../e2e/fixtures/sample-tests')

describe('test runner parsers', () => {
  it('makes reported files relative to the test project folder', () => {
    expect(relFile('C:\\repo\\app', 'C:/repo/app/src/a.test.ts')).toBe('src/a.test.ts')
    expect(relFile('C:\\Repo\\App', 'c:/repo/app/src/a.test.ts')).toBe('src/a.test.ts')
    expect(relFile('\\\\wsl.localhost\\Ubuntu\\home\\me\\app', '/home/me/app/test/x.spec.ts')).toBe('test/x.spec.ts')
    expect(relFile('/home/me/app', '/elsewhere/x.ts')).toBe('/elsewhere/x.ts')
  })

  it('reads `vitest list --json`', () => {
    const tests = parseVitestList('/p', [
      { name: 'math > nested > multiplies', file: '/p/unit/m.test.ts', location: { line: 12 } },
      { name: 'top level', file: '/p/unit/m.test.ts' }
    ])
    expect(tests).toEqual([
      { id: 'unit/m.test.ts::math > nested > multiplies', file: 'unit/m.test.ts', suite: ['math', 'nested'], name: 'multiplies', line: 12 },
      { id: 'unit/m.test.ts::top level', file: 'unit/m.test.ts', suite: [], name: 'top level', line: undefined }
    ])
  })

  it('reads the Vitest JSON report, with ids matching the listing', () => {
    const { results, fileErrors } = parseVitestReport('/p', {
      testResults: [
        {
          name: '/p/unit/m.test.ts',
          status: 'failed',
          assertionResults: [
            { ancestorTitles: ['math'], title: 'adds', status: 'passed', duration: 2, failureMessages: [] },
            { ancestorTitles: ['math'], title: 'bad', status: 'failed', duration: 3, failureMessages: ['AssertionError: nope'] },
            { ancestorTitles: [], title: 'later', status: 'pending', failureMessages: [] }
          ]
        },
        { name: '/p/unit/broken.test.ts', status: 'failed', message: 'SyntaxError: x', assertionResults: [] }
      ]
    })
    expect(results).toEqual([
      { id: 'unit/m.test.ts::math > adds', status: 'passed', duration: 2, message: undefined },
      { id: 'unit/m.test.ts::math > bad', status: 'failed', duration: 3, message: 'AssertionError: nope' },
      { id: 'unit/m.test.ts::later', status: 'skipped', duration: undefined, message: undefined }
    ])
    expect(fileErrors).toEqual([{ file: 'unit/broken.test.ts', message: 'SyntaxError: x' }])
  })

  it('reads Playwright JSON (listing and results, nested describes, projects, retries)', () => {
    const { tests, results } = parsePlaywrightReport('/p', {
      config: { rootDir: '/p/e2e' },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [{ title: 'top', file: 'a.spec.ts', line: 3, tests: [{ projectName: '', status: 'expected', results: [{ duration: 5 }] }] }],
          suites: [
            {
              title: 'group',
              file: 'a.spec.ts',
              line: 6,
              specs: [
                {
                  title: 'works',
                  file: 'a.spec.ts',
                  line: 7,
                  tests: [
                    { projectName: 'chromium', status: 'flaky', results: [{ duration: 1, errors: [{ message: 'first try' }] }, { duration: 2 }] },
                    {
                      projectName: 'firefox',
                      status: 'unexpected',
                      results: [{ duration: 4, errors: [{ message: 'm', stack: 'Error: boom\n  at a.spec.ts:8' }] }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
    expect(tests.map((t) => [t.id, t.file, t.suite, t.line, t.projectName])).toEqual([
      ['e2e/a.spec.ts::top', 'e2e/a.spec.ts', [], 3, undefined],
      ['e2e/a.spec.ts::group > works::chromium', 'e2e/a.spec.ts', ['group'], 7, 'chromium'],
      ['e2e/a.spec.ts::group > works::firefox', 'e2e/a.spec.ts', ['group'], 7, 'firefox']
    ])
    expect(results).toEqual([
      { id: 'e2e/a.spec.ts::top', status: 'passed', duration: 5, message: undefined, flaky: undefined },
      { id: 'e2e/a.spec.ts::group > works::chromium', status: 'passed', duration: 3, message: undefined, flaky: true },
      { id: 'e2e/a.spec.ts::group > works::firefox', status: 'failed', duration: 4, message: 'Error: boom\n  at a.spec.ts:8', flaky: undefined }
    ])
  })

  it('builds run arguments for a project, a file, a suite and a test', () => {
    const f = { report: 'r.json', live: 'live.js' }
    expect(runArgs('vitest', { projectId: 'x' }, f)).toEqual(['run', '--reporter=default', '--reporter=json', '--reporter=live.js', '--outputFile.json=r.json'])
    expect(runArgs('vitest', { projectId: 'x', file: 'a.test.ts', titlePath: ['math (x)', 'adds'] }, f).slice(0, 4)).toEqual([
      'run',
      'a.test.ts',
      '-t',
      '^math \\(x\\) > adds( > |$)'
    ])
    expect(runArgs('playwright', { projectId: 'x', file: 'e2e/a.spec.ts' }, f)).toEqual(['test', 'e2e/a.spec.ts', '--reporter=list,json,live.js'])
    expect(runArgs('playwright', { projectId: 'x', file: 'e2e/a.spec.ts', titlePath: ['t'], line: 7 }, f)[1]).toBe('e2e/a.spec.ts:7')
    expect(runArgs('playwright', { projectId: 'x', file: 'e2e/a.spec.ts', titlePath: ['group (1)'] }, f)).toEqual([
      'test',
      'e2e/a.spec.ts',
      '-g',
      'group \\(1\\)',
      '--reporter=list,json,live.js'
    ])
    // Jest: by path, and -t on titles joined with spaces.
    expect(runArgs('jest', { projectId: 'x', file: 'a.test.js', titlePath: ['strings', 'trims (x)'] }, f).slice(-4)).toEqual([
      '--runTestsByPath',
      'a.test.js',
      '-t',
      '^strings trims \\(x\\)( |$)'
    ])
    // pytest: node ids.
    expect(runArgs('pytest', { projectId: 'x' }, f).slice(-1)).toEqual(['--rootdir=.'])
    expect(runArgs('pytest', { projectId: 'x', file: 'py/check_a.py' }, f).slice(-1)).toEqual(['py/check_a.py'])
    expect(runArgs('pytest', { projectId: 'x', file: 'py/check_a.py', titlePath: ['TestGroup', 'test_x[1]'] }, f).slice(-1)).toEqual([
      'py/check_a.py::TestGroup::test_x[1]'
    ])
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c')
  })

  it('reads Jest listings and pytest node ids', () => {
    const listed = parseJestListing('/p', {
      testResults: [
        {
          name: '/p/jest/a.test.js',
          status: 'skipped',
          assertionResults: [{ ancestorTitles: ['strings', 'nested'], title: 'trims', status: 'pending', location: { line: 12 } }]
        }
      ]
    })
    expect(listed.tests).toEqual([
      { id: 'jest/a.test.js::strings > nested > trims', file: 'jest/a.test.js', suite: ['strings', 'nested'], name: 'trims', line: 12 }
    ])
    expect(pytestCase('py/check_a.py::TestGroup::test_x[1]', 9)).toEqual({
      id: 'py/check_a.py::TestGroup > test_x[1]',
      file: 'py/check_a.py',
      suite: ['TestGroup'],
      name: 'test_x[1]',
      line: 9
    })
    expect(liveResult('pytest', '/p', { nodeid: 'py/check_a.py::test_y', status: 'passed', duration: 3 }).id).toBe('py/check_a.py::test_y')
    expect(liveResult('jest', 'C:\\p', { file: 'C:\\p\\jest\\a.test.js', titles: ['s', 't'], status: 'failed' }).id).toBe('jest/a.test.js::s > t')
  })
})

describe('live results', () => {
  it('separates marked result lines from the output, across chunk boundaries', () => {
    const text: string[] = []
    const lines: unknown[] = []
    const live = new LiveOutput(
      (t) => text.push(t),
      (l) => lines.push(l)
    )
    live.push('RUN v5\n ✓ adds')
    live.push(` 2ms\n${RESULT_MARK}{"file":"/p/a.test.ts","name":"math > ad`)
    live.push(`ds","status":"passed","duration":2}\ntail without newline`)
    expect(lines).toEqual([{ file: '/p/a.test.ts', name: 'math > adds', status: 'passed', duration: 2 }])
    expect(text.join('')).toBe('RUN v5\n ✓ adds 2ms\n')
    live.flush()
    expect(text.join('')).toBe('RUN v5\n ✓ adds 2ms\ntail without newline')
  })

  it('keeps output printed on the same line before a marker, and bad JSON as text', () => {
    const text: string[] = []
    const live = new LiveOutput(
      (t) => text.push(t),
      () => undefined
    )
    live.push(`dots...${RESULT_MARK}{"file":"x","status":"passed"}\n${RESULT_MARK}{oops\n`)
    expect(text.join('')).toBe(`dots...${RESULT_MARK}{oops\n`)
  })

  it('gives live results the same ids as the listing', () => {
    expect(liveResult('vitest', 'C:\\p', { file: 'C:/p/unit/a.test.ts', name: 'math > adds', status: 'passed' }).id).toBe('unit/a.test.ts::math > adds')
    expect(liveResult('playwright', '/p', { file: '/p/e2e/a.spec.ts', titles: ['group', 'works'], projectName: 'chromium', status: 'failed' }).id).toBe(
      'e2e/a.spec.ts::group > works::chromium'
    )
  })

  it('converts Windows paths for WSL', () => {
    expect(toWslPath('C:\\Users\\me\\AppData\\Local\\Temp\\x\\r.json')).toBe('/mnt/c/Users/me/AppData/Local/Temp/x/r.json')
  })
})

describe('test framework detection', () => {
  const base = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-detect-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('finds configs in sub-folders, packages whose scripts call a framework, and pytest configs, skipping node_modules / venvs', () => {
    const w = (f: string, s = ''): void => {
      mkdirSync(join(base, f, '..'), { recursive: true })
      writeFileSync(join(base, f), s)
    }
    w('apps/web/vitest.config.ts')
    w('apps/web/playwright.config.ts')
    w('packages/lib/package.json', JSON.stringify({ scripts: { test: 'vitest run' } }))
    w('packages/other/package.json', JSON.stringify({ scripts: { test: 'jest --coverage' } }))
    w('packages/cfg/package.json', JSON.stringify({ jest: { testEnvironment: 'node' } }))
    w('packages/old/jest.config.js')
    w('services/api/pyproject.toml', '[project]\nname = "api"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n')
    w('services/worker/setup.cfg', '[tool:pytest]\n')
    w('services/plain/pyproject.toml', '[project]\nname = "plain"\n')
    w('tools/pytest.ini', '[pytest]\n')
    w('node_modules/dep/vitest.config.ts')
    w('.venv/lib/site/pytest.ini')
    const found = detectTestProjects(base)
      .map((p) => `${p.framework}:${p.relDir}`)
      .sort()
    expect(found).toEqual([
      'jest:packages/cfg',
      'jest:packages/old',
      'jest:packages/other',
      'playwright:apps/web',
      'pytest:services/api',
      'pytest:services/worker',
      'pytest:tools',
      'vitest:apps/web',
      'vitest:packages/lib'
    ])
  })

  it('keeps looking for other frameworks below a Gradle / .NET root, without nesting its own framework', () => {
    const root = join(base, 'mixed')
    const w = (f: string, s = ''): void => {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), s)
    }
    w('build.gradle', "plugins { id 'com.criteo.lifecycle' }")
    w('App.UTest/App.UTest.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>')
    w('App.UTest/nested/Other.csproj', '<Project><PackageReference Include="Microsoft.NET.Test.Sdk" /></Project>')
    w('module/build.gradle')
    expect(
      detectTestProjects(root)
        .map((p) => `${p.framework}:${p.relDir}`)
        .sort()
    ).toEqual(['dotnet:App.UTest', 'gradle:'])
  })

  it('finds the framework CLI in a parent node_modules (hoisted install), and a project virtualenv', () => {
    expect(findCli(FIXTURE, 'vitest')).toMatch(/vitest[\\/]vitest\.mjs$/)
    expect(findCli(FIXTURE, 'jest')).toMatch(/jest[\\/]bin[\\/]jest\.js$/)
    expect(findCli(FIXTURE, 'playwright')).toMatch(/cli\.js$/)
    const venv = join(base, 'pyproj')
    mkdirSync(join(venv, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
    writeFileSync(join(venv, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), '')
    mkdirSync(join(venv, 'src'))
    expect(findPython(join(venv, 'src')).venv).toBe(join(venv, '.venv'))
  })
})

describe('discovering and running real tests (fixture project)', () => {
  const output: string[] = []
  const progress: { id: string; status: string }[] = []
  const sender = {
    isDestroyed: () => false,
    send: (ch: string, _root: string, a: unknown, b: unknown) => {
      if (ch === 'tests:output') output.push(a as string)
      if (ch === 'tests:progress') progress.push(b as { id: string; status: string })
    }
  } as unknown as WebContents

  it('lists Vitest and Playwright tests', async () => {
    const projects = await discoverTests(FIXTURE)
    const vitest = projects.find((p) => p.framework === 'vitest')!
    const pw = projects.find((p) => p.framework === 'playwright')!
    expect(vitest.error).toBeUndefined()
    // Skipped tests are listed too (`vitest list` would leave them out).
    expect(vitest.tests.map((t) => t.id).sort()).toEqual([
      'unit/math.check.ts::is skipped',
      'unit/math.check.ts::math > adds numbers',
      'unit/math.check.ts::math > fails on purpose',
      'unit/math.check.ts::math > nested > multiplies',
      // Real names (not a text reading of the file): escapes kept, titles computed, no callbacks.
      'unit/names.check.ts::names > computed title 1',
      'unit/names.check.ts::names > computed title 2',
      'unit/names.check.ts::names > is not confused by callbacks',
      'unit/names.check.ts::names > keeps \\\\wsl.localhost escapes'
    ])
    // Line numbers (for "open in editor" and "Fix with agent").
    expect(vitest.tests.find((t) => t.name === 'fails on purpose')?.line).toBe(8)
    expect(pw.error).toBeUndefined()
    expect(pw.tests.map((t) => t.id)).toEqual(['pw/basic.pw.ts::basic > passes', 'pw/basic.pw.ts::basic > fails on purpose'])
  }, 120_000)

  it('runs a whole Vitest project, then a single test', async () => {
    const all = await runTests(FIXTURE, { projectId: 'vitest:' }, sender)
    expect(all.ok).toBe(true)
    const byId = Object.fromEntries(all.results.map((r) => [r.id, r]))
    expect(byId['unit/math.check.ts::math > adds numbers'].status).toBe('passed')
    expect(byId['unit/math.check.ts::math > fails on purpose'].status).toBe('failed')
    expect(byId['unit/math.check.ts::math > fails on purpose'].message).toMatch(/expected 4 to be 5/)
    expect(byId['unit/math.check.ts::is skipped'].status).toBe('skipped')
    expect(output.join('')).toMatch(/\$ vitest run/)
    // The listing and the run agree: same tests, same ids (the panel's counts depend on it).
    const listed = (await discoverTests(FIXTURE)).find((p) => p.framework === 'vitest')!.tests.map((t) => t.id)
    expect(all.results.map((r) => r.id).sort()).toEqual(listed.sort())
    // Live results arrived during the run, one per test (and the marked lines are not in the output).
    expect(progress.map((p) => `${p.id}=${p.status}`).sort()).toEqual(all.results.map((r) => `${r.id}=${r.status}`).sort())
    expect(output.join('')).not.toContain(RESULT_MARK)
    progress.length = 0

    const one = await runTests(FIXTURE, { projectId: 'vitest:', file: 'unit/math.check.ts', titlePath: ['math', 'nested'] }, sender)
    const ran = one.results.filter((r) => r.status !== 'skipped').map((r) => r.id)
    expect(ran).toEqual(['unit/math.check.ts::math > nested > multiplies'])
  }, 120_000)

  it('runs a single Playwright test by file and line', async () => {
    const projects = await discoverTests(FIXTURE)
    const t = projects.find((p) => p.framework === 'playwright')!.tests.find((x) => x.name === 'fails on purpose')!
    const r = await runTests(FIXTURE, { projectId: 'playwright:', file: t.file, titlePath: [...t.suite, t.name], line: t.line }, sender)
    expect(r.ok).toBe(true)
    expect(r.results).toHaveLength(1)
    expect(r.results[0]).toMatchObject({ id: t.id, status: 'failed' })
    expect(r.results[0].message).toMatch(/toHaveLength/)
    expect(progress).toContainEqual(expect.objectContaining({ id: t.id, status: 'failed' }))
  }, 120_000)

  it('runs a Playwright describe() block by its title', async () => {
    const r = await runTests(FIXTURE, { projectId: 'playwright:', file: 'pw/basic.pw.ts', titlePath: ['basic'] }, sender)
    expect(r.results.map((x) => x.status).sort()).toEqual(['failed', 'passed'])
  }, 120_000)

  it('lists and runs Jest tests (the listing matches the run)', async () => {
    const jest = (await discoverTests(FIXTURE)).find((p) => p.framework === 'jest')!
    expect(jest.error).toBeUndefined()
    expect(jest.tests.map((t) => t.id).sort()).toEqual([
      'jest/strings.check.js::is skipped',
      'jest/strings.check.js::strings > fails on purpose',
      'jest/strings.check.js::strings > joins words',
      'jest/strings.check.js::strings > nested > trims (spaces)'
    ])
    expect(jest.tests.find((t) => t.name === 'joins words')?.line).toBe(2)

    progress.length = 0
    const all = await runTests(FIXTURE, { projectId: 'jest:' }, sender)
    expect(all.ok).toBe(true)
    expect(all.results.map((r) => r.id).sort()).toEqual(jest.tests.map((t) => t.id).sort())
    const byId = Object.fromEntries(all.results.map((r) => [r.id, r]))
    expect(byId['jest/strings.check.js::strings > fails on purpose']).toMatchObject({ status: 'failed' })
    expect(byId['jest/strings.check.js::strings > fails on purpose'].message).toMatch(/Expected: "Vibe"/)
    expect(byId['jest/strings.check.js::is skipped'].status).toBe('skipped')
    // Live results for the tests that ran (Jest reports skipped ones only in the final report).
    const ran = all.results.filter((r) => r.status !== 'skipped')
    expect(progress.map((p) => `${p.id}=${p.status}`).sort()).toEqual(ran.map((r) => `${r.id}=${r.status}`).sort())

    const one = await runTests(FIXTURE, { projectId: 'jest:', file: 'jest/strings.check.js', titlePath: ['strings', 'nested', 'trims (spaces)'] }, sender)
    expect(one.results.filter((r) => r.status !== 'skipped').map((r) => r.id)).toEqual(['jest/strings.check.js::strings > nested > trims (spaces)'])
  }, 120_000)

  // pytest runs with the fixture's virtualenv (created by CI; locally: python -m venv .venv && pip install pytest).
  const hasVenv = existsSync(join(FIXTURE, '.venv'))
  it.skipIf(!hasVenv)(
    'lists and runs pytest tests (classes, parametrized tests, live results)',
    async () => {
      const py = (await discoverTests(FIXTURE)).find((p) => p.framework === 'pytest')!
      expect(py.error).toBeUndefined()
      expect(py.tests.map((t) => t.id)).toEqual([
        'py/check_math.py::test_adds',
        'py/check_math.py::test_fails_on_purpose',
        'py/check_math.py::TestGroup > test_inside_class',
        'py/check_math.py::test_param[1]',
        'py/check_math.py::test_param[2]',
        'py/check_math.py::test_skipped'
      ])
      expect(py.tests.find((t) => t.name === 'test_adds')?.line).toBe(4)

      progress.length = 0
      const all = await runTests(FIXTURE, { projectId: 'pytest:' }, sender)
      expect(all.ok).toBe(true)
      const status = Object.fromEntries(all.results.map((r) => [r.id, r.status]))
      expect(status).toEqual({
        'py/check_math.py::test_adds': 'passed',
        'py/check_math.py::test_fails_on_purpose': 'failed',
        'py/check_math.py::TestGroup > test_inside_class': 'passed',
        'py/check_math.py::test_param[1]': 'passed',
        'py/check_math.py::test_param[2]': 'passed',
        'py/check_math.py::test_skipped': 'skipped'
      })
      expect(all.results.find((r) => r.status === 'failed')?.message).toMatch(/assert \(2 \* 2\) == 5|assert 4 == 5/)
      expect(progress).toHaveLength(6)
      expect(output.join('')).not.toContain(RESULT_MARK)

      const cls = await runTests(FIXTURE, { projectId: 'pytest:', file: 'py/check_math.py', titlePath: ['TestGroup'] }, sender)
      expect(cls.results.map((r) => r.id)).toEqual(['py/check_math.py::TestGroup > test_inside_class'])
    },
    120_000
  )
})
