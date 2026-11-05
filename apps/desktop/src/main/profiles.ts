import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, extname, join } from 'node:path'
import type { Profile } from '@shared/types'

const isWin = process.platform === 'win32'

/** Directories listed in PATH, de-duplicated, existing only. */
function pathDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const d of raw.split(delimiter)) {
    const dir = d.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    const key = isWin ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(dir)
  }
  return dirs
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    // Windows "app execution aliases" (e.g. WindowsApps\winget.exe) cannot be stat'ed
    // (EACCES) but are runnable: they show up as reparse points (symbolic links).
    if (!isWin) return false
    try {
      return lstatSync(p).isSymbolicLink() && /\\WindowsApps\\/i.test(p)
    } catch {
      return false
    }
  }
}

/** Find all matches of an executable name on PATH (like `where` / `which -a`). */
function whichAll(name: string): string[] {
  const exts = isWin
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
    : ['']
  const out: string[] = []
  for (const dir of pathDirs()) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (isFile(candidate)) out.push(candidate)
    }
  }
  return out
}

export function which(name: string): string | undefined {
  return whichAll(name)[0]
}

/** On Windows, .cmd/.bat shims must be started through cmd.exe. */
function launchSpec(exe: string, args: string[] = []): { command: string; args: string[] } {
  if (isWin && ['.cmd', '.bat'].includes(extname(exe).toLowerCase())) {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', exe, ...args] }
  }
  return { command: exe, args }
}

/**
 * Shell integration: each shell reports its working directory after every prompt
 * with a standard terminal sequence (OSC 9;9 "path" like Windows Terminal, or
 * OSC 7 file://host/path). DevHub records it so restored shells reopen there.
 */
const POWERSHELL_INTEGRATION = [
  '$global:__devhubPrompt = $function:prompt',
  'function global:prompt {',
  '  $loc = $executionContext.SessionState.Path.CurrentLocation',
  "  if ($loc.Provider.Name -eq 'FileSystem') { [Console]::Write(\"$([char]27)]9;9;`\"$($loc.ProviderPath)`\"$([char]27)\\\") }",
  '  & $global:__devhubPrompt',
  '}'
].join("\n")

const powershellArgs = (): string[] => ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(POWERSHELL_INTEGRATION, 'utf16le').toString('base64')]

/** cmd.exe expands $e (ESC) and $P (current path) in PROMPT. */
const CMD_PROMPT = '$e]9;9;$P$e\\$P$G'

/** Git Bash: report the Windows form of the current directory. */
const GIT_BASH_PROMPT_COMMAND = 'printf "\\033]9;9;%s\\033\\\\" "$(pwd -W 2>/dev/null || pwd)"'

/** bash inside WSL: report the Linux path (OSC 7). */
export const WSL_PROMPT_COMMAND = 'printf "\\033]7;file://%s%s\\033\\\\" "$HOSTNAME" "$PWD"'

function windowsShells(): Profile[] {
  const profiles: Profile[] = []
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32').toLowerCase()

  const pwsh = which('pwsh')
  if (pwsh) profiles.push({ id: 'shell:pwsh', name: 'PowerShell', kind: 'shell', command: pwsh, args: powershellArgs(), source: pwsh })

  const winps = which('powershell')
  if (winps) profiles.push({ id: 'shell:powershell', name: 'Windows PowerShell', kind: 'shell', command: winps, args: powershellArgs(), source: winps })

  const cmd = process.env.ComSpec ?? which('cmd')
  if (cmd) profiles.push({ id: 'shell:cmd', name: 'Command Prompt', kind: 'shell', command: cmd, args: [], source: cmd, env: { PROMPT: CMD_PROMPT } })

  // Git Bash: derive from git.exe on PATH, else default install locations.
  const gitBashCandidates: string[] = []
  const git = which('git')
  if (git) {
    const gitRoot = dirname(dirname(git)) // ...\Git\cmd\git.exe -> ...\Git
    gitBashCandidates.push(join(gitRoot, 'bin', 'bash.exe'))
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) gitBashCandidates.push(join(base, 'Git', 'bin', 'bash.exe'))
  }
  const gitBash = gitBashCandidates.find(isFile)
  if (gitBash) {
    profiles.push({
      id: 'shell:git-bash',
      name: 'Git Bash',
      kind: 'shell',
      command: gitBash,
      args: ['--login', '-i'],
      source: gitBash,
      env: { PROMPT_COMMAND: GIT_BASH_PROMPT_COMMAND }
    })
  }

  // Other shells on PATH. Skip System32\bash.exe (the legacy WSL launcher) and Git's own bash.
  const others: Array<[string, string, string[]]> = [
    ['nu', 'Nushell', []],
    ['fish', 'Fish', []],
    ['zsh', 'Zsh', []],
    ['bash', 'Bash', ['--login', '-i']],
    ['elvish', 'Elvish', []],
    ['xonsh', 'Xonsh', []]
  ]
  for (const [exe, label, args] of others) {
    for (const found of whichAll(exe)) {
      const lower = found.toLowerCase()
      if (lower.startsWith(system32)) continue
      if (gitBash && lower.startsWith(dirname(dirname(gitBash)).toLowerCase())) continue
      const spec = launchSpec(found, args)
      profiles.push({ id: `shell:${exe}:${lower}`, name: label, kind: 'shell', ...spec, source: found })
      break
    }
  }
  return profiles
}

function unixShells(): Profile[] {
  const candidates = new Set<string>()
  if (process.env.SHELL) candidates.add(process.env.SHELL)
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split('\n')) {
      const p = line.trim()
      if (p && !p.startsWith('#')) candidates.add(p)
    }
  } catch {
    /* no /etc/shells */
  }
  for (const name of ['bash', 'zsh', 'fish', 'nu', 'pwsh', 'elvish', 'xonsh', 'sh']) {
    const found = which(name)
    if (found) candidates.add(found)
  }

  const seen = new Set<string>()
  const profiles: Profile[] = []
  for (const p of candidates) {
    if (!existsSync(p)) continue
    let real = p
    try {
      real = realpathSync(p)
    } catch {
      /* keep p */
    }
    const name = basename(real)
    if (seen.has(name)) continue // one entry per shell name (e.g. /bin/bash vs /usr/bin/bash)
    seen.add(name)
    const loginArgs = process.platform === 'darwin' ? ['-l'] : []
    const args = ['bash', 'zsh', 'sh', 'fish'].includes(name) ? loginArgs : []
    profiles.push({ id: `shell:${name}`, name, kind: 'shell', command: p, args, source: p })
  }
  return profiles
}

/** WSLENV with an extra entry, keeping what the user already shares with WSL. */
export function wslenvWith(entry: string): string {
  const cur = process.env.WSLENV
  return cur ? `${cur}:${entry}` : entry
}

/** Decode `wsl.exe` output, which is UTF-16LE unless WSL_UTF8=1 is honored. */
function decodeWslOutput(buf: Buffer): string {
  const looksUtf16 = buf.length >= 2 && (buf[1] === 0 || (buf[0] === 0xff && buf[1] === 0xfe))
  return (looksUtf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '').replace(/\0/g, '')
}

function wslDistros(): Promise<Profile[]> {
  if (!isWin) return Promise.resolve([])
  const wsl = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  if (!isFile(wsl)) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(wsl, ['-l', '-q'], { encoding: 'buffer', timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([])
      const names = decodeWslOutput(stdout as Buffer)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('docker-desktop'))
      resolve(
        names.map((distro) => ({
          id: `wsl:${distro}`,
          name: distro,
          kind: 'wsl' as const,
          command: wsl,
          args: ['-d', distro, '--cd', '~'],
          source: 'WSL',
          wslDistro: distro,
          // Pass PROMPT_COMMAND into the distro (WSLENV) so bash reports its directory.
          env: { PROMPT_COMMAND: WSL_PROMPT_COMMAND, WSLENV: wslenvWith('PROMPT_COMMAND/u') }
        }))
      )
    })
  })
}

/** AI agent CLIs: each one is simply a terminal profile running the agent. */
function agents(): Profile[] {
  const known: Array<[string, string]> = [
    ['claude', 'Claude Code'],
    ['codex', 'Codex CLI'],
    ['gemini', 'Gemini CLI'],
    ['opencode', 'opencode'],
    ['pi', 'pi']
  ]
  const profiles: Profile[] = []
  for (const [exe, label] of known) {
    const found = which(exe)
    if (!found) continue
    profiles.push({ id: `agent:${exe}`, name: label, kind: 'agent', ...launchSpec(found), source: found })
  }
  return profiles
}

let cache: Profile[] | undefined
/** Agents found inside WSL distributions (discovered on demand, per distro). */
const wslAgentCache = new Map<string, Profile[]>()

export async function listProfiles(refresh = false): Promise<Profile[]> {
  if (cache && !refresh) return [...cache, ...[...wslAgentCache.values()].flat()]
  const shells = isWin ? windowsShells() : unixShells()
  const [distros] = await Promise.all([wslDistros()])
  cache = [...shells, ...distros, ...agents()]
  return [...cache, ...[...wslAgentCache.values()].flat()]
}

const AGENT_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI', opencode: 'opencode', pi: 'pi' }

/**
 * Agent CLIs installed inside a WSL distribution. They run in the distro
 * through a login shell (so PATH from ~/.profile / nvm etc. applies). This
 * starts the distro, so it is only done when a WSL project needs it.
 */
export function wslAgents(distro: string): Promise<Profile[]> {
  const known = wslAgentCache.get(distro)
  if (known) return Promise.resolve(known)
  const wsl = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  const script = `for c in ${Object.keys(AGENT_LABELS).join(' ')}; do p=$(command -v "$c" 2>/dev/null) && echo "$c=$p"; done`
  return new Promise((resolve) => {
    execFile(wsl, ['-d', distro, '--exec', 'bash', '-lic', script], { encoding: 'buffer', timeout: 20000, windowsHide: true }, (_err, stdout) => {
      const found: Profile[] = []
      for (const line of decodeWslOutput((stdout as Buffer) ?? Buffer.alloc(0)).split(/\r?\n/)) {
        const m = /^(\w+)=(\/.+)$/.exec(line.trim())
        if (!m || !AGENT_LABELS[m[1]]) continue
        found.push({
          id: `wslagent:${distro}:${m[1]}`,
          name: `${AGENT_LABELS[m[1]]} (${distro})`,
          kind: 'agent',
          command: wsl,
          args: ['-d', distro, '--cd', '~', '--exec', 'bash', '-lic', `exec ${m[1]}`],
          source: `${distro}: ${m[2]}`,
          wslDistro: distro
        })
      }
      wslAgentCache.set(distro, found)
      resolve(found)
    })
  })
}

export async function findProfile(id: string): Promise<Profile | undefined> {
  return (await listProfiles()).find((p) => p.id === id)
}
