import type { ContainerBackendId } from '@shared/types'
import { relativeTime } from '../../time'
import { ENGINE_LABEL, timeOf } from './model'

/** Small pieces the Containers tab's views share. */

/** An icon-only button (its title is the tooltip and the accessible name). */
export function IconButton({
  title,
  onClick,
  danger,
  children
}: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button className={`icon-button ctr-action${danger ? ' ctr-danger' : ''}`} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  )
}

/** A tiny chip naming a row's engine (Docker, Podman, wslc). */
export function EngineChip({ engine }: { engine: ContainerBackendId }): React.JSX.Element {
  return <span className={`ctr-engine e-${engine}`}>{ENGINE_LABEL[engine]}</span>
}

/** "2 days ago", the full date on hover. */
export function When({ value }: { value: number | string | undefined }): React.JSX.Element | null {
  const t = timeOf(value)
  if (!t) return null
  return <span title={new Date(t * 1000).toLocaleString()}>{relativeTime(t)}</span>
}
