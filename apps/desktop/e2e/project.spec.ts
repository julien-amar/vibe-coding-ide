import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { cleanup, closeApp, createRepo, launch, openProject, readLog, tempDir, type TestApp } from './app'

let hub: TestApp
let profile: string
let work: string
let repo: string

const panel = (page: Page) => page.locator('.tab-panel.visible')
const gitPanel = (page: Page) => panel(page).locator('.git-panel')
const view = (page: Page, name: 'History' | 'Changes' | 'Branches') =>
  gitPanel(page)
    .locator('.git-toolbar')
    .getByRole('tab', { name: new RegExp(`^${name}`) })
    .click()

test.beforeEach(async () => {
  profile = tempDir('profile')
  work = tempDir('work')
  repo = createRepo(work)
  hub = await launch(profile)
  await openProject(hub.page, repo)
})

test.afterEach(async () => {
  await closeApp(hub)
  cleanup(profile)
  cleanup(work)
})

test('a project shows the git history with the branch graph and a terminal in the folder', async () => {
  const { page } = hub
  await expect(page.locator('.tab.active .tab-title')).toHaveText('demo-repo')
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(5)
  await expect(gitPanel(page).locator('.git-row').first()).toContainText('Rename login to auth')
  await expect(gitPanel(page).locator('.git-toolbar .ref-badge').first()).toHaveText('main')
  // Terminal and agent panel headers show the shell / agent, not the folder (it is the project's).
  await expect(panel(page).locator('.pane-header').filter({ hasText: 'demo-repo' })).toHaveCount(0)
  // No package updates bar in a project's terminal panel (terminal tabs only); the check is not even run.
  await page.waitForTimeout(3000)
  await expect(panel(page).locator('.update-bar')).toHaveCount(0)
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

  // Amend: the last commit's message comes into the box, to edit it; unchecked, it goes away.
  const box = changes.locator('.commit-box textarea')
  await changes.getByLabel('Amend last commit').check()
  await expect(box).toHaveValue('Commit from the e2e test')
  await box.fill('Commit from the e2e test, amended')
  await changes.locator('.commit-row button.primary').click()
  await expect(page.locator('.toast', { hasText: 'Commit amended' })).toBeVisible()

  await view(page, 'History')
  await expect(gitPanel(page).locator('.git-row').first()).toContainText('Commit from the e2e test, amended')
})

test('hunks and single lines can be staged, unstaged and discarded (in a small window)', async () => {
  const { page } = hub
  // A small window, like CI runners': a short, narrow Git panel must keep its files and buttons usable.
  await page.setViewportSize({ width: 800, height: 600 })
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  const original = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  writeFileSync(join(repo, 'list.txt'), original)
  git('add', 'list.txt')
  git('commit', '-q', '-m', 'Add list')
  // Two hunks: line 2 changed (+ a line added), line 11 removed.
  writeFileSync(join(repo, 'list.txt'), original.replace('line 2\n', 'line TWO\nadded\n').replace('line 11\n', ''))

  await view(page, 'Changes')
  const changes = gitPanel(page).locator('.changes-view')
  await changes.locator('.file-row', { hasText: 'list.txt' }).click()
  const diff = changes.locator('.changes-diff')
  await expect(diff.locator('.diff-line.hunk')).toHaveCount(2)

  // Stage the second hunk only.
  await diff.locator('.diff-line.hunk').nth(1).locator('button', { hasText: 'Stage' }).click()
  await expect.poll(() => git('show', ':list.txt')).toBe(original.replace('line 11\n', ''))
  await expect(diff.locator('.diff-line.hunk')).toHaveCount(1)

  // Select the added line alone and stage it (the "line TWO" change stays unstaged).
  await diff.locator('.diff-line.add', { hasText: '+added' }).click()
  await expect(diff.locator('.diff-selection-bar')).toContainText('1 line selected')
  await diff.locator('.diff-selection-bar button', { hasText: 'Stage' }).click()
  await expect.poll(() => git('show', ':list.txt')).toBe(original.replace('line 2\n', 'line 2\nadded\n').replace('line 11\n', ''))

  // Discard the remaining change (line 2 → line TWO), after confirming — once the diff shows the
  // staged line gone (acting on the previous diff is refused: "the file changed meanwhile").
  await expect(diff.locator('.diff-line.add', { hasText: '+added' })).toHaveCount(0)
  await expect(diff.locator('.diff-line.hunk')).toHaveCount(1)
  await diff.locator('.diff-line.hunk button', { hasText: 'Discard' }).click()
  await page.locator('.dialog button', { hasText: 'Discard' }).click()
  await expect.poll(() => readFileSync(join(repo, 'list.txt'), 'utf8')).toBe(original.replace('line 2\n', 'line 2\nadded\n').replace('line 11\n', ''))

  // Unstage the added line from the staged diff.
  await changes.locator('.file-row', { hasText: 'list.txt' }).first().click()
  await expect(diff.locator('.diff-title')).toContainText('staged')
  await diff.locator('.diff-line.add', { hasText: '+added' }).click()
  await diff.locator('.diff-selection-bar button', { hasText: 'Unstage' }).click()
  await expect.poll(() => git('show', ':list.txt')).toBe(original.replace('line 11\n', ''))
})

test('Shift+click selects a range of changed lines, staged at once', async () => {
  const { page } = hub
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  writeFileSync(join(repo, 'range.txt'), 'top\nbottom\n')
  git('add', 'range.txt')
  git('commit', '-q', '-m', 'Add range')
  writeFileSync(join(repo, 'range.txt'), 'top\none\ntwo\nthree\nfour\nbottom\n')

  await view(page, 'Changes')
  const changes = gitPanel(page).locator('.changes-view')
  await changes.locator('.file-row', { hasText: 'range.txt' }).click()
  const diff = changes.locator('.changes-diff')
  // Once the diff is the tracked file's (its hunk has Stage / Discard): lines can be selected.
  await expect(diff.locator('.diff-line.hunk button', { hasText: 'Stage' })).toBeVisible()
  await diff.locator('.diff-line.add', { hasText: '+one' }).click()
  await diff.locator('.diff-line.add', { hasText: '+three' }).click({ modifiers: ['Shift'] })
  await expect(diff.locator('.diff-selection-bar')).toContainText('3 lines selected')
  await expect(diff.locator('.diff-line.line-selected')).toHaveText(['+one', '+two', '+three'])
  await diff.locator('.diff-selection-bar button', { hasText: 'Stage' }).click()
  await expect.poll(() => git('show', ':range.txt')).toBe('top\none\ntwo\nthree\nbottom\n')
})

test('dragging over changed lines selects them (from a selected line: unselects them); a click still toggles one', async () => {
  const { page } = hub
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  writeFileSync(join(repo, 'range.txt'), 'top\nbottom\n')
  git('add', 'range.txt')
  git('commit', '-q', '-m', 'Add range')
  writeFileSync(join(repo, 'range.txt'), 'top\none\ntwo\nthree\nfour\nbottom\n')

  // Full screen: room for the diff's lines (the mouse moves over them where they are on screen).
  await panel(page)
    .locator('.pane', { has: page.locator('.git-panel') })
    .getByRole('button', { name: 'Full screen' })
    .click()
  await view(page, 'Changes')
  const changes = gitPanel(page).locator('.changes-view')
  await changes.locator('.file-row', { hasText: 'range.txt' }).click()
  const diff = changes.locator('.changes-diff')
  await expect(diff.locator('.diff-line.hunk button', { hasText: 'Stage' })).toBeVisible()
  await diff.locator('.diff-line', { hasText: 'bottom' }).scrollIntoViewIfNeeded()
  const line = (text: string) => diff.locator('.diff-line.add', { hasText: text })
  /** The button pressed on a line, moved over others (up or down), released on the last one. */
  const drag = async (...texts: string[]): Promise<void> => {
    const at = async (text: string): Promise<{ x: number; y: number }> => {
      const b = (await line(text).boundingBox())!
      return { x: b.x + 40, y: b.y + b.height / 2 }
    }
    const first = await at(texts[0])
    await page.mouse.move(first.x, first.y)
    await page.mouse.down()
    for (const t of texts.slice(1)) {
      const p = await at(t)
      await page.mouse.move(p.x, p.y, { steps: 4 })
    }
    await page.mouse.up()
  }

  // Downwards: the lines are selected (lines, not text).
  await drag('+one', '+two', '+three')
  await expect(diff.locator('.diff-line.line-selected')).toHaveText(['+one', '+two', '+three'])
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
  // Starting on a selected line, upwards: the lines moved over are unselected.
  await drag('+three', '+two')
  await expect(diff.locator('.diff-line.line-selected')).toHaveText(['+one'])
  await drag('+four', '+three')
  await expect(diff.locator('.diff-selection-bar')).toContainText('3 lines selected')
  await expect(diff.locator('.diff-line.line-selected')).toHaveText(['+one', '+three', '+four'])
  // A click (no move) still toggles one line.
  await line('+two').click()
  await expect(diff.locator('.diff-line.line-selected')).toHaveText(['+one', '+two', '+three', '+four'])
  await line('+two').click()
  await expect(diff.locator('.diff-line.line-selected')).toHaveText(['+one', '+three', '+four'])

  await diff.locator('.diff-selection-bar button', { hasText: 'Stage' }).click()
  await expect.poll(() => git('show', ':range.txt')).toBe('top\none\nthree\nfour\nbottom\n')
})

test('a pull request is created with gh (branch pushed first), then opened', async () => {
  const { page } = hub
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  // A GitHub remote whose pushes go to a local bare repository.
  const origin = join(work, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  git('remote', 'add', 'origin', 'https://github.com/e2e/demo-repo.git')
  git('config', `url.${pathToFileURL(origin).href}.pushInsteadOf`, 'https://github.com/e2e/demo-repo.git')
  git('push', '-q', '-u', 'origin', 'main')
  git('switch', '-q', '-c', 'feature/pr')
  writeFileSync(join(repo, 'pr.txt'), 'pr\n')
  git('add', 'pr.txt')
  git('commit', '-q', '-m', 'Add the PR file')
  const ghLog = join(profile, 'fake-gh.log')
  const browserLog = join(profile, 'browser.log')

  await expect(gitPanel(page).locator('.git-toolbar .ref-badge').first()).toHaveText('feature/pr')
  await gitPanel(page).locator('.git-toolbar button', { hasText: 'Pull request' }).click()
  const dialog = page.locator('.dialog')
  await expect(dialog.locator('h2')).toHaveText('New pull request')
  await expect(dialog.locator('input').first()).toHaveValue('Add the PR file')
  await dialog.locator('textarea').fill('First line\n"quoted" second line')
  await expect(dialog.locator('select')).toHaveValue('main')
  await dialog.locator('button', { hasText: 'Push & create' }).click()

  await expect(page.locator('.toast', { hasText: 'Created https://github.com/e2e/demo-repo/pull/1' })).toBeVisible()
  expect(readLog(browserLog)).toContain('https://github.com/e2e/demo-repo/pull/1')
  // Pushed (published) first, then created with the exact description.
  expect(execFileSync('git', ['--git-dir', origin, 'branch', '--list', 'feature/pr'], { encoding: 'utf8' })).toContain('feature/pr')
  const create = readLog(ghLog)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])
    .find((a) => a[1] === 'create')
  expect(create).toEqual(expect.arrayContaining(['--title=Add the PR file', '--body=First line\n"quoted" second line', '--base=main', '--head=feature/pr']))

  // The branch now has an open pull request: the button opens it.
  await gitPanel(page).locator('.git-toolbar button', { hasText: 'Pull request' }).click()
  await expect(page.locator('.toast', { hasText: '#1: Add the PR file' })).toBeVisible()
  expect(readLog(browserLog).trim().split('\n')).toHaveLength(2)
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

  // The Git panel has no split buttons; terminals do. Terminal / AI agent panels have no Restart button.
  await expect(gitPane.locator('button[title="Split right"]')).toHaveCount(0)
  await expect(panel(page).locator('.pane-header button[title="Restart"]')).toHaveCount(0)

  // Git's Refresh: the history reloads (never "not a git repository" meanwhile).
  await gitPane.locator('.git-toolbar button[title="Refresh"]').click()
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(5)
  await expect(gitPanel(page)).not.toContainText('not a git repository')

  // Close, then add back from the rail's + menu (real clicks: the menu must be on top).
  await gitPane.locator('button[title^="Close panel"]').click()
  await expect(gitPanel(page)).toBeHidden()
  await panel(page).locator('.rail-item.add').click()
  await page.locator('.rail-menu button', { hasText: 'Git' }).click()
  await expect(gitPanel(page)).toBeVisible()
  await expect(gitPanel(page).locator('.git-row')).toHaveCount(5)
})

test('any panel can go full screen; Escape (or Restore) brings the layout back as it was', async () => {
  const { page } = hub
  const main = panel(page).locator('.project-main')
  const gitPane = panel(page).locator('.pane', { has: page.locator('.pane-title', { hasText: 'Git' }) })
  const termPane = panel(page)
    .locator('.pane', { has: page.locator('.terminal-host') })
    .first()
  await expect(termPane).toBeVisible()
  const before = (await gitPane.boundingBox())!

  // Git full screen: it takes the whole project area, the other panels are hidden.
  await gitPane.getByRole('button', { name: 'Full screen' }).click()
  const box = (await gitPane.boundingBox())!
  const area = (await main.boundingBox())!
  expect(Math.round(box.width)).toBe(Math.round(area.width))
  expect(Math.round(box.height)).toBe(Math.round(area.height))
  await expect(termPane).toBeHidden()
  // Escape (focus in the Git panel): back as it was.
  await gitPanel(page).locator('.git-row').first().click()
  await page.keyboard.press('Escape')
  await expect(termPane).toBeVisible()
  expect(await gitPane.boundingBox()).toEqual(before)

  // A terminal full screen (double-click on its header): Escape stays the program's; Restore brings it back.
  await termPane.locator('.pane-header').dblclick({ position: { x: 400, y: 10 } })
  await expect(gitPane).toBeHidden()
  await termPane.locator('.terminal-host').click()
  await page.keyboard.press('Escape')
  await expect(gitPane).toBeHidden()
  await termPane.getByRole('button', { name: 'Restore the layout' }).click()
  await expect(gitPane).toBeVisible()
  expect(await gitPane.boundingBox()).toEqual(before)
})
