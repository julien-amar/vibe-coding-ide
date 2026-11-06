import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { parseWslPath } from '@shared/wsl-paths'
import { which } from '../profiles'

/** Where the agent runs: on Windows (or the host OS), or inside a WSL distribution. */
export type HarnessTarget = { kind: 'host' } | { kind: 'wsl'; distro: string; /** The distribution user's home, as a \\wsl.localhost path. */ home?: string }

/** A path (Windows or \\wsl.localhost) as the agent sees it: inside WSL, C:\x → /mnt/c/x and \\wsl.localhost\d\x → /x. */
export function agentPath(target: HarnessTarget, p: string): string {
  if (target.kind !== 'wsl') return p
  return parseWslPath(p)?.path ?? p.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')
}

/** The agent's home folder, readable from here (host home, or the distribution's home over \\wsl.localhost). */
export const agentHome = (target: HarnessTarget): string | undefined => (target.kind === 'wsl' ? target.home : homedir())

/** A stdio command as Claude Code should start it: Windows .cmd / .bat scripts (npx, uvx shims…) through cmd.exe. */
export function stdioCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  const found = isAbsolute(command) ? command : which(command)
  if (found && /\.(cmd|bat)$/i.test(found)) return { command: 'cmd', args: ['/c', command, ...args] }
  return { command, args }
}

/** A stdio server command for the target: Windows .cmd shims through cmd /c on the host, as typed inside WSL. */
export const serverCommand = (target: HarnessTarget, command: string, args: string[]): { command: string; args: string[] } =>
  target.kind === 'wsl' ? { command, args } : stdioCommand(command, args)
