import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { cleanup, launch, openProject, tempDir, type TestApp } from './app'

/** A project with Vitest and Playwright tests (passing, failing on purpose, skipped). */
const FIXTURE = resolve(__dirname, 'fixtures', 'sample-tests')

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

test('the Tests panel discovers Vitest and Playwright tests, runs them and shows failures', async () => {
  const { page } = hub
  await openProject(page, FIXTURE)
  const panel = page.locator('.tab-panel.visible .tests-panel')

  // Collapsed in the side rail by default: discovery starts when it is shown.
  await page.locator('.tab-panel.visible .side-rail .rail-item.tests').click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.test-row.kind-project')).toHaveText([/Vitest/, /Playwright/], { timeout: 60_000 })
  await expect(panel.locator('.tests-summary')).toContainText('5 tests')

  // Run everything.
  await panel.getByRole('button', { name: /Run all/ }).click()
  await expect(panel.locator('.tests-summary')).toContainText('2 failed', { timeout: 90_000 })
  await expect(panel.locator('.tests-summary')).toContainText('3 passed')
  // The skipped Vitest test is not listed by Vitest; it appears once the run reports it.
  await expect(panel.locator('.tests-summary')).toContainText('1 skipped')
  await expect(panel.locator('.tests-summary')).toContainText('6 tests')

  // Files holding a failure are expanded; selecting a failed test shows its error.
  const failing = panel.locator('.test-row.kind-test', { hasText: 'fails on purpose' }).first()
  await failing.click()
  await expect(panel.locator('.tests-details')).toContainText('expected 4 to be 5')

  // Run a single test: only it changes.
  const adds = panel.locator('.test-row.kind-test', { hasText: 'adds numbers' })
  await adds.hover()
  await adds.locator('.test-run').click()
  await expect(adds.locator('.test-status')).toHaveClass(/st-passed/, { timeout: 60_000 })
  await expect(panel.locator('.tests-summary')).toContainText('2 failed')

  // The console output of the runs.
  await panel.getByRole('button', { name: 'Output' }).click()
  await expect(panel.locator('.tests-output')).toContainText('$ vitest run')

  // Filter: failed only.
  await panel.locator('.tests-failed-only input').check()
  await expect(panel.locator('.test-row.kind-test')).toHaveCount(2)
})
