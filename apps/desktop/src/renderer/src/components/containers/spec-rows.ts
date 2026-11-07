import type { ContainerMount, ContainerPortBinding } from '@shared/types'

/** The rows of a container's Environment / Volumes / Ports editors, and their checks (pure: tested). */

export interface EnvRow {
  key: string
  value: string
}

/** Names whose values are masked (shown on demand). */
export const SECRET = /pass|secret|token|key|credential|auth/i

/** KEY=VALUE entries as editable rows (a value may contain "="). */
export const envRows = (env: string[]): EnvRow[] =>
  env.map((e) => {
    const i = e.indexOf('=')
    return i < 0 ? { key: e, value: '' } : { key: e.slice(0, i), value: e.slice(i + 1) }
  })

/** Rows as KEY=VALUE entries (rows without a name dropped). */
export const envList = (rows: EnvRow[]): string[] => rows.filter((r) => r.key.trim()).map((r) => `${r.key.trim()}=${r.value}`)

/** What is wrong with the variables, if anything. */
export function validateEnv(rows: EnvRow[]): string | undefined {
  const bad = rows.find((r) => r.key.trim() && /[\s=]/.test(r.key.trim()))
  if (bad) return `Invalid name: ${bad.key}`
  const keys = envList(rows).map((e) => e.split('=')[0])
  const dup = keys.find((k, i) => keys.indexOf(k) !== i)
  return dup ? `${dup} is set twice.` : undefined
}

/** What is wrong with the mounts, if anything. */
export function validateMounts(rows: ContainerMount[]): string | undefined {
  const bad = rows.find((r) => !r.target.trim().startsWith('/'))
  if (bad) return `The path in the container must start with "/"${bad.target ? `: ${bad.target}` : ''}.`
  const missing = rows.find((r) => r.type !== 'tmpfs' && !r.source.trim())
  if (missing) return `${missing.type === 'bind' ? 'A host folder' : 'A volume'} is needed for ${missing.target || 'each mount'}.`
  const targets = rows.map((r) => r.target.trim())
  const dup = targets.find((t, i) => targets.indexOf(t) !== i)
  return dup ? `${dup} is mounted twice.` : undefined
}

/** What is wrong with the published ports, if anything. */
export function validatePorts(rows: ContainerPortBinding[]): string | undefined {
  if (rows.some((p) => !Number.isInteger(p.container) || p.container < 1 || p.container > 65535)) return 'Each port needs a container port (1-65535).'
  const host = rows.find((p) => p.hostPort && !/^\d{1,5}(-\d{1,5})?$/.test(p.hostPort))
  if (host) return `Invalid host port: ${host.hostPort}`
  const published = rows.filter((p) => p.hostPort)
  const dup = published.find((p, i) => published.findIndex((q) => q.hostIp === p.hostIp && q.hostPort === p.hostPort && q.protocol === p.protocol) !== i)
  return dup ? `Host port ${dup.hostPort}/${dup.protocol} is used twice.` : undefined
}

/** Same rows (as the engine would get them). */
export const sameRows = <T>(a: T[], b: T[]): boolean => JSON.stringify(a) === JSON.stringify(b)
