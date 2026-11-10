import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanup, closeApp, createRepo, launch, openProject, tempDir, type TestApp } from './app'

/** Project folders and their git repositories: none, several, a long history. */
let hub: TestApp
let profile: string
let work: string

const panel = (page: Page) => page.locator('.tab-panel.visible')
const gitPanel = (page: Page) => panel(page).locator('.git-panel')
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
/** A history row by its commit's subject (after its branch badges). */
const commitRow = (page: Page, subject: string) =>
  gitPanel(page).locator('.git-row', { has: page.locator('.git-subject', { hasText: new RegExp(`(^|[^\\d])${subject}$`) }) })
/** The repository dropdown of the Git panel. */
const repoButton = (page: Page) => gitPanel(page).getByRole('button', { name: /^Repository: / })
async function chooseRepo(page: Page, name: string): Promise<void> {
  await repoButton(page).click()
  await page.getByRole('listbox', { name: 'Repository' }).getByRole('option', { name }).click()
}

/** A repository with `n` commits ("Commit 1" … "Commit n"), made at once with git fast-import. */
function repoWithCommits(dir: string, n: number): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  let stream = ''
  for (let i = 1; i <= n; i++) {
    const msg = `Commit ${i}\n`
    const content = `${i}\n`
    stream += `commit refs/heads/main\ncommitter Test <test@example.com> ${1_700_000_000 + i * 60} +0000\ndata ${msg.length}\n${msg}M 644 inline counter.txt\ndata ${content.length}\n${content}\n`
  }
  execFileSync('git', ['-C', dir, 'fast-import', '--quiet'], { input: stream })
  git(dir, 'reset', '-q', '--hard', 'main')
}

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

test('a folder without any git repository has no Git panel, and none can be added', async () => {
  const { page } = hub
  const folder = join(work, 'plain-folder')
  mkdirSync(folder)
  writeFileSync(join(folder, 'notes.txt'), 'no repository here\n')
  await page.evaluate(
    (r) => (window as unknown as { __vibeIdeTabs: { getState(): { openProject(root: string): Promise<void> } } }).__vibeIdeTabs.getState().openProject(r),
    folder
  )
  await expect(panel(page).locator('.pane-header').first()).toBeVisible()
  await expect(panel(page).locator('.pane-title', { hasText: 'Git' })).toHaveCount(0)
  await expect(panel(page).locator('.rail-item', { hasText: 'Git' })).toHaveCount(0)
  await panel(page).locator('.rail-item.add').click()
  await expect(page.locator('.rail-menu button', { hasText: 'Terminal' })).toBeVisible()
  await expect(page.locator('.rail-menu button', { hasText: 'Git' })).toHaveCount(0)
})

test('several repositories in the folder: a dropdown chooses the one shown', async () => {
  const { page } = hub
  const folder = join(work, 'workspace')
  mkdirSync(folder)
  createRepo(folder) // workspace/demo-repo: 5 commits
  repoWithCommits(join(folder, 'libs', 'other'), 2)
  // Dependencies are not looked into.
  mkdirSync(join(folder, 'node_modules', 'dep', '.git'), { recursive: true })

  await openProject(page, folder)
  // Left of the views, on the first repository.
  await expect(repoButton(page)).toHaveAccessibleName('Repository: demo-repo')
  const toolbar = gitPanel(page).locator('.git-toolbar')
  expect((await repoButton(page).boundingBox())!.x).toBeLessThan((await toolbar.getByRole('tab', { name: /^History/ }).boundingBox())!.x)
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(5)
  await repoButton(page).click()
  // (The current one is ticked.)
  await expect(page.getByRole('listbox', { name: 'Repository' }).getByRole('option')).toHaveText([/^demo-repo/, /^libs\/other/])
  await page.keyboard.press('Escape')

  await chooseRepo(page, 'libs/other')
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(2)
  await expect(commitRow(page, 'Commit 2')).toBeVisible()
  await chooseRepo(page, 'demo-repo')
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(5)
})

test('one repository: no dropdown', async () => {
  const { page } = hub
  await openProject(page, createRepo(work))
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(5)
  await expect(repoButton(page)).toHaveCount(0)
})

test('the history shows the last 1000 commits; a link below them loads the next ones', async () => {
  const { page } = hub
  const folder = join(work, 'long-history')
  repoWithCommits(folder, 1050)
  await openProject(page, folder)

  const rows = gitPanel(page).locator('.git-rows')
  const more = gitPanel(page).locator('.git-more')
  await expect(more).toHaveText('Load next page')
  await expect(commitRow(page, 'Commit 1050')).toBeVisible()
  await rows.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(commitRow(page, 'Commit 51')).toBeVisible()
  await expect(commitRow(page, 'Commit 50')).toHaveCount(0)

  await more.getByRole('button', { name: 'Load next page' }).click()
  await expect(more).toHaveCount(0)
  await rows.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(commitRow(page, 'Commit 1')).toBeVisible()
})
