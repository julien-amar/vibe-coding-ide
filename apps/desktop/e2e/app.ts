import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'

const MAIN = resolve(__dirname, '..', 'out', 'main', 'index.js')

export interface DevHub {
  app: ElectronApplication
  page: Page
  userData: string
}

/** A throwaway folder (removed by `cleanup`). */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `devhub-e2e-${prefix}-`)))
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* a process may still hold a file on Windows; the OS temp cleanup will get it */
  }
}

/**
 * Launch the built app with its own profile. DEVHUB_DEBUG exposes the tab store
 * (window.__devhubTabs) for the few actions a test cannot do with the mouse,
 * like picking a folder in the native dialog.
 */
export async function launch(userData: string): Promise<DevHub> {
  const app = await electron.launch({
    // CI Linux runners do not allow Chromium's sandbox (unprivileged user namespaces).
    args: [MAIN, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, DEVHUB_USER_DATA: userData, DEVHUB_DEBUG: '1', ELECTRON_ENABLE_LOGGING: '0' } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // The app is ready when the first tab exists.
  await expect(page.locator('.tab').first()).toBeVisible()
  return { app, page, userData }
}

/** Close the window like a user (saves the layout) and wait for the app to exit. */
export async function quit(hub: DevHub): Promise<void> {
  const closed = hub.app.waitForEvent('close')
  await hub.page.evaluate(() => window.devhub.window.close()).catch(() => undefined)
  await closed
}

/** Text currently in the terminal of the visible tab (or a given terminal host). */
export async function terminalText(page: Page, host = page.locator('.tab-panel.visible .terminal-host').first()): Promise<string> {
  return host.evaluate((el) => {
    const term = (el as unknown as { __xterm?: { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).__xterm
    if (!term) return ''
    const b = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  })
}

/** Type into the focused terminal of the visible tab. */
export async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.tab-panel.visible .terminal-host').first().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** A small git repository: main with 2 commits, a feature branch merged into it, a renamed file. */
export function createRepo(base: string): string {
  const repo = join(base, 'demo-repo')
  mkdirSync(repo)
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  const write = (f: string, content: string): void => {
    mkdirSync(join(repo, f, '..'), { recursive: true })
    writeFileSync(join(repo, f), content)
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'E2E Tester')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'core.autocrlf', 'false')
  write('README.md', 'hello\n')
  git('add', '.')
  git('commit', '-q', '-m', 'Initial commit')
  git('switch', '-q', '-c', 'feature/login')
  write('src/login.ts', 'export const login = true\n')
  git('add', '.')
  git('commit', '-q', '-m', 'Login form')
  git('switch', '-q', 'main')
  write('README.md', 'hello\nworld\n')
  git('commit', '-q', '-am', 'Update README')
  git('merge', '-q', '--no-ff', '-m', 'Merge feature/login', 'feature/login')
  git('mv', 'src/login.ts', 'src/auth.ts')
  git('commit', '-q', '-m', 'Rename login to auth')
  return repo
}

/** Open a folder as a project (the native folder picker cannot be driven by a test). */
export async function openProject(page: Page, root: string): Promise<void> {
  await page.evaluate((r) => (window as unknown as { __devhubTabs: { getState(): { openProject(root: string): Promise<void> } } }).__devhubTabs.getState().openProject(r), root)
  await expect(page.locator('.tab-panel.visible .git-panel')).toBeVisible()
}
