import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signingPlan } = require('../../scripts/release-build.cjs') as {
  signingPlan(env: Record<string, string | undefined>, platform: string): { args: string[]; env: Record<string, string>; signed: string; macSigned: boolean }
}

describe('release signing, from the repository secrets', () => {
  it('builds unsigned installers without secrets', () => {
    expect(signingPlan({}, 'win32')).toMatchObject({ args: [], env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, signed: 'no' })
    expect(signingPlan({}, 'darwin')).toMatchObject({ args: ['-c.mac.identity=null'], macSigned: false })
    expect(signingPlan({}, 'linux')).toMatchObject({ args: [], env: {} })
  })

  it('signs Windows builds with a certificate or Azure Trusted Signing', () => {
    expect(signingPlan({ WIN_CSC_LINK: 'base64' }, 'win32')).toMatchObject({ args: [], env: {}, signed: 'code signing certificate' })
    const azure = signingPlan(
      {
        AZURE_TENANT_ID: 't',
        AZURE_CLIENT_ID: 'c',
        AZURE_CLIENT_SECRET: 's',
        AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net/',
        AZURE_SIGNING_ACCOUNT: 'acct',
        AZURE_SIGNING_PROFILE: 'prof',
        AZURE_SIGNING_PUBLISHER: 'Jane Doe'
      },
      'win32'
    )
    expect(azure.signed).toBe('Azure Trusted Signing')
    expect(azure.args).toContain('-c.win.azureSignOptions.publisherName=Jane Doe')
    // Incomplete Azure settings: not used (unsigned rather than a failing build).
    expect(signingPlan({ AZURE_CLIENT_ID: 'c' }, 'win32').signed).toBe('no')
  })

  it('signs (and notarizes) macOS builds with a Developer ID', () => {
    const signed = signingPlan({ MAC_CSC_LINK: 'p12', MAC_CSC_KEY_PASSWORD: 'pw' }, 'darwin')
    expect(signed).toMatchObject({ args: [], env: { CSC_LINK: 'p12', CSC_KEY_PASSWORD: 'pw' }, macSigned: true })
    const notarized = signingPlan({ MAC_CSC_LINK: 'p12', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }, 'darwin')
    expect(notarized.args).toEqual(['-c.mac.notarize=true'])
  })
})
