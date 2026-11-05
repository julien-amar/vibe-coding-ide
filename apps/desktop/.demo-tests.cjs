// Guided demo of the Tests panel: a visible, isolated app instance (own temporary profile) driven
// step by step with on-screen captions. The window stays open at the end; closing it ends the demo.
// Usage: node demo-tests.cjs <apps/desktop folder> <project to open>
const { _electron: electron } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')

const [appDir, project] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vci-demo-'))
  const app = await electron.launch({
    args: [path.join(appDir, 'out/main/index.js')],
    env: { ...process.env, VIBE_CODING_IDE_USER_DATA: userData, VIBE_CODING_IDE_DEBUG: '1' }
  })
  const page = await app.firstWindow()
  await page.locator('.tab').first().waitFor()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setBounds({ width: 1400, height: 900 })
    w.center()
    w.focus()
  })

  // Caption bar at the bottom of the window.
  const caption = async (text, ms = 3500) => {
    await page.evaluate((t) => {
      let el = document.getElementById('demo-caption')
      if (!el) {
        el = document.createElement('div')
        el.id = 'demo-caption'
        el.style.cssText =
          'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;max-width:80%;padding:12px 20px;' +
          'border-radius:10px;background:rgba(20,20,30,.92);color:#fff;font:15px/1.4 Segoe UI,system-ui,sans-serif;' +
          'box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none;text-align:center'
        document.body.appendChild(el)
      }
      el.textContent = t
      el.style.display = t ? 'block' : 'none'
    }, text)
    if (ms) await sleep(ms)
  }
  // Highlight an element for a moment.
  const spot = async (locator) => {
    await locator.evaluate((el) => {
      el.style.outline = '3px solid #ffb900'
      el.style.outlineOffset = '2px'
      setTimeout(() => {
        el.style.outline = ''
      }, 2200)
    })
  }

  const panel = page.locator('.tab-panel.visible .tests-panel')

  await caption('Demo: the Tests panel of a project tab (a separate instance — your own window is not touched).', 4500)
  await page.evaluate((r) => window.__vibeIdeTabs.getState().openProject(r), project)
  await page.locator('.tab-panel.visible .git-panel').waitFor()
  await caption('This sample project has Vitest and Playwright tests — some pass, some fail on purpose, one is skipped.', 4500)

  const rail = page.locator('.tab-panel.visible .side-rail .rail-item.tests')
  await spot(rail)
  await caption('New projects keep "Tests" collapsed in the side rail. Click it to open the panel…', 3500)
  await rail.click()
  await panel.waitFor()
  await caption('Opening the panel finds the tests with each framework’s own listing…', 0)
  await panel.locator('.test-row.kind-project').first().waitFor({ timeout: 90000 })
  await sleep(1200)
  await caption('Tests are grouped by framework, file and describe() block.', 3000)
  for (const row of await panel.locator('.test-row.kind-file').all()) await row.locator('.test-chevron').click()
  await sleep(2500)

  const runAll = panel.getByRole('button', { name: /Run all/ })
  await spot(runAll)
  await caption('"Run all" runs every test with the project’s own installed tools…', 2500)
  await runAll.click()
  await page.waitForFunction(() => !document.querySelector('.tests-summary .busy'), null, { timeout: 300000 })
  await caption('Each test shows passed ✓ / failed ✗ / skipped ○ and its duration. The summary is in the toolbar.', 5000)
  await spot(panel.locator('.tests-summary'))
  await sleep(2000)

  const failing = panel.locator('.test-row.kind-test', { hasText: 'fails on purpose' }).first()
  await caption('Click a failed test to see its error and stack trace.', 2000)
  await failing.click()
  await sleep(4500)

  const adds = panel.locator('.test-row.kind-test', { hasText: 'adds numbers' })
  await adds.hover()
  await spot(adds.locator('.test-run'))
  await caption('Hover any test, suite, file or framework and click ▶ to run just that.', 3000)
  await adds.locator('.test-run').click()
  await page.waitForFunction(() => !document.querySelector('.tests-summary .busy'), null, { timeout: 120000 })
  await sleep(1500)

  await caption('"Output" shows the console output of the runs, as the framework printed it.', 2000)
  await panel.getByRole('button', { name: 'Output' }).click()
  await sleep(4000)

  await caption('"Failed" shows only failing tests; the box filters by name.', 2000)
  await panel.locator('.tests-failed-only input').check()
  await sleep(3500)
  await panel.locator('.tests-failed-only input').uncheck()
  await panel.locator('.tests-filter').fill('nested')
  await sleep(3000)
  await panel.locator('.tests-filter').fill('')

  await caption('That’s it — the window is yours now: try the panel yourself. Close the window to end the demo.', 7000)
  await caption('', 0)
  await app.waitForEvent('close', { timeout: 0 })
  fs.rmSync(userData, { recursive: true, force: true })
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
