import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { cleanup, createRepo, launch, openProject, quit, readLog, tempDir, type TestApp } from './app'

/** A minimal MCP server (stdio) with two tools. */
const FAKE_MCP = resolve(__dirname, 'fixtures', 'fake-tools', 'fake-mcp-server.cjs')

let hub: TestApp
let profile: string
let work: string

test.beforeEach(async () => {
  profile = tempDir('profile')
  work = tempDir('work')
  hub = await launch(profile)
})

test.afterEach(async () => {
  await hub.app.close().catch(() => undefined)
  cleanup(profile)
  cleanup(work)
})

/** Each start of the fake agent (its folder and arguments), latest last. */
const agentRuns = (): { cwd: string; args: string[] }[] =>
  readLog(`${hub.agentLog}.argv`)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { cwd: string; args: string[] })

/** Arguments of each start of the fake agent (optionally only in one project folder), latest last. */
const agentStarts = (inFolder?: string): string[][] =>
  agentRuns()
    .filter((r) => !inFolder || samePath(r.cwd, inFolder))
    .map((r) => r.args)

const samePath = (a: string, b: string): boolean => {
  const n = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n(a) === n(b)
}

/** The file given with a flag (e.g. --mcp-config) of an agent start, read. */
const flagFile = (args: string[], flag: string): string => readFileSync(args[args.indexOf(flag) + 1], 'utf8')

const agentPanes = (page: Page): Locator => page.locator('.tab-panel.visible .pane', { has: page.locator('.pane-header .agent-settings') })

/** Open an agent pane's settings dialog. */
async function openSettings(page: Page, pane: Locator): Promise<Locator> {
  await pane.locator('.agent-settings').click()
  const dialog = page.getByRole('dialog', { name: /settings/ })
  await expect(dialog).toBeVisible()
  return dialog
}

/** A repository created by createRepo, renamed (tabs are titled after the folder). */
function renameRepo(repo: string, name: string): string {
  const to = join(repo, '..', name)
  renameSync(repo, to)
  return to
}

async function addServer(dialog: Locator, name: string, args: string, env = ''): Promise<void> {
  await dialog.getByRole('button', { name: '+ Add server' }).click()
  const editor = dialog.locator('.harness-editor')
  await editor.getByLabel('Name', { exact: true }).fill(name)
  await editor.getByLabel('Command', { exact: true }).fill(process.execPath)
  await editor.getByLabel('Arguments', { exact: true }).fill(args)
  if (env) await editor.getByLabel(/Environment/).fill(env)
  await editor.getByRole('button', { name: 'Add' }).click()
}

test('each AI agent panel has its own settings (⚙): MCP servers with a health check, instructions, restart to apply', async () => {
  const { page } = hub
  const repo = createRepo(work)
  // A skill the repository already has: listed as loaded by Claude Code on its own.
  mkdirSync(join(repo, '.claude', 'skills', 'lint'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lints the code\n---\nRun the linter.\n')
  await openProject(page, repo)

  // The agent started without settings; there is no separate harness panel.
  await expect.poll(() => agentStarts().length).toBe(1)
  expect(agentStarts()[0]).not.toContain('--mcp-config')
  await page.locator('.tab-panel.visible .side-rail .rail-item.add').click()
  await expect(page.locator('.rail-menu')).not.toContainText('Harness')
  await page.keyboard.press('Escape')

  const first = agentPanes(page).first()
  let dialog = await openSettings(page, first)
  await expect(dialog).toContainText('this panel only')
  await expect(dialog.locator('.harness-support')).toContainText('Applies to Claude Code')

  // Add a stdio server, check it: started, its tools listed.
  await addServer(dialog, 'fake', `"${FAKE_MCP}" --verbose`, 'FAKE_TOKEN=secret')
  const row = dialog.locator('.harness-item', { hasText: 'fake' })
  await expect(row).toContainText('stdio')
  await row.getByRole('button', { name: 'Check' }).click()
  await expect(row.locator('.harness-status')).toHaveText('✓ 2 tools', { timeout: 30_000 })
  await expect(row.locator('.harness-tools')).toContainText('Adds two numbers')

  // The running agent is out of date: the dialog and the pane offer to restart it.
  await expect(dialog.locator('.harness-stale')).toContainText('previous settings')

  // Instructions (saved as typed); skills of the repository listed.
  await dialog.getByRole('tab', { name: /Instructions/ }).click()
  await dialog.getByLabel('Instructions').fill('Use pnpm.\nRun the tests before committing.')
  await dialog.getByRole('tab', { name: /Skills/ }).click()
  await expect(dialog.locator('.harness-item', { hasText: 'lint' })).toContainText('repository (.claude/skills)')

  // Close (Esc): the settings button shows how many settings are in use; the pane offers to restart.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(first.locator('.agent-settings-count')).toHaveText('2')
  await expect(first.locator('.harness-stale-bar')).toBeVisible()

  // Restart: the agent gets this pane's settings (generated files, passed with flags).
  await first.locator('.harness-stale-bar button').click()
  await expect(first.locator('.harness-stale-bar')).toHaveCount(0)
  await expect.poll(() => agentStarts().length).toBe(2)
  const args = agentStarts()[1]
  expect(JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'))).toEqual({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP, '--verbose'], env: { FAKE_TOKEN: 'secret' } } }
  })
  expect(readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')).toBe('Use pnpm.\nRun the tests before committing.\n')
  // Nothing written into the repository.
  expect(readLog(join(repo, '.mcp.json'))).toBe('')

  // A second agent panel: its own (empty) settings, independent of the first one.
  await first.locator('.pane-header button[title="Split down"]').click()
  await expect(agentPanes(page)).toHaveCount(2)
  await expect.poll(() => agentStarts().length).toBe(3)
  expect(agentStarts()[2]).not.toContain('--mcp-config')
  const second = agentPanes(page).nth(1)
  await expect(second.locator('.agent-settings-count')).toHaveCount(0)
  dialog = await openSettings(page, second)
  await expect(dialog.locator('.harness-item')).toHaveCount(0)
  await dialog.getByRole('tab', { name: /Instructions/ }).click()
  await dialog.getByLabel('Instructions').fill('Only review, never edit.')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(second.locator('.agent-settings-count')).toHaveText('1')
  await expect(first.locator('.agent-settings-count')).toHaveText('2')

  // Settings stay with their panel across a restart of the app.
  await quit(hub)
  hub = await launch(profile)
  await expect(agentPanes(hub.page)).toHaveCount(2, { timeout: 30_000 })
  await expect(agentPanes(hub.page).first().locator('.agent-settings-count')).toHaveText('2')
  await expect(agentPanes(hub.page).nth(1).locator('.agent-settings-count')).toHaveText('1')
  // Restored agents start with their own settings.
  await expect.poll(() => agentStarts().filter((a) => a.includes('--append-system-prompt-file')).length).toBeGreaterThanOrEqual(3)
})

test('AI agent settings are isolated between project tabs (and restored per tab)', async () => {
  const { page } = hub
  // Two projects, two tabs.
  const repoA = renameRepo(createRepo(work), 'alpha-repo')
  const repoB = renameRepo(createRepo(work), 'beta-repo')
  const tab = (name: string): Locator => page.locator('.tab', { hasText: name })

  // Tab A: an MCP server and instructions, applied by a restart.
  await openProject(page, repoA)
  await expect.poll(() => agentStarts(repoA).length).toBe(1)
  let dialog = await openSettings(page, agentPanes(page).first())
  await addServer(dialog, 'alpha-tools', `"${FAKE_MCP}"`)
  await dialog.getByRole('tab', { name: /Instructions/ }).click()
  await dialog.getByLabel('Instructions').fill('Alpha only.')
  await dialog.getByRole('tab', { name: /MCP servers/ }).click()
  await dialog.getByRole('button', { name: 'Restart agent' }).click()
  // Esc still closes the dialog (its Restart button went away; the restarted terminal does not take the keys).
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect.poll(() => agentStarts(repoA).length).toBe(2)
  const startA = agentStarts(repoA)[1]

  // Tab B: its agent starts without any of tab A's settings, and its ⚙ is empty.
  await openProject(page, repoB)
  await expect(tab('beta-repo')).toHaveClass(/active/)
  await expect.poll(() => agentStarts(repoB).length).toBe(1)
  expect(agentStarts(repoB)[0]).not.toContain('--mcp-config')
  expect(agentStarts(repoB)[0]).not.toContain('--append-system-prompt-file')
  const paneB = agentPanes(page).first()
  await expect(paneB.locator('.agent-settings-count')).toHaveCount(0)
  dialog = await openSettings(page, paneB)
  await expect(dialog.locator('.harness-item')).toHaveCount(0)
  await dialog.getByRole('tab', { name: /Instructions/ }).click()
  await expect(dialog.getByLabel('Instructions')).toHaveValue('')

  // Tab B gets its own instructions (no MCP server).
  await dialog.getByLabel('Instructions').fill('Beta only.')
  await dialog.getByRole('button', { name: 'Restart agent' }).click()
  await expect.poll(() => agentStarts(repoB).length).toBe(2)
  // A dialog left open does not follow to another tab: showing tab A closes it.
  await page.evaluate(() => (window as unknown as { __vibeIdeTabs: { getState(): { activateRelative(d: number): void } } }).__vibeIdeTabs.getState().activateRelative(-1))
  await expect(dialog).toBeHidden()
  await tab('beta-repo').click()
  const startB = agentStarts(repoB)[1]
  expect(flagFile(startB, '--append-system-prompt-file')).toBe('Beta only.\n')
  expect(startB).not.toContain('--mcp-config')

  // Tab A is unchanged: its settings, its generated files (separate from B's).
  expect(flagFile(startA, '--append-system-prompt-file')).toBe('Alpha only.\n')
  expect(Object.keys(JSON.parse(flagFile(startA, '--mcp-config')).mcpServers)).toEqual(['alpha-tools'])
  const dirOf = (args: string[]): string => args[args.indexOf('--append-system-prompt-file') + 1].replace(/[\\/][^\\/]+$/, '')
  expect(dirOf(startA)).not.toBe(dirOf(startB))
  await tab('alpha-repo').click()
  const paneA = agentPanes(page).first()
  await expect(paneA.locator('.agent-settings-count')).toHaveText('2')
  await expect(paneA.locator('.harness-stale-bar')).toHaveCount(0)
  dialog = await openSettings(page, paneA)
  await expect(dialog.locator('.harness-item')).toHaveText([/alpha-tools/])
  await page.keyboard.press('Escape')

  // After a restart of the app, each tab's agent starts again with its own settings.
  await quit(hub)
  const before = { a: agentStarts(repoA).length, b: agentStarts(repoB).length }
  hub = await launch(profile)
  await expect.poll(() => agentStarts(repoA).length, { timeout: 30_000 }).toBe(before.a + 1)
  await expect.poll(() => agentStarts(repoB).length, { timeout: 30_000 }).toBe(before.b + 1)
  const restoredA = agentStarts(repoA).at(-1)!
  const restoredB = agentStarts(repoB).at(-1)!
  expect(flagFile(restoredA, '--append-system-prompt-file')).toBe('Alpha only.\n')
  expect(Object.keys(JSON.parse(flagFile(restoredA, '--mcp-config')).mcpServers)).toEqual(['alpha-tools'])
  expect(flagFile(restoredB, '--append-system-prompt-file')).toBe('Beta only.\n')
  expect(restoredB).not.toContain('--mcp-config')
})

test('a server that fails to start shows its error and output; disabling servers and "only these servers"', async () => {
  const { page } = hub
  await openProject(page, createRepo(work))
  const pane = agentPanes(page).first()
  const dialog = await openSettings(page, pane)
  await dialog.getByRole('button', { name: '+ Add server' }).click()
  const editor = dialog.locator('.harness-editor')
  // The form refuses incomplete servers; Esc closes the form, not the dialog.
  await expect(editor.getByRole('button', { name: 'Add' })).toBeDisabled()
  await expect(editor).toContainText('A name is needed.')
  await editor.getByLabel('Name', { exact: true }).press('Escape')
  await expect(editor).toBeHidden()
  await expect(dialog).toBeVisible()

  await addServer(dialog, 'broken', `"${FAKE_MCP}"`, 'FAKE_MCP_EXIT=3')
  const row = dialog.locator('.harness-item', { hasText: 'broken' })
  await row.getByRole('button', { name: 'Check' }).click()
  await expect(row.locator('.harness-status')).toHaveText('✗ failed', { timeout: 30_000 })
  await expect(row.locator('.harness-error')).toContainText('exited (code 3)')
  await expect(row.locator('.harness-log')).toContainText('failing on purpose')

  // Disabled server, strict mode: the agent gets an empty MCP config and --strict-mcp-config.
  await row.getByLabel('Enable broken').uncheck()
  await dialog.getByLabel('Only these servers').check()
  await dialog.getByRole('button', { name: 'Restart agent' }).click()
  await expect.poll(() => agentStarts().length).toBe(2)
  const strict = agentStarts()[1]
  expect(strict).toContain('--strict-mcp-config')
  expect(JSON.parse(readFileSync(strict[strict.indexOf('--mcp-config') + 1], 'utf8'))).toEqual({ mcpServers: {} })
})
