import type { ContainerMount, ContainerPortBinding, ContainerSpec } from '@shared/types'

/**
 * What can be edited on a container — environment, mounts, published ports — read from an inspect
 * (Engine API and wslc share its shape), and applied to a new container's create body (an engine
 * cannot change them in place: the container is recreated).
 */

type Inspect = Record<string, any>

const PROTOCOLS = new Set(['tcp', 'udp', 'sctp'])

/** The editable settings of an inspected container. */
export function specOf(c: Inspect): ContainerSpec {
  const mounts: ContainerMount[] = ((c.Mounts ?? []) as Inspect[]).map((m) => ({
    type: m.Type === 'bind' ? 'bind' : m.Type === 'tmpfs' ? 'tmpfs' : 'volume',
    source: m.Type === 'volume' ? String(m.Name ?? '') : m.Type === 'tmpfs' ? '' : String(m.Source ?? ''),
    target: String(m.Destination ?? ''),
    readOnly: m.RW === false
  }))
  for (const target of Object.keys((c.HostConfig?.Tmpfs ?? {}) as Record<string, string>)) {
    if (!mounts.some((m) => m.target === target)) mounts.push({ type: 'tmpfs', source: '', target, readOnly: false })
  }
  const ports: ContainerPortBinding[] = []
  const bindings = (c.HostConfig?.PortBindings ?? {}) as Record<string, { HostIp?: string; HostPort?: string }[] | null>
  for (const [key, list] of Object.entries(bindings)) {
    const [port, protocol = 'tcp'] = key.split('/')
    for (const b of list ?? [{}]) ports.push({ container: Number(port), protocol, hostPort: b.HostPort ?? '', hostIp: b.HostIp ?? '' })
  }
  const exposed = Object.keys((c.Config?.ExposedPorts ?? {}) as Record<string, unknown>).filter((k) => !bindings[k])
  return { env: (c.Config?.Env ?? []) as string[], mounts, ports, exposed }
}

/** Mounts from the renderer: a type, a source (volume name, host path; none for tmpfs), an absolute target. */
export function mountList(v: unknown): ContainerMount[] {
  if (!Array.isArray(v)) throw new Error('Invalid mounts')
  const targets = new Set<string>()
  return v.map((x: Record<string, unknown>) => {
    const type = x?.type
    if (type !== 'volume' && type !== 'bind' && type !== 'tmpfs') throw new Error('Invalid mount type')
    const source = String(x.source ?? '').trim()
    const target = String(x.target ?? '').trim()
    if (!target.startsWith('/') || /[\0\r\n,]/.test(target)) throw new Error(`Invalid path in the container: ${target || '(empty)'}`)
    if (type !== 'tmpfs' && (!source || /[\0\r\n]/.test(source))) throw new Error(`A ${type === 'bind' ? 'host path' : 'volume'} is needed for ${target}`)
    if (targets.has(target)) throw new Error(`${target} is mounted twice`)
    targets.add(target)
    return { type, source: type === 'tmpfs' ? '' : source, target, readOnly: !!x.readOnly }
  })
}

/** Published ports from the renderer: container port, protocol, host port (or range; empty: any), host IP. */
export function portList(v: unknown): ContainerPortBinding[] {
  if (!Array.isArray(v)) throw new Error('Invalid ports')
  const seen = new Set<string>()
  return v.map((x: Record<string, unknown>) => {
    const container = Number(x?.container)
    const protocol = String(x?.protocol ?? 'tcp')
    const hostPort = String(x?.hostPort ?? '').trim()
    const hostIp = String(x?.hostIp ?? '').trim()
    if (!Number.isInteger(container) || container < 1 || container > 65535) throw new Error(`Invalid container port: ${String(x?.container)}`)
    if (!PROTOCOLS.has(protocol)) throw new Error(`Invalid protocol: ${protocol}`)
    const range = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(hostPort)
    if (hostPort && (!range || Number(range[1]) < 1 || Number(range[1]) > 65535 || (range[2] && Number(range[2]) < Number(range[1])))) {
      throw new Error(`Invalid host port: ${hostPort}`)
    }
    if (hostIp && !/^[0-9a-fA-F.:]+$/.test(hostIp)) throw new Error(`Invalid host IP: ${hostIp}`)
    const key = `${hostIp}:${hostPort || '*'}:${container}/${protocol}`
    if (hostPort && seen.has(key)) throw new Error(`Port ${hostPort} is published twice`)
    seen.add(key)
    return { container, protocol, hostPort, hostIp }
  })
}

/**
 * The create body (container config, host config) of a container like `c` with `change` applied
 * (exported for tests). Unchanged parts are kept as they are; anonymous volumes are kept by name.
 */
export function recreateBody(c: Inspect, change: Partial<Pick<ContainerSpec, 'env' | 'mounts' | 'ports'>>): { config: Inspect; host: Inspect } {
  const oldId = String(c.Id ?? '')
  const config: Inspect = { ...c.Config }
  if (change.env) config.Env = change.env
  // A default host name (the old container's short id) is not kept.
  if (config.Hostname && oldId.startsWith(config.Hostname)) delete config.Hostname
  const host: Inspect = { ...c.HostConfig }

  if (change.mounts) {
    // Mounts: all given here, structured (no "source:target" parsing of Windows paths).
    host.Binds = []
    host.Tmpfs = undefined
    host.Mounts = change.mounts.map((m) => ({ Type: m.type, ...(m.type === 'tmpfs' ? {} : { Source: m.source }), Target: m.target, ReadOnly: m.readOnly }))
  } else {
    // Volumes the image declares (anonymous): kept, by name, at the same place.
    const taken = new Set<string | undefined>([
      ...((host.Binds ?? []) as string[]).map((b) => b.split(':')[1]),
      ...((host.Mounts ?? []) as { Target?: string }[]).map((m) => m.Target)
    ])
    const anonymous = ((c.Mounts ?? []) as Inspect[])
      .filter((m) => m.Type === 'volume' && m.Name && !taken.has(m.Destination))
      .map((m) => `${m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`)
    if (anonymous.length) host.Binds = [...(host.Binds ?? []), ...anonymous]
  }

  if (change.ports) {
    const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {}
    for (const p of change.ports) (bindings[`${p.container}/${p.protocol}`] ??= []).push({ HostIp: p.hostIp, HostPort: p.hostPort })
    host.PortBindings = bindings
    config.ExposedPorts = { ...(c.Config?.ExposedPorts ?? {}), ...Object.fromEntries(Object.keys(bindings).map((k) => [k, {}])) }
  }
  return { config, host }
}
