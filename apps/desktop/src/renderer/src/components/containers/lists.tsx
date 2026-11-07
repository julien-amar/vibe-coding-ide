import type {
  ComposeProject,
  ContainerBackendId,
  ContainerBackendInfo,
  ContainerInfo,
  ContainerTarget,
  ImageInfo,
  NetworkInfo,
  VolumeInfo
} from '@shared/types'
import { ICONS } from './icons'
import { formatBytes, parseHumanSize, shortId, timeOf, type Selection, type Tagged } from './model'
import { ResourceTable, type Column, type SortState } from './table'
import { EngineChip, IconButton, When } from './ui'

/** The Containers tab's five lists: containers, images, volumes, networks, Compose projects. */

/** What the rows' buttons do (the view's actions). */
export interface ListActions {
  containerAction: (c: Tagged<ContainerInfo>, action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause', label: string) => void
  shell: (c: Tagged<ContainerInfo>) => void
  remove: (engine: ContainerBackendId, target: ContainerTarget, id: string, name: string) => void
  run: (engine: ContainerBackendId, image: string) => void
  compose: (p: Tagged<ComposeProject>, action: 'up' | 'down' | 'restart' | 'pull' | 'stop') => void
}

/** What every list gets from the view. */
export interface ListProps<T> {
  items: Tagged<T>[]
  /** A filter is typed (an empty list says "nothing matches"). */
  filtered: boolean
  sort: SortState | undefined
  onSort: (s: SortState | undefined) => void
  selected: Selection | undefined
  onSelect: (s: Selection) => void
  actions: ListActions
}

function Empty({ filtered, what }: { filtered: boolean; what: string }): React.JSX.Element {
  return <div className="pane-message">{filtered ? 'Nothing matches the filter.' : what}</div>
}

const engineColumn = <T extends { engine: ContainerBackendId }>(): Column<T> => ({
  key: 'engine',
  label: 'Engine',
  width: '76px',
  cell: (x) => <EngineChip engine={x.engine} />,
  sort: (x) => x.engine
})

/** Running, paused or restarting: shown when stopped containers are not. */
export const isActive = (c: ContainerInfo): boolean => ['running', 'paused', 'restarting'].includes(c.state)

// ---------- Containers ----------

const CONTAINER_COLUMNS: Column<Tagged<ContainerInfo>>[] = [
  { key: 'state', label: '', width: '14px', cell: (c) => <span className={`ctr-state st-${c.state}`} title={c.state} /> },
  { key: 'name', label: 'Name', width: 'minmax(130px, 1.3fr)', className: 'ctr-name', cell: (c) => <span title={c.id}>{c.name}</span>, sort: (c) => c.name },
  engineColumn(),
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
  { key: 'ports', label: 'Ports', width: 'minmax(70px, 0.7fr)', className: 'ctr-ports', cell: (c) => <PortLinks c={c} /> },
  {
    key: 'status',
    label: 'Status',
    width: 'minmax(110px, 1fr)',
    className: 'ctr-ellipsis muted',
    cell: (c) => c.status,
    sort: (c) => `${c.state === 'running' ? 0 : 1}${c.status}`
  }
]

/** A container's published ports, each opening http://localhost:<port>. */
function PortLinks({ c }: { c: ContainerInfo }): React.JSX.Element {
  return (
    <>
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
    </>
  )
}

/** A container row's buttons: start / stop / restart / pause / resume / shell / remove. */
function ContainerButtons({ c, pausable, actions }: { c: Tagged<ContainerInfo>; pausable: boolean; actions: ListActions }): React.JSX.Element {
  const running = c.state === 'running'
  const paused = c.state === 'paused'
  return (
    <>
      {!running && !paused && (
        <IconButton title="Start" onClick={() => actions.containerAction(c, 'start', 'Starting')}>
          {ICONS.start}
        </IconButton>
      )}
      {running && (
        <IconButton title="Stop" onClick={() => actions.containerAction(c, 'stop', 'Stopping')}>
          {ICONS.stop}
        </IconButton>
      )}
      {(running || paused) && (
        <IconButton title="Restart" onClick={() => actions.containerAction(c, 'restart', 'Restarting')}>
          {ICONS.restart}
        </IconButton>
      )}
      {pausable && running && (
        <IconButton title="Pause" onClick={() => actions.containerAction(c, 'pause', 'Pausing')}>
          {ICONS.pause}
        </IconButton>
      )}
      {paused && (
        <IconButton title="Resume" onClick={() => actions.containerAction(c, 'unpause', 'Resuming')}>
          {ICONS.start}
        </IconButton>
      )}
      {running && (
        <IconButton title="Open a shell in the container (new tab)" onClick={() => actions.shell(c)}>
          {ICONS.shell}
        </IconButton>
      )}
      <IconButton title="Remove" danger onClick={() => actions.remove(c.engine, 'container', c.id, c.name)}>
        {ICONS.trash}
      </IconButton>
    </>
  )
}

export function ContainerList({
  engines,
  showStopped,
  onShowStopped,
  ...p
}: ListProps<ContainerInfo> & { engines: ContainerBackendInfo[]; showStopped: boolean; onShowStopped: (on: boolean) => void }): React.JSX.Element {
  if (!p.items.length) return <Empty filtered={p.filtered} what="No containers." />
  const pausable = new Set(engines.filter((e) => e.features.pause).map((e) => e.id))
  return (
    <ResourceTable
      {...p}
      label="Containers"
      columns={CONTAINER_COLUMNS}
      rows={showStopped ? p.items : p.items.filter(isActive)}
      rowKey={(c) => `${c.engine}:${c.id}`}
      selection={(c) => ({ engine: c.engine, target: 'container', id: c.id, name: c.name, running: c.state === 'running' })}
      actionsWidth={176}
      headerExtra={
        <label className="ctr-show-stopped" title="List stopped containers too">
          <input type="checkbox" checked={showStopped} onChange={(e) => onShowStopped(e.target.checked)} />
          Show stopped
        </label>
      }
      actions={(c) => <ContainerButtons c={c} pausable={pausable.has(c.engine)} actions={p.actions} />}
    />
  )
}

// ---------- Images ----------

const imageName = (i: ImageInfo): string => i.tags[0] ?? shortId(i.id)

const IMAGE_COLUMNS: Column<Tagged<ImageInfo>>[] = [
  {
    key: 'name',
    label: 'Repository:tag',
    width: 'minmax(160px, 2fr)',
    className: 'ctr-name',
    cell: (i) => (i.tags.length ? <span title={i.tags.join('\n')}>{i.tags.join(', ')}</span> : <span className="muted">&lt;none&gt;</span>),
    sort: (i) => i.tags[0] ?? '~'
  },
  engineColumn(),
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
]

export function ImageList(p: ListProps<ImageInfo>): React.JSX.Element {
  if (!p.items.length) return <Empty filtered={p.filtered} what="No images." />
  return (
    <ResourceTable
      {...p}
      label="Images"
      columns={IMAGE_COLUMNS}
      rows={p.items}
      rowKey={(i) => `${i.engine}:${i.id}`}
      selection={(i) => ({ engine: i.engine, target: 'image', id: i.id, name: imageName(i) })}
      actionsWidth={64}
      actions={(i) => (
        <>
          <IconButton title="Run a container from this image" onClick={() => p.actions.run(i.engine, i.tags[0] ?? i.id)}>
            {ICONS.start}
          </IconButton>
          <IconButton title="Remove" danger onClick={() => p.actions.remove(i.engine, 'image', i.id, imageName(i))}>
            {ICONS.trash}
          </IconButton>
        </>
      )}
    />
  )
}

// ---------- Volumes ----------

const VOLUME_COLUMNS: Column<Tagged<VolumeInfo>>[] = [
  { key: 'name', label: 'Name', width: 'minmax(140px, 1.3fr)', className: 'ctr-name', cell: (v) => <span title={v.name}>{v.name}</span>, sort: (v) => v.name },
  engineColumn(),
  { key: 'driver', label: 'Driver', width: '80px', cell: (v) => v.driver, sort: (v) => v.driver },
  {
    key: 'mountpoint',
    label: 'Mount point',
    width: 'minmax(140px, 2fr)',
    className: 'ctr-mono ctr-ellipsis muted',
    cell: (v) => <span title={v.mountpoint}>{v.mountpoint}</span>,
    sort: (v) => v.mountpoint ?? ''
  }
]

export function VolumeList(p: ListProps<VolumeInfo>): React.JSX.Element {
  if (!p.items.length) return <Empty filtered={p.filtered} what="No volumes." />
  return (
    <ResourceTable
      {...p}
      label="Volumes"
      columns={VOLUME_COLUMNS}
      rows={p.items}
      rowKey={(v) => `${v.engine}:${v.name}`}
      selection={(v) => ({ engine: v.engine, target: 'volume', id: v.name, name: v.name })}
      actionsWidth={36}
      actions={(v) => (
        <IconButton title="Remove" danger onClick={() => p.actions.remove(v.engine, 'volume', v.name, v.name)}>
          {ICONS.trash}
        </IconButton>
      )}
    />
  )
}

// ---------- Networks ----------

/** The engines' own networks: they cannot be removed. */
export const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none', 'podman'])

const NETWORK_COLUMNS: Column<Tagged<NetworkInfo>>[] = [
  { key: 'name', label: 'Name', width: 'minmax(140px, 1.5fr)', className: 'ctr-name', cell: (n) => n.name, sort: (n) => n.name },
  engineColumn(),
  { key: 'id', label: 'Network ID', width: '110px', className: 'ctr-mono muted', cell: (n) => shortId(n.id), sort: (n) => n.id },
  { key: 'driver', label: 'Driver', width: '90px', cell: (n) => n.driver, sort: (n) => n.driver },
  { key: 'scope', label: 'Scope', width: '80px', className: 'muted', cell: (n) => n.scope ?? '', sort: (n) => n.scope ?? '' },
  { key: 'created', label: 'Created', width: '96px', className: 'muted', cell: (n) => <When value={n.created} />, sort: (n) => timeOf(n.created) }
]

export function NetworkList(p: ListProps<NetworkInfo>): React.JSX.Element {
  if (!p.items.length) return <Empty filtered={p.filtered} what="No networks." />
  return (
    <ResourceTable
      {...p}
      label="Networks"
      columns={NETWORK_COLUMNS}
      rows={p.items}
      rowKey={(n) => `${n.engine}:${n.id}`}
      selection={(n) => ({ engine: n.engine, target: 'network', id: n.id, name: n.name })}
      actionsWidth={36}
      actions={(n) =>
        !BUILT_IN_NETWORKS.has(n.name) && (
          <IconButton title="Remove" danger onClick={() => p.actions.remove(n.engine, 'network', n.id, n.name)}>
            {ICONS.trash}
          </IconButton>
        )
      }
    />
  )
}

// ---------- Compose ----------

/** Running services of a project. */
export const runningServices = (p: ComposeProject): number => p.services.filter((s) => s.state === 'running').length

const COMPOSE_COLUMNS: Column<Tagged<ComposeProject>>[] = [
  {
    key: 'state',
    label: '',
    width: '14px',
    cell: (p) => {
      const up = runningServices(p)
      return <span className={`ctr-state ${up === p.services.length ? 'st-running' : up ? 'st-paused' : 'st-exited'}`} />
    }
  },
  { key: 'name', label: 'Project', width: 'minmax(110px, 1fr)', className: 'ctr-name', cell: (p) => p.name, sort: (p) => p.name },
  engineColumn(),
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
  {
    key: 'running',
    label: 'Running',
    width: '96px',
    className: 'muted',
    cell: (p) => `${runningServices(p)} / ${p.services.length} running`,
    sort: runningServices
  },
  {
    key: 'folder',
    label: 'Folder',
    width: 'minmax(120px, 1.4fr)',
    className: 'ctr-mono ctr-ellipsis muted',
    cell: (p) => <span title={p.workingDir}>{p.workingDir}</span>,
    sort: (p) => p.workingDir ?? ''
  }
]

export function ComposeList(p: ListProps<ComposeProject>): React.JSX.Element {
  if (!p.items.length) return <Empty filtered={p.filtered} what="No Compose project has containers: compose up a folder (toolbar)." />
  const { compose } = p.actions
  return (
    <ResourceTable
      {...p}
      label="Compose projects"
      columns={COMPOSE_COLUMNS}
      rows={p.items}
      rowKey={(c) => `${c.engine}:${c.name}`}
      actionsWidth={150}
      actionsVisible
      actions={(c) => (
        <>
          <IconButton title="Up (start or update the services)" onClick={() => compose(c, 'up')}>
            {ICONS.start}
          </IconButton>
          <IconButton title="Restart" onClick={() => compose(c, 'restart')}>
            {ICONS.restart}
          </IconButton>
          <IconButton title="Stop" onClick={() => compose(c, 'stop')}>
            {ICONS.stop}
          </IconButton>
          <IconButton title="Pull the services' images" onClick={() => compose(c, 'pull')}>
            {ICONS.pull}
          </IconButton>
          <IconButton title="Down (remove the containers and networks)" danger onClick={() => compose(c, 'down')}>
            {ICONS.down}
          </IconButton>
        </>
      )}
    />
  )
}
