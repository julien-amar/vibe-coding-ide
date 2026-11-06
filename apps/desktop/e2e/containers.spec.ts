import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanup, closeApp, launch, readLog, tempDir, terminalText, type TestApp } from './app'
import { startFakeEngine, type FakeEngine } from './fake-engine'

let hub: TestApp
let profile: string
let engine: FakeEngine
const saved = { docker: process.env.DOCKER_HOST, podman: process.env.CONTAINER_HOST }

test.beforeEach(async () => {
  engine = await startFakeEngine()
  // The app finds Docker through DOCKER_HOST (here the fake engine); Podman is not running.
  process.env.DOCKER_HOST = engine.url
  process.env.CONTAINER_HOST = 'tcp://127.0.0.1:1'
  profile = tempDir('profile')
  hub = await launch(profile)
})

test.afterEach(async () => {
  await closeApp(hub)
  await engine.close()
  for (const [k, v] of [
    ['DOCKER_HOST', saved.docker],
    ['CONTAINER_HOST', saved.podman]
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  cleanup(profile)
})

const openContainers = async (page: Page) => {
  await page.keyboard.press('ControlOrMeta+t')
  await page.locator('.launcher-item', { hasText: 'Containers' }).click()
  const tab = page.locator('.tab-panel.visible .containers')
  await expect(tab).toBeVisible()
  return tab
}

test('the Containers tab lists, acts on, and shows the logs and stats of containers (Docker Engine API)', async () => {
  const { page } = hub
  const tab = await openContainers(page)
  await expect(page.locator('.tab.active')).toContainText('Containers')
  // Docker answers (the fake engine); Podman does not.
  const engines = tab.locator('.containers-engines')
  await expect(engines.getByRole('tab', { name: 'Docker' })).toHaveAttribute('aria-selected', 'true')
  await expect(engines.getByRole('tab', { name: 'Docker' }).locator('.engine-dot.on')).toHaveCount(1)
  await expect(engines.getByRole('tab', { name: 'Podman' }).locator('.engine-dot.on')).toHaveCount(0)
  await expect(tab.locator('.containers-detail')).toContainText('27.3.1-fake')

  // Containers: state, image, Compose project, published port.
  const web = tab.locator('.ctr-row', { hasText: 'shop-web-1' })
  await expect(web.locator('.ctr-state.st-running')).toHaveCount(1)
  await expect(web).toContainText('nginx:alpine')
  await expect(web.locator('.ctr-chip')).toHaveText('shop')
  await expect(web.locator('.ctr-ports')).toContainText('8080:80')
  await expect(tab.locator('.ctr-row', { hasText: 'db' }).locator('.ctr-state.st-exited')).toHaveCount(1)

  // Logs (multiplexed stdout + stderr) and live stats of the selected container.
  await web.click()
  const bottom = tab.locator('.containers-bottom-content')
  await expect(bottom.locator('.ctr-pre')).toContainText('hello from c0ffee000001')
  await expect(bottom.locator('.ctr-pre')).toContainText('a warning on stderr')
  await tab.locator('.containers-bottom-bar').getByRole('tab', { name: 'Stats' }).click()
  await expect(bottom.locator('.ctr-stat', { hasText: 'CPU' })).toContainText('%')
  await expect(bottom.locator('.ctr-stat', { hasText: 'Memory' })).toContainText('52 MB / 1.1 GB')
  await expect(bottom.locator('.ctr-stat', { hasText: 'Processes' })).toContainText('3')
  await tab.locator('.containers-bottom-bar').getByRole('tab', { name: 'Inspect' }).click()
  await expect(bottom.locator('.ctr-pre')).toContainText('"Tty": false')

  // A shell in it: a terminal tab running `docker exec -it <id> sh …` (the fake docker records it).
  await web.hover()
  await web.getByRole('button', { name: /Open a shell/ }).click()
  await expect(page.locator('.tab.active')).toContainText('shop-web-1 (shell)')
  await expect.poll(() => terminalText(page)).toContain('fake shell in c0ffee000001')
  await expect.poll(() => readLog(join(profile, 'fake-docker.log'))).toContain('["exec","-it","c0ffee000001","sh"')
  await page.locator('.tab', { hasText: 'Containers' }).click()

  // Stop it: the engine is called, the list follows.
  await web.hover()
  await web.getByRole('button', { name: 'Stop' }).click()
  await expect(web.locator('.ctr-state.st-exited')).toHaveCount(1)
  expect(engine.calls).toContain('POST /containers/c0ffee000001/stop')

  // Compose: the project from the containers' labels.
  await tab.locator('.containers-views').getByRole('tab', { name: 'Compose' }).click()
  await expect(tab.locator('.ctr-row', { hasText: 'shop' })).toContainText('0 / 1 running')
})

test('images, volumes and networks; pulling an image shows its output (through the CLI)', async () => {
  const { page } = hub
  const tab = await openContainers(page)
  const views = tab.locator('.containers-views')

  await views.getByRole('tab', { name: 'Images' }).click()
  await expect(tab.locator('.ctr-row', { hasText: 'nginx:alpine' })).toContainText('23 MB')
  await views.getByRole('button', { name: 'Pull…' }).click()
  await page.locator('.dialog input').fill('redis:7')
  await page.locator('.dialog button', { hasText: 'Pull' }).click()
  const output = tab.locator('.ctr-output')
  await expect(output).toContainText('Status: Downloaded newer image for redis:7')
  await expect(output.locator('.ctr-output-head')).toContainText('done')
  expect(readLog(join(profile, 'fake-docker.log'))).toContain('["pull","redis:7"]')

  await views.getByRole('tab', { name: 'Volumes' }).click()
  const vol = tab.locator('.ctr-row', { hasText: 'pgdata' })
  await expect(vol).toContainText('local')
  await vol.hover()
  await vol.getByRole('button', { name: 'Remove' }).click()
  await page.locator('.dialog button', { hasText: 'Remove' }).click()
  await expect(vol).toHaveCount(0)
  expect(engine.calls).toContain('DELETE /volumes/pgdata')

  await views.getByRole('tab', { name: 'Networks' }).click()
  await expect(tab.locator('.ctr-row')).toHaveCount(2)
  // Built-in networks cannot be removed.
  await expect(tab.locator('.ctr-row', { hasText: 'bridge' }).getByRole('button', { name: 'Remove' })).toHaveCount(0)
})

test('an engine that is not running says so; the tab and its engine are restored after a restart', async () => {
  let { page } = hub
  const tab = await openContainers(page)
  await tab.locator('.containers-engines').getByRole('tab', { name: 'Podman' }).click()
  await expect(tab.locator('.containers-unavailable')).toContainText('Podman is not available')
  await expect(tab.locator('.containers-unavailable')).toContainText('not running')
  await tab.locator('.containers-engines').getByRole('tab', { name: 'Docker' }).click()
  await expect(tab.locator('.ctr-row', { hasText: 'shop-web-1' })).toBeVisible()

  // Restart: the Containers tab comes back.
  const { quit } = await import('./app')
  await quit(hub)
  hub = await launch(profile)
  page = hub.page
  await expect(page.locator('.tab', { hasText: 'Containers' })).toHaveCount(1)
  await page.locator('.tab', { hasText: 'Containers' }).click()
  await expect(page.locator('.tab-panel.visible .ctr-row', { hasText: 'shop-web-1' })).toBeVisible()
})
