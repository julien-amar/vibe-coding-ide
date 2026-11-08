import { useEffect, useState } from 'react'
import type { ContainerBackendId, ContainerMount, ContainerPortBinding, ContainerSpec } from '@shared/types'
import { confirmDialog, notify } from '../Dialogs'
import { ICONS } from './icons'
import { ENGINE_LABEL } from './model'
import { IconButton } from './ui'
import { SECRET, envList, envRows, sameRows, validateEnv, validateMounts, validatePorts, type EnvRow } from './spec-rows'
import { Spinner } from '../Spinner'

// ---------------------------------------------------------------------------
// A container's settings — environment, volumes (mounts), ports — edited in a draft; applying recreates
// the container (Docker, Podman: an engine cannot change them in place). wslc: read-only.

export type SpecSection = 'env' | 'mounts' | 'ports'

export interface SpecViewProps {
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
export function SpecEditor<T>(
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
  }, [backend, id]) // eslint-disable-line react-hooks/exhaustive-deps -- loaded once per container (fromSpec is the caller's mapping, a new function each render)

  if (error) return <div className="pane-message containers-error">{error}</div>
  if (!spec) return <Spinner />
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

// ---------- Environment ----------

export function EnvView(props: SpecViewProps): React.JSX.Element {
  const [shown, setShown] = useState<Set<number>>(new Set())
  return (
    <SpecEditor<EnvRow>
      {...props}
      section="env"
      title="Environment"
      addLabel="+ Add a variable"
      blank={() => ({ key: '', value: '' })}
      fromSpec={(s) => envRows(s.env)}
      toChange={(rows) => ({ env: envList(rows) })}
      same={(a, b) => sameRows(envList(a), envList(b))}
      validate={validateEnv}
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

export function MountsView(props: SpecViewProps): React.JSX.Element {
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
      same={sameRows}
      validate={validateMounts}
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

export function PortsView(props: SpecViewProps): React.JSX.Element {
  return (
    <SpecEditor<ContainerPortBinding>
      {...props}
      section="ports"
      title="Ports"
      addLabel="+ Publish a port"
      blank={() => ({ container: 0, protocol: 'tcp', hostPort: '', hostIp: '' })}
      fromSpec={(s) => s.ports}
      toChange={(rows) => ({ ports: rows })}
      same={sameRows}
      validate={validatePorts}
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
