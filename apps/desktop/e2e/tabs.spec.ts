import { expect, test } from '@playwright/test'
import { cleanup, closeApp, launch, quit, tempDir, terminalText, type TestApp, typeInTerminal } from './app'

let hub: TestApp
let profile: string

test.beforeEach(async () => {
  profile = tempDir('profile')
  hub = await launch(profile)
})

test.afterEach(async () => {
  await closeApp(hub)
  cleanup(profile)
})

test('starts with a working shell tab', async () => {
  const { page } = hub
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab-panel.visible .terminal-host')).toBeVisible()
  await typeInTerminal(page, 'echo vibe-coding-ide-e2e-ok')
  await expect.poll(() => terminalText(page)).toMatch(/vibe-coding-ide-e2e-ok[\s\S]*vibe-coding-ide-e2e-ok/) // typed command + its output
})

test('the + launcher lists projects, shells and AI agents (with their logos), and opens a new tab', async () => {
  const { page } = hub
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.locator('.new-tab').click()
  const launcher = page.locator('.launcher')
  await expect(launcher).toBeVisible()
  await expect(launcher.locator('.launcher-group-label')).toContainText(['Projects', 'Shells'])
  // Each category has its logo; each AI agent (fake ones on PATH) its own logo.
  await expect(launcher.locator('.launcher-group-label .launcher-category-icon').first()).toBeVisible()
  const agents = launcher.locator('.launcher-group', { hasText: 'AI agents' })
  await expect(agents.locator('.agent-logo')).toHaveCount(5)
  for (const agent of ['claude', 'codex', 'gemini', 'opencode', 'pi']) await expect(agents.locator(`.agent-logo.${agent} svg`)).toHaveCount(1)
  // The keyboard moves the selection.
  await page.keyboard.press('ArrowDown')
  await expect(launcher.locator('.launcher-item.selected .launcher-item-name')).not.toHaveText('Open project…')
  await page.keyboard.press('ArrowUp')

  // Search narrows the list; Enter opens the selected entry.
  await launcher.locator('input').fill('open project…')
  await expect(launcher.locator('.launcher-item:not(.disabled)')).toHaveCount(1)
  await expect(launcher.locator('.launcher-item-name').first()).toHaveText('Open project…')
  // Shells, distributions and agents show their name only (no path).
  await expect(launcher.locator('.launcher-group', { hasText: 'Shells' }).locator('.launcher-item-source')).toHaveCount(0)
  await launcher.locator('input').fill('')
  await launcher.locator('.launcher-group', { hasText: 'Shells' }).locator('.launcher-item').first().click()
  await expect(launcher).toBeHidden()
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', /tab-/)
  // Closing the launcher must not break the page (an effect once returned a Promise).
  expect(errors).toEqual([])
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

test('after closing the last tab, the next start shows the welcome screen', async () => {
  let { page } = hub
  await expect(page.locator('.tab')).toHaveCount(1)
  // Closing the last tab closes the window (and, without other windows, the app on Windows / Linux).
  const exited = hub.app.waitForEvent('close')
  const windowClosed = page.waitForEvent('close')
  await page.locator('.tab').first().hover()
  // The window closes during the click: Playwright may report the page gone, which is the point.
  await page
    .locator('.tab')
    .first()
    .locator('.tab-close')
    .click()
    .catch(() => undefined)
  await windowClosed
  if (process.platform === 'darwin') await hub.app.close()
  await exited

  hub = await launch(profile)
  page = hub.page
  await expect(page.locator('.welcome')).toBeVisible()
  await expect(page.locator('.tab')).toHaveCount(0)
})
