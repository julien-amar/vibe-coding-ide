import { expect, test } from '@playwright/test'
import { cleanup, closeApp, launch, quit, tempDir, terminalText, type TestApp } from './app'

/** k9s: one launcher entry; the tab's dropdown chooses the context (fake kubectl: dev, prod current; fake k9s). */
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

test('k9s: one launcher entry; the tab chooses the context (k9s restarts on it), kept after a restart', async () => {
  let { page } = hub
  await page.keyboard.press('ControlOrMeta+t')
  // One entry, whatever the number of contexts.
  await expect(page.locator('.launcher-item', { hasText: 'k9s' })).toHaveCount(1)
  await page.locator('.launcher-item', { hasText: 'k9s' }).click()

  // Opens on the current context; the dropdown lists every context.
  const tab = page.locator('.tab-panel.visible')
  const context = tab.getByRole('combobox', { name: 'Kubernetes context' })
  await expect(context.locator('option')).toHaveText(['prod (current)', 'dev'])
  await expect(context.locator('option:checked')).toHaveText('prod (current)')
  await expect.poll(() => terminalText(page)).toContain('fake k9s --context prod')

  // Another context: k9s restarts on it, in the same tab.
  await context.selectOption({ label: 'dev' })
  await expect.poll(() => terminalText(page)).toContain('fake k9s --context dev')
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(page.locator('.tab.active')).toContainText('k9s · dev')

  // Settings: a context hidden is not offered (the tab's own stays listed while it is on it).
  await page.keyboard.press('ControlOrMeta+t')
  await page
    .locator('.launcher')
    .getByRole('button', { name: /Settings/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('switch', { name: /k9s · prod/ }).click()
  await page.keyboard.press('Escape')

  // Restart: the tab comes back on its context.
  await quit(hub)
  hub = await launch(profile)
  page = hub.page
  await page.locator('.tab', { hasText: 'k9s' }).click()
  await expect.poll(() => terminalText(page)).toContain('fake k9s --context dev')
  const after = page.locator('.tab-panel.visible').getByRole('combobox', { name: 'Kubernetes context' })
  await expect(after.locator('option:checked')).toHaveText('dev')
  await expect(after.locator('option')).toHaveText(['dev'])
})
