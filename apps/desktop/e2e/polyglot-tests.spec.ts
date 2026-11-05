import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { cleanup, launch, openProject, readLog, tempDir, type TestApp } from './app'

/** Go, Rust, .NET and Java (Maven) tests: passing, failing on purpose, skipped, subtests / nested classes. */
const FIXTURE = resolve(__dirname, 'fixtures', 'polyglot-tests')

/** A tool on PATH (or at one of its usual install places). */
function hasTool(name: string, extra: string[] = []): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter)
  return dirs.some((d) => exts.some((e) => existsSync(join(d, name + e)))) || extra.some((p) => existsSync(p))
}
const GO = hasTool('go', ['C:\\Program Files\\Go\\bin\\go.exe'])
const CARGO = hasTool('cargo', [join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin', 'cargo.exe')])
const DOTNET = hasTool('dotnet', ['C:\\Program Files\\dotnet\\dotnet.exe'])
const MAVEN = hasTool('mvn')
const GRADLE = hasTool('gradle')

let hub: TestApp
let profile: string

test.beforeEach(async () => {
  profile = tempDir('profile')
  hub = await launch(profile)
})

test.afterEach(async () => {
  await hub.app.close().catch(() => undefined)
  cleanup(profile)
})

/** Run a framework's tests from its group row; resolves when the run is over. */
async function runGroup(panel: Locator, label: RegExp): Promise<void> {
  const row = panel.locator('.test-row.kind-project', { hasText: label })
  await row.hover()
  await row.locator('.test-run').click()
  await expect(panel.locator('.tests-summary .busy')).toHaveCount(0, { timeout: 300_000 })
}

test('Go, Rust, .NET, Gradle and Maven projects: discovered, run, opened in the editor and sent to the agent', async () => {
  test.setTimeout(600_000)
  const { page } = hub
  await openProject(page, FIXTURE)
  const panel = page.locator('.tab-panel.visible .tests-panel')
  await page.locator('.tab-panel.visible .side-rail .rail-item.tests').click()
  // One group per project folder (Java tests are listed from the sources, even without Maven).
  await expect(panel.locator('.test-row.kind-project')).toHaveText([/\.NET · dotnet/, /Go · go/, /Gradle · gradle/, /Maven · java/, /Rust · rust/], {
    timeout: 300_000
  })
  await expect(panel.locator('.test-row.kind-project', { hasText: 'Maven' }).locator('.test-count')).toHaveText('5')
  await expect(panel.locator('.test-row.kind-project', { hasText: 'Gradle' }).locator('.test-count')).toHaveText('5')

  test.skip(!GO, 'Go is not installed')
  await runGroup(panel, /Go · go/)
  // A test's row by its exact name.
  const testRow = (name: string) =>
    panel.locator('.test-row.kind-test', { has: page.locator('.test-label', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
  await expect(testRow('TestFailsOnPurpose').locator('.test-status')).toHaveClass(/st-failed/)
  await expect(testRow('TestSkipped').locator('.test-status')).toHaveClass(/st-skipped/)
  // Subtests appear once they have run.
  await expect(testRow('small').locator('.test-status')).toHaveClass(/st-passed/)
  await expect(testRow('large').locator('.test-status')).toHaveClass(/st-passed/)

  // The failure, with the test's real source file (the group is the package folder).
  await testRow('TestFailsOnPurpose').click()
  const details = panel.locator('.tests-details')
  await expect(details).toContainText('Add(2, 2) = 4, want 5')
  await details.locator('.tests-location', { hasText: 'mathx/mathx_test.go:11' }).click()
  await expect.poll(() => readLog(hub.editorLog)).toMatch(/mathx_test\.go:11:1"/)
  await details.locator('.tests-message .tests-location', { hasText: 'mathx/mathx_test.go:13' }).click()
  await expect.poll(() => readLog(hub.editorLog)).toMatch(/mathx_test\.go:13:1"/)

  await details.getByRole('button', { name: /Fix with agent/ }).click()
  await expect.poll(() => readLog(hub.agentLog), { timeout: 20_000 }).toContain('This Go test fails. Please fix it.')
  expect(readLog(hub.agentLog)).toContain('File: go/mathx/mathx_test.go:11')
  expect(readLog(hub.agentLog)).toContain(`cd 'go' && go test './mathx' -run '^TestFailsOnPurpose$'`)

  if (CARGO) {
    await runGroup(panel, /Rust · rust/)
    await expect(testRow('fails_on_purpose').locator('.test-status')).toHaveClass(/st-failed/)
    // A file without failures starts collapsed: the name filter shows its tests.
    await panel.locator('.tests-filter').fill('adds_from_outside')
    await expect(panel.locator('.test-row.kind-test', { hasText: 'adds_from_outside' }).locator('.test-status')).toHaveClass(/st-passed/)
    await panel.locator('.tests-filter').fill('')
  }
  if (DOTNET) {
    await runGroup(panel, /\.NET · dotnet/)
    await expect(testRow('FailsOnPurpose').locator('.test-status')).toHaveClass(/st-failed/)
    await expect(testRow('AddsPairs(a: 1000, b: 2000)').locator('.test-status')).toHaveClass(/st-passed/)
  }
  // Java: the Gradle group comes before the Maven one; both have the same test names.
  if (GRADLE) {
    await runGroup(panel, /Gradle · gradle/)
    await expect(testRow('failsOnPurpose').first().locator('.test-status')).toHaveClass(/st-failed/)
    // A parameterized test's cases (named "[1] 1, 1" by Gradle) count for their method.
    await expect(testRow('addsPairs').first().locator('.test-status')).toHaveClass(/st-passed/)
  }
  if (MAVEN) {
    await runGroup(panel, /Maven · java/)
    await expect(testRow('failsOnPurpose').last().locator('.test-status')).toHaveClass(/st-failed/)
    await expect(testRow('addsPairs').last().locator('.test-status')).toHaveClass(/st-passed/)
    // The failure's stack trace links to the test source.
    await testRow('failsOnPurpose').last().click()
    await expect(panel.locator('.tests-details .tests-location', { hasText: /MathTest\.java:\d+/ }).first()).toBeVisible()
  }
})
