import { useEffect, useState } from 'react'
import type { ContainerBackendId, ContainerFileEntry } from '@shared/types'
import { relativeTime } from '../../time'
import { notify } from '../Dialogs'
import { ICONS } from './icons'
import { formatBytes } from './model'
import { IconButton } from './ui'

// ---------------------------------------------------------------------------
// Files: browse the selected (running) container's file system; preview and save files

export interface FilePreview {
  path: string
  text?: string
  binary?: boolean
  truncated?: boolean
  error?: string
}

export function FilesView({ backend, id }: { backend: ContainerBackendId; id: string }): React.JSX.Element {
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
