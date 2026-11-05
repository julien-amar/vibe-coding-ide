import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  runTests
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
                    { projectName: 'firefox', status: 'unexpected', results: [{ duration: 4, errors: [{ message: 'm', stack: 'Error: boom\n  at a.spec.ts:8' }] }] }
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
    expect(runArgs('vitest', { projectId: 'x' }, 'r.json')).toEqual(['run', '--reporter=default', '--reporter=json', '--outputFile.json=r.json'])
    expect(runArgs('vitest', { projectId: 'x', file: 'a.test.ts', titlePath: ['math (x)', 'adds'] }, 'r.json').slice(0, 4)).toEqual([
      'run',
      'a.test.ts',
      '-t',
      '^math \\(x\\) > adds( > |$)'
    ])
    expect(runArgs('playwright', { projectId: 'x', file: 'e2e/a.spec.ts' }, 'r.json')).toEqual(['test', 'e2e/a.spec.ts', '--reporter=list,json'])
    expect(runArgs('playwright', { projectId: 'x', file: 'e2e/a.spec.ts', titlePath: ['t'], line: 7 }, 'r.json')[1]).toBe('e2e/a.spec.ts:7')
    expect(runArgs('playwright', { projectId: 'x', file: 'e2e/a.spec.ts', titlePath: ['group (1)'] }, 'r.json')).toEqual([
      'test',
      'e2e/a.spec.ts',
      '-g',
      'group \\(1\\)',
      '--reporter=list,json'
    ])
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c')
  })
})

describe('live results', () => {
  it('separates marked result lines from the output, across chunk boundaries', () => {
    const text: string[] = []
    const lines: unknown[] = []
    const live = new LiveOutput((t) => text.push(t), (l) => lines.push(l))
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
    const live = new LiveOutput((t) => text.push(t), () => undefined)
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

  it('finds configs in sub-folders and packages whose scripts call vitest, skipping node_modules', () => {
    const w = (f: string, s = ''): void => {
      mkdirSync(join(base, f, '..'), { recursive: true })
      writeFileSync(join(base, f), s)
    }
    w('apps/web/vitest.config.ts')
    w('apps/web/playwright.config.ts')
    w('packages/lib/package.json', JSON.stringify({ scripts: { test: 'vitest run' } }))
    w('packages/other/package.json', JSON.stringify({ scripts: { test: 'jest' } }))
    w('node_modules/dep/vitest.config.ts')
    const found = detectTestProjects(base).map((p) => `${p.framework}:${p.relDir}`).sort()
    expect(found).toEqual(['playwright:apps/web', 'vitest:apps/web', 'vitest:packages/lib'])
  })

  it('finds the framework CLI in a parent node_modules (hoisted install)', () => {
    expect(findCli(FIXTURE, 'vitest')).toMatch(/vitest[\\/]vitest\.mjs$/)
    expect(findCli(FIXTURE, 'playwright')).toMatch(/cli\.js$/)
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
      'unit/math.check.ts::math > nested > multiplies'
    ])
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
    // Live results arrived during the run (and the marked lines are not in the output).
    expect(progress.map((p) => `${p.id}=${p.status}`).sort()).toEqual([
      'unit/math.check.ts::is skipped=skipped',
      'unit/math.check.ts::math > adds numbers=passed',
      'unit/math.check.ts::math > fails on purpose=failed',
      'unit/math.check.ts::math > nested > multiplies=passed'
    ])
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
})
