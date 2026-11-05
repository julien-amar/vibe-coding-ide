import type { TestCase, TestProject } from '@shared/types'
import { FRAMEWORK_LABEL, stripAnsi } from './test-tree'

/** Messages sent to the AI agent by "Fix with agent". */

const MAX_MESSAGE = 3000
const MAX_MESSAGE_MANY = 1200
const MAX_TESTS = 8

/** Shell quoting: single quotes (literal in POSIX shells and PowerShell), double quotes when the text has a '. */
const quote = (s: string): string => (s.includes("'") ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : `'${s}'`)
const regex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Path of a test file relative to the project root. */
const projectPath = (project: TestProject, file: string): string => (project.relDir ? `${project.relDir}/${file}` : file)

/** Shell command that runs one test (or a whole file / the test project), from the project root. */
export function runCommand(project: TestProject, test?: TestCase, file?: string): string {
  const f = test?.file ?? file
  let cmd: string
  switch (project.framework) {
    case 'vitest':
      cmd = ['npx vitest run', f && quote(f), test && `-t ${quote(`^${regex([...test.suite, test.name].join(' > '))}$`)}`].filter(Boolean).join(' ')
      break
    case 'jest':
      cmd = ['npx jest', f && quote(f), test && `-t ${quote(`^${regex([...test.suite, test.name].join(' '))}$`)}`].filter(Boolean).join(' ')
      break
    case 'playwright':
      cmd = ['npx playwright test', f && quote(test?.line ? `${f}:${test.line}` : f)].filter(Boolean).join(' ')
      break
    case 'pytest':
      cmd = ['python -m pytest', f && quote(test ? [f, ...test.suite, test.name].join('::') : f)].filter(Boolean).join(' ')
      break
    case 'go': {
      // file = package folder; -run: one anchored pattern per level (test / subtest).
      const pkg = f ? (f === '.' ? '.' : `./${f}`) : './...'
      const run = test ? ` -run ${quote([...test.suite, test.name].map((t) => `^${regex(t)}$`).join('/'))}` : ''
      cmd = `go test ${quote(pkg)}${run}`
      break
    }
    case 'cargo':
      cmd = test ? `cargo test -- ${quote([...test.suite, test.name].join('::'))} --exact` : 'cargo test'
      break
    case 'dotnet': {
      // file = class; a data-driven test's cases run together (filter on the method).
      const method = test?.name.replace(/\(.*\)$/s, '')
      cmd = f && f !== '(tests)' ? `dotnet test --filter ${quote(test ? `FullyQualifiedName=${f}.${method}` : `FullyQualifiedName~${f}.`)}` : 'dotnet test'
      break
    }
    case 'maven':
      cmd = f ? `mvn test ${quote(`-Dtest=${test ? `${f}#${test.name}` : f}`)}` : 'mvn test'
      break
    case 'gradle':
      cmd = f ? `gradle test --tests ${quote(test ? `${f}.${test.name}` : f)}` : 'gradle test'
      break
  }
  return project.relDir ? `cd ${quote(project.relDir)} && ${cmd}` : cmd
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s)

export interface Failure {
  test: TestCase
  message?: string
}

/** Prompt asking the agent to fix failing tests of one test project. */
export function fixPrompt(project: TestProject, failures: Failure[]): string {
  const fw = FRAMEWORK_LABEL[project.framework]
  // The test's source file (a Go package, .NET / JVM class is not one).
  const where = (t: TestCase): string => `${projectPath(project, t.source ?? t.file)}${t.line ? `:${t.line}` : ''}`
  const title = (t: TestCase): string => [...t.suite, t.name].join(' › ') + (t.projectName ? ` [${t.projectName}]` : '')
  if (failures.length === 1) {
    const { test, message } = failures[0]
    return [
      `This ${fw} test fails. Please fix it.`,
      '',
      `Test: ${title(test)}`,
      `File: ${where(test)}`,
      '',
      'Error:',
      clip(stripAnsi(message ?? '(no message)').trim(), MAX_MESSAGE),
      '',
      'Find the cause and fix it: in the code under test, or in the test itself if the test is wrong (say which, and why).',
      'Then run the test to confirm it passes:',
      runCommand(project, test)
    ].join('\n')
  }
  const shown = failures.slice(0, MAX_TESTS)
  const files = [...new Set(failures.map((f) => f.test.file))]
  return [
    `${failures.length} ${fw} tests fail. Please fix them.`,
    '',
    ...shown.flatMap(({ test, message }, i) => [
      `${i + 1}. ${title(test)} — ${where(test)}`,
      clip(stripAnsi(message ?? '(no message)').trim(), MAX_MESSAGE_MANY),
      ''
    ]),
    ...(failures.length > shown.length ? [`… and ${failures.length - shown.length} more.`, ''] : []),
    'Find the causes and fix them: in the code under test, or in the tests themselves if they are wrong (say which, and why).',
    'Then run the tests to confirm they pass:',
    files.length === 1 ? runCommand(project, undefined, files[0]) : runCommand(project)
  ].join('\n')
}
