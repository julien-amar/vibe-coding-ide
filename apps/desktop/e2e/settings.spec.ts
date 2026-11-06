import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanup, closeApp, createRepo, launch, openProject, tempDir, type TestApp } from './app'

let hub: TestApp
let profile: string
let work: string

test.beforeEach(async () => {
  profile = tempDir('profile')
  work = tempDir('work')
  hub = await launch(profile)
})

test.afterEach(async () => {
  await closeApp(hub)
  cleanup(profile)
  cleanup(work)
})

const openSettings = async (page: Page) => {
  await page.locator('.new-tab').click()
  await page.locator('.launcher button[aria-label="Settings"]').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await expect(page.locator('.launcher')).toHaveCount(0)
  return dialog
}
const savedSettings = (): Record<string, unknown> => {
  const file = join(profile, 'settings.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
}
const prefersDark = (page: Page): Promise<boolean> => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)

test('settings: theme, shown agents and WSL integration, saved and applied at once', async () => {
  const { page } = hub
  // Playwright emulates a light colour scheme by default, which would hide the app's own theme.
  await page.emulateMedia({ colorScheme: null })
  const dialog = await openSettings(page)

  // Theme: forced dark / light (every window's colours follow).
  await dialog.getByRole('radio', { name: 'Dark' }).click()
  await expect.poll(() => prefersDark(page)).toBe(true)
  await dialog.getByRole('radio', { name: 'Light' }).click()
  await expect.poll(() => prefersDark(page)).toBe(false)
  expect(savedSettings().theme).toBe('light')

  // Hide an agent: no longer offered by the launcher.
  await dialog.getByRole('switch', { name: 'Show pi' }).click()
  await expect(dialog.getByRole('switch', { name: 'Show pi' })).toHaveAttribute('aria-checked', 'false')
  expect(savedSettings().hiddenProfiles).toEqual(['agent:pi'])

  // WSL integration off: no distribution offered (and the list in Settings says why).
  await dialog.getByRole('switch', { name: 'WSL integration' }).click()
  await expect(dialog.locator('.settings-section').filter({ has: page.locator('h3', { hasText: 'WSL distributions' }) })).toContainText(
    'Turn WSL integration on'
  )
  expect(savedSettings().wsl).toBe(false)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.locator('.new-tab').click()
  const agents = page.locator('.launcher-group', { hasText: 'AI agents' })
  await expect(agents.locator('.launcher-item')).toHaveCount(4)
  await expect(agents).not.toContainText(/\bpi\b/)
  await expect(page.locator('.launcher-group', { hasText: 'WSL distributions' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Shown again.
  const again = await openSettings(page)
  await again.getByRole('switch', { name: 'Show pi' }).click()
  await page.keyboard.press('Escape')
  await page.locator('.new-tab').click()
  await expect(page.locator('.launcher-group', { hasText: 'AI agents' }).locator('.launcher-item')).toHaveCount(5)
})

test('reset layout: a project tab is rebuilt as a new one for its folder', async () => {
  const { page } = hub
  const repo = createRepo(work)
  await openProject(page, repo)
  const panel = page.locator('.tab-panel.visible')
  const layoutOf = () =>
    page.evaluate(() => {
      const st = (
        window as unknown as { __vibeIdeTabs: { getState(): { tabs: { project?: { layout: unknown } }[]; activeId: string } } }
      ).__vibeIdeTabs.getState()
      const walk = (n: {
        kind: string
        children?: unknown[]
        type?: string
        sessionId?: string
        collapsed?: boolean
      }): { type?: string; sessionId?: string; collapsed?: boolean }[] => (n.kind === 'split' ? (n.children as (typeof n)[]).flatMap(walk) : [n])
      const tab = st.tabs.find((t) => (t as { id?: string }).id === st.activeId)!
      return walk(tab.project!.layout as never).map((p) => ({ type: p.type, sessionId: p.sessionId, collapsed: !!p.collapsed }))
    })
  await expect.poll(async () => (await layoutOf()).filter((p) => p.sessionId).length).toBe(2)
  const before = await layoutOf()
  const terminalSession = before.find((p) => p.type === 'terminal')!.sessionId

  // A second terminal panel, and the Git panel collapsed into the side rail.
  await panel.locator('.rail-item.add').click()
  await page.locator('.rail-menu button', { hasText: 'Terminal' }).click()
  await expect.poll(async () => (await layoutOf()).filter((p) => p.type === 'terminal').length).toBe(2)

  await page.locator('.tab.active').click({ button: 'right' })
  await page.locator('.context-menu button', { hasText: 'Reset layout' }).click()
  await expect(page.locator('.dialog')).toContainText('gets the panels of a new project tab')
  await page.locator('.dialog button', { hasText: 'Reset' }).click()

  await expect.poll(async () => (await layoutOf()).map((p) => p.type).sort()).toEqual(['agent', 'git', 'terminal', 'tests'])
  // New processes for the terminal and the agent; Tests back in the side rail.
  await expect.poll(async () => (await layoutOf()).filter((p) => p.sessionId).length).toBe(2)
  const after = await layoutOf()
  expect(after.find((p) => p.type === 'terminal')!.sessionId).not.toBe(terminalSession)
  expect(after.find((p) => p.type === 'tests')!.collapsed).toBe(true)
  expect(after.find((p) => p.type === 'git')!.collapsed).toBe(false)
})

test('settings: version, default AI agent of new projects, reset to defaults; Ctrl+T opens the launcher', async () => {
  const { page } = hub
  // Ctrl+T: the launcher (new tab).
  await page.locator('.tab.active').click()
  await page.keyboard.press('ControlOrMeta+t')
  await expect(page.locator('.launcher')).toBeVisible()
  await page.keyboard.press('Escape')

  const dialog = await openSettings(page)
  // The app's version: bottom right corner (the footer).
  await expect(dialog.locator('.settings-foot .settings-version')).toHaveText(/v\d+\.\d+\.\d+$/)
  // No path or counter on the entries.
  await expect(dialog).not.toContainText('fake-tools')
  await expect(dialog).not.toContainText(' shown')

  // Default AI agent: new projects get it.
  await dialog.getByLabel('Default AI agent').selectOption('agent:codex')
  await expect.poll(() => savedSettings().defaultAgent).toBe('agent:codex')
  await page.keyboard.press('Escape')
  await openProject(page, createRepo(work))
  const agentPane = page.locator('.tab-panel.visible .profile-select-button').last()
  await expect(agentPane).toContainText('Codex CLI')

  // Reset to defaults (confirmed in place).
  const again = await openSettings(page)
  await again.getByRole('radio', { name: 'Dark' }).click()
  await again.getByRole('button', { name: 'Reset to defaults' }).click()
  await again.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(again.getByLabel('Default AI agent')).toHaveValue('')
  await expect(again.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  expect(savedSettings()).toEqual({ theme: 'system', wsl: true, hiddenProfiles: [] })
})

test('a recent project can be removed from the launcher (trash button on hover)', async () => {
  const { page } = hub
  const repo = createRepo(work)
  await openProject(page, repo)
  await page.keyboard.press('ControlOrMeta+t')
  const row = page.locator('.launcher-row', { hasText: 'demo-repo' })
  await expect(row).toBeVisible()
  // Only recent projects have one ("Open project…" does not).
  await expect(page.locator('.launcher-row', { hasText: 'Open project…' }).locator('.launcher-remove')).toHaveCount(0)
  await row.hover()
  await expect(row.locator('.launcher-remove')).toBeVisible()
  await row.locator('.launcher-remove').click()
  await expect(row).toHaveCount(0)
  // Gone for good (the open tab stays).
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+t')
  await expect(page.locator('.launcher')).toBeVisible()
  await expect(page.locator('.launcher-row', { hasText: 'demo-repo' })).toHaveCount(0)
  await expect(page.locator('.tab', { hasText: 'demo-repo' })).toHaveCount(1)
})
