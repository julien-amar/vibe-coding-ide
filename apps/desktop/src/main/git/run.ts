import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseWslPath } from '@shared/wsl-paths'
import { directLaunch } from '../harness'
import { which } from '../profiles'
import { wslExe, wslExec, wslLogin } from '../wsl'

/** Running git (and the hosting tools gh / glab) for a project: on this machine, or inside its WSL distribution. */

function gitBinary(): string {
  const onPath = which('git')
  if (onPath) return onPath
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
      const candidate = base && join(base, 'Git', 'cmd', 'git.exe')
      if (candidate && existsSync(candidate)) return candidate
    }
  }
  return 'git'
}

const BASE_CONFIG = ['-c', 'core.quotepath=off', '-c', 'log.showSignature=false', '-c', 'color.ui=false']

/**
 * How to run git for a project root. Repos inside WSL (\\wsl.localhost\<distro>\…)
 * run the distro's own git through wsl.exe — faster and correct (permissions,
 * symlinks, line endings) compared to Windows git over the network share.
 * --exec runs git directly: without it wsl.exe passes the command line through
 * the distro shell, which would mangle arguments such as --format=%(refname).
 */
function gitCommand(root: string, args: string[]): { file: string; args: string[]; cwd?: string } {
  const wsl = process.platform === 'win32' ? parseWslPath(root) : undefined
  if (wsl) {
    return { file: wslExe(), args: wslExec(wsl.distro, ['git', ...BASE_CONFIG, ...args], wsl.path) }
  }
  return { file: gitBinary(), args: ['-C', root, ...BASE_CONFIG, ...args] }
}

/**
 * How to run a hosting tool (gh, glab) in the repository: inside the distribution for WSL
 * repositories (through a login shell, where its PATH and credentials are), else from PATH.
 */
export function toolCommand(root: string, program: 'gh' | 'glab', args: string[]): { file: string; args: string[]; cwd?: string } | undefined {
  const wsl = process.platform === 'win32' ? parseWslPath(root) : undefined
  if (wsl) {
    return { file: wslExe(), args: wslLogin(wsl.distro, program, args, { cd: wsl.path }) }
  }
  const exe = which(program)
  if (!exe) return undefined
  // A command shim (npm-style .cmd): its script is started directly (cmd.exe would mangle a
  // description with quotes or line breaks; Node cannot spawn .cmd files without a shell).
  if (/\.(cmd|bat)$/i.test(exe)) {
    const direct = directLaunch(exe, args)
    return direct ? { file: direct.command, args: direct.args, cwd: root } : undefined
  }
  return { file: exe, args, cwd: root }
}

export interface RunOptions {
  timeout?: number
  input?: string
  /** Exit codes that are not errors (e.g. 1 for `git diff --no-index` with differences). */
  okCodes?: number[]
  /** Extra environment variables. */
  env?: Record<string, string>
}

export function git(root: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return run(gitCommand(root, args), `git ${args[0]}`, opts)
}

export function run(cmd: { file: string; args: string[]; cwd?: string }, label: string, opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, {
      cwd: cmd.cwd,
      windowsHide: true,
      // Never block on a terminal credential prompt; credential managers (GUI) still work.
      // gh / glab: no prompts, no pager, no colours.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', PAGER: 'cat', ...(opts.env ?? {}) }
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    child.stdout.on('data', (b: Buffer) => {
      size += b.length
      if (size <= 64 * 1024 * 1024) out.push(b)
    })
    child.stderr.on('data', (b: Buffer) => err.push(b))
    const timer = setTimeout(() => child.kill(), opts.timeout ?? 20000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      if (code === 0 || (code !== null && opts.okCodes?.includes(code))) resolve(stdout)
      else reject(new Error(Buffer.concat(err).toString('utf8').trim() || stdout.trim() || `${label} failed (exit ${code})`))
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** Options for commands that reach a remote (fetch, push…). */
export const NETWORK = { timeout: 180000 }
