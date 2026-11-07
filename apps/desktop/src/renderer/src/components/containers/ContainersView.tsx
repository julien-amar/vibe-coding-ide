import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  ComposeProject,
  ContainerBackendId,
  ContainerBackendInfo,
  ContainerInfo,
  ContainerJob,
  ContainerListKind,
  ContainerListResult,
  ContainersPrefs,
  ContainerTarget,
  ImageInfo,
  NetworkInfo,
  VolumeInfo
} from '@shared/types'
import { useTabs, type Tab } from '../../store'
import { confirmDialog, notify, openDialog } from '../Dialogs'
import { ICONS } from './icons'
import {
  BOTTOM_LABEL,
  ENGINE_LABEL,
  VIEWS,
  bottomTabs,
  composeProjectName,
  keepTail,
  matches,
  splitList,
  viewAfterSelect,
  type Bottom,
  type Job,
  type Selection,
  type Tagged
} from './model'
import { IconButton } from './ui'
import { DEFAULT_CONTAINERS_PREFS } from '@shared/settings-defaults'
import { ComposeList, ContainerList, ImageList, NetworkList, VolumeList } from './lists'
import { type SortState } from './table'
import { AutoScrollPre, InspectView, LogsView } from './streams'
import { StatsView } from './StatsView'
import { ContainerTerminal } from './ContainerTerminal'
import { FilesView } from './FilesView'
import { EnvView, MountsView, PortsView, type SpecViewProps } from './SpecViews'
import { PullDialog } from './PullDialog'
import { VolumeDialog } from './VolumeDialog'
import { ContainersSettings } from './ContainersSettings'

/**
 * The Containers tab: one view of every engine that runs — Docker, Podman (Engine API) and wslc (its
 * CLI) — with containers, images, volumes, networks and Compose projects tagged by engine; logs,
 * live stats, inspect; pull, build, run, Compose with live output. The status bar shows which
 * engines answer; ⚙ holds the tab's options and registry logins.
 */
export function ContainersView({ visible }: { tab: Tab; visible: boolean }): React.JSX.Element {
  const [backends, setBackends] = useState<ContainerBackendInfo[] | null>(null)
  const [prefs, setPrefs] = useState<ContainersPrefs>(DEFAULT_CONTAINERS_PREFS)
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
  const [sort, setSort] = useState<SortState>()
  /** The container whose in-place terminal is open (engine:id). */
  const [termKey, setTermKey] = useState<string>()

  const loadBackends = useCallback(async () => {
    setBackends(await window.ide.containers.backends())
  }, [])
  useEffect(() => {
    void loadBackends()
    void window.ide.settings.get().then((s) => setPrefs(s.containers ?? DEFAULT_CONTAINERS_PREFS))
    return window.ide.settings.onChanged((s: AppSettings) => setPrefs(s.containers ?? DEFAULT_CONTAINERS_PREFS))
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
  }, [view, engineKey]) // eslint-disable-line react-hooks/exhaustive-deps -- another view or set of engines: reset, then load once (load changes with them)

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
    const buildArgs = splitList(r.args, /\r?\n/)
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
    await startJob(engine, `Run ${image}`, {
      kind: 'run',
      image,
      name: String(r.name),
      ports: splitList(r.ports, /,/),
      volumes: splitList(r.volumes, /,/),
      env: splitList(r.env, /\r?\n/),
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
    const name = composeProjectName(dir)
    await startJob(engine, `Compose up ${name}`, { kind: 'compose', project: name, action: 'up', configFiles: [], workingDir: dir })
  }

  // ---------- Lists ----------

  const q = filter.trim().toLowerCase()
  const select = (s: Selection): void => {
    setSelected(s)
    setBottom((b) => viewAfterSelect(s, b))
  }
  const listProps = {
    filtered: !!q,
    sort,
    onSort: setSort,
    selected,
    onSelect: select,
    actions: {
      containerAction,
      shell: (c: Tagged<ContainerInfo>) => void shell(c),
      remove: (...a: Parameters<typeof remove>) => void remove(...a),
      run: (...a: Parameters<typeof run>) => void run(...a),
      compose: (...a: Parameters<typeof compose>) => void compose(...a)
    }
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
          return (
            <ContainerList
              {...listProps}
              items={items.containers.filter((c) => matches(q, c.name, c.image, c.id))}
              engines={engines}
              showStopped={showStopped}
              onShowStopped={toggleStopped}
            />
          )
        case 'images':
          return <ImageList {...listProps} items={items.images.filter((i) => matches(q, i.id, ...i.tags))} />
        case 'volumes':
          return <VolumeList {...listProps} items={items.volumes.filter((v) => matches(q, v.name, v.driver))} />
        case 'networks':
          return <NetworkList {...listProps} items={items.networks.filter((n) => matches(q, n.name, n.driver))} />
        case 'compose':
          return <ComposeList {...listProps} items={items.compose.filter((p) => matches(q, p.name, p.workingDir))} />
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

  const tabs = bottomTabs(selected, !!job)
  const shownBottom = bottom && tabs.includes(bottom) ? bottom : undefined
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
  const terminalAlive = !!selKey && termKey === selKey && tabs.includes('terminal')
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
        {tabs.length > 0 && (
          <div className="segmented" role="tablist">
            {tabs.map((b) => (
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
