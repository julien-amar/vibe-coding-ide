import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposeProject,
  ContainerBackendId,
  ContainerBackendInfo,
  ContainerInfo,
  ContainerJob,
  ContainerListKind,
  ContainerListResult,
  ContainerStats,
  ContainerTarget,
  ImageInfo,
  NetworkInfo,
  VolumeInfo
} from '@shared/types'
import { useTabs, type Tab } from '../store'
import { relativeTime } from '../time'
import { confirmDialog, notify, openDialog } from './Dialogs'

/**
 * The Containers tab: Docker, Podman (Engine API) and wslc (its CLI) — containers, images, volumes,
 * networks and Compose projects; logs, live stats, inspect; pull, build, run, Compose and registry
 * login with live output.
 */

const VIEWS: { id: ContainerListKind; label: string }[] = [
  { id: 'containers', label: 'Containers' },
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
  { id: 'compose', label: 'Compose' }
]

type Bottom = 'logs' | 'stats' | 'inspect' | 'output'

interface Selection {
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

export function ContainersView({ tab, visible }: { tab: Tab; visible: boolean }): React.JSX.Element {
  const [backends, setBackends] = useState<ContainerBackendInfo[] | null>(null)
  const [view, setView] = useState<ContainerListKind>('containers')
  const [data, setData] = useState<ContainerListResult | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Selection>()
  const [bottom, setBottom] = useState<Bottom>()
  const [job, setJob] = useState<Job>()
  const [busy, setBusy] = useState<string>()

  const loadBackends = useCallback(async () => {
    setBackends(null)
    setBackends(await window.ide.containers.backends())
  }, [])
  useEffect(() => {
    void loadBackends()
  }, [loadBackends])

  // The engine: the tab's own, else the first that answers.
  const chosen = tab.profileId as ContainerBackendId | undefined
  const backend: ContainerBackendId = (backends?.find((b) => b.id === chosen)?.id ??
    backends?.find((b) => b.available)?.id ??
    chosen ??
    'docker') as ContainerBackendId
  const info = backends?.find((b) => b.id === backend)
  const views = VIEWS.filter((v) => v.id !== 'compose' || info?.features.compose)

  const load = useCallback(async () => {
    if (!info?.available) return
    const r = await window.ide.containers.list(backend, view)
    setData(r)
  }, [backend, view, info?.available])

  // A view or engine change: its list (and nothing selected).
  useEffect(() => {
    setData(null)
    setSelected(undefined)
    void load()
  }, [backend, view]) // eslint-disable-line react-hooks/exhaustive-deps

  // Kept current while on screen.
  useEffect(() => {
    if (!visible || !info?.available) return
    void load()
    const iv = setInterval(() => void load(), 3000)
    return () => clearInterval(iv)
  }, [visible, load, info?.available])

  const switchBackend = (id: ContainerBackendId): void => {
    useTabs.getState().setContainersBackend(tab.id, id)
    setBottom(undefined)
  }

  /** Runs an action with a busy label; errors as toasts; the list refreshed after. */
  const act = async (label: string, fn: () => Promise<{ ok: boolean; error?: string; text?: string }>, success?: string): Promise<boolean> => {
    setBusy(label)
    const r = await fn()
    setBusy(undefined)
    if (!r.ok) notify(r.error ?? `${label} failed`, 'error')
    else if (success || r.text) notify(r.text ? `${success ?? label}: ${r.text}` : success!, 'success')
    void load()
    return r.ok
  }

  // ---------- Jobs (pull, build, run, compose): live output in the bottom section ----------

  const startJob = async (title: string, j: ContainerJob): Promise<void> => {
    const stream = await window.ide.containers.job(backend, j)
    setJob({ stream, title, text: '', running: true })
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

  // ---------- Dialogs ----------

  const pull = async (): Promise<void> => {
    const r = await openDialog({ title: 'Pull an image', fields: [{ name: 'image', label: 'Image', placeholder: 'nginx:alpine' }], confirmLabel: 'Pull' })
    const image = r && String(r.image).trim()
    if (image) await startJob(`Pull ${image}`, { kind: 'pull', image })
  }

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
        { name: 'args', label: 'Build arguments (one KEY=VALUE per line)', kind: 'textarea' }
      ],
      confirmLabel: 'Build'
    })
    if (!r) return
    const buildArgs = String(r.args ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    await startJob(`Build ${String(r.tag).trim() || context}`, {
      kind: 'build',
      context,
      tag: String(r.tag),
      dockerfile: String(r.dockerfile),
      target: String(r.target),
      buildArgs
    })
  }

  const run = async (image: string): Promise<void> => {
    const nets = (await window.ide.containers.list(backend, 'networks')).networks?.map((n) => n.name) ?? []
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
    await startJob(`Run ${image}`, {
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

  const login = async (): Promise<void> => {
    const r = await openDialog({
      title: 'Log in to a registry',
      message: `Opens a terminal running ${backend} login: the password is typed there, and kept by ${info?.label ?? backend}'s credential store (the OS keychain).`,
      fields: [{ name: 'registry', label: 'Registry (empty: Docker Hub)', placeholder: 'ghcr.io' }],
      confirmLabel: 'Open login'
    })
    if (!r) return
    const profile = await window.ide.containers.loginProfile(backend, String(r.registry ?? ''))
    if (profile) await useTabs.getState().openProfile(profile)
    else notify(`The ${backend} command line tool is not installed.`, 'error')
  }

  const shell = async (c: ContainerInfo): Promise<void> => {
    const profile = await window.ide.containers.shellProfile(backend, c.id, c.name)
    if (profile) await useTabs.getState().openProfile(profile)
    else notify(`The ${backend} command line tool is not installed.`, 'error')
  }

  const prune = async (target: ContainerTarget, what: string): Promise<void> => {
    if (await confirmDialog(`Remove ${what}?`, `Every ${what.replace(/^(all )?/, '')} of ${info?.label} will be removed.`, 'Remove', true)) {
      await act('Pruning', () => window.ide.containers.prune(backend, target), 'Pruned')
    }
  }

  const create = async (target: 'volume' | 'network'): Promise<void> => {
    const r = await openDialog({ title: `New ${target}`, fields: [{ name: 'name', label: 'Name' }], confirmLabel: 'Create' })
    const name = r && String(r.name).trim()
    if (name) await act('Creating', () => window.ide.containers.create(backend, target, name), `Created ${name}`)
  }

  const remove = async (target: ContainerTarget, id: string, name: string): Promise<void> => {
    const note = target === 'container' ? ' It is stopped first if it runs.' : ''
    if (await confirmDialog(`Remove ${target}?`, `${name} will be removed.${note}`, 'Remove', true)) {
      if (selected?.id === id) setSelected(undefined)
      await act('Removing', () => window.ide.containers.action(backend, target, id, 'remove'), `Removed ${name}`)
    }
  }

  const compose = async (p: ComposeProject, action: 'up' | 'down' | 'restart' | 'pull' | 'stop'): Promise<void> => {
    if (action === 'down' && !(await confirmDialog('Compose down?', `The containers and networks of ${p.name} will be removed.`, 'Down', true))) return
    await startJob(`Compose ${action} ${p.name}`, { kind: 'compose', project: p.name, action, configFiles: p.configFiles, workingDir: p.workingDir })
  }

  const composeFolder = async (): Promise<void> => {
    const dir = await window.ide.project.pickFolder()
    if (!dir) return
    const name =
      (
        dir
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() ?? 'app'
      )
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '') || 'app'
    await startJob(`Compose up ${name}`, { kind: 'compose', project: name, action: 'up', configFiles: [], workingDir: dir })
  }

  // ---------- Lists ----------

  const q = filter.trim().toLowerCase()
  const match = (...texts: (string | undefined)[]): boolean => !q || texts.some((t) => t?.toLowerCase().includes(q))

  const select = (s: Selection): void => {
    setSelected(s)
    setBottom((b) => (s.target === 'container' ? (b && b !== 'output' ? b : 'logs') : 'inspect'))
  }

  const content = (): React.ReactNode => {
    if (!backends) return <div className="pane-message">Looking for container engines…</div>
    if (!info?.available)
      return (
        <div className="pane-message containers-unavailable">
          <p>
            <strong>{info?.label ?? backend}</strong> is not available.
          </p>
          <p className="muted">{info?.error}</p>
          <button className="tool-button" onClick={() => void loadBackends()}>
            Check again
          </button>
        </div>
      )
    if (!data) return <div className="pane-message">Loading…</div>
    if (!data.ok) return <div className="pane-message containers-error">{data.error}</div>
    switch (view) {
      case 'containers':
        return containerList((data.containers ?? []).filter((c) => match(c.name, c.image, c.id)))
      case 'images':
        return imageList((data.images ?? []).filter((i) => match(i.id, ...i.tags)))
      case 'volumes':
        return volumeList((data.volumes ?? []).filter((v) => match(v.name, v.driver)))
      case 'networks':
        return networkList((data.networks ?? []).filter((n) => match(n.name, n.driver)))
      case 'compose':
        return composeList((data.compose ?? []).filter((p) => match(p.name, p.workingDir)))
    }
  }

  const empty = (what: string): React.JSX.Element => <div className="pane-message">{q ? 'Nothing matches the filter.' : `No ${what}.`}</div>

  // Lists: render functions (not components: they would be new components on each render).
  const containerList = (items: ContainerInfo[]): React.JSX.Element => {
    if (!items.length) return empty('containers')
    return (
      <div className="ctr-list" role="list">
        {items.map((c) => {
          const running = c.state === 'running'
          const paused = c.state === 'paused'
          return (
            <div
              key={c.id}
              role="listitem"
              className={`ctr-row${selected?.id === c.id ? ' selected' : ''}`}
              onClick={() => select({ target: 'container', id: c.id, name: c.name, running })}
            >
              <span className={`ctr-state st-${c.state}`} title={c.state} />
              <span className="ctr-main">
                <span className="ctr-name">{c.name}</span>
                <span className="ctr-sub">
                  {c.image}
                  {c.compose && <span className="ctr-chip">{c.compose.project}</span>}
                </span>
              </span>
              <span className="ctr-ports">
                {c.ports
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
                  ))}
              </span>
              <span className="ctr-status">{c.status}</span>
              <span className="ctr-actions" onClick={(e) => e.stopPropagation()}>
                {!running && !paused && (
                  <IconAction title="Start" onClick={() => void act('Starting', () => window.ide.containers.action(backend, 'container', c.id, 'start'))}>
                    ▶
                  </IconAction>
                )}
                {running && (
                  <IconAction title="Stop" onClick={() => void act('Stopping', () => window.ide.containers.action(backend, 'container', c.id, 'stop'))}>
                    ■
                  </IconAction>
                )}
                {(running || paused) && (
                  <IconAction title="Restart" onClick={() => void act('Restarting', () => window.ide.containers.action(backend, 'container', c.id, 'restart'))}>
                    ⟳
                  </IconAction>
                )}
                {info?.features.pause && running && (
                  <IconAction title="Pause" onClick={() => void act('Pausing', () => window.ide.containers.action(backend, 'container', c.id, 'pause'))}>
                    ❚❚
                  </IconAction>
                )}
                {paused && (
                  <IconAction title="Resume" onClick={() => void act('Resuming', () => window.ide.containers.action(backend, 'container', c.id, 'unpause'))}>
                    ▶
                  </IconAction>
                )}
                {running && (
                  <IconAction title="Open a shell in the container (new tab)" onClick={() => void shell(c)}>
                    {'>_'}
                  </IconAction>
                )}
                <IconAction title="Remove" danger onClick={() => void remove('container', c.id, c.name)}>
                  <TrashIcon />
                </IconAction>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const imageList = (items: ImageInfo[]): React.JSX.Element => {
    if (!items.length) return empty('images')
    return (
      <div className="ctr-list" role="list">
        {items.map((i) => {
          const name = i.tags[0] ?? shortId(i.id)
          return (
            <div
              key={i.id}
              role="listitem"
              className={`ctr-row${selected?.id === i.id ? ' selected' : ''}`}
              onClick={() => select({ target: 'image', id: i.id, name })}
            >
              <span className="ctr-main">
                <span className="ctr-name">{i.tags.length ? i.tags.join(', ') : <span className="muted">&lt;none&gt;</span>}</span>
                <span className="ctr-sub">{shortId(i.id)}</span>
              </span>
              <span className="ctr-status">
                {formatBytes(i.size)}
                {i.created ? ` · ${relativeTime(i.created)}` : ''}
                {i.containers ? ` · ${i.containers} container${i.containers > 1 ? 's' : ''}` : ''}
              </span>
              <span className="ctr-actions" onClick={(e) => e.stopPropagation()}>
                <IconAction title="Run a container from this image" onClick={() => void run(i.tags[0] ?? i.id)}>
                  ▶
                </IconAction>
                <IconAction title="Remove" danger onClick={() => void remove('image', i.id, name)}>
                  <TrashIcon />
                </IconAction>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const volumeList = (items: VolumeInfo[]): React.JSX.Element => {
    if (!items.length) return empty('volumes')
    return (
      <div className="ctr-list" role="list">
        {items.map((v) => (
          <div
            key={v.name}
            role="listitem"
            className={`ctr-row${selected?.id === v.name ? ' selected' : ''}`}
            onClick={() => select({ target: 'volume', id: v.name, name: v.name })}
          >
            <span className="ctr-main">
              <span className="ctr-name">{v.name}</span>
              <span className="ctr-sub">{v.mountpoint}</span>
            </span>
            <span className="ctr-status">{v.driver}</span>
            <span className="ctr-actions" onClick={(e) => e.stopPropagation()}>
              <IconAction title="Remove" danger onClick={() => void remove('volume', v.name, v.name)}>
                <TrashIcon />
              </IconAction>
            </span>
          </div>
        ))}
      </div>
    )
  }

  const networkList = (items: NetworkInfo[]): React.JSX.Element => {
    if (!items.length) return empty('networks')
    const builtIn = new Set(['bridge', 'host', 'none', 'podman'])
    return (
      <div className="ctr-list" role="list">
        {items.map((n) => (
          <div
            key={n.id}
            role="listitem"
            className={`ctr-row${selected?.id === n.id ? ' selected' : ''}`}
            onClick={() => select({ target: 'network', id: n.id, name: n.name })}
          >
            <span className="ctr-main">
              <span className="ctr-name">{n.name}</span>
              <span className="ctr-sub">{shortId(n.id)}</span>
            </span>
            <span className="ctr-status">
              {n.driver}
              {n.scope ? ` · ${n.scope}` : ''}
            </span>
            <span className="ctr-actions" onClick={(e) => e.stopPropagation()}>
              {!builtIn.has(n.name) && (
                <IconAction title="Remove" danger onClick={() => void remove('network', n.id, n.name)}>
                  <TrashIcon />
                </IconAction>
              )}
            </span>
          </div>
        ))}
      </div>
    )
  }

  const composeList = (items: ComposeProject[]): React.JSX.Element => {
    if (!items.length)
      return <div className="pane-message">{q ? 'Nothing matches the filter.' : 'No Compose project has containers. Use “Compose up a folder…”.'}</div>
    return (
      <div className="ctr-list" role="list">
        {items.map((p) => {
          const up = p.services.filter((s) => s.state === 'running').length
          return (
            <div key={p.name} role="listitem" className="ctr-row compose">
              <span className={`ctr-state ${up === p.services.length ? 'st-running' : up ? 'st-paused' : 'st-exited'}`} />
              <span className="ctr-main">
                <span className="ctr-name">{p.name}</span>
                <span className="ctr-sub">
                  {p.services.map((s) => (
                    <span key={s.container} className={`ctr-chip${s.state === 'running' ? ' on' : ''}`} title={`${s.container}: ${s.state}`}>
                      {s.name}
                    </span>
                  ))}
                </span>
              </span>
              <span className="ctr-status">
                {up} / {p.services.length} running
              </span>
              <span className="ctr-actions visible">
                <button className="tool-button" onClick={() => void compose(p, 'up')} title="docker compose up -d">
                  Up
                </button>
                <button className="tool-button" onClick={() => void compose(p, 'restart')}>
                  Restart
                </button>
                <button className="tool-button" onClick={() => void compose(p, 'stop')}>
                  Stop
                </button>
                <button className="tool-button" onClick={() => void compose(p, 'pull')}>
                  Pull
                </button>
                <button className="tool-button" onClick={() => void compose(p, 'down')}>
                  Down
                </button>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const tools = (): React.ReactNode => {
    switch (view) {
      case 'containers':
        return (
          <button className="tool-button" onClick={() => void prune('container', 'all stopped containers')}>
            Prune stopped
          </button>
        )
      case 'images':
        return (
          <>
            <button className="tool-button" onClick={() => void pull()}>
              Pull…
            </button>
            <button className="tool-button" onClick={() => void build()}>
              Build…
            </button>
            <button className="tool-button" onClick={() => void prune('image', 'unused images')}>
              Prune
            </button>
          </>
        )
      case 'volumes':
        return (
          <>
            <button className="tool-button" onClick={() => void create('volume')}>
              New volume…
            </button>
            <button className="tool-button" onClick={() => void prune('volume', 'unused volumes')}>
              Prune
            </button>
          </>
        )
      case 'networks':
        return (
          <>
            <button className="tool-button" onClick={() => void create('network')}>
              New network…
            </button>
            <button className="tool-button" onClick={() => void prune('network', 'unused networks')}>
              Prune
            </button>
          </>
        )
      case 'compose':
        return (
          <button className="tool-button" onClick={() => void composeFolder()}>
            Compose up a folder…
          </button>
        )
    }
  }

  const bottomTabs: Bottom[] = [
    ...(selected?.target === 'container' ? (['logs', 'stats'] as Bottom[]) : []),
    ...(selected ? (['inspect'] as Bottom[]) : []),
    ...(job ? (['output'] as Bottom[]) : [])
  ]
  const shownBottom = bottom && bottomTabs.includes(bottom) ? bottom : undefined

  return (
    <div className="containers">
      <div className="pane-toolbar containers-toolbar">
        <div className="segmented containers-engines" role="tablist" aria-label="Container engine">
          {(backends ?? []).map((b) => (
            <button
              key={b.id}
              role="tab"
              aria-selected={b.id === backend}
              className={b.id === backend ? 'active' : ''}
              title={b.available ? `${b.label} ${b.detail ?? ''}` : (b.error ?? `${b.label} is not available`)}
              onClick={() => switchBackend(b.id)}
            >
              <span className={`engine-dot${b.available ? ' on' : ''}`} />
              {b.label}
            </button>
          ))}
        </div>
        {info?.available && <span className="muted containers-detail">{info.detail}</span>}
        <span className="spacer" />
        {busy && <span className="muted busy">{busy}…</span>}
        {info?.available && (
          <button className="tool-button" onClick={() => void login()} title="Log in to a registry (Docker Hub, ghcr.io…)">
            Registry login…
          </button>
        )}
        <button
          className="icon-button"
          title="Refresh"
          onClick={() => {
            void loadBackends()
            void load()
          }}
        >
          ⟳
        </button>
      </div>
      {info?.available && (
        <div className="pane-toolbar containers-views">
          <div className="segmented" role="tablist">
            {views.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)}>
                {v.label}
                {view === v.id && data?.ok && <span className="count">{countOf(data, v.id)}</span>}
              </button>
            ))}
          </div>
          <input className="containers-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="spacer" />
          {tools()}
        </div>
      )}
      <div className="containers-body">{content()}</div>
      {bottomTabs.length > 0 && (
        <div className={`containers-bottom${shownBottom ? ' open' : ''}`}>
          {shownBottom && (
            <div className="containers-bottom-content">
              {shownBottom === 'logs' && selected && <LogsView key={selected.id} backend={backend} id={selected.id} />}
              {shownBottom === 'stats' && selected && <StatsView key={selected.id} backend={backend} id={selected.id} running={!!selected.running} />}
              {shownBottom === 'inspect' && selected && <InspectView key={selected.id} backend={backend} target={selected.target} id={selected.id} />}
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
          <div className="pane-toolbar containers-bottom-bar">
            <div className="segmented" role="tablist">
              {bottomTabs.map((b) => (
                <button
                  key={b}
                  role="tab"
                  aria-selected={shownBottom === b}
                  className={shownBottom === b ? 'active' : ''}
                  onClick={() => setBottom(shownBottom === b ? undefined : b)}
                >
                  {b === 'logs' ? 'Logs' : b === 'stats' ? 'Stats' : b === 'inspect' ? 'Inspect' : 'Output'}
                </button>
              ))}
            </div>
            {selected && <span className="muted">{selected.name}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

const countOf = (d: ContainerListResult, kind: ContainerListKind): number =>
  ({ containers: d.containers, images: d.images, volumes: d.volumes, networks: d.networks, compose: d.compose })[kind]?.length ?? 0

/** An outline trash can (the emoji renders as a red block on Windows). */
function TrashIcon(): React.JSX.Element {
  return (
    <svg className="ctr-trash" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.6a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-8.6M7 7v4.5M9 7v4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconAction({
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
    <button className={`icon-button ctr-action${danger ? ' danger' : ''}`} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  )
}

/** A <pre> that follows new output unless scrolled up. */
function AutoScrollPre({ text, className = '' }: { text: string; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <pre
      ref={ref}
      className={`ctr-pre selectable ${className}`}
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
