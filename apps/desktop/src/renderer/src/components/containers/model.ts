import type { ContainerBackendId, ContainerListKind, ContainerTarget } from '@shared/types'

/**
 * The Containers tab's model: what is selected, what the bottom section shows, and the pure
 * helpers (sizes, times, names) the views share.
 */

/** An item of a list, with the engine it comes from. */
export type Tagged<T> = T & { engine: ContainerBackendId }

export const ENGINE_LABEL: Record<ContainerBackendId, string> = { docker: 'Docker', podman: 'Podman', wslc: 'wslc' }

export const VIEWS: { id: ContainerListKind; label: string }[] = [
  { id: 'containers', label: 'Containers' },
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
  { id: 'compose', label: 'Compose' }
]

/** What the bottom section shows: about the selection, or a job's output. */
export type Bottom = 'logs' | 'terminal' | 'files' | 'mounts' | 'ports' | 'env' | 'stats' | 'inspect' | 'output'

export const BOTTOM_LABEL: Record<Bottom, string> = {
  logs: 'Logs',
  terminal: 'Terminal',
  files: 'Files',
  mounts: 'Volumes',
  ports: 'Ports',
  env: 'Environment',
  stats: 'Stats',
  inspect: 'Inspect',
  output: 'Output'
}

/** The selected row. */
export interface Selection {
  engine: ContainerBackendId
  target: ContainerTarget
  id: string
  name: string
  running?: boolean
}

/** A job (pull, build, run, Compose…) and its output so far. */
export interface Job {
  stream: string
  title: string
  text: string
  running: boolean
  code?: number
  error?: string
}

/**
 * The bottom section's views for a selection: a container's logs, terminal and files (running),
 * settings and stats; anything's inspect; the last job's output.
 */
export function bottomTabs(selected: Selection | undefined, hasJob: boolean): Bottom[] {
  const container = selected?.target === 'container'
  return [
    ...(container ? (['logs'] as const) : []),
    ...(container && selected.running ? (['terminal', 'files'] as const) : []),
    ...(container ? (['mounts', 'ports', 'env', 'stats'] as const) : []),
    ...(selected ? (['inspect'] as const) : []),
    ...(hasJob ? (['output'] as const) : [])
  ]
}

/** The view shown after selecting `s`: a container keeps its view (else logs); others: inspect. */
export const viewAfterSelect = (s: Selection, current: Bottom | undefined): Bottom =>
  s.target === 'container' ? (current && current !== 'output' ? current : 'logs') : 'inspect'

const MAX_TEXT = 400_000
/** Output kept for display: its last 400 kB. */
export const keepTail = (s: string): string => (s.length > MAX_TEXT ? s.slice(s.length - MAX_TEXT) : s)

/** "23 MB", "1.1 GB" (decimal units, as the engines show them); text sizes (wslc) as they are. */
export function formatBytes(n: number | string | undefined): string {
  if (typeof n === 'string') return n
  if (!n) return '0 B'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Bytes of a human size ("10.1kB", "1.2 GB"), for sorting. */
export function parseHumanSize(s: string): number {
  const m = /^([\d.]+)\s*([kmgt]?)i?b?$/i.exec(s.trim())
  if (!m) return 0
  return Number(m[1]) * 1000 ** ' kmgt'.indexOf(m[2].toLowerCase() || ' ')
}

/** The short form of an image / container / network id. */
export const shortId = (id: string): string => id.replace(/^sha256:/, '').slice(0, 12)

/** Unix seconds of a time given as seconds or as a date string (0 if unknown). */
export function timeOf(v: number | string | undefined): number {
  if (typeof v === 'number') return v
  const t = v ? Date.parse(v) : NaN
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000)
}

/** Whether any of `texts` contains the filter `q` (lower case; empty: everything matches). */
export const matches = (q: string, ...texts: (string | undefined)[]): boolean => !q || texts.some((t) => t?.toLowerCase().includes(q))

/** A Compose project name for a folder (its name, lower case, letters / digits / _ / -). */
export function composeProjectName(dir: string): string {
  const base = dir
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
  return (base ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'app'
}

/** Comma- or line-separated values of a dialog field, trimmed, empty ones dropped. */
export const splitList = (v: unknown, sep: RegExp): string[] =>
  String(v ?? '')
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean)
