import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { ContainerFileEntry } from '@shared/types'
import { directLaunch } from '../harness'

/**
 * A running container's files, through the engine's CLI (`<cli> exec <id> sh -c …`): the same for
 * Docker, Podman and wslc (which has no `cp`). Paths are passed as arguments, never in the script.
 */

export interface Cli {
  command: string
  env?: Record<string, string>
}

/** Lists a folder: one line per entry — type (d, f, l = link, L = link to a folder, o), size, mtime, name. */
export const LIST_SCRIPT = [
  'cd "$1" || exit 3',
  'for f in .[!.]* ..?* *; do',
  '  [ -e "$f" ] || [ -L "$f" ] || continue',
  '  if [ -L "$f" ]; then if [ -d "$f" ]; then t=L; else t=l; fi',
  '  elif [ -d "$f" ]; then t=d; elif [ -f "$f" ]; then t=f; else t=o; fi',
  '  s=$(stat -c "%s %Y" "./$f" 2>/dev/null)',
  '  printf "%s\\t%s\\t%s\\n" "$t" "$s" "$f"',
  'done'
].join('\n')

/** The first $2 bytes of a file. */
export const HEAD_SCRIPT = 'head -c "$2" "$1"'
/** A whole file. */
export const CAT_SCRIPT = 'cat "$1"'

const PREVIEW_MAX = 256 * 1024

/** A path inside the container: absolute, normalised, no control characters. */
export function containerPath(p: unknown): string {
  const s = String(p ?? '/')
  if (!s.startsWith('/') || /[\0\r\n]/.test(s)) throw new Error('Invalid path')
  const parts: string[] = []
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

/** Parses LIST_SCRIPT's output (exported for tests): folders first, then by name. */
export function parseListing(out: string): ContainerFileEntry[] {
  const entries: ContainerFileEntry[] = []
  for (const line of out.split('\n')) {
    const m = /^([dflLo])\t(?:(\d+) (\d+))?\t(.+)$/.exec(line.replace(/\r$/, ''))
    if (!m) continue
    const type = ({ d: 'dir', f: 'file', l: 'link', L: 'dirlink', o: 'other' } as const)[m[1] as 'd']
    entries.push({ name: m[4], type, size: m[2] ? Number(m[2]) : undefined, mtime: m[3] ? Number(m[3]) : undefined })
  }
  const isDir = (e: ContainerFileEntry): number => (e.type === 'dir' || e.type === 'dirlink' ? 0 : 1)
  return entries.sort((a, b) => isDir(a) - isDir(b) || a.name.localeCompare(b.name))
}

function execIn(cli: Cli, id: string, script: string, args: string[]): ReturnType<typeof spawn> {
  const all = ['exec', id, 'sh', '-c', script, 'sh', ...args]
  // An npm-style .cmd shim (Node cannot spawn it without a shell): its script, directly.
  const launch = /\.(cmd|bat)$/i.test(cli.command) ? directLaunch(cli.command, all) : undefined
  return spawn(launch?.command ?? cli.command, launch?.args ?? all, { windowsHide: true, env: { ...process.env, ...(cli.env ?? {}) } })
}

/** Runs a script in the container; its output (up to `max` bytes), stderr and exit code. */
function run(cli: Cli, id: string, script: string, args: string[], max = 4 * 1024 * 1024): Promise<{ out: Buffer; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execIn(cli, id, script, args)
    const chunks: Buffer[] = []
    let size = 0
    let err = ''
    const timer = setTimeout(() => child.kill(), 20_000)
    child.stdout!.on('data', (d: Buffer) => {
      if (size < max) chunks.push(d)
      size += d.length
    })
    child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ out: Buffer.alloc(0), err: e.message, code: -1 })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ out: Buffer.concat(chunks), err, code })
    })
  })
}

const failure = (err: string, code: number | null, fallback: string): string =>
  err.trim().split('\n').slice(-2).join(' ').trim() || (code === 3 ? 'No such folder (or not readable).' : fallback)

export async function listFiles(cli: Cli, id: string, path: string): Promise<{ ok: boolean; path: string; entries?: ContainerFileEntry[]; error?: string }> {
  const r = await run(cli, id, LIST_SCRIPT, [path])
  if (r.code !== 0) return { ok: false, path, error: failure(r.err, r.code, `Listing failed (exit ${r.code}).`) }
  return { ok: true, path, entries: parseListing(r.out.toString('utf8')) }
}

/** The beginning of a file, as text (or "binary"). */
export async function readFilePreview(
  cli: Cli,
  id: string,
  path: string
): Promise<{ ok: boolean; text?: string; truncated?: boolean; binary?: boolean; error?: string }> {
  const r = await run(cli, id, HEAD_SCRIPT, [path, String(PREVIEW_MAX + 1)], PREVIEW_MAX + 1)
  if (r.code !== 0) return { ok: false, error: failure(r.err, r.code, `Reading failed (exit ${r.code}).`) }
  const buf = r.out.subarray(0, PREVIEW_MAX)
  if (buf.subarray(0, 8000).includes(0)) return { ok: true, binary: true }
  return { ok: true, text: buf.toString('utf8'), truncated: r.out.length > PREVIEW_MAX }
}

/** Copies a file of the container to `dest` on this machine. */
export function saveFile(cli: Cli, id: string, path: string, dest: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = execIn(cli, id, CAT_SCRIPT, [path])
    const file = createWriteStream(dest)
    let err = ''
    child.stdout!.pipe(file)
    child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => {
      file.end(() => resolve(code === 0 ? { ok: true } : { ok: false, error: failure(err, code, `Copy failed (exit ${code}).`) }))
    })
  })
}
