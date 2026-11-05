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
  // Count shown on a status filter button (all / passed / skipped / failed).
  const count = (f: string) => panel.locator('.tests-status-filter [data-filter="' + f + '"] .count')

  // Collapsed in the side rail by default: discovery starts when it is shown.
  await page.locator('.tab-panel.visible .side-rail .rail-item.tests').click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.test-row.kind-project')).toHaveText([/Vitest/, /Playwright/], { timeout: 60_000 })
  // Skipped tests are listed too.
  await expect(count('all')).toHaveText('10')

  // Run everything.
  await panel.getByRole('button', { name: /Run all/ }).click()
  await expect(panel.locator('.tests-summary .busy')).toHaveCount(0, { timeout: 90_000 })
  await expect(count('failed')).toHaveText('2')
  await expect(count('passed')).toHaveText('7')
  await expect(count('skipped')).toHaveText('1')
  await expect(count('all')).toHaveText('10')
  // The marked live-result lines are hidden from the output.
  await panel.getByRole('button', { name: 'Output' }).click()
  await expect(panel.locator('.tests-output')).not.toContainText('@@vibe-coding-ide')
  await panel.getByRole('button', { name: 'Details' }).click()

  // Files holding a failure are expanded; selecting a failed test shows its error.
  const failing = panel.locator('.test-row.kind-test', { hasText: 'fails on purpose' }).first()
  await failing.click()
  await expect(panel.locator('.tests-details')).toContainText('expected 4 to be 5')

  // Run a single test: only it changes.
  const adds = panel.locator('.test-row.kind-test', { hasText: 'adds numbers' })
  await adds.hover()
  await adds.locator('.test-run').click()
  await expect(adds.locator('.test-status')).toHaveClass(/st-passed/, { timeout: 60_000 })
  await expect(count('failed')).toHaveText('2')

  // The console output of the runs.
  await panel.getByRole('button', { name: 'Output' }).click()
  await expect(panel.locator('.tests-output')).toContainText('$ vitest run')

  // Status filters (connected buttons): failed, passed, skipped, then all again.
  const filter = (name: string) => panel.getByRole('radio', { name: new RegExp(name) })
  await filter('Show failed').click()
  await expect(filter('Show failed')).toHaveAttribute('aria-checked', 'true')
  await expect(panel.locator('.test-row.kind-test')).toHaveText([/fails on purpose/, /fails on purpose/])
  await filter('Show passed').click()
  await expect(panel.locator('.test-row.kind-test')).toHaveCount(7)
  await filter('Show skipped').click()
  await expect(panel.locator('.test-row.kind-test')).toHaveText([/is skipped/])
  // Combined with the name filter; nothing matches: a message.
  await panel.locator('.tests-filter').fill('nested')
  await expect(panel.locator('.tests-empty')).toHaveText('No skipped tests matching “nested”.')
  await filter('Show all').click()
  await expect(panel.locator('.test-row.kind-test')).toHaveText([/multiplies/])
})
