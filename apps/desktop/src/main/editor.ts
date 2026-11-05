import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { shell } from 'electron'
import { parseWslPath } from '@shared/wsl-paths'
import { launchSpec, which } from './profiles'

/**
 * "Open in editor" for file references in test results and stack traces: the
 * user's code editor at the line (VS Code, Cursor, Windsurf, VSCodium, Zed,
 * Sublime Text), otherwise the system's default app for the file.
 */

/** Editors on PATH, in order of preference, and how each takes "file at line:column". */
const EDITORS: { cmd: string; args: (file: string, line: number, col: number) => string[] }[] = [
  ...['code', 'cursor', 'windsurf', 'codium'].map((cmd) => ({ cmd, args: (f: string, l: number, c: number) => ['-g', `${f}:${l}:${c}`] })),
  { cmd: 'zed', args: (f, l, c) => [`${f}:${l}:${c}`] },
  { cmd: 'subl', args: (f, l, c) => [`${f}:${l}:${c}`] }
]

const isWinAbsolute = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p)

/** Same folder, or inside it (case-insensitive on Windows). */
function isInside(dir: string, p: string): boolean {
  const norm = (s: string): string => {
    const n = normalize(s).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? n.toLowerCase() : n
  }
  const d = norm(dir)
  const f = norm(p)
  const sep = process.platform === 'win32' ? '\\' : '/'
  return f === d || f.startsWith(d + sep)
}

/**
 * A file reference from test output as an existing file, or undefined. Accepts absolute paths,
 * file:// URLs, Linux paths of a WSL project (/home/…, /mnt/c/…) and paths relative to `base`
 * (the test project folder, inside the project; default: the project root). The file may be
 * outside the project (e.g. a dependency in a parent folder's node_modules): `inProject` says.
 */
export function resolveFileReference(root: string, file: string, base = root): { path: string; inProject: boolean } | undefined {
  let f = file.trim()
  if (/^file:\/\//i.test(f)) {
    try {
      f = decodeURIComponent(f.replace(/^file:\/\/(localhost)?/i, ''))
    } catch {
      return undefined
    }
    if (/^\/[A-Za-z]:[\\/]/.test(f)) f = f.slice(1) // file:///C:/x
  }
  const wslRoot = parseWslPath(root)
  if (wslRoot && f.startsWith('/')) {
    const mnt = /^\/mnt\/([a-z])\/(.*)$/i.exec(f)
    if (mnt) f = `${mnt[1].toUpperCase()}:\\${mnt[2]}`
    else {
      // \\wsl.localhost\<distro> (or \\wsl$\<distro>) as in the project root, then the Linux path.
      const prefix = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/][^\\/]+/i.exec(root)![0]
      f = prefix + f
    }
  }
  const absolute = process.platform === 'win32' ? isWinAbsolute(f) : f.startsWith('/')
  const safeBase = isInside(root, base) ? base : root
  const path = normalize(absolute ? f : join(safeBase, f))
  try {
    return statSync(path).isFile() ? { path, inProject: isInside(root, path) } : undefined
  } catch {
    return undefined
  }
}

/** An existing file inside the project, or undefined (see resolveFileReference). */
export function resolveProjectFile(root: string, file: string, base = root): string | undefined {
  const r = resolveFileReference(root, file, base)
  return r?.inProject ? r.path : undefined
}

export async function openInEditor(root: string, file: string, line?: number, column?: number, base?: string): Promise<{ ok: boolean; error?: string }> {
  const ref = resolveFileReference(root, file, base)
  if (!ref) return { ok: false, error: `File not found: ${file}` }
  const { path } = ref
  const l = Math.max(1, Math.floor(Number(line) || 1))
  const c = Math.max(1, Math.floor(Number(column) || 1))
  for (const editor of EDITORS) {
    const exe = which(editor.cmd)
    if (!exe) continue
    const spec = launchSpec(exe, editor.args(path, l, c))
    try {
      spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return { ok: true }
    } catch {
      /* try the next editor */
    }
  }
  // No code editor found: the system's default app for the file (without the line). Only for the
  // project's own files: "opening" an arbitrary file with its default app could run a program.
  if (!ref.inProject) return { ok: false, error: `No code editor found on PATH (VS Code, Cursor, Zed…) to open ${path}.` }
  const err = await shell.openPath(path)
  return err ? { ok: false, error: err } : { ok: true }
}
