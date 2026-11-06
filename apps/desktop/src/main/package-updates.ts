import { execFile } from 'node:child_process'
import type { PackageUpdateInfo } from '@shared/types'
import { which } from './profiles'
import { wslExe, wslExec } from './wsl'

/**
 * Pending package updates of the system a shell runs on, checked once when the
 * shell starts and shown as a status bar under its terminal:
 * - a WSL distribution: its package manager's cached lists (no root, nothing downloaded);
 * - Windows (PowerShell, cmd, Git Bash…): winget.
 */
export type UpdateTarget = { kind: 'wsl'; distro: string } | { kind: 'windows' }

const targetKey = (t: UpdateTarget): string => (t.kind === 'wsl' ? `wsl:${t.distro}` : 'windows')

// ---------- WSL ----------

/** Prints "<manager> <count>". */
const WSL_CHECK_SCRIPT = [
  'if command -v apt-get >/dev/null 2>&1; then',
  "  echo \"apt $(apt list --upgradable 2>/dev/null | grep -c 'upgradable from')\"",
  'elif command -v dnf >/dev/null 2>&1; then',
  "  echo \"dnf $(dnf -q -C check-update 2>/dev/null | grep -c '^[[:alnum:]]')\"",
  'elif command -v pacman >/dev/null 2>&1; then',
  '  echo "pacman $(pacman -Qu 2>/dev/null | wc -l)"',
  'elif command -v apk >/dev/null 2>&1; then',
  "  echo \"apk $(apk version -l '<' 2>/dev/null | tail -n +2 | wc -l)\"",
  'elif command -v zypper >/dev/null 2>&1; then',
  "  echo \"zypper $(zypper -q --non-interactive --no-refresh list-updates 2>/dev/null | grep -c '^v ')\"",
  'else',
  '  echo "none 0"',
  'fi'
].join('\n')

/** Command typed into the terminal when the user accepts the update (asks for the password there). */
const UPDATE_COMMANDS: Record<string, string> = {
  apt: 'sudo apt update && sudo apt upgrade -y',
  dnf: 'sudo dnf upgrade -y',
  pacman: 'sudo pacman -Syu',
  apk: 'sudo apk upgrade -U',
  zypper: 'sudo zypper update -y',
  // Works the same from PowerShell, cmd and Git Bash; installers may ask for elevation (UAC).
  winget: 'winget upgrade --all'
}

function checkWsl(distro: string): Promise<PackageUpdateInfo | null> {
  return new Promise((resolve) => {
    // sh run directly, so the script reaches it unmodified (no shell re-parsing by wsl.exe).
    execFile(wslExe(), wslExec(distro, ['sh', '-c', WSL_CHECK_SCRIPT]), { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(null)
      const m = /^(\w+) (\d+)/m.exec(String(stdout))
      const manager = m?.[1]
      const count = Number(m?.[2] ?? 0)
      if (!manager || !UPDATE_COMMANDS[manager] || count <= 0) return resolve(null)
      resolve({ system: distro, manager, count, command: UPDATE_COMMANDS[manager] })
    })
  })
}

// ---------- Windows (winget) ----------

/**
 * Count the packages of winget's upgrade table: the rows between the header's
 * dashed separator and the end of the table. Packages that need explicit
 * targeting (a second table) are not counted, as `winget upgrade --all` skips
 * them too. Language independent (no parsing of the "N upgrades available" text).
 */
export function countWingetUpgrades(output: string): number {
  // Lines end with \r\n; progress spinners are redrawn with \r: keep what is left on each line.
  const lines = output.split('\n').map((l) => l.replace(/\r$/, '').split('\r').pop()!.trimEnd())
  const sep = lines.findIndex((l) => /^-{10,}$/.test(l.trim()))
  if (sep < 0) return 0
  let count = 0
  for (const line of lines.slice(sep + 1)) {
    // The table ends at a blank line or at the summary ("19 upgrades available.").
    if (!line.trim() || /^\d+\s/.test(line.trim())) break
    count++
  }
  return count
}

function checkWindows(): Promise<PackageUpdateInfo | null> {
  const winget = which('winget')
  if (!winget) return Promise.resolve(null)
  return new Promise((resolve) => {
    // Lists only (never installs); no prompts, no agreement acceptance on the user's behalf.
    execFile(winget, ['upgrade', '--disable-interactivity'], { timeout: 90000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(null)
      const count = countWingetUpgrades(String(stdout))
      resolve(count > 0 ? { system: 'Windows', manager: 'winget', count, command: UPDATE_COMMANDS.winget } : null)
    })
  })
}

// ---------- Shared ----------

/** One check at a time per system; results are reused for a few minutes (several tabs opening at once). */
const CACHE_MS = 5 * 60 * 1000
const recent = new Map<string, { at: number; result: Promise<PackageUpdateInfo | null> }>()

export function checkUpdates(target: UpdateTarget): Promise<PackageUpdateInfo | null> {
  const key = targetKey(target)
  const hit = recent.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result
  const result = target.kind === 'wsl' ? checkWsl(target.distro) : checkWindows()
  recent.set(key, { at: Date.now(), result })
  return result
}

/** After an accepted update, the next shell on that system checks again. */
export function forgetUpdates(target: UpdateTarget): void {
  recent.delete(targetKey(target))
}
