/* eslint-disable react/no-unstable-nested-components -- the tables' cell and action callbacks are plain functions called while rendering, not components */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AppSettings,
  ComposeProject,
  ContainerBackendId,
  ContainerBackendInfo,
  ContainerFileEntry,
  ContainerInfo,
  ContainerJob,
  ContainerListKind,
  ContainerListResult,
  ContainerMount,
  ContainerPortBinding,
  ContainerSpec,
  ContainersPrefs,
  ContainerStats,
  ContainerTarget,
  CreateOptions,
  ImageInfo,
  ImageSuggestion,
  NetworkInfo,
  VolumeInfo
} from '@shared/types'
import { useTabs, type Tab } from '../store'
import { relativeTime } from '../time'
import { TerminalView } from './TerminalView'
import { confirmDialog, notify, openDialog } from './Dialogs'

/**
 * The Containers tab: one view of every engine that runs — Docker, Podman (Engine API) and wslc (its
 * CLI) — with containers, images, volumes, networks and Compose projects tagged by engine; logs,
 * live stats, inspect; pull, build, run, Compose with live output. The status bar shows which
 * engines answer; ⚙ holds the tab's options and registry logins.
 */

type Tagged<T> = T & { engine: ContainerBackendId }

const ENGINE_LABEL: Record<ContainerBackendId, string> = { docker: 'Docker', podman: 'Podman', wslc: 'wslc' }
const DEFAULT_PREFS: ContainersPrefs = { hidden: [], refresh: 3, confirmRemove: true }

type Bottom = 'logs' | 'terminal' | 'files' | 'mounts' | 'ports' | 'env' | 'stats' | 'inspect' | 'output'
const BOTTOM_LABEL: Record<Bottom, string> = {
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

interface Selection {
  engine: ContainerBackendId
  target: ContainerTarget
  id: string
  name: string
  running?: boolean
}

interface Job {
  stream: string
  title: string
  text: string
  running: boolean
  code?: number
  error?: string
}

const MAX_TEXT = 400_000
const keepTail = (s: string): string => (s.length > MAX_TEXT ? s.slice(s.length - MAX_TEXT) : s)

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

const shortId = (id: string): string => id.replace(/^sha256:/, '').slice(0, 12)

// ---------------------------------------------------------------------------
// Icons (16 × 16, currentColor)

const Svg = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <svg className="ctr-icon" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
)

const ICONS = {
  containers: (
    <Svg>
      <rect x="1.5" y="8.5" width="6" height="5.5" rx="1" />
      <rect x="8.5" y="8.5" width="6" height="5.5" rx="1" />
      <rect x="5" y="2" width="6" height="5.5" rx="1" />
    </Svg>
  ),
  images: (
    <Svg>
      <path d="M8 1.8l6 3.2-6 3.2-6-3.2z" />
      <path d="M2 8l6 3.2L14 8" />
      <path d="M2 11l6 3.2 6-3.2" />
    </Svg>
  ),
  volumes: (
    <Svg>
      <ellipse cx="8" cy="3.8" rx="5.5" ry="2" />
      <path d="M2.5 3.8v8.4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V3.8" />
      <path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
    </Svg>
  ),
  networks: (
    <Svg>
      <circle cx="8" cy="3" r="1.8" />
      <circle cx="3" cy="13" r="1.8" />
      <circle cx="13" cy="13" r="1.8" />
      <path d="M8 4.8v3.4M8 8.2L4 11.4M8 8.2l4 3.2" />
    </Svg>
  ),
  compose: (
    <Svg>
      <rect x="2" y="2" width="12" height="3.5" rx="1" />
      <rect x="2" y="6.3" width="12" height="3.5" rx="1" />
      <rect x="2" y="10.6" width="12" height="3.5" rx="1" />
    </Svg>
  ),
  start: (
    <Svg>
      <path d="M5 3l8 5-8 5z" fill="currentColor" />
    </Svg>
  ),
  stop: (
    <Svg>
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
    </Svg>
  ),
  restart: (
    <Svg>
      <path d="M13 8a5 5 0 11-1.6-3.7" />
      <path d="M13 2.5v3h-3" />
    </Svg>
  ),
  pause: (
    <Svg>
      <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2" />
    </Svg>
  ),
  shell: (
    <Svg>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3" />
    </Svg>
  ),
  trash: (
    <Svg>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.6a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-8.6M7 7v4.5M9 7v4.5" />
    </Svg>
  ),
  pull: (
    <Svg>
      <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5" />
      <path d="M2.5 11.5v1.5a1 1 0 001 1h9a1 1 0 001-1v-1.5" />
    </Svg>
  ),
  build: (
    <Svg>
      <path d="M9.5 2.5l4 4-1.5 1.5-4-4z" />
      <path d="M8 5.5L2.5 11a1.4 1.4 0 002 2L10 7.5" />
    </Svg>
  ),
  prune: (
    <Svg>
      <path d="M10.5 2l-3 6" />
      <path d="M4 8.5h6.5l1 5.5H3z" />
      <path d="M6 11v3M8.5 11v3" />
    </Svg>
  ),
  add: (
    <Svg>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  ),
  folderUp: (
    <Svg>
      <path d="M1.5 4.5A1.5 1.5 0 013 3h3l1.5 1.5H13A1.5 1.5 0 0114.5 6v6A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12z" />
      <path d="M6.5 7l3 2-3 2z" fill="currentColor" />
    </Svg>
  ),
  down: (
    <Svg>
      <path d="M8 2v6" />
      <path d="M4.6 4.2a5 5 0 106.8 0" />
    </Svg>
  ),
  refresh: (
    <Svg>
      <path d="M13 8a5 5 0 11-1.6-3.7" />
      <path d="M13 2.5v3h-3" />
    </Svg>
  ),
  folder: (
    <Svg>
      <path d="M1.5 4.5A1.5 1.5 0 013 3h3l1.5 1.5H13A1.5 1.5 0 0114.5 6v6A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12z" fill="currentColor" fillOpacity="0.25" />
    </Svg>
  ),
  file: (
    <Svg>
      <path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" />
      <path d="M9.5 1.5v3h3" />
    </Svg>
  ),
  link: (
    <Svg>
      <path d="M6.5 9.5l3-3" />
      <path d="M7 4.5l1.2-1.2a2.5 2.5 0 013.5 3.5L10.5 8" />
      <path d="M9 11.5l-1.2 1.2a2.5 2.5 0 01-3.5-3.5L5.5 8" />
    </Svg>
  ),
  settings: (
    <Svg>
      <path d="M6.8 1.5h2.4l.4 1.9a5 5 0 011.3.75l1.8-.6 1.2 2.1-1.4 1.3a5 5 0 010 1.5l1.4 1.3-1.2 2.1-1.8-.6a5 5 0 01-1.3.75l-.4 1.9H6.8l-.4-1.9a5 5 0 01-1.3-.75l-1.8.6-1.2-2.1 1.4-1.3a5 5 0 010-1.5L2.1 5.65l1.2-2.1 1.8.6a5 5 0 011.3-.75z" />
      <circle cx="8" cy="8" r="2.1" />
    </Svg>
  )
}

const VIEWS: { id: ContainerListKind; label: string }[] = [
  { id: 'containers', label: 'Containers' },
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
  { id: 'compose', label: 'Compose' }
]

function IconButton({
  title,
  onClick,
  danger,
  children
}: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button className={`icon-button ctr-action${danger ? ' ctr-danger' : ''}`} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  )
}

/** A column of a resource table. */
interface Column<T> {
  key: string
  label: string
  /** CSS grid track. */
  width: string
  cell: (x: T) => React.ReactNode
  /** Sort key (none: not sortable). */
  sort?: (x: T) => string | number
  className?: string
  align?: 'right'
}

/** Unix seconds of a time given as seconds or as a date string (0 if unknown). */
const timeOf = (v: number | string | undefined): number => {
  if (typeof v === 'number') return v
  const t = v ? Date.parse(v) : NaN
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000)
}

/** "2 days ago", the full date on hover. */
function When({ value }: { value: number | string | undefined }): React.JSX.Element | null {
  const t = timeOf(value)
  if (!t) return null
  return <span title={new Date(t * 1000).toLocaleString()}>{relativeTime(t)}</span>
}

/** Bytes of a human size ("10.1kB", "1.2 GB"), for sorting. */
const parseHumanSize = (s: string): number => {
  const m = /^([\d.]+)\s*([kmgt]?)i?b?$/i.exec(s.trim())
  if (!m) return 0
  return Number(m[1]) * 1000 ** ' kmgt'.indexOf(m[2].toLowerCase() || ' ')
}

/** A tiny chip naming a row's engine (Docker, Podman, wslc). */
const EngineChip = ({ engine }: { engine: ContainerBackendId }): React.JSX.Element => <span className={`ctr-engine e-${engine}`}>{ENGINE_LABEL[engine]}</span>

export function ContainersView({ visible }: { tab: Tab; visible: boolean }): React.JSX.Element {
  const [backends, setBackends] = useState<ContainerBackendInfo[] | null>(null)
  const [prefs, setPrefs] = useState<ContainersPrefs>(DEFAULT_PREFS)
  const [view, setView] = useState<ContainerListKind>('containers')
  /** The current view's list, per engine. */
  const [data, setData] = useState<Partial<Record<ContainerBackendId, ContainerListResult>> | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Selection>()
  const [bottom, setBottom] = useState<Bottom>()
  const [job, setJob] = useState<Job>()
  const [busy, setBusy] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pullOpen, setPullOpen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [showStopped, setShowStopped] = useState(() => {
    try {
      return localStorage.getItem('containers-show-stopped') !== '0'
    } catch {
      return true
    }
  })
  const toggleStopped = (on: boolean): void => {
    setShowStopped(on)
    try {
      localStorage.setItem('containers-show-stopped', on ? '1' : '0')
    } catch {
      /* not kept */
    }
  }
  /** The lists' sort column (none: the engine's order). */
  const [sort, setSort] = useState<{ key: string; desc: boolean }>()
  /** The container whose in-place terminal is open (engine:id). */
  const [termKey, setTermKey] = useState<string>()

  const loadBackends = useCallback(async () => {
    setBackends(await window.ide.containers.backends())
  }, [])
  useEffect(() => {
    void loadBackends()
    void window.ide.settings.get().then((s) => setPrefs(s.containers ?? DEFAULT_PREFS))
    return window.ide.settings.onChanged((s: AppSettings) => setPrefs(s.containers ?? DEFAULT_PREFS))
  }, [loadBackends])

  /** Engines shown (not hidden in the options) and running. */
  const engines = useMemo(() => (backends ?? []).filter((b) => b.available && !prefs.hidden.includes(b.id)), [backends, prefs.hidden])
  const engineKey = engines.map((e) => e.id).join(',')
  const several = engines.length > 1
  const views = VIEWS.filter((v) => v.id !== 'compose' || engines.some((e) => e.features.compose))
  const defaultEngine = engines.find((e) => e.id === prefs.defaultEngine)?.id ?? engines[0]?.id

  const load = useCallback(async () => {
    const list = engines.filter((e) => view !== 'compose' || e.features.compose)
    if (!list.length) return setData({})
    const results = await Promise.all(list.map(async (e) => [e.id, await window.ide.containers.list(e.id, view)] as const))
    setData(Object.fromEntries(results))
  }, [engines, view])

  useEffect(() => {
    setData(null)
    setSelected(undefined)
    setSort(undefined)
    void load()
  }, [view, engineKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Kept current while on screen (every prefs.refresh seconds; engines looked up again every 15 s).
  useEffect(() => {
    if (!visible) return
    void load()
    const lists = prefs.refresh > 0 ? setInterval(() => void load(), prefs.refresh * 1000) : undefined
    const status = setInterval(() => void loadBackends(), 15_000)
    return () => {
      clearInterval(lists)
      clearInterval(status)
    }
  }, [visible, load, loadBackends, prefs.refresh])

  /** The current view's items of every engine, each tagged with its engine. */
  const items = useMemo(() => {
    const all = <K extends 'containers' | 'images' | 'volumes' | 'networks' | 'compose'>(key: K) =>
      Object.entries(data ?? {}).flatMap(([engine, r]) =>
        ((r?.[key] ?? []) as NonNullable<ContainerListResult[K]>).map((x) => ({ ...x, engine: engine as ContainerBackendId }))
      )
    return {
      containers: all('containers') as Tagged<ContainerInfo>[],
      images: all('images') as Tagged<ImageInfo>[],
      volumes: all('volumes') as Tagged<VolumeInfo>[],
      networks: all('networks') as Tagged<NetworkInfo>[],
      compose: all('compose') as Tagged<ComposeProject>[]
    }
  }, [data])
  const errors = Object.entries(data ?? {}).filter(([, r]) => r && !r.ok) as [ContainerBackendId, ContainerListResult][]

  /** Runs an action; errors as toasts; the lists refreshed after. */
  const act = async (label: string, fn: () => Promise<{ ok: boolean; error?: string; text?: string }>, success?: string): Promise<boolean> => {
    setBusy(label)
    const r = await fn()
    setBusy(undefined)
    if (!r.ok) notify(r.error ?? `${label} failed`, 'error')
    else if (success || r.text) notify(r.text ? `${success ?? label}: ${r.text}` : success!, 'success')
    void load()
    return r.ok
  }

  // ---------- Jobs: live output in the bottom section ----------

  const startJob = async (engine: ContainerBackendId, title: string, j: ContainerJob): Promise<void> => {
    const stream = await window.ide.containers.job(engine, j)
    setJob({ stream, title: several ? `${title} (${ENGINE_LABEL[engine]})` : title, text: '', running: true })
    setBottom('output')
  }

  useEffect(
    () =>
      window.ide.containers.onStream((e) => {
        setJob((cur) => {
          if (!cur || cur.stream !== e.stream) return cur
          if (e.kind === 'text') return { ...cur, text: keepTail(cur.text + e.text) }
          if (e.kind === 'end') {
            const ok = !e.error && (e.code === 0 || e.code === undefined)
            notify(ok ? `${cur.title}: done` : `${cur.title}: ${e.error ?? `failed (exit ${e.code})`}`, ok ? 'success' : 'error')
            void load()
            return { ...cur, running: false, code: e.code, error: e.error }
          }
          return cur
        })
      }),
    [load]
  )

  // ---------- Dialogs (an Engine field when several run) ----------

  const engineField = (filterFn: (b: ContainerBackendInfo) => boolean = () => true): { name: string; label: string; options: string[] }[] => {
    const list = engines.filter(filterFn)
    if (list.length < 2) return []
    const first = list.find((e) => e.id === defaultEngine) ?? list[0]
    return [{ name: 'engine', label: 'Engine', options: [first, ...list.filter((e) => e !== first)].map((e) => e.label) }]
  }
  const engineOf = (r: Record<string, unknown>, filterFn: (b: ContainerBackendInfo) => boolean = () => true): ContainerBackendId | undefined => {
    const list = engines.filter(filterFn)
    return (list.find((e) => e.label === r.engine) ?? list.find((e) => e.id === defaultEngine) ?? list[0])?.id
  }

  const pull = (): void => setPullOpen(true)

  const build = async (): Promise<void> => {
    const context = await window.ide.project.pickFolder()
    if (!context) return
    const r = await openDialog({
      title: 'Build an image',
      message: `Build context: ${context}`,
      fields: [
        { name: 'tag', label: 'Tag', placeholder: 'my-app:dev' },
        { name: 'dockerfile', label: 'Dockerfile (in the context; empty: Dockerfile)', placeholder: 'Dockerfile' },
        { name: 'target', label: 'Target stage (optional)' },
        { name: 'args', label: 'Build arguments (one KEY=VALUE per line)', kind: 'textarea' },
        ...engineField()
      ],
      confirmLabel: 'Build'
    })
    const engine = r && engineOf(r)
    if (!r || !engine) return
    const buildArgs = String(r.args ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    await startJob(engine, `Build ${String(r.tag).trim() || context}`, {
      kind: 'build',
      context,
      tag: String(r.tag),
      dockerfile: String(r.dockerfile),
      target: String(r.target),
      buildArgs
    })
  }

  const run = async (engine: ContainerBackendId, image: string): Promise<void> => {
    const nets = (await window.ide.containers.list(engine, 'networks')).networks?.map((n) => n.name) ?? []
    const r = await openDialog({
      title: `Run ${image}`,
      fields: [
        { name: 'name', label: 'Container name (optional)' },
        { name: 'ports', label: 'Ports (host:container, comma separated)', placeholder: '8080:80' },
        { name: 'volumes', label: 'Volumes (source:/path, comma separated)', placeholder: 'data:/var/lib/data' },
        { name: 'env', label: 'Environment (one KEY=VALUE per line)', kind: 'textarea' },
        { name: 'network', label: 'Network', options: ['(default)', ...nets] },
        { name: 'restart', label: 'Restart', options: ['no', 'unless-stopped', 'always', 'on-failure'] }
      ],
      confirmLabel: 'Run'
    })
    if (!r) return
    const list = (v: unknown, sep: RegExp): string[] =>
      String(v ?? '')
        .split(sep)
        .map((s) => s.trim())
        .filter(Boolean)
    await startJob(engine, `Run ${image}`, {
      kind: 'run',
      image,
      name: String(r.name),
      ports: list(r.ports, /,/),
      volumes: list(r.volumes, /,/),
      env: list(r.env, /\r?\n/),
      network: r.network === '(default)' ? undefined : String(r.network),
      restart: r.restart === 'no' ? undefined : String(r.restart)
    })
  }

  const shell = async (c: Tagged<ContainerInfo>): Promise<void> => {
    const profile = await window.ide.containers.shellProfile(c.engine, c.id, c.name)
    if (profile) await useTabs.getState().openProfile(profile)
    else notify(`The ${ENGINE_LABEL[c.engine]} command line tool is not installed.`, 'error')
  }

  const prune = async (target: ContainerTarget, what: string): Promise<void> => {
    const names = engines.map((e) => e.label).join(', ')
    if (!(await confirmDialog(`Remove ${what}?`, `Every ${what.replace(/^(all )?/, '')} of ${names} will be removed.`, 'Remove', true))) return
    for (const e of engines) await act(`Pruning ${e.label}`, () => window.ide.containers.prune(e.id, target), several ? `${e.label}: pruned` : 'Pruned')
  }

  const create = async (target: 'volume' | 'network'): Promise<void> => {
    if (target === 'volume') return setVolumeOpen(true)
    const r = await openDialog({ title: `New ${target}`, fields: [{ name: 'name', label: 'Name' }, ...engineField()], confirmLabel: 'Create' })
    const name = r && String(r.name).trim()
    const engine = r && engineOf(r)
    if (name && engine) await act('Creating', () => window.ide.containers.create(engine, target, name), `Created ${name}`)
  }

  const remove = async (engine: ContainerBackendId, target: ContainerTarget, id: string, name: string): Promise<void> => {
    const note = target === 'container' ? ' It is stopped first if it runs.' : ''
    if (prefs.confirmRemove && !(await confirmDialog(`Remove ${target}?`, `${name} will be removed.${note}`, 'Remove', true))) return
    if (selected?.engine === engine && selected.id === id) setSelected(undefined)
    await act('Removing', () => window.ide.containers.action(engine, target, id, 'remove'), `Removed ${name}`)
  }

  const containerAction = (c: Tagged<ContainerInfo>, action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause', label: string): void =>
    void act(label, () => window.ide.containers.action(c.engine, 'container', c.id, action))

  const compose = async (p: Tagged<ComposeProject>, action: 'up' | 'down' | 'restart' | 'pull' | 'stop'): Promise<void> => {
    if (action === 'down' && !(await confirmDialog('Compose down?', `The containers and networks of ${p.name} will be removed.`, 'Down', true))) return
    await startJob(p.engine, `Compose ${action} ${p.name}`, { kind: 'compose', project: p.name, action, configFiles: p.configFiles, workingDir: p.workingDir })
  }

  const composeFolder = async (): Promise<void> => {
    const dir = await window.ide.project.pickFolder()
    if (!dir) return
    const withCompose = (b: ContainerBackendInfo): boolean => b.features.compose
    let engine = engines.find((e) => e.id === defaultEngine && e.features.compose)?.id ?? engines.find(withCompose)?.id
    if (engines.filter(withCompose).length > 1) {
      const r = await openDialog({ title: 'Compose up a folder', message: dir, fields: engineField(withCompose), confirmLabel: 'Up' })
      if (!r) return
      engine = engineOf(r, withCompose)
    }
    if (!engine) return
    const name =
      (
        dir
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() ?? 'app'
      )
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '') || 'app'
    await startJob(engine, `Compose up ${name}`, { kind: 'compose', project: name, action: 'up', configFiles: [], workingDir: dir })
  }

  // ---------- Lists: tables with a header (click a column to sort) ----------

  const q = filter.trim().toLowerCase()
  const match = (...texts: (string | undefined)[]): boolean => !q || texts.some((t) => t?.toLowerCase().includes(q))
  const isSelected = (engine: ContainerBackendId, id: string): boolean => selected?.engine === engine && selected.id === id

  const select = (s: Selection): void => {
    setSelected(s)
    setBottom((b) => (s.target === 'container' ? (b && b !== 'output' ? b : 'logs') : 'inspect'))
  }

  const empty = (what: string): React.JSX.Element => <div className="pane-message">{q ? 'Nothing matches the filter.' : `No ${what}.`}</div>

  /** A table: header, then one row per item; `actions` in the last column (shown on hover). */
  const table = <T extends { engine: ContainerBackendId }>(opts: {
    label: string
    columns: Column<T>[]
    actionsWidth: number
    rows: T[]
    rowKey: (x: T) => string
    selection?: (x: T) => Selection
    actions: (x: T) => React.ReactNode
    actionsVisible?: boolean
    /** In the actions column header (right-aligned). */
    headerExtra?: React.ReactNode
  }): React.JSX.Element => {
    const { columns, rows } = opts
    const col = columns.find((c) => c.key === sort?.key && c.sort)
    const sorted = col
      ? [...rows].sort((a, b) => {
          const x = col.sort!(a)
          const y = col.sort!(b)
          const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
          return sort!.desc ? -r : r
        })
      : rows
    const template = { gridTemplateColumns: [...columns.map((c) => c.width), `${opts.actionsWidth}px`].join(' ') }
    return (
      <div className="ctr-table" role="table" aria-label={opts.label}>
        <div className="ctr-thead" role="row" style={template}>
          {columns.map((c) => (
            <span
              key={c.key}
              role="columnheader"
              className={`ctr-th${c.align === 'right' ? ' right' : ''}`}
              aria-sort={sort?.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}
            >
              {c.sort ? (
                <button
                  className="ctr-sort"
                  onClick={() => setSort((s) => (s?.key === c.key ? (s.desc ? undefined : { key: c.key, desc: true }) : { key: c.key, desc: false }))}
                >
                  {c.label}
                  {sort?.key === c.key && <span aria-hidden>{sort.desc ? ' ▾' : ' ▴'}</span>}
                </button>
              ) : (
                c.label
              )}
            </span>
          ))}
          <span role="columnheader" className="ctr-th ctr-th-actions" aria-label={opts.headerExtra ? undefined : 'Actions'}>
            {opts.headerExtra}
          </span>
        </div>
        {sorted.map((x) => {
          const sel = opts.selection?.(x)
          return (
            <div
              key={opts.rowKey(x)}
              role="row"
              className={`ctr-row${sel && isSelected(sel.engine, sel.id) ? ' selected' : ''}${sel ? '' : ' static'}`}
              style={template}
              onClick={sel ? () => select(sel) : undefined}
            >
              {columns.map((c) => (
                <span key={c.key} role="cell" className={`ctr-td${c.className ? ` ${c.className}` : ''}${c.align === 'right' ? ' right' : ''}`}>
                  {c.cell(x)}
                </span>
              ))}
              <span role="cell" className={`ctr-actions${opts.actionsVisible ? ' visible' : ''}`} onClick={(e) => e.stopPropagation()}>
                {opts.actions(x)}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const engineCol = <T extends { engine: ContainerBackendId }>(): Column<T> => ({
    key: 'engine',
    label: 'Engine',
    width: '76px',
    cell: (x) => <EngineChip engine={x.engine} />,
    sort: (x) => x.engine
  })

  const containerList = (list: Tagged<ContainerInfo>[]): React.JSX.Element => {
    if (!list.length) return empty('containers')
    return table({
      label: 'Containers',
      rows: showStopped ? list : list.filter((c) => ['running', 'paused', 'restarting'].includes(c.state)),
      headerExtra: (
        <label className="ctr-show-stopped" title="List stopped containers too">
          <input type="checkbox" checked={showStopped} onChange={(e) => toggleStopped(e.target.checked)} />
          Show stopped
        </label>
      ),
      rowKey: (c) => `${c.engine}:${c.id}`,
      selection: (c) => ({ engine: c.engine, target: 'container', id: c.id, name: c.name, running: c.state === 'running' }),
      actionsWidth: 176,
      columns: [
        { key: 'state', label: '', width: '14px', cell: (c) => <span className={`ctr-state st-${c.state}`} title={c.state} /> },
        {
          key: 'name',
          label: 'Name',
          width: 'minmax(130px, 1.3fr)',
          className: 'ctr-name',
          cell: (c) => <span title={c.id}>{c.name}</span>,
          sort: (c) => c.name
        },
        engineCol(),
        {
          key: 'image',
          label: 'Image',
          width: 'minmax(110px, 1.1fr)',
          className: 'ctr-ellipsis',
          cell: (c) => <span title={c.image}>{c.image}</span>,
          sort: (c) => c.image
        },
        {
          key: 'compose',
          label: 'Compose',
          width: 'minmax(70px, 0.7fr)',
          className: 'ctr-ellipsis',
          cell: (c) =>
            c.compose && (
              <>
                <span className="ctr-chip">{c.compose.project}</span> <span className="muted">{c.compose.service}</span>
              </>
            ),
          sort: (c) => c.compose?.project ?? ''
        },
        {
          key: 'ports',
          label: 'Ports',
          width: 'minmax(70px, 0.7fr)',
          className: 'ctr-ports',
          cell: (c) =>
            c.ports
              .filter((p) => p.host)
              .map((p) => (
                <button
                  key={`${p.host}/${p.protocol}`}
                  className="link-button"
                  title={`Open http://localhost:${p.host} (container port ${p.container}/${p.protocol})`}
                  onClick={(e) => {
                    e.stopPropagation()
                    window.ide.app.openExternal(`http://localhost:${p.host}`)
                  }}
                >
                  {p.host}:{p.container}
                </button>
              ))
        },
        {
          key: 'status',
          label: 'Status',
          width: 'minmax(110px, 1fr)',
          className: 'ctr-ellipsis muted',
          cell: (c) => c.status,
          sort: (c) => `${c.state === 'running' ? 0 : 1}${c.status}`
        }
      ],
      actions: (c) => {
        const running = c.state === 'running'
        const paused = c.state === 'paused'
        const pausable = engines.find((e) => e.id === c.engine)?.features.pause
        return (
          <>
            {!running && !paused && (
              <IconButton title="Start" onClick={() => containerAction(c, 'start', 'Starting')}>
                {ICONS.start}
              </IconButton>
            )}
            {running && (
              <IconButton title="Stop" onClick={() => containerAction(c, 'stop', 'Stopping')}>
                {ICONS.stop}
              </IconButton>
            )}
            {(running || paused) && (
              <IconButton title="Restart" onClick={() => containerAction(c, 'restart', 'Restarting')}>
                {ICONS.restart}
              </IconButton>
            )}
            {pausable && running && (
              <IconButton title="Pause" onClick={() => containerAction(c, 'pause', 'Pausing')}>
                {ICONS.pause}
              </IconButton>
            )}
            {paused && (
              <IconButton title="Resume" onClick={() => containerAction(c, 'unpause', 'Resuming')}>
                {ICONS.start}
              </IconButton>
            )}
            {running && (
              <IconButton title="Open a shell in the container (new tab)" onClick={() => void shell(c)}>
                {ICONS.shell}
              </IconButton>
            )}
            <IconButton title="Remove" danger onClick={() => void remove(c.engine, 'container', c.id, c.name)}>
              {ICONS.trash}
            </IconButton>
          </>
        )
      }
    })
  }

  const imageList = (list: Tagged<ImageInfo>[]): React.JSX.Element => {
    if (!list.length) return empty('images')
    const nameOf = (i: ImageInfo): string => i.tags[0] ?? shortId(i.id)
    return table({
      label: 'Images',
      rows: list,
      rowKey: (i) => `${i.engine}:${i.id}`,
      selection: (i) => ({ engine: i.engine, target: 'image', id: i.id, name: nameOf(i) }),
      actionsWidth: 64,
      columns: [
        {
          key: 'name',
          label: 'Repository:tag',
          width: 'minmax(160px, 2fr)',
          className: 'ctr-name',
          cell: (i) => (i.tags.length ? <span title={i.tags.join('\n')}>{i.tags.join(', ')}</span> : <span className="muted">&lt;none&gt;</span>),
          sort: (i) => i.tags[0] ?? '~'
        },
        engineCol(),
        { key: 'id', label: 'Image ID', width: '110px', className: 'ctr-mono muted', cell: (i) => shortId(i.id), sort: (i) => shortId(i.id) },
        {
          key: 'size',
          label: 'Size',
          width: '80px',
          align: 'right',
          cell: (i) => formatBytes(i.size),
          sort: (i) => (typeof i.size === 'number' ? i.size : parseHumanSize(i.size))
        },
        {
          key: 'used',
          label: 'Containers',
          width: '86px',
          align: 'right',
          className: 'muted',
          cell: (i) => String(i.containers ?? 0),
          sort: (i) => i.containers ?? 0
        }
      ],
      actions: (i) => (
        <>
          <IconButton title="Run a container from this image" onClick={() => void run(i.engine, i.tags[0] ?? i.id)}>
            {ICONS.start}
          </IconButton>
          <IconButton title="Remove" danger onClick={() => void remove(i.engine, 'image', i.id, nameOf(i))}>
            {ICONS.trash}
          </IconButton>
        </>
      )
    })
  }

  const volumeList = (list: Tagged<VolumeInfo>[]): React.JSX.Element => {
    if (!list.length) return empty('volumes')
    return table({
      label: 'Volumes',
      rows: list,
      rowKey: (v) => `${v.engine}:${v.name}`,
      selection: (v) => ({ engine: v.engine, target: 'volume', id: v.name, name: v.name }),
      actionsWidth: 36,
      columns: [
        {
          key: 'name',
          label: 'Name',
          width: 'minmax(140px, 1.3fr)',
          className: 'ctr-name',
          cell: (v) => <span title={v.name}>{v.name}</span>,
          sort: (v) => v.name
        },
        engineCol(),
        { key: 'driver', label: 'Driver', width: '80px', cell: (v) => v.driver, sort: (v) => v.driver },
        {
          key: 'mountpoint',
          label: 'Mount point',
          width: 'minmax(140px, 2fr)',
          className: 'ctr-mono ctr-ellipsis muted',
          cell: (v) => <span title={v.mountpoint}>{v.mountpoint}</span>,
          sort: (v) => v.mountpoint ?? ''
        }
      ],
      actions: (v) => (
        <IconButton title="Remove" danger onClick={() => void remove(v.engine, 'volume', v.name, v.name)}>
          {ICONS.trash}
        </IconButton>
      )
    })
  }

  const networkList = (list: Tagged<NetworkInfo>[]): React.JSX.Element => {
    if (!list.length) return empty('networks')
    const builtIn = new Set(['bridge', 'host', 'none', 'podman'])
    return table({
      label: 'Networks',
      rows: list,
      rowKey: (n) => `${n.engine}:${n.id}`,
      selection: (n) => ({ engine: n.engine, target: 'network', id: n.id, name: n.name }),
      actionsWidth: 36,
      columns: [
        { key: 'name', label: 'Name', width: 'minmax(140px, 1.5fr)', className: 'ctr-name', cell: (n) => n.name, sort: (n) => n.name },
        engineCol(),
        { key: 'id', label: 'Network ID', width: '110px', className: 'ctr-mono muted', cell: (n) => shortId(n.id), sort: (n) => n.id },
        { key: 'driver', label: 'Driver', width: '90px', cell: (n) => n.driver, sort: (n) => n.driver },
        { key: 'scope', label: 'Scope', width: '80px', className: 'muted', cell: (n) => n.scope ?? '', sort: (n) => n.scope ?? '' },
        { key: 'created', label: 'Created', width: '96px', className: 'muted', cell: (n) => <When value={n.created} />, sort: (n) => timeOf(n.created) }
      ],
      actions: (n) =>
        !builtIn.has(n.name) && (
          <IconButton title="Remove" danger onClick={() => void remove(n.engine, 'network', n.id, n.name)}>
            {ICONS.trash}
          </IconButton>
        )
    })
  }

  const composeList = (list: Tagged<ComposeProject>[]): React.JSX.Element => {
    if (!list.length)
      return <div className="pane-message">{q ? 'Nothing matches the filter.' : 'No Compose project has containers: compose up a folder (toolbar).'}</div>
    const up = (p: ComposeProject): number => p.services.filter((s) => s.state === 'running').length
    return table({
      label: 'Compose projects',
      rows: list,
      rowKey: (p) => `${p.engine}:${p.name}`,
      actionsWidth: 150,
      actionsVisible: true,
      columns: [
        {
          key: 'state',
          label: '',
          width: '14px',
          cell: (p) => <span className={`ctr-state ${up(p) === p.services.length ? 'st-running' : up(p) ? 'st-paused' : 'st-exited'}`} />
        },
        { key: 'name', label: 'Project', width: 'minmax(110px, 1fr)', className: 'ctr-name', cell: (p) => p.name, sort: (p) => p.name },
        engineCol(),
        {
          key: 'services',
          label: 'Services',
          width: 'minmax(140px, 1.6fr)',
          className: 'ctr-chips',
          cell: (p) =>
            p.services.map((s) => (
              <span key={s.container} className={`ctr-chip${s.state === 'running' ? ' on' : ''}`} title={`${s.container}: ${s.state}`}>
                {s.name}
              </span>
            ))
        },
        { key: 'running', label: 'Running', width: '96px', className: 'muted', cell: (p) => `${up(p)} / ${p.services.length} running`, sort: (p) => up(p) },
        {
          key: 'folder',
          label: 'Folder',
          width: 'minmax(120px, 1.4fr)',
          className: 'ctr-mono ctr-ellipsis muted',
          cell: (p) => <span title={p.workingDir}>{p.workingDir}</span>,
          sort: (p) => p.workingDir ?? ''
        }
      ],
      actions: (p) => (
        <>
          <IconButton title="Up (start or update the services)" onClick={() => void compose(p, 'up')}>
            {ICONS.start}
          </IconButton>
          <IconButton title="Restart" onClick={() => void compose(p, 'restart')}>
            {ICONS.restart}
          </IconButton>
          <IconButton title="Stop" onClick={() => void compose(p, 'stop')}>
            {ICONS.stop}
          </IconButton>
          <IconButton title="Pull the services' images" onClick={() => void compose(p, 'pull')}>
            {ICONS.pull}
          </IconButton>
          <IconButton title="Down (remove the containers and networks)" danger onClick={() => void compose(p, 'down')}>
            {ICONS.down}
          </IconButton>
        </>
      )
    })
  }

  const content = (): React.ReactNode => {
    if (!backends) return <div className="pane-message">Looking for container engines…</div>
    if (!engines.length)
      return (
        <div className="pane-message containers-unavailable">
          <p>
            <strong>No container engine is running.</strong>
          </p>
          {backends
            .filter((b) => !prefs.hidden.includes(b.id))
            .map((b) => (
              <p key={b.id} className="muted">
                {b.label} is not running
              </p>
            ))}
          <button className="tool-button" onClick={() => void loadBackends()}>
            Check again
          </button>
        </div>
      )
    if (!data) return <div className="pane-message">Loading…</div>
    const list = (() => {
      switch (view) {
        case 'containers':
          return containerList(items.containers.filter((c) => match(c.name, c.image, c.id)))
        case 'images':
          return imageList(items.images.filter((i) => match(i.id, ...i.tags)))
        case 'volumes':
          return volumeList(items.volumes.filter((v) => match(v.name, v.driver)))
        case 'networks':
          return networkList(items.networks.filter((n) => match(n.name, n.driver)))
        case 'compose':
          return composeList(items.compose.filter((p) => match(p.name, p.workingDir)))
      }
    })()
    return (
      <>
        {errors.map(([engine, r]) => (
          <div key={engine} className="containers-error">
            {ENGINE_LABEL[engine]}: {r.error}
          </div>
        ))}
        {list}
      </>
    )
  }

  const tools = (): React.ReactNode => {
    switch (view) {
      case 'containers':
        return (
          <IconButton title="Remove all stopped containers" onClick={() => void prune('container', 'all stopped containers')}>
            {ICONS.prune}
          </IconButton>
        )
      case 'images':
        return (
          <>
            <IconButton title="Pull an image…" onClick={() => void pull()}>
              {ICONS.pull}
            </IconButton>
            <IconButton title="Build an image from a folder…" onClick={() => void build()}>
              {ICONS.build}
            </IconButton>
            <IconButton title="Remove unused images" onClick={() => void prune('image', 'unused images')}>
              {ICONS.prune}
            </IconButton>
          </>
        )
      case 'volumes':
        return (
          <>
            <IconButton title="New volume…" onClick={() => void create('volume')}>
              {ICONS.add}
            </IconButton>
            <IconButton title="Remove unused volumes" onClick={() => void prune('volume', 'unused volumes')}>
              {ICONS.prune}
            </IconButton>
          </>
        )
      case 'networks':
        return (
          <>
            <IconButton title="New network…" onClick={() => void create('network')}>
              {ICONS.add}
            </IconButton>
            <IconButton title="Remove unused networks" onClick={() => void prune('network', 'unused networks')}>
              {ICONS.prune}
            </IconButton>
          </>
        )
      case 'compose':
        return (
          <IconButton title="Compose up a folder…" onClick={() => void composeFolder()}>
            {ICONS.folderUp}
          </IconButton>
        )
    }
  }

  const bottomTabs: Bottom[] = [
    ...(selected?.target === 'container' ? (['logs'] as Bottom[]) : []),
    ...(selected?.target === 'container' && selected.running ? (['terminal', 'files'] as Bottom[]) : []),
    ...(selected?.target === 'container' ? (['mounts', 'ports', 'env', 'stats'] as Bottom[]) : []),
    ...(selected ? (['inspect'] as Bottom[]) : []),
    ...(job ? (['output'] as Bottom[]) : [])
  ]
  const shownBottom = bottom && bottomTabs.includes(bottom) ? bottom : undefined
  // Volumes, Ports, Environment: the selected container; a recreation selects the new one.
  const specProps: SpecViewProps | undefined =
    selected?.target === 'container'
      ? {
          backend: selected.engine,
          id: selected.id,
          name: selected.name,
          editable: !!engines.find((e) => e.id === selected.engine)?.features.editSpec,
          onRecreated: (newId) => {
            setSelected({ ...selected, id: newId })
            void load()
          }
        }
      : undefined
  // The terminal stays open while its container is selected (hidden under the other views).
  const selKey = selected ? `${selected.engine}:${selected.id}` : undefined
  const terminalAlive = !!selKey && termKey === selKey && bottomTabs.includes('terminal')
  useEffect(() => {
    if (shownBottom === 'terminal' && selKey && termKey !== selKey) setTermKey(selKey)
  }, [shownBottom, selKey, termKey])

  return (
    <div className="containers">
      <div className="pane-toolbar containers-views">
        <div className="segmented" role="tablist">
          {views.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)}>
              {ICONS[v.id]}
              {v.label}
              {view === v.id && data && <span className="count">{items[v.id].length}</span>}
            </button>
          ))}
        </div>
        <input className="containers-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="spacer" />
        {busy && <span className="muted busy">{busy}…</span>}
        {engines.length > 0 && tools()}
        <span className="ctr-toolbar-sep" />
        <IconButton
          title="Refresh"
          onClick={() => {
            void loadBackends()
            void load()
          }}
        >
          {ICONS.refresh}
        </IconButton>
        <IconButton title="Containers settings: engines, registries…" onClick={() => setSettingsOpen(true)}>
          {ICONS.settings}
        </IconButton>
      </div>
      <div className="containers-body">{content()}</div>
      {(shownBottom || terminalAlive) && (
        <div className="containers-bottom" hidden={!shownBottom}>
          {terminalAlive && selected && (
            <ContainerTerminal key={selKey} backend={selected.engine} id={selected.id} name={selected.name} visible={visible && shownBottom === 'terminal'} />
          )}
          {shownBottom === 'env' && specProps && <EnvView key={selKey} {...specProps} />}
          {shownBottom === 'mounts' && specProps && <MountsView key={selKey} {...specProps} />}
          {shownBottom === 'ports' && specProps && <PortsView key={selKey} {...specProps} />}
          {shownBottom === 'files' && selected && <FilesView key={selKey} backend={selected.engine} id={selected.id} />}
          {shownBottom === 'logs' && selected && <LogsView key={`${selected.engine}:${selected.id}`} backend={selected.engine} id={selected.id} />}
          {shownBottom === 'stats' && selected && (
            <StatsView key={`${selected.engine}:${selected.id}`} backend={selected.engine} id={selected.id} running={!!selected.running} />
          )}
          {shownBottom === 'inspect' && selected && (
            <InspectView key={`${selected.engine}:${selected.id}`} backend={selected.engine} target={selected.target} id={selected.id} />
          )}
          {shownBottom === 'output' && job && (
            <div className="ctr-output">
              <div className="ctr-output-head">
                <strong>{job.title}</strong>
                <span className={`muted${job.running ? ' busy' : ''}`}>
                  {job.running ? 'running…' : job.error ? job.error : job.code === 0 ? 'done' : `exit ${job.code}`}
                </span>
                <span className="spacer" />
                {job.running && (
                  <button className="tool-button" onClick={() => window.ide.containers.stopStream(job.stream)}>
                    Stop
                  </button>
                )}
              </div>
              <AutoScrollPre text={job.text} />
            </div>
          )}
        </div>
      )}
      {/* Status bar: details of the selection (logs, stats…), and which engines answer. */}
      <div className="pane-toolbar containers-status">
        {bottomTabs.length > 0 && (
          <div className="segmented" role="tablist">
            {bottomTabs.map((b) => (
              <button
                key={b}
                role="tab"
                aria-selected={shownBottom === b}
                className={shownBottom === b ? 'active' : ''}
                onClick={() => setBottom(shownBottom === b ? undefined : b)}
              >
                {BOTTOM_LABEL[b]}
              </button>
            ))}
          </div>
        )}
        {selected && <span className="muted containers-selected">{selected.name}</span>}
        <span className="spacer" />
        <div className="containers-engines" aria-label="Container engines">
          {(backends ?? []).map((b) => (
            <span
              key={b.id}
              data-engine={b.id}
              className={`engine-status${b.available ? ' on' : ''}${prefs.hidden.includes(b.id) ? ' hidden-engine' : ''}`}
              title={
                b.available
                  ? `${b.label}: running${b.detail ? ` (${b.detail})` : ''}${prefs.hidden.includes(b.id) ? ' — hidden (settings)' : ''}`
                  : `${b.label} is not running`
              }
            >
              <span className="engine-dot" />
              {b.label}
            </span>
          ))}
        </div>
      </div>
      {volumeOpen && (
        <VolumeDialog
          engines={engines}
          defaultEngine={defaultEngine}
          onClose={() => setVolumeOpen(false)}
          onCreate={(engine, name, options) => {
            setVolumeOpen(false)
            void act('Creating', () => window.ide.containers.create(engine, 'volume', name, options), name ? `Created ${name}` : 'Created a volume')
          }}
        />
      )}
      {pullOpen && (
        <PullDialog
          engines={engines}
          defaultEngine={defaultEngine}
          onClose={() => setPullOpen(false)}
          onPull={(engine, image) => {
            setPullOpen(false)
            void startJob(engine, `Pull ${image}`, { kind: 'pull', image })
          }}
        />
      )}
      {settingsOpen && <ContainersSettings backends={backends ?? []} prefs={prefs} onClose={() => setSettingsOpen(false)} onStart={startJob} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings (⚙): engines shown, default engine, refresh, confirmations; registry login / logout

function ContainersSettings({
  backends,
  prefs,
  onClose,
  onStart
}: {
  backends: ContainerBackendInfo[]
  prefs: ContainersPrefs
  onClose: () => void
  onStart: (engine: ContainerBackendId, title: string, job: ContainerJob) => Promise<void>
}): React.JSX.Element {
  const [registry, setRegistry] = useState('')
  const usable = backends.filter((b) => b.available)
  const [loginEngine, setLoginEngine] = useState<ContainerBackendId | undefined>((usable.find((b) => b.id === prefs.defaultEngine) ?? usable[0])?.id)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const save = (patch: Partial<ContainersPrefs>): void => void window.ide.settings.set({ containers: { ...prefs, ...patch } })
  const toggleEngine = (id: ContainerBackendId, shown: boolean): void =>
    save({ hidden: shown ? prefs.hidden.filter((h) => h !== id) : [...new Set([...prefs.hidden, id])] })

  const login = async (): Promise<void> => {
    if (!loginEngine) return
    const profile = await window.ide.containers.loginProfile(loginEngine, registry)
    if (!profile) return notify(`The ${ENGINE_LABEL[loginEngine]} command line tool is not installed.`, 'error')
    onClose()
    await useTabs.getState().openProfile(profile)
  }
  const logout = async (): Promise<void> => {
    if (!loginEngine) return
    onClose()
    await onStart(loginEngine, `Log out of ${registry.trim() || 'Docker Hub'}`, { kind: 'logout', registry })
  }

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-dialog ctr-settings" role="dialog" aria-modal="true" aria-label="Containers settings">
        <header className="settings-head">
          <h2>Containers settings</h2>
          <span className="spacer" />
          <button className="icon-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="settings-body">
          <section className="settings-section">
            <h3>Engines</h3>
            <div className="settings-list">
              {backends.map((b) => (
                <div key={b.id} className="settings-row">
                  <span className={`engine-status${b.available ? ' on' : ''}`}>
                    <span className="engine-dot" />
                  </span>
                  <span className="settings-row-text">
                    <span className="settings-row-name">{b.label}</span>
                    <span className="settings-row-help">{b.available ? `Running${b.detail ? ` — ${b.detail}` : ''}` : `${b.label} is not running`}</span>
                  </span>
                  {/* Only running engines can be shown or hidden. */}
                  {b.available && <Toggle checked={!prefs.hidden.includes(b.id)} onChange={(on) => toggleEngine(b.id, on)} label={`Show ${b.label}`} />}
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3>Behaviour</h3>
            <div className="settings-defaults">
              <label className="settings-default">
                <span>Default engine (new images, containers, volumes…)</span>
                <select
                  aria-label="Default engine"
                  value={prefs.defaultEngine ?? ''}
                  onChange={(e) => save({ defaultEngine: (e.target.value || undefined) as ContainerBackendId | undefined })}
                >
                  <option value="">The first running</option>
                  {backends.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-default">
                <span>Refresh the lists</span>
                <select aria-label="Refresh" value={String(prefs.refresh)} onChange={(e) => save({ refresh: Number(e.target.value) })}>
                  {[1, 3, 5, 10, 30].map((s) => (
                    <option key={s} value={s}>
                      Every {s} s
                    </option>
                  ))}
                  <option value="0">Only on demand</option>
                </select>
              </label>
            </div>
            <div className="settings-row">
              <span className="settings-row-text">
                <span className="settings-row-name">Confirm before removing</span>
                <span className="settings-row-help">Ask before removing a container, an image, a volume or a network.</span>
              </span>
              <Toggle checked={prefs.confirmRemove} onChange={(on) => save({ confirmRemove: on })} label="Confirm before removing" />
            </div>
          </section>

          <section className="settings-section">
            <h3>Registries</h3>
            <p className="muted settings-note">
              Log in to pull and push private images. The login runs the engine's own tool in a terminal tab (you type the password there); the engine keeps it
              in its credential store (the OS keychain).
            </p>
            <div className="ctr-registry">
              <select
                aria-label="Registry engine"
                value={loginEngine ?? ''}
                onChange={(e) => setLoginEngine(e.target.value as ContainerBackendId)}
                disabled={!usable.length}
              >
                {usable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              <input
                aria-label="Registry"
                placeholder="Registry (empty: Docker Hub), e.g. ghcr.io"
                value={registry}
                onChange={(e) => setRegistry(e.target.value)}
              />
              <button className="tool-button primary" disabled={!loginEngine} onClick={() => void login()}>
                Log in…
              </button>
              <button className="tool-button" disabled={!loginEngine} onClick={() => void logout()}>
                Log out
              </button>
            </div>
            {!usable.length && <p className="muted settings-note">No engine is running.</p>}
          </section>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Details of the selection: logs, stats, inspect

/** A <pre> that follows new output unless scrolled up. */
function AutoScrollPre({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <pre
      ref={ref}
      className="ctr-pre selectable"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {text}
    </pre>
  )
}

/** A stream (logs or stats) of the selected container, for as long as the view is shown. */
function useStream(start: () => Promise<string>, onEvent: (e: Parameters<Parameters<typeof window.ide.containers.onStream>[0]>[0]) => void): void {
  const handler = useRef(onEvent)
  handler.current = onEvent
  useEffect(() => {
    let stream: string | undefined
    let alive = true
    const off = window.ide.containers.onStream((e) => {
      if (e.stream === stream) handler.current(e)
    })
    void start().then((id) => {
      stream = id
      if (!alive) window.ide.containers.stopStream(id)
    })
    return () => {
      alive = false
      off()
      if (stream) window.ide.containers.stopStream(stream)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

function LogsView({ backend, id }: { backend: ContainerBackendId; id: string }): React.JSX.Element {
  const [text, setText] = useState('')
  const [ended, setEnded] = useState<string>()
  const [search, setSearch] = useState('')
  useStream(
    () => window.ide.containers.logs(backend, id),
    (e) => {
      if (e.kind === 'text') setText((t) => keepTail(t + e.text))
      if (e.kind === 'end') setEnded(e.error ?? 'The log stream ended (the container stopped).')
    }
  )
  // eslint-disable-next-line no-control-regex -- terminal colour codes in logs
  const clean = useMemo(() => text.replace(/\x1b\[[0-9;]*m/g, ''), [text])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q
      ? clean
          .split('\n')
          .filter((l) => l.toLowerCase().includes(q))
          .join('\n')
      : clean
  }, [clean, search])
  return (
    <div className="ctr-logs">
      <div className="ctr-output-head">
        <input className="containers-filter" placeholder="Search the logs" value={search} onChange={(e) => setSearch(e.target.value)} />
        {ended && <span className="muted">{ended}</span>}
      </div>
      <AutoScrollPre text={shown || (ended ? '' : 'Waiting for logs…')} />
    </div>
  )
}

function StatsView({ backend, id, running }: { backend: ContainerBackendId; id: string; running: boolean }): React.JSX.Element {
  const [samples, setSamples] = useState<ContainerStats[]>([])
  const [ended, setEnded] = useState<string>()
  useStream(
    () => window.ide.containers.stats(backend, id),
    (e) => {
      if (e.kind === 'stats') setSamples((s) => [...s.slice(-59), e.stats])
      if (e.kind === 'end' && e.error) setEnded(e.error)
    }
  )
  if (!running) return <div className="pane-message">The container is not running.</div>
  const last = samples[samples.length - 1]
  if (!last) return <div className="pane-message">{ended ?? 'Waiting for the first sample…'}</div>
  const memPct = last.memLimit ? (last.memUsed / last.memLimit) * 100 : 0
  return (
    <div className="ctr-stats">
      <StatCard label="CPU" value={`${last.cpu.toFixed(1)} %`} values={samples.map((s) => s.cpu)} max={Math.max(100, ...samples.map((s) => s.cpu))} />
      <StatCard
        label="Memory"
        value={`${formatBytes(last.memUsed)}${last.memLimit ? ` / ${formatBytes(last.memLimit)}` : ''}`}
        sub={last.memLimit ? `${memPct.toFixed(1)} %` : undefined}
        values={samples.map((s) => s.memUsed)}
        max={Math.max(last.memLimit || 0, ...samples.map((s) => s.memUsed))}
      />
      <StatCard label="Network" value={`↓ ${formatBytes(last.netRx)}  ↑ ${formatBytes(last.netTx)}`} />
      <StatCard label="Block I/O" value={`read ${formatBytes(last.blockRead)}  write ${formatBytes(last.blockWrite)}`} />
      {last.pids !== undefined && <StatCard label="Processes" value={String(last.pids)} />}
    </div>
  )
}

function StatCard({ label, value, sub, values, max }: { label: string; value: string; sub?: string; values?: number[]; max?: number }): React.JSX.Element {
  const points =
    values && values.length > 1 ? values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - (max ? (v / max) * 28 : 0)}`).join(' ') : undefined
  return (
    <div className="ctr-stat">
      <div className="ctr-stat-label">{label}</div>
      <div className="ctr-stat-value">{value}</div>
      {sub && <div className="ctr-stat-sub">{sub}</div>}
      {points && (
        <svg className="ctr-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
          <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  )
}

function InspectView({ backend, target, id }: { backend: ContainerBackendId; target: ContainerTarget; id: string }): React.JSX.Element {
  const [text, setText] = useState<string>()
  useEffect(() => {
    let alive = true
    void window.ide.containers.inspect(backend, target, id).then((r) => alive && setText(r.ok ? r.text : r.error))
    return () => {
      alive = false
    }
  }, [backend, target, id])
  return <pre className="ctr-pre selectable">{text ?? 'Loading…'}</pre>
}

// ---------------------------------------------------------------------------
// Terminal: a shell in the selected container (`exec -it … sh`), inside the tab

function ContainerTerminal({ backend, id, name, visible }: { backend: ContainerBackendId; id: string; name: string; visible: boolean }): React.JSX.Element {
  const [session, setSession] = useState<string>()
  const [error, setError] = useState<string>()
  const [ended, setEnded] = useState<number>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    let sid: string | undefined
    setSession(undefined)
    setEnded(undefined)
    void (async () => {
      const profile = await window.ide.containers.shellProfile(backend, id, name)
      if (!profile) {
        if (alive) setError(`The ${ENGINE_LABEL[backend]} command line tool is not installed.`)
        return
      }
      try {
        const s = await window.ide.pty.create({ profileId: profile.id, cols: 80, rows: 24, panel: true })
        sid = s.sessionId
        if (alive) setSession(sid)
        else window.ide.pty.kill(sid)
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
    })()
    const off = window.ide.pty.onExit((s, code) => {
      if (s === sid && alive) setEnded(code)
    })
    return () => {
      alive = false
      off()
      if (sid) window.ide.pty.kill(sid)
    }
  }, [backend, id, name, attempt])
  return (
    <div className="ctr-terminal" hidden={!visible}>
      {(ended !== undefined || error) && (
        <div className="ctr-output-head">
          <span className="muted">{error ?? `The shell ended (exit ${ended}).`}</span>
          <button
            className="tool-button"
            onClick={() => {
              setError(undefined)
              setAttempt((a) => a + 1)
            }}
          >
            New shell
          </button>
        </div>
      )}
      {session && ended === undefined && (
        <div className="ctr-terminal-host">
          <TerminalView key={session} sessionId={session} visible={visible} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Files: browse the selected (running) container's file system; preview and save files

interface FilePreview {
  path: string
  text?: string
  binary?: boolean
  truncated?: boolean
  error?: string
}

function FilesView({ backend, id }: { backend: ContainerBackendId; id: string }): React.JSX.Element {
  const [path, setPath] = useState('/')
  const [typed, setTyped] = useState('/')
  const [entries, setEntries] = useState<ContainerFileEntry[]>()
  const [error, setError] = useState<string>()
  const [file, setFile] = useState<FilePreview>()
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setEntries(undefined)
    setError(undefined)
    setTyped(path)
    void window.ide.containers.listFiles(backend, id, path).then((r) => {
      if (!alive) return
      if (r.ok) setEntries(r.entries)
      else setError(r.error)
    })
    return () => {
      alive = false
    }
  }, [backend, id, path, reload])

  const childPath = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`)
  const up = path === '/' ? undefined : path.replace(/\/[^/]+$/, '') || '/'
  const crumbs = path.split('/').filter(Boolean)

  const open = async (e: ContainerFileEntry): Promise<void> => {
    const p = childPath(path, e.name)
    if (e.type === 'dir' || e.type === 'dirlink') {
      setPath(p)
      return
    }
    setFile({ path: p })
    const r = await window.ide.containers.readFile(backend, id, p)
    setFile((cur) => (cur?.path === p ? { path: p, text: r.text, binary: r.binary, truncated: r.truncated, error: r.ok ? undefined : r.error } : cur))
  }
  const save = async (p: string): Promise<void> => {
    const r = await window.ide.containers.saveFile(backend, id, p)
    if (!r) return
    notify(r.ok ? `Saved to ${r.savedTo}` : (r.error ?? 'Copy failed'), r.ok ? 'success' : 'error')
  }

  const previewText = (f: FilePreview): string => {
    if (f.error) return f.error
    if (f.binary) return 'Binary file: save it to open it on this computer.'
    if (f.text === undefined) return 'Loading…'
    return f.text + (f.truncated ? '\n… (only the first 256 kB: save the file for the rest)' : '')
  }

  return (
    <div className="ctr-files">
      <div className="ctr-output-head ctr-files-bar">
        <IconButton title="Parent folder" onClick={() => up && setPath(up)}>
          <span aria-hidden>↑</span>
        </IconButton>
        <nav className="ctr-crumbs" aria-label="Path">
          <button className="link-button" onClick={() => setPath('/')}>
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="muted">/</span>}
              <button className="link-button" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
            </span>
          ))}
        </nav>
        <input
          className="containers-filter ctr-path"
          aria-label="Go to path"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed.startsWith('/')) setPath(typed.replace(/\/+$/, '') || '/')
          }}
        />
        <IconButton title="Refresh" onClick={() => setReload((r) => r + 1)}>
          {ICONS.refresh}
        </IconButton>
      </div>
      <div className="ctr-files-body">
        <div className="ctr-files-list" role="list" aria-label="Files">
          {error && <div className="containers-error">{error}</div>}
          {!entries && !error && <div className="pane-message">Loading…</div>}
          {entries?.length === 0 && <div className="pane-message">Empty folder.</div>}
          {entries?.map((e) => {
            const p = childPath(path, e.name)
            const dir = e.type === 'dir' || e.type === 'dirlink'
            return (
              <div key={e.name} role="listitem" className={`ctr-file${file?.path === p ? ' selected' : ''}`} onClick={() => void open(e)} title={p}>
                <span className={`ctr-file-icon${dir ? ' dir' : ''}`}>{dir ? ICONS.folder : e.type === 'link' ? ICONS.link : ICONS.file}</span>
                <span className="ctr-file-name">
                  {e.name}
                  {e.type === 'dirlink' && <span className="muted"> →</span>}
                </span>
                <span className="ctr-file-size muted">{dir || e.size === undefined ? '' : formatBytes(e.size)}</span>
                <span className="ctr-file-time muted">{e.mtime ? relativeTime(e.mtime) : ''}</span>
                <span className="ctr-actions" onClick={(ev) => ev.stopPropagation()}>
                  {!dir && (
                    <IconButton title="Save to this computer…" onClick={() => void save(p)}>
                      {ICONS.pull}
                    </IconButton>
                  )}
                </span>
              </div>
            )
          })}
        </div>
        {file && (
          <div className="ctr-file-preview">
            <div className="ctr-output-head">
              <strong className="ctr-file-path">{file.path}</strong>
              <span className="spacer" />
              <IconButton title="Save to this computer…" onClick={() => void save(file.path)}>
                {ICONS.pull}
              </IconButton>
              <IconButton title="Close the preview" onClick={() => setFile(undefined)}>
                <span aria-hidden>✕</span>
              </IconButton>
            </div>
            <pre className="ctr-pre selectable">{previewText(file)}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pull an image: a reference with suggestions from the registries (names; tags after a colon)

function PullDialog({
  engines,
  defaultEngine,
  onClose,
  onPull
}: {
  engines: ContainerBackendInfo[]
  defaultEngine?: ContainerBackendId
  onClose: () => void
  onPull: (engine: ContainerBackendId, image: string) => void
}): React.JSX.Element {
  const [image, setImage] = useState('')
  const [engine, setEngine] = useState<ContainerBackendId | undefined>(defaultEngine ?? engines[0]?.id)
  const [items, setItems] = useState<ImageSuggestion[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string>()
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => input.current?.focus(), [])

  // Suggestions, 250 ms after the last key (the latest answer wins).
  useEffect(() => {
    const text = image.trim()
    if (!engine || text.length < 2) {
      setItems([])
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    const t = setTimeout(() => {
      void window.ide.containers.searchImages(engine, text).then((r) => {
        if (!alive) return
        setSearching(false)
        setItems(r.items)
        setError(r.ok ? undefined : r.error)
        setActive(-1)
      })
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [image, engine])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (s: ImageSuggestion): void => {
    setImage(s.name)
    // Picked: the list closes (typing again, e.g. ":" for the tags, reopens it).
    setOpen(false)
    setActive(-1)
    input.current?.focus()
  }
  const submit = (): void => {
    const ref = image.trim()
    if (!ref || !engine) return
    onPull(engine, ref)
  }
  const shown = open && items.length > 0

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog ctr-pull"
        role="dialog"
        aria-label="Pull an image"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key !== 'Escape') return
          if (shown) setOpen(false)
          else onClose()
        }}
      >
        <h2>Pull an image</h2>
        <label className="dialog-field">
          <span>Image (type a name for suggestions; after a colon, its tags)</span>
          <div className="ctr-combo">
            <input
              ref={input}
              role="combobox"
              aria-expanded={shown}
              aria-controls="ctr-pull-suggestions"
              aria-autocomplete="list"
              aria-activedescendant={shown && active >= 0 ? `ctr-pull-${active}` : undefined}
              placeholder="nginx:alpine"
              spellCheck={false}
              autoComplete="off"
              value={image}
              onChange={(e) => {
                setImage(e.target.value)
                setOpen(true)
              }}
              onBlur={() => setOpen(false)}
              onKeyDown={(e) => {
                if (!shown) return
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const d = e.key === 'ArrowDown' ? 1 : -1
                  // -1: the typed text; wraps around.
                  setActive((a) => {
                    const next = a + d
                    return next < -1 ? items.length - 1 : next >= items.length ? -1 : next
                  })
                } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0 && items[active]) {
                  e.preventDefault()
                  choose(items[active])
                }
              }}
            />
            {searching && <span className="ctr-combo-busy muted">searching…</span>}
            {shown && (
              <ul className="ctr-suggest" role="listbox" id="ctr-pull-suggestions" ref={listRef} aria-label="Suggestions">
                {items.map((s, i) => (
                  <li
                    key={s.name}
                    id={`ctr-pull-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? 'active' : ''}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(s)
                    }}
                    onMouseEnter={() => setActive(i)}
                  >
                    <span className="ctr-suggest-name">
                      {s.name}
                      {s.official && <span className="ctr-suggest-official">Official</span>}
                    </span>
                    <span className="ctr-suggest-meta muted">
                      {s.stars !== undefined && `★ ${s.stars.toLocaleString()}`}
                      {s.size ? formatBytes(s.size) : ''}
                    </span>
                    {s.description && <span className="ctr-suggest-desc muted">{s.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </label>
        {error && <p className="dialog-message muted">Suggestions unavailable: {error}</p>}
        {engines.length > 1 && (
          <label className="dialog-field">
            <span>Engine</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value as ContainerBackendId)}>
              {engines.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!image.trim() || !engine}>
            Pull
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// A container's settings — environment, volumes (mounts), ports — edited in a draft; applying recreates
// the container (Docker, Podman: an engine cannot change them in place). wslc: read-only.

type SpecSection = 'env' | 'mounts' | 'ports'

interface SpecViewProps {
  backend: ContainerBackendId
  id: string
  name: string
  editable: boolean
  onRecreated: (newId: string) => void
}

/**
 * The shared part of the three editors: the container's settings, a draft of one section, its
 * header (what applying does, Revert, Apply) and the recreation.
 */
function SpecEditor<T>(
  props: SpecViewProps & {
    section: SpecSection
    title: string
    fromSpec: (s: ContainerSpec) => T[]
    toChange: (rows: T[]) => Partial<Pick<ContainerSpec, 'env' | 'mounts' | 'ports'>>
    validate: (rows: T[]) => string | undefined
    same: (a: T[], b: T[]) => boolean
    blank: () => T
    addLabel: string
    renderRows: (rows: T[], set: (i: number, patch: Partial<T>) => void, remove: (i: number) => void) => React.ReactNode
    extra?: (spec: ContainerSpec, add: (row: T) => void) => React.ReactNode
  }
): React.JSX.Element {
  const { backend, id, name, editable } = props
  const [spec, setSpec] = useState<ContainerSpec>()
  const [rows, setRows] = useState<T[]>([])
  const [error, setError] = useState<string>()
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let alive = true
    void window.ide.containers.spec(backend, id).then((r) => {
      if (!alive) return
      if (!r.ok || !r.spec) return setError(r.error ?? 'Unavailable')
      setSpec(r.spec)
      setRows(props.fromSpec(r.spec))
    })
    return () => {
      alive = false
    }
  }, [backend, id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="pane-message containers-error">{error}</div>
  if (!spec) return <div className="pane-message">Loading…</div>
  const original = props.fromSpec(spec)
  const changed = !props.same(rows, original)
  const invalid = props.validate(rows)

  const apply = async (): Promise<void> => {
    const ok = await confirmDialog(
      'Recreate the container?',
      `An engine cannot change a container's ${props.title.toLowerCase()} in place: ${name} is recreated with the same image, command and networks, and the new ${props.title.toLowerCase()}. Files changed in the container outside its volumes are lost. It is restarted if it was running.`,
      'Recreate',
      true
    )
    if (!ok) return
    setApplying(true)
    const r = await window.ide.containers.recreate(backend, id, props.toChange(rows))
    setApplying(false)
    if (!r.ok || !r.id) return notify(`${props.title} not changed: ${r.error ?? 'failed'}`, 'error')
    notify(`${name}: recreated with the new ${props.title.toLowerCase()}`, 'success')
    props.onRecreated(r.id)
  }

  const set = (i: number, patch: Partial<T>): void => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number): void => setRows((rs) => rs.filter((_, j) => j !== i))
  return (
    <div className="ctr-env">
      <div className="ctr-output-head">
        <strong>{props.title}</strong>
        <span className="muted">
          {editable ? 'Applying recreates the container.' : `Read-only: ${ENGINE_LABEL[backend]} cannot recreate a container from here.`}
        </span>
        <span className="spacer" />
        {changed && invalid && <span className="containers-error">{invalid}</span>}
        {editable && (
          <>
            <button className="tool-button" disabled={!changed || applying} onClick={() => setRows(original)}>
              Revert
            </button>
            <button className="tool-button primary" disabled={!changed || applying || !!invalid} onClick={() => void apply()}>
              {applying ? 'Recreating…' : 'Apply'}
            </button>
          </>
        )}
      </div>
      <div className="ctr-env-list" role="table" aria-label={props.title}>
        {rows.length === 0 && <p className="muted ctr-spec-empty">None.</p>}
        {props.renderRows(rows, set, remove)}
        {props.extra?.(spec, (row) => setRows((rs) => [...rs, row]))}
        {editable && (
          <button className="tool-button ctr-env-add" onClick={() => setRows((rs) => [...rs, props.blank()])}>
            {props.addLabel}
          </button>
        )}
      </div>
    </div>
  )
}

const sameJson = <T,>(a: T[], b: T[]): boolean => JSON.stringify(a) === JSON.stringify(b)

// ---------- Environment ----------

interface EnvRow {
  key: string
  value: string
}

const SECRET = /pass|secret|token|key|credential|auth/i

function EnvView(props: SpecViewProps): React.JSX.Element {
  const [shown, setShown] = useState<Set<number>>(new Set())
  const toList = (rows: EnvRow[]): string[] => rows.filter((r) => r.key.trim()).map((r) => `${r.key.trim()}=${r.value}`)
  return (
    <SpecEditor<EnvRow>
      {...props}
      section="env"
      title="Environment"
      addLabel="+ Add a variable"
      blank={() => ({ key: '', value: '' })}
      fromSpec={(s) =>
        s.env.map((e) => {
          const i = e.indexOf('=')
          return i < 0 ? { key: e, value: '' } : { key: e.slice(0, i), value: e.slice(i + 1) }
        })
      }
      toChange={(rows) => ({ env: toList(rows) })}
      same={(a, b) => sameJson(toList(a), toList(b))}
      validate={(rows) => {
        const keys = toList(rows).map((e) => e.split('=')[0])
        const dup = keys.find((k, i) => keys.indexOf(k) !== i)
        const bad = rows.find((r) => r.key.trim() && /[\s=]/.test(r.key.trim()))
        return dup ? `${dup} is set twice.` : bad ? `Invalid name: ${bad.key}` : undefined
      }}
      renderRows={(rows, set, remove) =>
        rows.map((r, i) => {
          const secret = SECRET.test(r.key)
          return (
            <div key={i} className="ctr-env-row" role="row">
              <input
                className="ctr-env-key"
                aria-label="Name"
                value={r.key}
                readOnly={!props.editable}
                spellCheck={false}
                placeholder="NAME"
                onChange={(e) => set(i, { key: e.target.value })}
              />
              <span className="muted">=</span>
              <input
                className="ctr-env-value"
                aria-label={`Value of ${r.key}`}
                type={secret && !shown.has(i) ? 'password' : 'text'}
                value={r.value}
                readOnly={!props.editable}
                spellCheck={false}
                onChange={(e) => set(i, { value: e.target.value })}
              />
              {secret && (
                <IconButton
                  title={shown.has(i) ? 'Hide the value' : 'Show the value'}
                  onClick={() =>
                    setShown((s) => {
                      const n = new Set(s)
                      if (n.has(i)) n.delete(i)
                      else n.add(i)
                      return n
                    })
                  }
                >
                  <span aria-hidden>{shown.has(i) ? '◉' : '◎'}</span>
                </IconButton>
              )}
              {props.editable && (
                <IconButton title={`Remove ${r.key || 'this variable'}`} danger onClick={() => remove(i)}>
                  {ICONS.trash}
                </IconButton>
              )}
            </div>
          )
        })
      }
    />
  )
}

// ---------- Volumes (mounts) ----------

function MountsView(props: SpecViewProps): React.JSX.Element {
  // Existing volumes of the engine, offered as sources.
  const [volumes, setVolumes] = useState<string[]>([])
  useEffect(() => {
    void window.ide.containers.list(props.backend, 'volumes').then((r) => setVolumes((r.volumes ?? []).map((v) => v.name)))
  }, [props.backend])
  const listId = `ctr-volumes-${props.backend}`
  return (
    <SpecEditor<ContainerMount>
      {...props}
      section="mounts"
      title="Volumes"
      addLabel="+ Add a volume"
      blank={() => ({ type: 'volume', source: '', target: '', readOnly: false })}
      fromSpec={(s) => s.mounts}
      toChange={(rows) => ({ mounts: rows })}
      same={sameJson}
      validate={(rows) => {
        const targets = rows.map((r) => r.target.trim())
        const bad = rows.find((r) => !r.target.trim().startsWith('/'))
        const missing = rows.find((r) => r.type !== 'tmpfs' && !r.source.trim())
        const dup = targets.find((t, i) => targets.indexOf(t) !== i)
        return bad
          ? `The path in the container must start with "/"${bad.target ? `: ${bad.target}` : ''}.`
          : missing
            ? `${missing.type === 'bind' ? 'A host folder' : 'A volume'} is needed for ${missing.target || 'each mount'}.`
            : dup
              ? `${dup} is mounted twice.`
              : undefined
      }}
      renderRows={(rows, set, remove) => (
        <>
          <datalist id={listId}>
            {volumes.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          {rows.map((m, i) => (
            <div key={i} className="ctr-env-row ctr-mount-row" role="row">
              <select aria-label="Type" value={m.type} disabled={!props.editable} onChange={(e) => set(i, { type: e.target.value as ContainerMount['type'] })}>
                <option value="volume">Volume</option>
                <option value="bind">Host folder</option>
                <option value="tmpfs">Memory (tmpfs)</option>
              </select>
              <input
                className="ctr-env-key ctr-mount-source"
                aria-label="Source"
                list={m.type === 'volume' ? listId : undefined}
                value={m.source}
                readOnly={!props.editable}
                disabled={m.type === 'tmpfs'}
                spellCheck={false}
                placeholder={m.type === 'volume' ? 'volume name' : m.type === 'bind' ? '/path/on/the/host' : '(memory)'}
                onChange={(e) => set(i, { source: e.target.value })}
              />
              <span className="muted">→</span>
              <input
                className="ctr-env-value"
                aria-label="Path in the container"
                value={m.target}
                readOnly={!props.editable}
                spellCheck={false}
                placeholder="/path/in/the/container"
                onChange={(e) => set(i, { target: e.target.value })}
              />
              <label className="ctr-ro" title="Mounted read-only">
                <input
                  type="checkbox"
                  aria-label="Read-only"
                  checked={m.readOnly}
                  disabled={!props.editable}
                  onChange={(e) => set(i, { readOnly: e.target.checked })}
                />
                read-only
              </label>
              {props.editable && (
                <IconButton title={`Remove ${m.target || 'this volume'}`} danger onClick={() => remove(i)}>
                  {ICONS.trash}
                </IconButton>
              )}
            </div>
          ))}
        </>
      )}
    />
  )
}

// ---------- Ports ----------

function PortsView(props: SpecViewProps): React.JSX.Element {
  return (
    <SpecEditor<ContainerPortBinding>
      {...props}
      section="ports"
      title="Ports"
      addLabel="+ Publish a port"
      blank={() => ({ container: 0, protocol: 'tcp', hostPort: '', hostIp: '' })}
      fromSpec={(s) => s.ports}
      toChange={(rows) => ({ ports: rows })}
      same={sameJson}
      validate={(rows) => {
        const bad = rows.find((p) => !Number.isInteger(p.container) || p.container < 1 || p.container > 65535)
        const host = rows.find((p) => p.hostPort && !/^\d{1,5}(-\d{1,5})?$/.test(p.hostPort))
        const keys = rows.filter((p) => p.hostPort).map((p) => `${p.hostIp}:${p.hostPort}/${p.protocol}`)
        const dup = keys.find((k, i) => keys.indexOf(k) !== i)
        return bad
          ? 'Each port needs a container port (1-65535).'
          : host
            ? `Invalid host port: ${host.hostPort}`
            : dup
              ? `Host port ${dup.split(':')[1]} is used twice.`
              : undefined
      }}
      renderRows={(rows, set, remove) =>
        rows.map((p, i) => (
          <div key={i} className="ctr-env-row ctr-port-row" role="row">
            <input
              className="ctr-port-ip"
              aria-label="Host IP"
              value={p.hostIp}
              readOnly={!props.editable}
              spellCheck={false}
              placeholder="all interfaces"
              onChange={(e) => set(i, { hostIp: e.target.value.trim() })}
            />
            <span className="muted">:</span>
            <input
              className="ctr-port-num"
              aria-label="Host port"
              value={p.hostPort}
              readOnly={!props.editable}
              spellCheck={false}
              placeholder="any"
              onChange={(e) => set(i, { hostPort: e.target.value.trim() })}
            />
            <span className="muted">→</span>
            <input
              className="ctr-port-num"
              aria-label="Container port"
              value={p.container ? String(p.container) : ''}
              readOnly={!props.editable}
              spellCheck={false}
              placeholder="80"
              onChange={(e) => set(i, { container: Number(e.target.value.trim()) || 0 })}
            />
            <select aria-label="Protocol" value={p.protocol} disabled={!props.editable} onChange={(e) => set(i, { protocol: e.target.value })}>
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
              <option value="sctp">sctp</option>
            </select>
            <span className="spacer" />
            {p.hostPort && /^\d+$/.test(p.hostPort) && (
              <button
                className="link-button"
                title={`Open http://localhost:${p.hostPort}`}
                onClick={() => window.ide.app.openExternal(`http://localhost:${p.hostPort}`)}
              >
                open
              </button>
            )}
            {props.editable && (
              <IconButton title={`Stop publishing ${p.container || 'this port'}`} danger onClick={() => remove(i)}>
                {ICONS.trash}
              </IconButton>
            )}
          </div>
        ))
      }
      extra={(spec, add) =>
        spec.exposed.length > 0 && (
          <p className="muted ctr-exposed">
            Exposed by the image, not published:{' '}
            {spec.exposed.map((k) => {
              const [port, protocol = 'tcp'] = k.split('/')
              return props.editable ? (
                <button
                  key={k}
                  className="link-button"
                  title={`Publish ${k}`}
                  onClick={() => add({ container: Number(port), protocol, hostPort: port, hostIp: '' })}
                >
                  {k}
                </button>
              ) : (
                <span key={k}>{k} </span>
              )
            })}
          </p>
        )
      }
    />
  )
}

// ---------------------------------------------------------------------------
// New volume: name, engine, type (local, NFS, SMB, host folder, in memory, another driver), labels

type VolumeKind = 'local' | 'nfs' | 'cifs' | 'bind' | 'tmpfs' | 'custom' | 'guest' | 'vhd'

const VOLUME_KINDS: Record<'engine' | 'wslc', { id: VolumeKind; label: string }[]> = {
  engine: [
    { id: 'local', label: 'Local (default)' },
    { id: 'nfs', label: 'NFS share' },
    { id: 'cifs', label: 'SMB / CIFS share' },
    { id: 'bind', label: "A folder of the engine's host" },
    { id: 'tmpfs', label: 'In memory (tmpfs)' },
    { id: 'custom', label: 'Another driver (plugin)…' }
  ],
  wslc: [
    { id: 'guest', label: 'guest (default)' },
    { id: 'vhd', label: 'vhd (virtual disk)' }
  ]
}

/** KEY=VALUE lines → a map (empty lines skipped; a line without "=" is an error). */
function pairs(text: string): { map: Record<string, string>; error?: string } {
  const map: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    const i = l.indexOf('=')
    if (i <= 0) return { map, error: `"${l}" is not KEY=VALUE` }
    map[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return { map }
}

/** The driver and its options for the chosen type (exported for tests). */
export function volumeSettings(kind: VolumeKind, f: Record<string, string>): { driver?: string; options: Record<string, string>; error?: string } {
  const extra = pairs(f.options ?? '')
  if (extra.error) return { options: {}, error: extra.error }
  switch (kind) {
    case 'nfs':
      if (!f.server?.trim() || !f.path?.trim()) return { options: {}, error: 'The NFS server and its exported path are needed.' }
      return {
        driver: 'local',
        options: { type: 'nfs', o: [`addr=${f.server.trim()}`, f.mount?.trim()].filter(Boolean).join(','), device: `:${f.path.trim()}`, ...extra.map }
      }
    case 'cifs':
      if (!f.share?.trim()) return { options: {}, error: 'The share (//server/share) is needed.' }
      return { driver: 'local', options: { type: 'cifs', device: f.share.trim(), ...(f.mount?.trim() ? { o: f.mount.trim() } : {}), ...extra.map } }
    case 'bind':
      if (!f.path?.trim()) return { options: {}, error: "The folder (a path on the engine's host) is needed." }
      return { driver: 'local', options: { type: 'none', o: 'bind', device: f.path.trim(), ...extra.map } }
    case 'tmpfs':
      return { driver: 'local', options: { type: 'tmpfs', device: 'tmpfs', ...(f.size?.trim() ? { o: `size=${f.size.trim()}` } : {}), ...extra.map } }
    case 'custom':
      if (!f.driver?.trim()) return { options: {}, error: 'The driver name is needed.' }
      return { driver: f.driver.trim(), options: extra.map }
    case 'guest':
    case 'vhd':
      return { driver: kind, options: extra.map }
    default:
      return { options: extra.map }
  }
}

function VolumeDialog({
  engines,
  defaultEngine,
  onClose,
  onCreate
}: {
  engines: ContainerBackendInfo[]
  defaultEngine?: ContainerBackendId
  onClose: () => void
  onCreate: (engine: ContainerBackendId, name: string, options: CreateOptions) => void
}): React.JSX.Element {
  const [engine, setEngine] = useState<ContainerBackendId | undefined>(defaultEngine ?? engines[0]?.id)
  const kinds = VOLUME_KINDS[engine === 'wslc' ? 'wslc' : 'engine']
  const [kind, setKind] = useState<VolumeKind>(kinds[0].id)
  const [f, setF] = useState<Record<string, string>>({ mount: '' })
  const [touched, setTouched] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const shownKind = kinds.some((k) => k.id === kind) ? kind : kinds[0].id
  const settings = volumeSettings(shownKind, f)
  const labels = pairs(f.labels ?? '')
  const nameError = f.name?.trim() && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(f.name.trim()) ? 'Letters, digits, "_", "." and "-" only (not first).' : undefined
  const error = nameError ?? settings.error ?? labels.error
  const field = (name: string, label: string, placeholder?: string, hint?: string): React.JSX.Element => (
    <label className="dialog-field" key={name}>
      <span>{label}</span>
      <input aria-label={label} value={f[name] ?? ''} placeholder={placeholder} spellCheck={false} onChange={(e) => setF({ ...f, [name]: e.target.value })} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  )
  const area = (name: string, label: string, placeholder: string): React.JSX.Element => (
    <label className="dialog-field" key={name}>
      <span>{label}</span>
      <textarea
        aria-label={label}
        className="selectable"
        rows={3}
        value={f[name] ?? ''}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setF({ ...f, [name]: e.target.value })}
      />
    </label>
  )

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog ctr-volume-dialog"
        role="dialog"
        aria-label="New volume"
        onSubmit={(e) => {
          e.preventDefault()
          setTouched(true)
          if (error || !engine) return
          onCreate(engine, (f.name ?? '').trim(), { driver: settings.driver, options: settings.options, labels: labels.map })
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
      >
        <h2>New volume</h2>
        <label className="dialog-field">
          <span>Name (empty: the engine names it)</span>
          <input
            ref={first}
            aria-label="Name"
            value={f.name ?? ''}
            placeholder="my-data"
            spellCheck={false}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </label>
        <div className="ctr-dialog-row">
          {engines.length > 1 && (
            <label className="dialog-field">
              <span>Engine</span>
              <select aria-label="Engine" value={engine} onChange={(e) => setEngine(e.target.value as ContainerBackendId)}>
                {engines.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="dialog-field">
            <span>Type</span>
            <select aria-label="Type" value={shownKind} onChange={(e) => setKind(e.target.value as VolumeKind)}>
              {kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {shownKind === 'nfs' && (
          <div className="ctr-dialog-row">
            {field('server', 'NFS server', '10.0.0.5 or nas.local')}
            {field('path', 'Exported path', '/export/data')}
          </div>
        )}
        {shownKind === 'cifs' && field('share', 'Share', '//server/share')}
        {shownKind === 'bind' &&
          field(
            'path',
            "Folder on the engine's host",
            '/srv/data',
            'A path inside the engine (Docker Desktop: its Linux VM, e.g. /mnt/host/c/data for C:\\data).'
          )}
        {shownKind === 'tmpfs' && <p className="dialog-message muted">Contents are lost when no container uses the volume.</p>}
        {shownKind === 'custom' && field('driver', 'Driver', 'rexray/ebs')}
        {/* Optional settings, folded (opened when one is set). */}
        <details className="ctr-advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
          <summary>Advanced settings</summary>
          {shownKind === 'nfs' && field('mount', 'Mount options', 'rw,nfsvers=4', 'Added after addr=… (e.g. rw,nfsvers=4,soft).')}
          {shownKind === 'cifs' &&
            field('mount', 'Mount options', 'username=me,password=…,vers=3.0', 'Credentials given here are kept in the volume settings (visible to inspect).')}
          {shownKind === 'tmpfs' && field('size', 'Size limit', '256m')}
          {area('options', 'Driver options (KEY=VALUE per line)', 'KEY=VALUE')}
          {area('labels', 'Labels (KEY=VALUE per line)', 'project=shop')}
        </details>
        {!error && (settings.driver || Object.keys(settings.options).length > 0) && (
          <p className="dialog-message muted ctr-volume-preview">
            {[settings.driver && `driver: ${settings.driver}`, ...Object.entries(settings.options).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join('  ·  ')}
          </p>
        )}
        {touched && error && <p className="dialog-message containers-error">{error}</p>}
        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!engine}>
            Create
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
