/** The Tests panel: frameworks, projects, tests, runs. */

/** Test frameworks the Tests panel can discover and run. */
export type TestFramework = 'vitest' | 'jest' | 'playwright' | 'pytest' | 'go' | 'cargo' | 'dotnet' | 'maven' | 'gradle'

/** A test (one per Playwright project when a config defines several). */
export interface TestCase {
  /** Stable id: framework-specific, unique within its TestProject. */
  id: string
  /**
   * First level of the tree, relative to the test project's folder with forward slashes: the
   * test file — or, where tests are not grouped by file, the Go package folder or the
   * .NET / JVM class.
   */
  file: string
  /** Enclosing describe() titles / modules / nested classes, outermost first. */
  suite: string[]
  name: string
  /** Line of the test in `source` (or `file`). */
  line?: number
  /** Source file of the test when `file` is not one (Go package, .NET / JVM class). */
  source?: string
  /** Playwright project name (several projects run the same spec). */
  projectName?: string
}

/** A folder with a test framework config (a repo can hold several, e.g. in a monorepo). */
export interface TestProject {
  /** `<framework>:<folder relative to the project root>` */
  id: string
  framework: TestFramework
  /** Absolute folder (Windows or \\wsl.localhost path). */
  dir: string
  /** Folder relative to the project root ('' = the root). */
  relDir: string
  tests: TestCase[]
  /** Discovery failed (output of the listing command). */
  error?: string
  /** The project file of a .NET test project ("App.Tests.csproj"): its name in the Tests tree. */
  projectFile?: string
}

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'running'

export interface TestResult {
  id: string
  status: Exclude<TestStatus, 'running'>
  /** Milliseconds. */
  duration?: number
  /** Failure message and stack (plain text). */
  message?: string
  /** Passed only after a retry. */
  flaky?: boolean
}

/** What to run: a whole test project, a file, or a suite / test inside a file. */
export interface TestRunRequest {
  projectId: string
  file?: string
  /** Suite titles (and the test name last, for a single test) inside `file`. */
  titlePath?: string[]
  /** Line of the suite / test (Playwright runs by file:line). */
  line?: number
}

export interface TestRunResult {
  ok: boolean
  /** The run could not start or produced no report. */
  error?: string
  results: TestResult[]
  /** Files that failed before running their tests (syntax error, failing import…). */
  fileErrors: { file: string; message: string }[]
  cancelled?: boolean
}
