import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
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
    return false
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

function windowsShells(): Profile[] {
  const profiles: Profile[] = []
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32').toLowerCase()

  const pwsh = which('pwsh')
  if (pwsh) profiles.push({ id: 'shell:pwsh', name: 'PowerShell', kind: 'shell', command: pwsh, args: ['-NoLogo'], source: pwsh })

  const winps = which('powershell')
  if (winps) profiles.push({ id: 'shell:powershell', name: 'Windows PowerShell', kind: 'shell', command: winps, args: ['-NoLogo'], source: winps })

  const cmd = process.env.ComSpec ?? which('cmd')
  if (cmd) profiles.push({ id: 'shell:cmd', name: 'Command Prompt', kind: 'shell', command: cmd, args: [], source: cmd })

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
  if (gitBash) profiles.push({ id: 'shell:git-bash', name: 'Git Bash', kind: 'shell', command: gitBash, args: ['--login', '-i'], source: gitBash })

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
          source: 'WSL'
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

export async function listProfiles(refresh = false): Promise<Profile[]> {
  if (cache && !refresh) return cache
  const shells = isWin ? windowsShells() : unixShells()
  const [distros] = await Promise.all([wslDistros()])
  cache = [...shells, ...distros, ...agents()]
  return cache
}

export async function findProfile(id: string): Promise<Profile | undefined> {
  return (await listProfiles()).find((p) => p.id === id)
}
