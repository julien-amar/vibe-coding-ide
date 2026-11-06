import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { which } from '../profiles'
import { killTree, readText } from '../tests/core'

/**
 * An npm command shim on Windows (codex.cmd…) as a direct launch: `node <script>` (or the .exe it
 * runs). The shim runs through cmd.exe, which would mangle arguments with quotes or line breaks.
 */
export function directLaunch(command: string, args: string[]): { command: string; args: string[] } | undefined {
  if (process.platform !== 'win32') return undefined
  // launchSpec form: cmd.exe /d /c <shim.cmd> <args…>
  const shim = /cmd(\.exe)?$/i.test(command) && args[0] === '/d' && args[1] === '/c' ? args[2] : /\.cmd$/i.test(command) ? command : undefined
  if (!shim || !/\.cmd$/i.test(shim)) return undefined
  const rest = shim === command ? args : args.slice(3)
  const target = /"%dp0%\\([^"]+\.(?:js|cjs|mjs|exe))"\s+%\*/i.exec(readText(shim))?.[1]
  if (!target) return undefined
  const file = join(shim, '..', target)
  if (!existsSync(file)) return undefined
  if (/\.exe$/i.test(file)) return { command: file, args: rest }
  const node = which('node')
  return node ? { command: node, args: [file, ...rest] } : undefined
}

const versionCache = new Map<string, { at: number; major: Promise<number | undefined> }>()

/**
 * Major version of the agent an agent profile starts (`<agent> --version`), through the same launch:
 * an npm shim run directly, or `bash -lic 'exec <agent>'` inside WSL. Cached for 10 minutes.
 */
export function agentMajorVersion(launch: { command: string; args: string[] }): Promise<number | undefined> {
  const key = JSON.stringify([launch.command, launch.args])
  const hit = versionCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.major
  const last = launch.args.length - 1
  const inWsl = /^exec \S+$/.test(launch.args[last] ?? '')
  const spec = inWsl
    ? { command: launch.command, args: [...launch.args.slice(0, last), `${launch.args[last]} --version`] }
    : (() => {
        const direct = directLaunch(launch.command, launch.args) ?? launch
        return { command: direct.command, args: [...direct.args, '--version'] }
      })()
  const major = new Promise<number | undefined>((done) => {
    let out = ''
    const child = spawn(spec.command, spec.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => killTree(child), 20_000)
    child.stdout.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr.on('data', (b: Buffer) => (out += b.toString()))
    child.on('error', () => done(undefined))
    child.on('close', () => {
      clearTimeout(timer)
      const m = /(?:^|\s|v)(\d+)\.\d+(?:\.\d+)?/.exec(out)
      done(m ? Number(m[1]) : undefined)
    })
  })
  versionCache.set(key, { at: Date.now(), major })
  return major
}
