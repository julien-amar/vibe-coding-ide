import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanup, closeApp, launch, quit, readLog, tempDir, terminalText, type TestApp } from './app'
import { startFakeEngine, type FakeEngine } from './fake-engine'

let hub: TestApp
let profile: string
let engine: FakeEngine
const saved = { docker: process.env.DOCKER_HOST, podman: process.env.CONTAINER_HOST, hub: process.env.VIBE_CODING_IDE_DOCKER_HUB }

test.beforeEach(async () => {
  engine = await startFakeEngine()
  // The app finds Docker through DOCKER_HOST (here the fake engine); Podman is not running.
  process.env.DOCKER_HOST = engine.url
  process.env.CONTAINER_HOST = 'tcp://127.0.0.1:1'
  // Docker Hub's web API (image tags): the fake engine's.
  process.env.VIBE_CODING_IDE_DOCKER_HUB = engine.hubUrl
  profile = tempDir('profile')
  hub = await launch(profile)
  // wslc may run on the machine (Windows): left out, so only the fake engine's items are listed.
  await hub.page.evaluate(() => window.ide.settings.set({ containers: { hidden: ['wslc'], refresh: 3, confirmRemove: true } }))
})

test.afterEach(async () => {
  await closeApp(hub)
  await engine.close()
  for (const [k, v] of [
    ['DOCKER_HOST', saved.docker],
    ['CONTAINER_HOST', saved.podman],
    ['VIBE_CODING_IDE_DOCKER_HUB', saved.hub]
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
  // Every view shows its count, not only the shown one.
  const viewCount = (name: string) =>
    tab
      .locator('.containers-views')
      .getByRole('tab', { name: new RegExp(`^${name}`) })
      .locator('.count')
  await expect(viewCount('Containers')).toHaveText('2')
  await expect(viewCount('Images')).toHaveText('2')
  await expect(viewCount('Volumes')).toHaveText('1')
  await expect(viewCount('Networks')).toHaveText('2')
  await expect(viewCount('Compose')).toHaveText('1')
  // Refresh: the list and the counts load again (a spinner meanwhile), then are back.
  await tab.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(tab.locator('.ctr-row')).toHaveCount(2)
  await expect(viewCount('Images')).toHaveText('2')
  // Status bar: Docker answers (the fake engine), Podman does not.
  const status = tab.locator('.containers-status')
  await expect(status.locator('.engine-status[data-engine="docker"]')).toHaveClass(/\bon\b/)
  await expect(status.locator('.engine-status[data-engine="docker"]')).toHaveAttribute('title', /27\.3\.1-fake/)
  await expect(status.locator('.engine-status[data-engine="podman"]')).not.toHaveClass(/\bon\b/)

  // Containers: state, image, Compose project, published port. Its engine's tag.
  const web = tab.locator('.ctr-row', { hasText: 'shop-web-1' })
  await expect(web.locator('.ctr-state.st-running')).toHaveCount(1)
  await expect(web).toContainText('nginx:alpine')
  await expect(web.locator('.ctr-chip')).toHaveText('shop')
  await expect(web.locator('.ctr-engine')).toHaveText('Docker')
  await expect(web.locator('.ctr-ports')).toContainText('8080:80')
  await expect(tab.locator('.ctr-row', { hasText: 'db' }).locator('.ctr-state.st-exited')).toHaveCount(1)

  // A header over the columns; a click sorts (again: descending).
  await expect(tab.getByRole('columnheader')).toHaveText(['', 'Name', 'Engine', 'Image', 'Compose', 'Ports', 'Status', 'Show stopped'])
  await tab.getByRole('columnheader', { name: 'Name' }).click()
  await expect(tab.locator('.ctr-row .ctr-name')).toHaveText(['db', 'shop-web-1'])
  await tab.getByRole('columnheader', { name: 'Name' }).click()
  await expect(tab.locator('.ctr-row .ctr-name')).toHaveText(['shop-web-1', 'db'])
  await expect(tab.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending')
  // Stopped containers hidden, then listed again (the checkbox in the header).
  const showStopped = tab.getByRole('checkbox', { name: 'Show stopped' })
  await showStopped.uncheck()
  await expect(tab.locator('.ctr-row .ctr-name')).toHaveText(['shop-web-1'])
  await showStopped.check()
  await expect(tab.locator('.ctr-row')).toHaveCount(2)

  // Logs (multiplexed stdout + stderr) and live stats of the selected container; the switcher is in the status bar.
  await web.click()
  const bottom = tab.locator('.containers-bottom')
  await expect(bottom.locator('.ctr-pre')).toContainText('hello from c0ffee000001')
  await expect(bottom.locator('.ctr-pre')).toContainText('a warning on stderr')
  await status.getByRole('tab', { name: 'Stats' }).click()
  await expect(bottom.locator('.ctr-stat', { hasText: 'CPU' })).toContainText('%')
  await expect(bottom.locator('.ctr-stat', { hasText: 'Memory' })).toContainText('52 MB / 1.1 GB')
  await expect(bottom.locator('.ctr-stat', { hasText: 'Processes' })).toContainText('3')
  // Live: the CPU and memory graphs need several samples.
  await expect(bottom.locator('.ctr-spark polyline')).toHaveCount(2)
  await status.getByRole('tab', { name: 'Inspect' }).click()
  await expect(bottom.locator('.ctr-pre')).toContainText('"Tty": false')

  // A shell in it: a terminal tab running `docker exec -it <id> sh …` (the fake docker records it).
  await web.hover()
  await web.getByRole('button', { name: /Open a shell/ }).click()
  await expect(page.locator('.tab.active')).toContainText('shop-web-1 (shell)')
  await expect.poll(() => terminalText(page)).toContain('fake shell in c0ffee000001')
  await expect.poll(() => readLog(join(profile, 'fake-docker.log'))).toContain('["exec","-it","c0ffee000001","sh"')
  await page.locator('.tab', { hasText: 'Containers' }).click()

  // Stop it (icon button): the engine is called, the list follows.
  await web.hover()
  await web.getByRole('button', { name: 'Stop' }).click()
  await expect(web.locator('.ctr-state.st-exited')).toHaveCount(1)
  expect(engine.calls).toContain('POST /containers/c0ffee000001/stop')

  // Compose: the project from the containers' labels.
  await tab.locator('.containers-views').getByRole('tab', { name: 'Compose' }).click()
  await expect(tab.locator('.ctr-row', { hasText: 'shop' })).toContainText('0 / 1 running')
})

test('a selected container: a terminal in the tab, and its files (browse, preview, save)', async () => {
  const { page, app } = hub
  const tab = await openContainers(page)
  // Every row says which engine it comes from.
  await expect(tab.locator('.ctr-row', { hasText: 'shop-web-1' }).locator('.ctr-engine')).toHaveText('Docker')
  await tab.locator('.ctr-row', { hasText: 'shop-web-1' }).click()
  const status = tab.locator('.containers-status')
  const bottom = tab.locator('.containers-bottom')

  // Terminal: `docker exec -it <id> sh …` in the tab; commands typed there reach it.
  await status.getByRole('tab', { name: 'Terminal' }).click()
  await expect.poll(() => terminalText(page, bottom.locator('.ctr-terminal .terminal-host'))).toContain('fake shell in c0ffee000001')
  await bottom.locator('.ctr-terminal .terminal-host').click()
  await page.keyboard.type('ls /etc')
  await page.keyboard.press('Enter')
  await expect.poll(() => terminalText(page, bottom.locator('.ctr-terminal .terminal-host'))).toContain('ran: ls /etc')
  await expect(page.locator('.tab')).toHaveCount(2) // no new tab

  // Files: the root, a folder, a text preview, a binary one.
  await status.getByRole('tab', { name: 'Files' }).click()
  const files = bottom.locator('.ctr-files')
  await expect(files.locator('.ctr-file').first()).toContainText('etc') // folders first
  await expect(files.locator('.ctr-file', { hasText: 'hello.txt' })).toContainText('25 B')
  await files.locator('.ctr-file', { hasText: 'hello.txt' }).click()
  await expect(files.locator('.ctr-file-preview pre')).toHaveText('hello from the container\n')
  await files.locator('.ctr-file', { hasText: 'blob.bin' }).click()
  await expect(files.locator('.ctr-file-preview pre')).toContainText('Binary file')
  await files.locator('.ctr-file', { hasText: 'etc' }).click()
  await expect(files.locator('.ctr-crumbs')).toContainText('etc')
  await files.locator('.ctr-file', { hasText: 'hosts' }).click()
  await expect(files.locator('.ctr-file-preview pre')).toContainText('127.0.0.1 localhost')

  // Save a file to this computer (the save dialog answered by the test).
  const dest = join(profile, 'hosts-copy')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
  }, dest)
  await files.locator('.ctr-file-preview').getByRole('button', { name: 'Save to this computer…' }).click()
  await expect.poll(() => readLog(dest)).toBe('127.0.0.1 localhost\n::1 ip6\n')

  // A folder that does not exist: its error. Back to the root through the breadcrumb.
  await files.getByRole('textbox', { name: 'Go to path' }).fill('/nope')
  await files.getByRole('textbox', { name: 'Go to path' }).press('Enter')
  await expect(files.locator('.containers-error')).toContainText("can't cd to /nope")
  await files.locator('.ctr-crumbs').getByRole('button', { name: '/' }).click()
  await expect(files.locator('.ctr-file', { hasText: 'hello.txt' })).toBeVisible()

  // Back to the terminal: the same shell (kept while the container is selected).
  await status.getByRole('tab', { name: 'Terminal' }).click()
  await expect.poll(() => terminalText(page, bottom.locator('.ctr-terminal .terminal-host'))).toContain('ran: ls /etc')
})

test('pulling an image: suggestions from the registry, then the tags after a colon', async () => {
  const { page } = hub
  const tab = await openContainers(page)
  await tab.locator('.containers-views').getByRole('tab', { name: 'Images' }).click()
  await tab.locator('.containers-views').getByRole('button', { name: 'Pull an image…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Pull an image' })
  const input = dialog.getByRole('combobox')
  const options = dialog.getByRole('option')

  // Names: the engine's registry search; official images first.
  await input.fill('redis')
  await expect(options.locator('.ctr-suggest-name')).toHaveText(['redisOfficial', 'bitnami/redis'])
  await expect(options.first()).toContainText('★ 13,000')
  await input.press('ArrowDown')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await input.press('Enter')
  await expect(input).toHaveValue('redis')
  await expect(dialog.getByRole('listbox')).toHaveCount(0)

  // Tags (Docker Hub), filtered by what follows the colon; a click picks one.
  await input.pressSequentially(':7')
  await expect(options.locator('.ctr-suggest-name')).toHaveText(['redis:7.4-alpine', 'redis:7.4', 'redis:7'])
  await options.filter({ hasText: 'redis:7.4-alpine' }).click()
  await expect(input).toHaveValue('redis:7.4-alpine')
  await expect(dialog.getByRole('listbox')).toHaveCount(0)
  expect(engine.calls.some((c) => c.startsWith('GET /v2/repositories/library/redis/tags/') && c.includes('name=7'))).toBe(true)

  // Enter (the list closed) pulls.
  await input.press('Enter')
  await expect(tab.locator('.ctr-output')).toContainText('Status: Downloaded newer image for redis:7.4-alpine')
})

test("a container's environment: secrets masked; a change recreates the container with the same settings", async () => {
  const { page } = hub
  const tab = await openContainers(page)
  await tab.locator('.ctr-row', { hasText: 'shop-web-1' }).click()
  await tab.locator('.containers-status').getByRole('tab', { name: 'Environment' }).click()
  const env = tab.locator('.ctr-env')
  await expect(env.getByRole('textbox', { name: 'Value of NGINX_PORT' })).toHaveValue('80')
  await expect(env.getByLabel('Value of API_TOKEN')).toHaveAttribute('type', 'password')
  await expect(env.getByRole('button', { name: 'Apply' })).toBeDisabled()

  await env.getByRole('textbox', { name: 'Value of NGINX_PORT' }).fill('8081')
  await env.getByRole('button', { name: '+ Add a variable' }).click()
  await env.getByRole('textbox', { name: 'Name' }).last().fill('DEBUG')
  await env.getByRole('textbox', { name: 'Value of DEBUG' }).fill('1')
  await env.getByRole('button', { name: 'Apply' }).click()
  await page.locator('.dialog button', { hasText: 'Recreate' }).click()
  await expect(page.locator('.toast', { hasText: 'recreated with the new environment' })).toBeVisible()

  // Same image, mounts (the anonymous volume kept by name), network and aliases; the new variables; no old host name.
  expect(engine.created).toHaveLength(1)
  const body = engine.created[0]
  expect(body.Image).toBe('nginx:alpine')
  expect(body.Env).toEqual(['PATH=/usr/bin:/bin', 'NGINX_PORT=8081', 'API_TOKEN=s3cret', 'DEBUG=1'])
  expect(body.Hostname).toBeUndefined()
  expect(body.HostConfig.Binds).toEqual(['/srv/shop/html:/usr/share/nginx/html:ro', 'anon123:/var/cache/nginx'])
  expect(body.HostConfig.PortBindings).toEqual({ '80/tcp': [{ HostPort: '8080' }] })
  expect(body.NetworkingConfig.EndpointsConfig.shop_default.Aliases).toEqual(['web'])
  // The old one set aside and stopped, the new one started, then the old one removed.
  const order = [
    'POST /containers/c0ffee000001/rename',
    'POST /containers/c0ffee000001/stop',
    'POST /containers/create?name=shop-web-1',
    'POST /containers/c0ffee000101/start',
    'DELETE /containers/c0ffee000001?force=1'
  ]
  const at = order.map((o) => engine.calls.findIndex((c) => c.startsWith(o)))
  expect(at.every((i) => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)

  // The list and the view follow the new container.
  await expect(tab.locator('.ctr-row', { hasText: 'shop-web-1' })).toHaveCount(1)
  await expect(env.getByRole('textbox', { name: 'Value of NGINX_PORT' })).toHaveValue('8081')
  await expect(env.getByRole('textbox', { name: 'Value of DEBUG' })).toHaveValue('1')
})

test('new volumes: a type with its settings (NFS), labels, checks; or named by the engine', async () => {
  const { page } = hub
  const tab = await openContainers(page)
  const views = tab.locator('.containers-views')
  await views.getByRole('tab', { name: 'Volumes' }).click()
  await views.getByRole('button', { name: 'New volume…' }).click()
  let dialog = page.getByRole('dialog', { name: 'New volume' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill('nfsdata')
  await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'NFS share' })
  // Missing settings: said, nothing created.
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.locator('.containers-error')).toContainText('The NFS server and its exported path are needed.')
  await dialog.getByRole('textbox', { name: 'NFS server' }).fill('10.0.0.5')
  await dialog.getByRole('textbox', { name: 'Exported path' }).fill('/export/data')
  // Optional settings: folded under Advanced settings.
  await expect(dialog.getByRole('textbox', { name: 'Mount options' })).toBeHidden()
  await dialog.getByText('Advanced settings').click()
  await dialog.getByRole('textbox', { name: 'Mount options' }).fill('rw,nfsvers=4')
  await dialog.getByRole('textbox', { name: 'Labels (KEY=VALUE per line)' }).fill('project=shop')
  await expect(dialog.locator('.ctr-volume-preview')).toContainText('type=nfs')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(tab.locator('.ctr-row', { hasText: 'nfsdata' })).toBeVisible()
  expect(engine.volumeBodies[0]).toEqual({
    Name: 'nfsdata',
    Driver: 'local',
    DriverOpts: { type: 'nfs', o: 'addr=10.0.0.5,rw,nfsvers=4', device: ':/export/data' },
    Labels: { project: 'shop' }
  })

  // No name, the default type: the engine names it.
  await views.getByRole('button', { name: 'New volume…' }).click()
  dialog = page.getByRole('dialog', { name: 'New volume' })
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(tab.locator('.ctr-row', { hasText: 'generated0123456789' })).toBeVisible()
  expect(engine.volumeBodies[1]).toEqual({})
})

test("a container's volumes and ports: edited, then applied by recreating it", async () => {
  const { page } = hub
  const tab = await openContainers(page)
  await tab.locator('.ctr-row', { hasText: 'shop-web-1' }).click()
  const status = tab.locator('.containers-status')
  const bottom = tab.locator('.containers-bottom')

  // Volumes: a host folder (read-only) and the image's anonymous volume; one more added.
  await status.getByRole('tab', { name: 'Volumes' }).click()
  const rows = bottom.getByRole('row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).getByRole('textbox', { name: 'Source' })).toHaveValue('/srv/shop/html')
  await expect(rows.nth(0).getByRole('checkbox', { name: 'Read-only' })).toBeChecked()
  await expect(rows.nth(1).getByRole('textbox', { name: 'Path in the container' })).toHaveValue('/var/cache/nginx')
  await bottom.getByRole('button', { name: '+ Add a volume' }).click()
  // (A volume's source offers the engine's volumes: a combobox.)
  await rows.nth(2).getByLabel('Source').fill('pgdata')
  await expect(bottom.getByRole('button', { name: 'Apply' })).toBeDisabled() // no path in the container yet
  await rows.nth(2).getByRole('textbox', { name: 'Path in the container' }).fill('/data')
  await bottom.getByRole('button', { name: 'Apply' }).click()
  await page.locator('.dialog button', { hasText: 'Recreate' }).click()
  await expect(page.locator('.toast', { hasText: 'recreated with the new volumes' })).toBeVisible()
  expect(engine.created[0].HostConfig.Binds).toEqual([])
  expect(engine.created[0].HostConfig.Mounts).toEqual([
    { Type: 'bind', Source: '/srv/shop/html', Target: '/usr/share/nginx/html', ReadOnly: true },
    { Type: 'volume', Source: 'anon123', Target: '/var/cache/nginx', ReadOnly: false },
    { Type: 'volume', Source: 'pgdata', Target: '/data', ReadOnly: false }
  ])

  // Ports: 8080 → 80 moved to 8081; 443 (exposed by the image) published.
  await status.getByRole('tab', { name: 'Ports' }).click()
  await expect(bottom.getByRole('textbox', { name: 'Host port' })).toHaveValue('8080')
  await bottom.getByRole('textbox', { name: 'Host port' }).fill('8081')
  await bottom.locator('.ctr-exposed').getByRole('button', { name: '443/tcp' }).click()
  await expect(bottom.getByRole('textbox', { name: 'Container port' })).toHaveCount(2)
  await bottom.getByRole('button', { name: 'Apply' }).click()
  await page.locator('.dialog button', { hasText: 'Recreate' }).click()
  await expect(page.locator('.toast', { hasText: 'recreated with the new ports' })).toBeVisible()
  expect(engine.created[1].HostConfig.PortBindings).toEqual({
    '80/tcp': [{ HostIp: '', HostPort: '8081' }],
    '443/tcp': [{ HostIp: '', HostPort: '443' }]
  })
})

test('images, volumes and networks; pulling an image shows its output (through the CLI)', async () => {
  const { page } = hub
  const tab = await openContainers(page)
  const views = tab.locator('.containers-views')

  await views.getByRole('tab', { name: 'Images' }).click()
  await expect(tab.locator('.ctr-row', { hasText: 'nginx:alpine' })).toContainText('23 MB')
  // Containers using each image (counted: the engine does not say), 0 included.
  await expect(tab.locator('.ctr-row', { hasText: 'nginx:alpine' }).getByRole('cell').nth(4)).toHaveText('1')
  await expect(tab.locator('.ctr-row', { hasText: 'busybox' }).getByRole('cell').nth(4)).toHaveText('0')
  // Prune: every unused image (tagged ones too), not only dangling ones.
  await views.getByRole('button', { name: 'Remove unused images' }).click()
  await page.locator('.dialog button', { hasText: 'Remove' }).click()
  await expect(tab.locator('.ctr-row', { hasText: 'busybox' })).toHaveCount(0)
  await expect(tab.locator('.ctr-row', { hasText: 'nginx:alpine' })).toHaveCount(1)
  expect(engine.calls.some((c) => c.startsWith('POST /images/prune?filters=') && decodeURIComponent(c).includes('"dangling":["false"]'))).toBe(true)
  await views.getByRole('button', { name: 'Pull an image…' }).click()
  await page.locator('.dialog input').fill('redis:7')
  // Enter: the typed image (registry suggestions arriving late may cover the Pull button).
  await page.locator('.dialog input').press('Enter')
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

test('settings: engines shown, confirmations, registry login and logout; the tab is restored after a restart', async () => {
  let { page } = hub
  const tab = await openContainers(page)
  await expect(tab.locator('.ctr-row', { hasText: 'shop-web-1' })).toBeVisible()
  const openSettings = async () => {
    await tab.getByRole('button', { name: /Containers settings/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Containers settings' })
    await expect(dialog).toBeVisible()
    return dialog
  }

  // Docker left out: no engine left (Podman is not running, wslc hidden).
  let dialog = await openSettings()
  // An engine that is not running: just said, no switch.
  await expect(dialog.locator('.settings-row', { hasText: 'Podman' }).locator('.settings-row-help')).toHaveText('Podman is not running')
  await expect(dialog.getByRole('switch', { name: 'Show Podman' })).toHaveCount(0)
  await dialog.getByRole('switch', { name: 'Show Docker' }).click()
  await expect(tab.locator('.containers-unavailable')).toContainText('No container engine is running')
  await expect(tab.locator('.engine-status[data-engine="docker"]')).toHaveClass(/hidden-engine/)
  await dialog.getByRole('switch', { name: 'Show Docker' }).click()
  // No confirmation before removing.
  await dialog.getByRole('switch', { name: 'Confirm before removing' }).click()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await tab.locator('.containers-views').getByRole('tab', { name: 'Volumes' }).click()
  const vol = tab.locator('.ctr-row', { hasText: 'pgdata' })
  await vol.hover()
  await vol.getByRole('button', { name: 'Remove' }).click()
  await expect(vol).toHaveCount(0)
  await expect(page.locator('.dialog')).toHaveCount(0)

  // Registry login: a terminal running `docker login ghcr.io`; logout: a job with its output.
  dialog = await openSettings()
  await dialog.getByRole('textbox', { name: 'Registry' }).fill('ghcr.io')
  await dialog.getByRole('button', { name: 'Log in…' }).click()
  await expect.poll(() => readLog(join(profile, 'fake-docker.log'))).toContain('["login","ghcr.io"]')
  await page.locator('.tab', { hasText: 'Containers' }).click()
  dialog = await openSettings()
  await dialog.getByRole('textbox', { name: 'Registry' }).fill('ghcr.io')
  await dialog.getByRole('button', { name: 'Log out' }).click()
  await expect(tab.locator('.ctr-output-head')).toContainText('Log out of ghcr.io')
  await expect.poll(() => readLog(join(profile, 'fake-docker.log'))).toContain('["logout","ghcr.io"]')

  // Restart: the Containers tab and its settings come back.
  await quit(hub)
  hub = await launch(profile)
  page = hub.page
  await page.locator('.tab', { hasText: 'Containers' }).click()
  await expect(page.locator('.tab-panel.visible .ctr-row', { hasText: 'shop-web-1' })).toBeVisible()
  expect((await page.evaluate(() => window.ide.settings.get())).containers?.confirmRemove).toBe(false)
})
