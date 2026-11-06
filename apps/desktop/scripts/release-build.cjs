#!/usr/bin/env node
// Builds the installers for the current OS (used by .github/workflows/release.yml), signed when the
// repository has signing secrets, unsigned otherwise:
//
//   Windows, either
//     - Azure Trusted Signing: secrets AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and
//       variables AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE,
//       AZURE_SIGNING_PUBLISHER (the certificate's subject name, e.g. "Jane Doe")
//     - or a code signing certificate: secrets WIN_CSC_LINK (base64 .pfx), WIN_CSC_KEY_PASSWORD
//   macOS: secrets MAC_CSC_LINK (base64 "Developer ID Application" .p12), MAC_CSC_KEY_PASSWORD;
//     notarized when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are set too.
//     A signed macOS build updates itself; an unsigned one only tells about new versions.
//   Linux: AppImage / deb are not signed.
//
// Usage: node scripts/release-build.cjs        (from apps/desktop; --dry-run prints the plan)
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/** The electron-builder arguments and environment for this OS and these secrets. */
function signingPlan(env, platform) {
  const has = (...names) => names.every((n) => typeof env[n] === 'string' && env[n].trim() !== '')
  const args = []
  const extraEnv = {}
  let signed = 'no'
  let macSigned = false
  if (platform === 'win32') {
    if (
      has(
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET',
        'AZURE_SIGNING_ENDPOINT',
        'AZURE_SIGNING_ACCOUNT',
        'AZURE_SIGNING_PROFILE',
        'AZURE_SIGNING_PUBLISHER'
      )
    ) {
      args.push(
        `-c.win.azureSignOptions.endpoint=${env.AZURE_SIGNING_ENDPOINT}`,
        `-c.win.azureSignOptions.codeSigningAccountName=${env.AZURE_SIGNING_ACCOUNT}`,
        `-c.win.azureSignOptions.certificateProfileName=${env.AZURE_SIGNING_PROFILE}`,
        `-c.win.azureSignOptions.publisherName=${env.AZURE_SIGNING_PUBLISHER}`
      )
      signed = 'Azure Trusted Signing'
    } else if (has('WIN_CSC_LINK')) {
      signed = 'code signing certificate' // electron-builder reads WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD
    } else extraEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  } else if (platform === 'darwin') {
    if (has('MAC_CSC_LINK')) {
      extraEnv.CSC_LINK = env.MAC_CSC_LINK
      extraEnv.CSC_KEY_PASSWORD = env.MAC_CSC_KEY_PASSWORD ?? ''
      macSigned = true
      if (has('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID')) {
        args.push('-c.mac.notarize=true')
        signed = 'Developer ID, notarized'
      } else signed = 'Developer ID, not notarized (set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)'
    } else {
      args.push('-c.mac.identity=null')
      extraEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    }
  }
  return { args, env: extraEnv, signed, macSigned }
}

function main() {
  const dir = path.join(__dirname, '..')
  const plan = signingPlan(process.env, process.platform)
  console.log(`Signing: ${plan.signed}`)
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ args: plan.args, env: Object.keys(plan.env) }, null, 2))
    return
  }
  // Tell the app whether it can update itself on macOS (read by src/main/updater.ts).
  const pkgFile = path.join(dir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  pkg.vibeCodingIde = { ...(pkg.vibeCodingIde ?? {}), macSigned: plan.macSigned }
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')

  const run = (args) => {
    const r = spawnSync('pnpm', args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...plan.env } })
    if (r.status !== 0) process.exit(r.status ?? 1)
  }
  run(['run', 'build'])
  run(['exec', 'electron-builder', '--publish', 'never', ...plan.args.map((a) => (process.platform === 'win32' ? `"${a}"` : a))])
}

module.exports = { signingPlan }
if (require.main === module) main()
