import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Profile, PtyCreateRequest } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { agentMajorVersion, agentOf, compileHarness, directLaunch, harnessIsEmpty, sanitizeHarness, type CompiledHarness, type HarnessTarget } from './harness'
import { wslHome } from './profiles'
import { wslenvWith } from './wsl'

/** How a terminal / agent panel's process starts: its folder, and an agent panel's own settings. */

export const isDir = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The profile started in a folder. WSL processes start in a Linux directory (wsl.exe --cd): a Linux
 * path, or a \\wsl.localhost\<distro>\… path of the same distribution. Others get it as their cwd.
 */
export function startIn(profile: Profile, dir: string | undefined): { launch: Profile; cwd?: string } {
  if (!profile.wslDistro) return { launch: profile, cwd: dir && isDir(dir) ? dir : undefined }
  const wsl = dir ? parseWslPath(dir) : undefined
  const linuxDir = dir?.startsWith('/') ? dir : wsl && wsl.distro.toLowerCase() === profile.wslDistro.toLowerCase() ? wsl.path : undefined
  if (!linuxDir) return { launch: profile }
  const i = profile.args.indexOf('--cd')
  return { launch: { ...profile, args: i >= 0 ? profile.args.map((a, j) => (j === i + 1 ? linuxDir : a)) : ['--cd', linuxDir, ...profile.args] } }
}

/**
 * An AI agent panel's launch with its own settings (MCP servers, skills, instructions): files
 * generated in `runsDir` (app data, not the repository) and passed with flags / environment.
 */
export async function withAgentSettings(launch: Profile, req: PtyCreateRequest, cwd: string | undefined, runsDir: string): Promise<Profile> {
  const harness = req.harness ? sanitizeHarness(req.harness) : undefined
  if (launch.kind !== 'agent' || !harness || harnessIsEmpty(harness)) return launch
  const root = req.harnessRoot && isDir(String(req.harnessRoot)) ? String(req.harnessRoot) : (cwd ?? homedir())
  const agent = agentOf(launch.id)
  const outDir = join(
    runsDir,
    createHash('sha1')
      .update(root + JSON.stringify(harness))
      .digest('hex')
      .slice(0, 16),
    `${agent ?? 'agent'}${launch.wslDistro ? `-${launch.wslDistro}` : ''}`
  )
  const target: HarnessTarget = launch.wslDistro ? { kind: 'wsl', distro: launch.wslDistro, home: await wslHome(launch.wslDistro) } : { kind: 'host' }
  // opencode 2 needs a private server for the panel's settings (opencode 1 does not know the flag).
  const opencodeMajor = agent === 'opencode' ? await agentMajorVersion(launch) : undefined
  const extra = compileHarness(agent, harness, root, outDir, target, { opencodeMajor })
  return extra.args.length || Object.keys(extra.env).length ? withExtra(launch, extra) : launch
}

/**
 * A launch with arguments and environment added. Host agents: arguments appended (npm command shims
 * launched directly: cmd.exe would mangle quotes and line breaks). WSL agents (… --exec bash -lic
 * 'exec <agent>'): the arguments go through "$@", one Linux argument each; environment variables
 * cross into the distribution through WSLENV.
 */
export function withExtra(launch: Profile, extra: CompiledHarness): Profile {
  const env = { ...(launch.env ?? {}), ...extra.env }
  if (launch.wslDistro) {
    const last = launch.args.length - 1
    const agentCmd = /^exec (\S+)$/.exec(launch.args[last] ?? '')?.[1]
    if (!agentCmd) return launch
    const names = Object.keys(extra.env)
    return {
      ...launch,
      args: [...launch.args.slice(0, last), `exec ${agentCmd} "$@"`, agentCmd, ...extra.args],
      env: names.length ? { ...env, WSLENV: wslenvWith(...(launch.env?.WSLENV ? [launch.env.WSLENV] : []), ...names) } : env
    }
  }
  const direct = extra.args.length ? directLaunch(launch.command, launch.args) : undefined
  return { ...launch, ...(direct ?? {}), args: [...(direct?.args ?? launch.args), ...extra.args], env }
}
