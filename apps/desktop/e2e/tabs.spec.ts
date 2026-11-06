import { expect, test } from '@playwright/test'
import { cleanup, launch, quit, tempDir, terminalText, typeInTerminal, type TestApp } from './app'

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

test('starts with a working shell tab', async () => {
  const { page } = hub
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab-panel.visible .terminal-host')).toBeVisible()
  await typeInTerminal(page, 'echo vibe-coding-ide-e2e-ok')
  await expect.poll(() => terminalText(page)).toMatch(/vibe-coding-ide-e2e-ok[\s\S]*vibe-coding-ide-e2e-ok/) // typed command + its output
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

  // Reorder by drag and drop onto the right half of the second tab. The drag events are dispatched
  // in the page: a mouse-driven HTML5 drag goes through the OS drag loop, which on Windows runners
  // sometimes shows the drop marker but never delivers the drop.
  const tabs = page.locator('.tab')
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const at = async (el: typeof tabs, fx: number): Promise<{ clientX: number; clientY: number; screenX: number; screenY: number }> => {
    const b = (await el.boundingBox())!
    const s = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }))
    const p = { clientX: b.x + b.width * fx, clientY: b.y + b.height / 2 }
    return { ...p, screenX: s.x + p.clientX, screenY: s.y + p.clientY + 30 }
  }
  await tabs.first().dispatchEvent('dragstart', { dataTransfer: dt, ...(await at(tabs.first(), 0.5)) })
  await tabs.nth(1).dispatchEvent('dragover', { dataTransfer: dt, ...(await at(tabs.nth(1), 0.75)) })
  await expect(tabs.nth(1)).toHaveClass(/drop-after/)
  await tabs.nth(1).dispatchEvent('drop', { dataTransfer: dt, ...(await at(tabs.nth(1), 0.75)) })
  await page.evaluate((d) => (d.dropEffect = 'move'), dt)
  await tabs.first().dispatchEvent('dragend', { dataTransfer: dt, ...(await at(tabs.first(), 0.5)) })
  await expect(tabs.nth(1).locator('.tab-title')).toHaveText('First tab')
  await expect(tabs).toHaveCount(2)

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
