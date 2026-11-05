import type { TabKind } from '@shared/types'

const LABELS: Record<TabKind, string> = { shell: '>_', wsl: 'WSL', agent: 'AI', project: 'PRJ' }

export function KindBadge({ kind }: { kind: TabKind }): React.JSX.Element {
  return <span className={`kind-badge ${kind}`}>{LABELS[kind]}</span>
}
