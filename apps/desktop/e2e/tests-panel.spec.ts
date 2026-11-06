import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { cleanup, launch, openProject, readLog, tempDir, type TestApp } from './app'

/**
 * A project with Vitest, Jest, Playwright and pytest tests (passing, failing on purpose,
 * skipped). pytest needs the fixture's virtualenv (.venv, created by CI); without it the
 * pytest tests are left out of the expected counts.
 */
const FIXTURE = resolve(__dirname, 'fixtures', 'sample-tests')
const PYTEST = existsSync(resolve(FIXTURE, '.venv'))
const expected = PYTEST ? { all: 20, passed: 13, failed: 4, skipped: 3 } : { all: 14, passed: 9, failed: 3, skipped: 2 }

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

test('the Tests panel discovers and runs Vitest, Jest, Playwright and pytest tests, and filters them', async () => {
  const { page } = hub
  await openProject(page, FIXTURE)
  const panel = page.locator('.tab-panel.visible .tests-panel')
  // Count shown on a status filter button (all / passed / skipped / failed).
  const count = (f: string) => panel.locator(`.tests-status-filter [data-filter="${f}"] .count`)

  // Collapsed in the side rail by default: discovery starts when it is shown.
  await page.locator('.tab-panel.visible .side-rail .rail-item.tests').click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.test-row.kind-project')).toHaveText([/Vitest/, /Jest/, /Playwright/, ...(PYTEST ? [/pytest/] : [])], { timeout: 90_000 })
  // Skipped tests are listed too.
  await expect(count('all')).toHaveText(String(expected.all))

  // Run everything.
  await panel.getByRole('button', { name: /Run all/ }).click()
  await expect(panel.locator('.tests-summary .busy')).toHaveCount(0, { timeout: 180_000 })
  await expect(count('failed')).toHaveText(String(expected.failed))
  await expect(count('passed')).toHaveText(String(expected.passed))
  await expect(count('skipped')).toHaveText(String(expected.skipped))
  await expect(count('all')).toHaveText(String(expected.all))
  // The marked live-result lines are hidden from the output.
  await panel.getByRole('button', { name: 'Output' }).click()
  await expect(panel.locator('.tests-output')).not.toContainText('@@vibe-coding-ide')
  await expect(panel.locator('.tests-output')).toContainText('$ jest')

  // Files holding a failure are expanded; selecting a failed test shows its error.
  const failing = panel.locator('.test-row.kind-test', { hasText: 'fails on purpose' }).first()
  await failing.click()
  await expect(panel.locator('.tests-details')).toContainText('expected 4 to be 5')

  // Run a single test: only it changes.
  const adds = panel.locator('.test-row.kind-test', { hasText: 'adds numbers' })
  await adds.hover()
  await adds.locator('.test-run').click()
  await expect(adds.locator('.test-status')).toHaveClass(/st-passed/, { timeout: 60_000 })
  await expect(count('failed')).toHaveText(String(expected.failed))

  // Status filters (connected buttons): failed, passed, skipped, then all again.
  const filter = (name: string) => panel.getByRole('radio', { name: new RegExp(name) })
  await filter('Show failed').click()
  await expect(filter('Show failed')).toHaveAttribute('aria-checked', 'true')
  await expect(panel.locator('.test-row.kind-test')).toHaveCount(expected.failed)
  await filter('Show passed').click()
  await expect(panel.locator('.test-row.kind-test')).toHaveCount(expected.passed)
  await filter('Show skipped').click()
  await expect(panel.locator('.test-row.kind-test')).toHaveCount(expected.skipped)
  // Combined with the name filter; nothing matches: a message.
  await panel.locator('.tests-filter').fill('nested')
  await expect(panel.locator('.tests-empty')).toHaveText('No skipped tests matching “nested”.')
  await filter('Show all').click()
  await expect(panel.locator('.test-row.kind-test')).toHaveText([/multiplies/, /trims \(spaces\)/])
})

test('a failed test opens in the editor and is sent to the AI agent with "Fix with agent"', async () => {
  const { page } = hub
  await openProject(page, FIXTURE)
  const panel = page.locator('.tab-panel.visible .tests-panel')
  await page.locator('.tab-panel.visible .side-rail .rail-item.tests').click()
  const vitest = panel.locator('.test-row.kind-project', { hasText: 'Vitest' })
  await expect(vitest).toBeVisible({ timeout: 90_000 })
  await vitest.hover()
  await vitest.locator('.test-run').click()
  const failing = panel.locator('.test-row.kind-test', { hasText: 'fails on purpose' }).first()
  await expect(failing.locator('.test-status')).toHaveClass(/st-failed/, { timeout: 90_000 })
  await failing.click()
  const details = panel.locator('.tests-details')

  // The file:line under the test name opens the editor there (a fake `code` records the call).
  await details.locator('.tests-location', { hasText: 'unit/math.check.ts:8' }).click()
  await expect.poll(() => readLog(hub.editorLog)).toMatch(/"-g","[^"]*math\.check\.ts:8:1"/)
  // So do the locations in the stack trace.
  await details
    .locator('.tests-message .tests-location', { hasText: /math\.check\.ts:9:\d+/ })
    .first()
    .click()
  await expect.poll(() => readLog(hub.editorLog)).toMatch(/math\.check\.ts:9:\d+"/)
  // Frames in dependencies outside the project folder (here the repository's node_modules; on
  // Windows Vitest prints them as file:/// URLs, shown without the scheme) open too.
  const depFrame = details.locator('.tests-message .tests-location', { hasText: /node_modules[\\/]vitest/ }).first()
  await expect(depFrame).not.toContainText('file:')
  await depFrame.click()
  await expect.poll(() => readLog(hub.editorLog)).toMatch(/node_modules[\\/]+vitest[^"]*\.js:\d+:\d+"/)
  // Double-clicking a test opens it too.
  await panel.locator('.test-row.kind-test', { hasText: 'adds numbers' }).dblclick()
  await expect.poll(() => readLog(hub.editorLog)).toMatch(/math\.check\.ts:4:1"/)

  // "Fix with agent": the failure, its location and how to re-run it, pasted into the agent
  // panel's CLI (a fake `claude` records what it receives) and submitted.
  await failing.click()
  await details.getByRole('button', { name: /Fix with agent/ }).click()
  await expect(page.locator('.toast')).toContainText('Sent to the AI agent')
  await expect.poll(() => readLog(hub.agentLog), { timeout: 20_000 }).toContain('This Vitest test fails. Please fix it.')
  const sent = readLog(hub.agentLog)
  expect(sent).toContain('Test: math › fails on purpose')
  expect(sent).toContain('File: unit/math.check.ts:8')
  expect(sent).toContain('expected 4 to be 5')
  expect(sent).toContain(`npx vitest run 'unit/math.check.ts' -t '^math > fails on purpose$'`)
  // Pasted as one block (bracketed paste), then submitted with Enter.
  expect(sent.startsWith('\x1b[200~')).toBe(true)
  await expect.poll(() => readLog(hub.agentLog).endsWith('\x1b[201~\r')).toBe(true)
})

test('"Fix with agent" opens an AI agent panel when none is running, and waits for it to start', async () => {
  const { page } = hub
  await openProject(page, FIXTURE)
  // Close the project's agent panel.
  const agentPane = page.locator('.tab-panel.visible .pane', { has: page.locator('.pane-header', { hasText: 'Claude Code' }) })
  await agentPane.locator('.pane-header button[title^="Close panel"]').click()
  await expect(agentPane).toHaveCount(0)

  const panel = page.locator('.tab-panel.visible .tests-panel')
  await page.locator('.tab-panel.visible .side-rail .rail-item.tests').click()
  const jest = panel.locator('.test-row.kind-project', { hasText: 'Jest' })
  await expect(jest).toBeVisible({ timeout: 90_000 })
  await jest.hover()
  await jest.locator('.test-run').click()
  const failing = panel.locator('.test-row.kind-test', { hasText: 'fails on purpose' }).first()
  await expect(failing.locator('.test-status')).toHaveClass(/st-failed/, { timeout: 90_000 })
  await failing.click()
  await panel
    .locator('.tests-details')
    .getByRole('button', { name: /Fix with agent/ })
    .click()

  // A new agent panel appears, and gets the message once it has started.
  await expect(agentPane).toHaveCount(1)
  await expect.poll(() => readLog(hub.agentLog), { timeout: 30_000 }).toContain('This Jest test fails. Please fix it.')
  expect(readLog(hub.agentLog)).toContain(`npx jest 'jest/strings.check.js' -t '^strings fails on purpose$'`)
})
