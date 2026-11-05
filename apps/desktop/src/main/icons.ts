import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { app, nativeImage } from 'electron'
import type { Profile } from '@shared/types'

/**
 * Real icons for launch profiles, taken from the installed software itself:
 * - Windows executables (powershell.exe, cmd.exe, git-bash.exe…): the exe's embedded icon.
 * - WSL distributions: the `shortcut.ico` the distro ships in its install folder.
 * Returns null when no meaningful icon exists (npm .cmd shims, Unix shells); the UI then
 * draws a monogram instead.
 */
const cache = new Map<string, Promise<string | null>>()

const ICON_PX = 32

function toDataUrl(img: Electron.NativeImage): string | null {
  if (img.isEmpty()) return null
  const { width } = img.getSize()
  return (width > ICON_PX ? img.resize({ width: ICON_PX, height: ICON_PX, quality: 'best' }) : img).toDataURL()
}

async function fileIcon(path: string): Promise<string | null> {
  try {
    return toDataUrl(await app.getFileIcon(path, { size: 'normal' }))
  } catch {
    return null
  }
}

/** Map of WSL distribution name → install folder, from the registry (HKCU\…\Lxss). */
let wslBasePaths: Promise<Map<string, string>> | undefined
function wslInstallFolders(): Promise<Map<string, string>> {
  wslBasePaths ??= new Promise((resolve) => {
    const map = new Map<string, string>()
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    execFile(reg, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(map)
      let name: string | undefined
      let base: string | undefined
      const flush = (): void => {
        if (name && base) map.set(name, base)
        name = base = undefined
      }
      for (const line of stdout.split(/\r?\n/)) {
        if (/^HKEY_/.test(line)) {
          flush()
          continue
        }
        const m = /^\s+(\w+)\s+REG_\w+\s+(.*)$/.exec(line)
        if (!m) continue
        if (m[1] === 'DistributionName') name = m[2].trim()
        if (m[1] === 'BasePath') base = m[2].trim().replace(/^\\\\\?\\/, '')
      }
      flush()
      resolve(map)
    })
  })
  return wslBasePaths
}

/**
 * The icon Windows shows for an executable without an embedded icon. Executables
 * that only have this icon (e.g. Git's bin\bash.exe, claude.exe) get a monogram
 * instead, so entries stay distinguishable.
 */
let genericExeIcon: Promise<string | null> | undefined
function genericIcon(): Promise<string | null> {
  genericExeIcon ??= (async () => {
    try {
      const dir = join(app.getPath('temp'), 'devhub-icons')
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, 'no-icon.exe')
      if (!existsSync(probe)) writeFileSync(probe, '')
      return await fileIcon(probe)
    } catch {
      return null
    }
  })()
  return genericExeIcon
}

async function exeIcon(path: string): Promise<string | null> {
  const icon = await fileIcon(path)
  return icon && icon !== (await genericIcon()) ? icon : null
}

async function resolveIcon(profile: Profile): Promise<string | null> {
  if (process.platform !== 'win32') return null

  if (profile.kind === 'wsl') {
    const base = (await wslInstallFolders()).get(profile.name)
    const ico = base && join(base, 'shortcut.ico')
    if (!ico || !existsSync(ico)) return null
    return toDataUrl(nativeImage.createFromPath(ico)) ?? (await fileIcon(ico))
  }

  const source = profile.source ?? profile.command
  // Git's executables only expose the generic icon; Git for Windows ships its icon as a .ico file.
  if (profile.id === 'shell:git-bash') {
    const gitRoot = dirname(dirname(source)) // ...\Git\bin\bash.exe -> ...\Git
    for (const env of ['ucrt64', 'mingw64', 'clangarm64', 'mingw32']) {
      const ico = join(gitRoot, env, 'share', 'git', 'git-for-windows.ico')
      if (existsSync(ico)) {
        const icon = toDataUrl(nativeImage.createFromPath(ico))
        if (icon) return icon
      }
    }
    const launcher = join(gitRoot, 'git-bash.exe')
    if (existsSync(launcher)) {
      const icon = await exeIcon(launcher)
      if (icon) return icon
    }
  }
  // .cmd/.bat shims only have the generic batch-file icon: let the UI draw a monogram.
  if (extname(source).toLowerCase() !== '.exe' || !existsSync(source)) return null
  return exeIcon(source)
}

export function profileIcon(profile: Profile): Promise<string | null> {
  let p = cache.get(profile.id)
  if (!p) {
    p = resolveIcon(profile).catch(() => null)
    cache.set(profile.id, p)
  }
  return p
}
