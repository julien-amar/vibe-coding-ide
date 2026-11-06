import { describe, expect, it } from 'vitest'
import type { TestCase, TestProject } from '@shared/types'
import { fixPrompt, runCommand } from './test-prompt'

const project = (framework: TestProject['framework'], relDir = 'apps/web'): TestProject => ({
  id: `${framework}:${relDir}`,
  framework,
  dir: '/r/' + relDir,
  relDir,
  tests: []
})
const t = (file: string, suite: string[], name: string, line?: number): TestCase => ({
  id: `${file}::${[...suite, name].join(' > ')}`,
  file,
  suite,
  name,
  line
})

describe('Fix with agent prompts', () => {
  it('gives the command that runs exactly one test, per framework (quotes that work in bash and PowerShell)', () => {
    expect(runCommand(project('vitest'), t('src/a.test.ts', ['math (x)'], 'adds "1"'))).toBe(
      String.raw`cd 'apps/web' && npx vitest run 'src/a.test.ts' -t '^math \(x\) > adds "1"$'`
    )
    expect(runCommand(project('jest', ''), t('a.test.js', ['strings'], 'joins'))).toBe(`npx jest 'a.test.js' -t '^strings joins$'`)
    expect(runCommand(project('playwright', ''), t('e2e/a.spec.ts', [], 'works', 12))).toBe(`npx playwright test 'e2e/a.spec.ts:12'`)
    expect(runCommand(project('pytest', 'api'), t('tests/test_a.py', ['TestX'], 'test_y[1]'))).toBe(
      `cd 'api' && python -m pytest 'tests/test_a.py::TestX::test_y[1]'`
    )
    expect(runCommand(project('vitest', ''), undefined, 'src/a.test.ts')).toBe(`npx vitest run 'src/a.test.ts'`)
    // Go: package folder and one anchored pattern per level; Rust: module path; .NET: class + method
    // (all cases of a data-driven test); Maven / Gradle: class + method.
    expect(runCommand(project('go', 'go'), { ...t('mathx', ['TestTable'], 'small'), source: 'mathx/m_test.go' })).toBe(
      `cd 'go' && go test './mathx' -run '^TestTable$/^small$'`
    )
    expect(runCommand(project('cargo', ''), t('src/lib.rs', ['tests', 'nested'], 'works'))).toBe(`cargo test -- 'tests::nested::works' --exact`)
    expect(runCommand(project('dotnet', ''), t('Ns.MathTests', [], 'AddsPairs(a: 1, b: 1)'))).toBe(
      `dotnet test --filter 'FullyQualifiedName=Ns.MathTests.AddsPairs'`
    )
    expect(runCommand(project('maven', ''), t('sample.MathTest$Inner', [], 'works'))).toBe(`mvn test '-Dtest=sample.MathTest$Inner#works'`)
    expect(runCommand(project('gradle', ''), t('sample.MathTest', [], 'adds'))).toBe(`gradle test --tests 'sample.MathTest.adds'`)
    // A name with a single quote: double quotes, with backslashes and $ escaped for the shell
    // (bash turns \\\$ back into the regex's \$, a literal dollar sign).
    expect(runCommand(project('jest', ''), t('a.test.js', [], `it's $HOME`))).toBe(String.raw`npx jest 'a.test.js' -t "^it's \\\$HOME\$"`)
  })

  it('describes one failure with its location, error and how to check the fix', () => {
    const p = fixPrompt(project('vitest'), [
      { test: t('src/a.test.ts', ['math'], 'adds', 8), message: '\x1b[31mAssertionError: expected 4 to be 5\x1b[39m\n    at src/a.test.ts:9:19' }
    ])
    expect(p).toContain('This Vitest test fails. Please fix it.')
    expect(p).toContain('Test: math › adds')
    expect(p).toContain('File: apps/web/src/a.test.ts:8')
    expect(p).toContain('AssertionError: expected 4 to be 5\n    at src/a.test.ts:9:19')
    expect(p).not.toContain('\x1b')
    expect(p.trim().split('\n').pop()).toBe(`cd 'apps/web' && npx vitest run 'src/a.test.ts' -t '^math > adds$'`)
  })

  it('lists several failures (capped) and runs their file or project', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ test: t('src/a.test.ts', [], `t${i}`), message: 'x'.repeat(5000) }))
    const p = fixPrompt(project('jest', ''), many)
    expect(p).toMatch(/^10 Jest tests fail/)
    expect(p).toContain('8. t7 — src/a.test.ts')
    expect(p).not.toContain('9. t8')
    expect(p).toContain('… and 2 more.')
    expect(p).toContain('… (truncated)')
    expect(p.trim().split('\n').pop()).toBe(`npx jest 'src/a.test.ts'`)
  })
})
