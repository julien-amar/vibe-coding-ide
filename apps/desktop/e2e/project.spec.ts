import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanup, createRepo, launch, openProject, tempDir, type TestApp } from './app'

let hub: TestApp
let profile: string
let work: string
let repo: string

const panel = (page: Page) => page.locator('.tab-panel.visible')
const gitPanel = (page: Page) => panel(page).locator('.git-panel')
const view = (page: Page, name: 'History' | 'Changes' | 'Branches') => gitPanel(page).locator('.segmented button', { hasText: name }).click()

test.beforeEach(async () => {
  profile = tempDir('profile')
  work = tempDir('work')
  repo = createRepo(work)
  hub = await launch(profile)
  await openProject(hub.page, repo)
})

test.afterEach(async () => {
  await hub.app.close().catch(() => undefined)
  cleanup(profile)
  cleanup(work)
})

test('a project shows the git history with the branch graph and a terminal in the folder', async () => {
  const { page } = hub
  await expect(page.locator('.tab.active .tab-title')).toHaveText('demo-repo')
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(5)
  await expect(gitPanel(page).locator('.git-row').first()).toContainText('Rename login to auth')
  await expect(gitPanel(page).locator('.git-toolbar .ref-badge').first()).toHaveText('main')
  // The terminal panel runs in the project folder.
  await expect(panel(page).locator('.pane-path').first()).toContainText('demo-repo')
})

test('clicking a commit shows its files and the diff of the selected file', async () => {
  const { page } = hub
  await gitPanel(page).locator('.git-row', { hasText: 'Update README' }).click()
  const details = gitPanel(page).locator('.commit-details')
  await expect(details.locator('.commit-subject')).toHaveText('Update README')
  await expect(details.locator('.file-row')).toHaveCount(1)
  await expect(details.locator('.diff-line.add')).toContainText(['+world'])

  // A rename is shown as old → new, with only the real change in the diff.
  await gitPanel(page).locator('.git-row', { hasText: 'Rename login to auth' }).click()
  await expect(details.locator('.file-row')).toContainText(['auth.ts'])
  await expect(details.locator('.file-row .file-dir')).toContainText(['src/login.ts'])

  // Merge commits are compared with their first parent.
  await gitPanel(page).locator('.git-row', { hasText: 'Merge feature/login' }).click()
  await expect(details.locator('.commit-header')).toContainText('first parent')
  await expect(details.locator('.file-row')).toContainText(['login.ts'])

  await details.locator('button[title="Close commit details"]').click()
  await expect(details).toBeHidden()
})

test('changes can be staged and committed from the Changes view', async () => {
  const { page } = hub
  appendFileSync(join(repo, 'README.md'), 'from e2e\n')
  await view(page, 'Changes')
  const changes = gitPanel(page).locator('.changes-view')
  await expect(changes.locator('.file-row', { hasText: 'README.md' })).toBeVisible()

  await changes.locator('.file-row', { hasText: 'README.md' }).click()
  await expect(changes.locator('.diff-line.add')).toContainText(['+from e2e'])

  await changes.locator('.link-button', { hasText: 'Stage all' }).click()
  await expect(changes.locator('.file-group-header', { hasText: 'Staged' }).locator('.count')).toHaveText('1')
  await changes.locator('.commit-box textarea').fill('Commit from the e2e test')
  await changes.locator('.commit-row button.primary').click()
  await expect(page.locator('.toast', { hasText: 'Committed' })).toBeVisible()

  await view(page, 'History')
  await expect(gitPanel(page).locator('.git-row').first()).toContainText('Commit from the e2e test')
})

test('branches can be created and switched from the Branches view', async () => {
  const { page } = hub
  await view(page, 'Branches')
  await gitPanel(page).locator('.branches-actions button', { hasText: 'New branch' }).click()
  await page.locator('.dialog input').first().fill('fix/e2e')
  await page.locator('.dialog button', { hasText: 'Create' }).click()
  await expect(gitPanel(page).locator('.branch-row.current .branch-name')).toHaveText('fix/e2e')

  await gitPanel(page).locator('.branch-row', { hasText: 'main' }).hover()
  await gitPanel(page).locator('.branch-row', { hasText: 'main' }).locator('button', { hasText: 'Switch' }).click()
  await expect(gitPanel(page).locator('.branch-row.current .branch-name')).toHaveText('main')
})

test('panels can be collapsed, closed and added back', async () => {
  const { page } = hub
  const gitPane = panel(page).locator('.pane', { has: page.locator('.pane-title', { hasText: 'Git' }) })

  // Collapse to the side rail and bring back.
  await gitPane.locator('button[title^="Collapse"]').click()
  await expect(gitPanel(page)).toBeHidden()
  await panel(page).locator('.rail-item', { hasText: 'Git' }).click()
  await expect(gitPanel(page)).toBeVisible()

  // The Git panel has no split buttons; terminals do.
  await expect(gitPane.locator('button[title="Split right"]')).toHaveCount(0)

  // Close, then add back from the rail's + menu (real clicks: the menu must be on top).
  await gitPane.locator('button[title^="Close panel"]').click()
  await expect(gitPanel(page)).toBeHidden()
  await panel(page).locator('.rail-item.add').click()
  await page.locator('.rail-menu button', { hasText: 'Git' }).click()
  await expect(gitPanel(page)).toBeVisible()
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(5)
})
