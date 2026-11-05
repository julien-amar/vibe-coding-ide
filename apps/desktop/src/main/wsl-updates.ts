import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { WslUpdateInfo } from '@shared/types'

/**
 * Detects pending package updates inside a WSL distribution, using the package
 * manager's cached package lists (no root needed, nothing is downloaded).
 * Prints "<manager> <count>".
 */
const CHECK_SCRIPT = [
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

/** Command typed into the terminal when the user accepts the update (asks for the sudo password there). */
const UPDATE_COMMANDS: Record<string, string> = {
  apt: 'sudo apt update && sudo apt upgrade -y',
  dnf: 'sudo dnf upgrade -y',
  pacman: 'sudo pacman -Syu',
  apk: 'sudo apk upgrade -U',
  zypper: 'sudo zypper update -y'
}

/** One check at a time per distro; results are reused for a few minutes (several tabs opening at once). */
const CACHE_MS = 5 * 60 * 1000
const recent = new Map<string, { at: number; result: Promise<WslUpdateInfo | null> }>()

function runCheck(distro: string): Promise<WslUpdateInfo | null> {
  const wsl = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  return new Promise((resolve) => {
    // --exec: run sh directly so the script reaches it unmodified (no shell re-parsing by wsl.exe).
    execFile(wsl, ['-d', distro, '--exec', 'sh', '-c', CHECK_SCRIPT], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(null)
      const m = /^(\w+) (\d+)/m.exec(String(stdout))
      const manager = m?.[1]
      const count = Number(m?.[2] ?? 0)
      if (!manager || !UPDATE_COMMANDS[manager] || count <= 0) return resolve(null)
      resolve({ distro, manager, count, command: UPDATE_COMMANDS[manager] })
    })
  })
}

export function checkWslUpdates(distro: string): Promise<WslUpdateInfo | null> {
  const hit = recent.get(distro)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result
  const result = runCheck(distro)
  recent.set(distro, { at: Date.now(), result })
  return result
}

/** After an accepted update, the next WSL session of that distro checks again. */
export function forgetWslUpdates(distro: string): void {
  recent.delete(distro)
}
