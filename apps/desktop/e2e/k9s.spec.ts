import { expect, test } from '@playwright/test'
import { cleanup, closeApp, launch, tempDir, terminalText, type TestApp } from './app'

/** k9s in the launcher's Tools: one entry per kubectl context (fake kubectl: dev, prod current; fake k9s). */
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

test('k9s: one launcher entry per kubectl context, opened in a terminal tab on that context', async () => {
  const { page } = hub
  await page.keyboard.press('ControlOrMeta+t')
  const entries = page.locator('.launcher-item', { hasText: 'k9s' })
  // The current context first.
  await expect(entries).toHaveText([/k9s · prod \(current\)/, /k9s · dev/])

  await entries.filter({ hasText: 'k9s · dev' }).click()
  await expect(page.locator('.tab.active')).toContainText('k9s · dev')
  await expect.poll(() => terminalText(page)).toContain('fake k9s --context dev')

  // Settings: the Tools section, where they can be hidden.
  await page.keyboard.press('ControlOrMeta+t')
  await page
    .locator('.launcher')
    .getByRole('button', { name: /Settings/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('switch', { name: /k9s · dev/ })).toBeVisible()
  await dialog.getByRole('switch', { name: /k9s · dev/ }).click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+t')
  await expect(page.locator('.launcher-item', { hasText: 'k9s' })).toHaveText([/k9s · prod \(current\)/])
})
