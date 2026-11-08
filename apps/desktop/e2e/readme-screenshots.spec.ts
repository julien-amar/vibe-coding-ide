import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanup, closeApp, launch, openProject, tempDir, type TestApp } from './app'
import { startFakeEngine } from './fake-engine'

/**
 * The README's screenshots (docs/screenshots/*.png), in dark mode: not part of the test runs.
 *   pnpm build && README_SCREENSHOTS=1 pnpm exec playwright test e2e/readme-screenshots.spec.ts
 * Windows (the terminal shows PowerShell). A demo project, the fake AI agent (an illustrative
 * session), the fake container engine: no personal paths or data on screen.
 */
test.skip(!process.env.README_SCREENSHOTS || process.platform !== 'win32', 'README screenshots: README_SCREENSHOTS=1, on Windows')

const OUT = resolve(__dirname, '..', '..', '..', 'docs', 'screenshots')
const SIZE = { width: 1440, height: 880 }

/** An illustrative AI agent session (the fake agent prints it). */
const AGENT_BANNER = [
  ' AI agent · demo-shop',
  '',
  ' > Add a test for the cart total with a discount code',
  '',
  '   Reading src/cart.ts',
  '   Writing src/cart.test.ts',
  '   1 test added: run it from the Tests panel.',
  '',
  ' > '
].join('\n')

/** A demo shop repository: two authors, a merged branch, an open one, uncommitted changes. */
function demoRepo(base: string): string {
  const repo = join(base, 'demo-shop')
  mkdirSync(repo)
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  const write = (f: string, content: string): void => {
    mkdirSync(join(repo, f, '..'), { recursive: true })
    writeFileSync(join(repo, f), content)
  }
  const as = (name: string): void => {
    git('config', 'user.name', name)
    git('config', 'user.email', `${name.split(' ')[0].toLowerCase()}@example.com`)
  }
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  as('Alex Martin')
  write('README.md', '# Demo shop\n')
  write(
    'src/cart.ts',
    'export interface Item {\n  price: number\n  quantity: number\n}\n\nexport function total(items: Item[]): number {\n  return items.reduce((sum, i) => sum + i.price * i.quantity, 0)\n}\n'
  )
  git('add', '.')
  git('commit', '-q', '-m', 'Cart with a total')
  as('Sam Lee')
  git('switch', '-q', '-c', 'feature/checkout')
  write(
    'src/checkout.ts',
    "import { total, type Item } from './cart'\n\nexport function checkout(items: Item[]): string {\n  return `Paid ${total(items).toFixed(2)}`\n}\n"
  )
  git('add', '.')
  git('commit', '-q', '-m', 'Checkout page')
  write(
    'src/checkout.ts',
    "import { total, type Item } from './cart'\n\nexport function checkout(items: Item[]): string {\n  if (!items.length) throw new Error('Empty cart')\n  return `Paid ${total(items).toFixed(2)}`\n}\n"
  )
  git('commit', '-q', '-am', 'Refuse an empty cart at checkout')
  git('switch', '-q', 'main')
  as('Alex Martin')
  write('README.md', '# Demo shop\n\nA small shop: cart, checkout, discounts.\n')
  git('commit', '-q', '-am', 'Describe the project')
  git('merge', '-q', '--no-ff', '-m', 'Merge feature/checkout', 'feature/checkout')
  git('switch', '-q', '-c', 'feature/discounts')
  write('src/discount.ts', 'export const codes: Record<string, number> = { WELCOME10: 0.1 }\n')
  git('add', '.')
  git('commit', '-q', '-m', 'Discount codes')
  git('switch', '-q', 'main')
  as('Sam Lee')
  write('src/format.ts', "export const money = (n: number): string => n.toLocaleString('en', { style: 'currency', currency: 'EUR' })\n")
  git('add', '.')
  git('commit', '-q', '-m', 'Money formatting')
  // Uncommitted: a change to the cart, a new test.
  write(
    'src/cart.ts',
    "import { codes } from './discount'\n\nexport interface Item {\n  price: number\n  quantity: number\n}\n\nexport function total(items: Item[], code?: string): number {\n  const sum = items.reduce((s, i) => s + i.price * i.quantity, 0)\n  const off = code ? (codes[code] ?? 0) : 0\n  return Math.round(sum * (1 - off) * 100) / 100\n}\n"
  )
  write('src/discount.ts', 'export const codes: Record<string, number> = { WELCOME10: 0.1 }\n')
  write(
    'src/cart.test.ts',
    "import { total } from './cart'\n\ntest('a discount code lowers the total', () => {\n  expect(total([{ price: 20, quantity: 2 }], 'WELCOME10')).toBe(36)\n})\n"
  )
  return repo
}

let hub: TestApp
let profile: string
let work: string

test.beforeEach(async () => {
  mkdirSync(OUT, { recursive: true })
  profile = tempDir('profile')
  work = tempDir('work')
  process.env.FAKE_AGENT_BANNER = AGENT_BANNER
})

test.afterEach(async () => {
  await closeApp(hub)
  delete process.env.FAKE_AGENT_BANNER
  cleanup(profile)
  cleanup(work)
})

async function start(): Promise<Page> {
  hub = await launch(profile)
  const { page } = hub
  await page.setViewportSize(SIZE)
  await page.evaluate(() => window.ide.settings.set({ theme: 'dark', containers: { hidden: ['wslc'], refresh: 0, confirmRemove: true } }))
  await page.emulateMedia({ colorScheme: 'dark' })
  return page
}

const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: join(OUT, `${name}.png`) })

/** A neutral PowerShell prompt (no user name or path on screen). */
async function neutralPrompt(page: Page, host: ReturnType<Page['locator']>, name: string): Promise<void> {
  await expect(host).toBeVisible()
  await page.waitForTimeout(2500)
  await host.click()
  await page.keyboard.type(`function prompt { 'PS ${name}> ' }; Clear-Host`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
}

test('README: a project (Git, terminal, AI agent), its changes, settings', async () => {
  const page = await start()
  const repo = demoRepo(work)
  await openProject(page, repo)
  const tab = page.locator('.tab-panel.visible')
  const terminal = tab
    .locator('.pane', { has: page.locator('.terminal-host') })
    .filter({ hasNot: page.locator('.agent-logo') })
    .first()
  await neutralPrompt(page, terminal.locator('.terminal-host'), 'demo-shop')
  await page.keyboard.type('git log --oneline --graph -6')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  await tab.locator('.git-row').first().click()
  await page.waitForTimeout(800)
  await page.mouse.move(SIZE.width - 5, SIZE.height - 5)
  await shot(page, 'project')

  // Changes: a file's diff, with hunks and lines to stage.
  await tab
    .locator('.git-toolbar')
    .getByRole('tab', { name: /^Changes/ })
    .click()
  await tab.locator('.git-panel').locator('text=cart.ts').first().click()
  await page.waitForTimeout(1200)
  await page.mouse.move(SIZE.width - 5, SIZE.height - 5)
  const gitPane = tab.locator('.pane', { has: page.locator('.pane-title', { hasText: 'Git' }) })
  await gitPane.getByRole('button', { name: 'Full screen' }).click()
  await page.waitForTimeout(600)
  await shot(page, 'git-changes')
  await page.keyboard.press('Escape')

  // Settings.
  await page.evaluate(() =>
    (window as unknown as { __vibeIdeTabs: { getState(): { setLauncherOpen(o: boolean): void } } }).__vibeIdeTabs.getState().setLauncherOpen(true)
  )
  await page
    .getByRole('button', { name: /Settings/ })
    .first()
    .click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.waitForTimeout(500)
  await shot(page, 'settings')
})

test('README: the Tests panel', async () => {
  const page = await start()
  await openProject(page, resolve(__dirname, 'fixtures', 'sample-tests'))
  const tab = page.locator('.tab-panel.visible')
  await tab.locator('.side-rail .rail-item.tests').click()
  const panel = tab.locator('.tests-panel')
  await expect(panel.locator('.test-row.kind-project').first()).toBeVisible({ timeout: 90_000 })
  await tab
    .locator('.pane', { has: page.locator('.pane-title', { hasText: 'Tests' }) })
    .getByRole('button', { name: 'Full screen' })
    .click()
  await panel.getByRole('button', { name: /Run all/ }).click()
  await expect(panel.locator('.tests-summary .busy')).toHaveCount(0, { timeout: 180_000 })
  // A failed test, with its failure in the details.
  await panel
    .locator('.test-row', { has: page.locator('.test-status.st-failed') })
    .last()
    .click()
  await page.waitForTimeout(800)
  await page.mouse.move(SIZE.width - 5, SIZE.height - 5)
  await shot(page, 'tests')
})

test('README: the Containers tab', async () => {
  const engine = await startFakeEngine()
  process.env.DOCKER_HOST = engine.url
  process.env.CONTAINER_HOST = 'tcp://127.0.0.1:1'
  try {
    const page = await start()
    await page.keyboard.press('ControlOrMeta+t')
    await page.locator('.launcher-item', { hasText: 'Containers' }).click()
    const tab = page.locator('.tab-panel.visible .containers')
    await tab.locator('.ctr-row', { hasText: 'shop-web-1' }).click()
    await tab.locator('.containers-status').getByRole('tab', { name: 'Stats' }).click()
    await page.waitForTimeout(8000)
    await page.mouse.move(SIZE.width - 5, SIZE.height - 5)
    await shot(page, 'containers')
  } finally {
    await engine.close()
    delete process.env.DOCKER_HOST
    delete process.env.CONTAINER_HOST
  }
})
