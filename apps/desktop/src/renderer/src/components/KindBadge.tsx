import type { TabKind } from '@shared/types'

const LABELS: Record<TabKind, string> = { shell: '>_', wsl: 'WSL', agent: 'AI', tool: '⎈', project: 'PRJ', containers: '' }

export function KindBadge({ kind }: { kind: TabKind }): React.JSX.Element {
  if (kind === 'containers') return <ContainersIcon />
  return <span className={`kind-badge ${kind}`}>{LABELS[kind]}</span>
}

/** Containers: stacked boxes. */
export function ContainersIcon({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="containers-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="8.5" width="6" height="5.5" rx="1" />
      <rect x="8.5" y="8.5" width="6" height="5.5" rx="1" />
      <rect x="5" y="2" width="6" height="5.5" rx="1" />
    </svg>
  )
}
