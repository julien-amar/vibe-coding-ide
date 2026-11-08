import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'

const MAIN = resolve(__dirname, '..', 'out', 'main', 'index.js')

export interface TestApp {
  app: ElectronApplication
  page: Page
  userData: string
  /** What the fake AI agent received (typed / pasted text). */
  agentLog: string
  /** The fake editor's calls (JSON arguments, one call per line). */
  editorLog: string
}

/** A throwaway folder (removed by `cleanup`). */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `vibe-coding-ide-e2e-${prefix}-`)))
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* a process may still hold a file on Windows; the OS temp cleanup will get it */
  }
}

/**
 * Launch the built app with its own profile. VIBE_CODING_IDE_DEBUG exposes the tab store
 * (window.__vibeIdeTabs) for the few actions a test cannot do with the mouse,
 * like picking a folder in the native dialog.
 */
export async function launch(userData: string): Promise<TestApp> {
  // Fake `claude` and `code` first on PATH: project tabs never start a real AI agent, and
  // "open in editor" never opens a real editor. What they receive is logged in the profile folder.
  const agentLog = join(userData, 'fake-agent.log')
  const editorLog = join(userData, 'fake-editor.log')
  const app = await electron.launch({
    // CI Linux runners do not allow Chromium's sandbox (unprivileged user namespaces).
    args: [MAIN, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: {
      ...process.env,
      ...fakeToolsEnv(agentLog, editorLog),
      VIBE_CODING_IDE_USER_DATA: userData,
      VIBE_CODING_IDE_DEBUG: '1',
      ELECTRON_ENABLE_LOGGING: '0'
    } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // The app is ready when the first tab exists (or the welcome screen: a window without tabs).
  await expect(page.locator('.tab, .welcome').first()).toBeVisible()
  return { app, page, userData, agentLog, editorLog }
}

/** Contents of a fake tool's log ('' while it does not exist). */
export function readLog(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * End a test's app (after each test): close it, and if it has not exited within 15 s (seen on
 * Windows runners), end its whole process tree — a hung close must not time the worker out.
 */
export async function closeApp(hub: TestApp | undefined): Promise<void> {
  if (!hub) return
  const proc = hub.app.process()
  const closed = await Promise.race([
    hub.app.close().then(
      () => true,
      () => true
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))
  ])
  if (closed || proc.exitCode !== null || proc.pid === undefined) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-proc.pid, 'SIGKILL')
  } catch {
    proc.kill('SIGKILL')
  }
}

/** Close the window like a user (saves the layout) and wait for the app to exit. */
export async function quit(hub: TestApp): Promise<void> {
  const exited = hub.app.waitForEvent('close')
  const windowClosed = hub.page.waitForEvent('close')
  await hub.page.evaluate(() => window.ide.window.close()).catch(() => undefined)
  await windowClosed
  // macOS apps keep running without windows; quit like Cmd+Q (the layout was saved on window close).
  if (process.platform === 'darwin') await hub.app.close()
  await exited
}

/** Text currently in the terminal of the visible tab (or a given terminal host). */
export async function terminalText(page: Page, host = page.locator('.tab-panel.visible .terminal-host').first()): Promise<string> {
  return host.evaluate((el) => {
    const term = (
      el as unknown as { __xterm?: { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }
    ).__xterm
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

/**
 * Environment that puts fake tools first on PATH: `claude` (the AI agent: records what it
 * receives in `agentLog`) and `code` (the editor: records its arguments in `editorLog`).
 * Tests never send anything to a real agent or open a real editor.
 */
export function fakeToolsEnv(agentLog: string, editorLog: string): Record<string, string> {
  const dir = resolve(__dirname, 'fixtures', 'fake-tools')
  if (process.platform !== 'win32')
    for (const f of ['claude', 'codex', 'pi', 'opencode', 'gemini', 'code', 'gh', 'docker', 'kubectl', 'k9s']) chmodSync(join(dir, f), 0o755)
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return {
    [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ''}`,
    FAKE_AGENT_LOG: agentLog,
    FAKE_EDITOR_LOG: editorLog,
    // `gh` (GitHub CLI) and the browser: what they were asked, next to the other logs.
    FAKE_GH_LOG: join(dirname(agentLog), 'fake-gh.log'),
    FAKE_DOCKER_LOG: join(dirname(agentLog), 'fake-docker.log'),
    VIBE_CODING_IDE_BROWSER_LOG: join(dirname(agentLog), 'browser.log')
  }
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
  await page.evaluate(
    (r) => (window as unknown as { __vibeIdeTabs: { getState(): { openProject(root: string): Promise<void> } } }).__vibeIdeTabs.getState().openProject(r),
    root
  )
  await expect(page.locator('.tab-panel.visible .git-panel')).toBeVisible()
}
