import type { ProfileKind } from '@shared/types'

const LABELS: Record<ProfileKind, string> = { shell: '>_', wsl: 'WSL', agent: 'AI' }

export function KindBadge({ kind }: { kind: ProfileKind }): React.JSX.Element {
  return <span className={`kind-badge ${kind}`}>{LABELS[kind]}</span>
}
