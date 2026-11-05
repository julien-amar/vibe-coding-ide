import { expect, test } from '@playwright/test'
import { cleanup, launch, quit, tempDir, terminalText, typeInTerminal, type DevHub } from './app'

let hub: DevHub
let profile: string

test.beforeEach(async () => {
  profile = tempDir('profile')
  hub = await launch(profile)
})

test.afterEach(async () => {
  await hub.app.close().catch(() => undefined)
  cleanup(profile)
})

test('starts with a working shell tab', async () => {
  const { page } = hub
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab-panel.visible .terminal-host')).toBeVisible()
  await typeInTerminal(page, 'echo devhub-e2e-ok')
  await expect.poll(() => terminalText(page)).toMatch(/devhub-e2e-ok[\s\S]*devhub-e2e-ok/) // typed command + its output
})

test('the + launcher lists projects and shells, and opens a new tab', async () => {
  const { page } = hub
  await page.locator('.new-tab').click()
  const launcher = page.locator('.launcher')
  await expect(launcher).toBeVisible()
  await expect(launcher.locator('.launcher-group-label')).toContainText(['Projects', 'Shells'])

  // Search narrows the list; Enter opens the selected entry.
  await launcher.locator('input').fill('open folder…')
  await expect(launcher.locator('.launcher-item:not(.disabled)')).toHaveCount(1)
  await expect(launcher.locator('.launcher-item-name').first()).toHaveText('Open folder…')
  await launcher.locator('input').fill('')
  await launcher.locator('.launcher-group', { hasText: 'Shells' }).locator('.launcher-item').first().click()
  await expect(launcher).toBeHidden()
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', /tab-/)
})

test('tabs can be renamed, reordered and closed', async () => {
  const { page } = hub
  await page.locator('.new-tab').click()
  await page.locator('.launcher-group', { hasText: 'Shells' }).locator('.launcher-item').first().click()
  await expect(page.locator('.tab')).toHaveCount(2)

  // Rename by double-click.
  await page.locator('.tab').first().dblclick()
  await expect(page.locator('.tab-rename')).toBeFocused()
  await page.locator('.tab-rename').fill('First tab')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tab').first().locator('.tab-title')).toHaveText('First tab')

  // Reorder by drag and drop onto the right half of the second tab (tab widths differ per OS).
  const target = page.locator('.tab').nth(1)
  const box = (await target.boundingBox())!
  await page.locator('.tab').first().dragTo(target, { targetPosition: { x: box.width * 0.75, y: box.height / 2 } })
  await expect(page.locator('.tab').nth(1).locator('.tab-title')).toHaveText('First tab')

  // Close with ×.
  await page.locator('.tab').nth(1).hover()
  await page.locator('.tab').nth(1).locator('.tab-close').click()
  await expect(page.locator('.tab')).toHaveCount(1)
})

test('the layout and tab names are restored after a restart', async () => {
  let { page } = hub
  await page.locator('.tab').first().dblclick()
  await expect(page.locator('.tab-rename')).toBeFocused()
  await page.locator('.tab-rename').fill('Keep me')
  await page.keyboard.press('Enter')
  await typeInTerminal(page, 'echo before-restart')
  await expect.poll(() => terminalText(page)).toMatch(/before-restart[\s\S]*before-restart/)

  await quit(hub)
  hub = await launch(profile)
  page = hub.page
  await expect(page.locator('.tab').first().locator('.tab-title')).toHaveText('Keep me')
  // Previous output is shown above the restore marker.
  await expect.poll(() => terminalText(page)).toContain('restored from previous session')
  expect(await terminalText(page)).toContain('before-restart')
})
