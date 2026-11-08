import { useState } from 'react'
import type { ContainerBackendId, ContainerStats } from '@shared/types'
import { formatBytes } from './model'
import { useStream } from './streams'
import { Spinner } from '../Spinner'

/** A container's live stats: CPU and memory with graphs, network, block I/O, processes. */
export function StatsView({ backend, id, running }: { backend: ContainerBackendId; id: string; running: boolean }): React.JSX.Element {
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
  if (!last) return ended ? <div className="pane-message">{ended}</div> : <Spinner label="Waiting for the first sample" />
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

export function StatCard({
  label,
  value,
  sub,
  values,
  max
}: {
  label: string
  value: string
  sub?: string
  values?: number[]
  max?: number
}): React.JSX.Element {
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
