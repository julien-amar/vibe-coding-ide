import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cmdCommandLine, spawnSpec } from './profiles'

/**
 * .cmd / .bat programs started directly (the editor's code.cmd, mvn.cmd, gradlew.bat, npm shims):
 * cmd.exe reads its command line again, so a file name or a test name with "&" could run commands.
 */
describe('cmd.exe command lines', () => {
  it('quotes the arguments cmd.exe would read as commands; refuses what no quoting makes safe', () => {
    expect(cmdCommandLine('C:\\Program Files\\Code\\bin\\code.cmd', ['-g', 'C:\\repo\\x&md,pwned&.js:1:1'])).toBe(
      '"C:\\Program Files\\Code\\bin\\code.cmd" -g "C:\\repo\\x&md,pwned&.js:1:1"'
    )
    // "=" is quoted too (a batch file's %1 would split there); a trailing backslash is doubled when quoted.
    expect(cmdCommandLine('mvn.cmd', ['-Dtest=A#b', 'a|b', 'x (y)', 'C:\\dir\\', 'C:\\my dir\\'])).toBe(
      '"mvn.cmd" "-Dtest=A#b" "a|b" "x (y)" C:\\dir\\ "C:\\my dir\\\\"'
    )
    expect(cmdCommandLine('x.cmd', [''])).toBe('"x.cmd" ""')
    expect(() => cmdCommandLine('x.cmd', ['50% off'])).toThrow(/safely/)
    expect(() => cmdCommandLine('x.cmd', ['say "hi"'])).toThrow(/safely/)
    expect(() => cmdCommandLine('x.cmd', ['a\nb'])).toThrow(/safely/)
  })

  const dir = mkdtempSync(join(tmpdir(), 'vci-cmd-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it.skipIf(process.platform !== 'win32')('a real .cmd gets the arguments as they are, and nothing else runs', () => {
    // The .cmd hands its arguments to node, as code.cmd / npm shims do with %*.
    const shim = join(dir, 'echo-args.cmd')
    writeFileSync(shim, `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`)
    const args = ['-g', join(dir, 'x&md,pwned&.js:1:1'), 'a|b', 'x (y)', 'k=v;w', 'plain']
    const spec = spawnSpec(shim, args)
    expect(spec.verbatim).toBe(true)
    const r = spawnSync(spec.command, spec.args, {
      cwd: dir,
      encoding: 'utf8',
      windowsVerbatimArguments: spec.verbatim,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout.trim())).toEqual(args)
    expect(existsSync(join(dir, 'pwned'))).toBe(false)
  })
})
