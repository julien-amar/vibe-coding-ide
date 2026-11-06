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
  // What this panel's agent gets: everything, for Claude Code.
  await expect(dialog.locator('.harness-support-line')).toContainText('Claude Code:')
  await expect(dialog.locator('.harness-support-line .ok')).toHaveText(['✓ MCP servers', '✓ skills', '✓ instructions'])

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

test('other agents get the settings in their own format (Codex CLI, pi) or are shown as not supported (Gemini CLI)', async () => {
  const { page } = hub
  const repo = createRepo(work)
  mkdirSync(join(repo, 'agent-skills', 'haiku'), { recursive: true })
  writeFileSync(join(repo, 'agent-skills', 'haiku', 'SKILL.md'), '---\nname: haiku\ndescription: Answers with a haiku\n---\nWrite a haiku.\n')
  await openProject(page, repo)
  await expect.poll(() => agentStarts(repo).length).toBe(1)
  const pane = agentPanes(page).first()

  /** Switch the pane's agent (as its header's agent menu does) and wait for the new start. */
  const useAgent = async (profileId: string): Promise<string[]> => {
    const before = agentStarts(repo).length
    await page.evaluate((id) => {
      const tabs = (window as unknown as { __vibeIdeTabs: { getState(): Record<string, unknown> } }).__vibeIdeTabs.getState() as {
        tabs: { id: string; project?: { layout: unknown } }[]
        activeId: string
        restartPane(tabId: string, paneId: string, profileId?: string): Promise<void>
      }
      const tab = tabs.tabs.find((t) => t.id === tabs.activeId)!
      const walk = (n: { kind: string; children?: unknown[]; type?: string; id?: string }): { type?: string; id?: string }[] =>
        n.kind === 'split' ? (n.children as (typeof n)[]).flatMap(walk) : [n]
      const agentPane = walk(tab.project!.layout as never).find((p) => p.type === 'agent')!
      return tabs.restartPane(tab.id, agentPane.id!, id)
    }, profileId)
    await expect.poll(() => agentStarts(repo).length).toBe(before + 1)
    return agentStarts(repo).at(-1)!
  }

  // The settings: a server, a skill, instructions with quotes and a line break.
  let dialog = await openSettings(page, pane)
  await addServer(dialog, 'demo-tools', `"${FAKE_MCP}" "an arg"`)
  await dialog.getByRole('tab', { name: /Instructions/ }).click()
  await dialog.getByLabel('Instructions').fill('Use pnpm.\nSay "hi" first.')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await page.evaluate(() => {
    const st = (window as unknown as { __vibeIdeTabs: { getState(): Record<string, unknown> } }).__vibeIdeTabs.getState() as {
      tabs: { id: string; project?: { layout: unknown } }[]
      activeId: string
      setPaneHarness(tabId: string, paneId: string, h: unknown): void
    }
    const tab = st.tabs.find((t) => t.id === st.activeId)!
    const walk = (n: { kind: string; children?: unknown[]; type?: string; id?: string; harness?: Record<string, unknown> }): (typeof n)[] =>
      n.kind === 'split' ? (n.children as (typeof n)[]).flatMap(walk) : [n]
    const p = walk(tab.project!.layout as never).find((x) => x.type === 'agent')!
    // (Adding a skill folder goes through a native folder picker: set it directly.)
    st.setPaneHarness(tab.id, p.id!, { ...p.harness, skills: [{ path: 'agent-skills/haiku', enabled: true }] })
  })

  // Codex CLI: -c overrides; the quoted argument and the instructions arrive intact (no cmd.exe on the way).
  const codex = await useAgent('agent:codex')
  dialog = await openSettings(page, pane)
  await expect(dialog.locator('.harness-support-line')).toContainText('Codex CLI:')
  await expect(dialog.locator('.harness-support-line .ok')).toHaveText(['✓ MCP servers', '✓ skills', '✓ instructions'])
  await page.keyboard.press('Escape')
  expect(codex).toContain(`mcp_servers.demo-tools.args=[${JSON.stringify(FAKE_MCP)}, "an arg"]`)
  const instructions = codex.find((a) => a.startsWith('developer_instructions='))!
  expect(instructions).toContain('Use pnpm.\\nSay \\"hi\\" first.')
  expect(instructions).toMatch(/- haiku: Answers with a haiku \(file: [^)]*SKILL\.md\)/)

  // "Only these skills" (Skills tab).
  dialog = await openSettings(page, pane)
  await dialog.getByRole('tab', { name: /Skills/ }).click()
  await dialog.getByLabel('Only these skills').check()
  await page.keyboard.press('Escape')

  // pi: MCP servers through a session-only extension, instructions and skills as flags, its own
  // skills off (--no-skills); "Only these servers" is not possible.
  const pi = await useAgent('agent:pi')
  expect(pi.indexOf('--no-skills')).toBeGreaterThan(-1)
  expect(pi.indexOf('--no-skills')).toBeLessThan(pi.indexOf('--skill'))
  expect(readFileSync(pi[pi.indexOf('--append-system-prompt') + 1], 'utf8')).toBe('Use pnpm.\nSay "hi" first.\n')
  expect(pi[pi.indexOf('--skill') + 1]).toMatch(/agent-skills[\\/]haiku$/)
  const extension = readFileSync(pi[pi.indexOf('--extension') + 1], 'utf8')
  expect(extension).toContain('pi.registerMcpServer(name, config)')
  expect(extension).toContain('"demo-tools"')
  dialog = await openSettings(page, pane)
  await expect(dialog.locator('.harness-support-line .no')).toHaveCount(0)
  await expect(dialog.locator('.harness-support-line')).toContainText('session-only extension')
  await expect(dialog.getByLabel('Only these servers')).toBeDisabled()
  await page.keyboard.press('Escape')

  // opencode 2 (the fake reports 2.2.5): a private server, so the panel's config applies.
  const opencode = await useAgent('agent:opencode')
  expect(opencode).toEqual(['--standalone'])

  // Gemini CLI: nothing passed, and the dialog says why.
  const gemini = await useAgent('agent:gemini')
  expect(gemini).toEqual([])
  dialog = await openSettings(page, pane)
  await expect(dialog.locator('.harness-support-line')).toHaveClass(/none/)
  await expect(dialog.locator('.harness-support-line')).toContainText('only reads settings from ~/.gemini')
  await dialog.getByRole('tab', { name: /Skills/ }).click()
  await expect(dialog.getByLabel('Only these skills')).toBeDisabled()
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
