import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContainerBackendId, ContainerTarget } from '@shared/types'
import { keepTail } from './model'
import { useLatest } from '../../use-latest'
import { Spinner } from '../Spinner'

/** Logs and inspect of the selection; the auto-scrolling output and the stream hook the details share. */
// ---------------------------------------------------------------------------
// Details of the selection: logs, stats, inspect

/** A <pre> that follows new output unless scrolled up. */
export function AutoScrollPre({ text }: { text: string }): React.JSX.Element {
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
export function useStream(start: () => Promise<string>, onEvent: (e: Parameters<Parameters<typeof window.ide.containers.onStream>[0]>[0]) => void): void {
  const handler = useLatest(onEvent)
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- one stream per mount (the view is keyed by its container); events reach the latest handler
}

export function LogsView({ backend, id }: { backend: ContainerBackendId; id: string }): React.JSX.Element {
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
      {/* Until the first lines arrive (and with a search typed, the matches: possibly none). */}
      {text || ended ? <AutoScrollPre text={shown} /> : <Spinner label="Waiting for logs" />}
    </div>
  )
}

export function InspectView({ backend, target, id }: { backend: ContainerBackendId; target: ContainerTarget; id: string }): React.JSX.Element {
  const [text, setText] = useState<string>()
  useEffect(() => {
    let alive = true
    void window.ide.containers.inspect(backend, target, id).then((r) => alive && setText(r.ok ? r.text : r.error))
    return () => {
      alive = false
    }
  }, [backend, target, id])
  return text === undefined ? <Spinner /> : <pre className="ctr-pre selectable">{text}</pre>
}
