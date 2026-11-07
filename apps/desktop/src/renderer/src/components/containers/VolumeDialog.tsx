import { useEffect, useRef, useState } from 'react'
import type { ContainerBackendId, ContainerBackendInfo, CreateOptions } from '@shared/types'
import { Modal } from '../Modal'
import { VOLUME_KINDS, pairs, volumeSettings, type VolumeKind } from './volume-settings'

// New volume: name, engine, type (local, NFS, SMB, host folder, in memory, another driver), labels
export function VolumeDialog({
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

  return (
    <Modal
      label="New volume"
      className="dialog ctr-volume-dialog"
      onClose={onClose}
      onSubmit={() => {
        setTouched(true)
        if (error || !engine) return
        onCreate(engine, (f.name ?? '').trim(), { driver: settings.driver, options: settings.options, labels: labels.map })
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
    </Modal>
  )
}
