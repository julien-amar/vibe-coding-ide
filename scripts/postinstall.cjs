// Runs after `pnpm install` (root postinstall).
const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs')
const { execSync } = require('node:child_process')
const { join } = require('node:path')

// pnpm 12 skips dependency build scripts unless allowed; make sure the Electron binary is downloaded.
if (!existsSync('node_modules/electron/dist')) execSync('node node_modules/electron/install.js', { stdio: 'inherit' })

// node-pty's macOS prebuilds ship `spawn-helper`, which can lose its execute bit when the package
// is extracted; every shell then fails with "posix_spawnp failed".
const prebuilds = 'node_modules/node-pty/prebuilds'
if (process.platform === 'darwin' && existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
      chmodSync(helper, 0o755)
      console.log(`made ${helper} executable`)
    }
  }
}
