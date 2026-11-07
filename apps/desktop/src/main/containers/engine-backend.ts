import type {
  ContainerAction,
  CreateOptions,
  ImageSuggestion,
  ContainerBackendInfo,
  ContainerInfo,
  ContainerListKind,
  ContainerListResult,
  ContainerSpec,
  ContainerStats,
  ContainerTarget
} from '@shared/types'
import { which } from '../profiles'
import { composeOf, composeProjects, type ContainerBackend } from './backend'
import { call, candidates, demux, json, statsSample, stream, type Endpoint } from './engine'
import { recreateBody, specOf } from './spec'

const LABELS = { docker: 'Docker', podman: 'Podman' } as const
const enc = encodeURIComponent

/** Docker or Podman through the Docker Engine API. */
export class EngineBackend implements ContainerBackend {
  private endpoint: Endpoint | undefined
  constructor(readonly id: 'docker' | 'podman') {}

  /** The first endpoint that answers /_ping (remembered while it keeps answering). */
  private async connect(): Promise<Endpoint> {
    if (this.endpoint) {
      try {
        const r = await call(this.endpoint, 'GET', '/_ping', undefined, 1500)
        if (r.status < 400) return this.endpoint
      } catch {
        /* look again */
      }
      this.endpoint = undefined
    }
    let last = ''
    for (const ep of candidates(this.id)) {
      try {
        const r = await call(ep, 'GET', '/_ping', undefined, 1500)
        if (r.status < 400) return (this.endpoint = ep)
        last = `${ep.label}: ${r.status}`
      } catch (e) {
        last = (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? '' : (e as Error).message
      }
    }
    throw new Error(
      last ||
        `${LABELS[this.id]} is not running (no engine at ${candidates(this.id)
          .map((e) => e.label)
          .join(', ')}).`
    )
  }

  async info(): Promise<ContainerBackendInfo> {
    const base = { id: this.id, label: LABELS[this.id], features: { pause: true, compose: this.id === 'docker' || !!which('podman'), editSpec: true } }
    try {
      const ep = await this.connect()
      const v = await json<{ Version?: string; Components?: { Name?: string }[] }>(ep, 'GET', '/version', undefined, 3000)
      return { ...base, available: true, detail: `${v?.Version ?? ''} · ${ep.label}`.replace(/^ · /, '') }
    } catch (e) {
      return { ...base, available: false, error: (e as Error).message }
    }
  }

  async list(kind: ContainerListKind): Promise<ContainerListResult> {
    const ep = await this.connect()
    if (kind === 'containers' || kind === 'compose') {
      const raw = await json<Record<string, any>[]>(ep, 'GET', '/containers/json?all=1')
      const containers: ContainerInfo[] = raw.map((c) => ({
        id: c.Id,
        name: String(c.Names?.[0] ?? c.Id).replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        created: c.Created,
        ports: dedupePorts(
          (c.Ports ?? []).map((p: Record<string, any>) => ({ host: p.PublicPort, container: p.PrivatePort, protocol: p.Type ?? 'tcp', ip: p.IP }))
        ),
        compose: composeOf(c.Labels)
      }))
      return kind === 'containers' ? { ok: true, containers } : { ok: true, compose: composeProjects(containers) }
    }
    if (kind === 'images') {
      const raw = await json<Record<string, any>[]>(ep, 'GET', '/images/json')
      // Containers per image: the engine reports -1 (not computed) unless asked; counted from the containers.
      const used = new Map<string, number>()
      if (raw.some((i) => !(i.Containers >= 0))) {
        for (const c of await json<{ ImageID?: string }[]>(ep, 'GET', '/containers/json?all=1')) {
          if (c.ImageID) used.set(c.ImageID, (used.get(c.ImageID) ?? 0) + 1)
        }
      }
      return {
        ok: true,
        images: raw.map((i) => ({
          id: i.Id,
          tags: (i.RepoTags ?? []).filter((t: string) => t !== '<none>:<none>'),
          size: i.Size,
          created: i.Created,
          containers: i.Containers >= 0 ? i.Containers : (used.get(i.Id) ?? 0)
        }))
      }
    }
    if (kind === 'volumes') {
      const raw = await json<{ Volumes?: Record<string, any>[] }>(ep, 'GET', '/volumes')
      return { ok: true, volumes: (raw.Volumes ?? []).map((v) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, created: v.CreatedAt })) }
    }
    const raw = await json<Record<string, any>[]>(ep, 'GET', '/networks')
    return { ok: true, networks: raw.map((n) => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope, created: n.Created })) }
  }

  async action(target: ContainerTarget, id: string, action: ContainerAction): Promise<void> {
    const ep = await this.connect()
    if (target !== 'container') {
      if (action !== 'remove') throw new Error(`Cannot ${action} a ${target}.`)
      const path = { image: `/images/${enc(id)}`, volume: `/volumes/${enc(id)}`, network: `/networks/${enc(id)}` }[target]
      await json(ep, 'DELETE', path)
      return
    }
    if (action === 'remove') await json(ep, 'DELETE', `/containers/${enc(id)}?force=1`)
    else await json(ep, 'POST', `/containers/${enc(id)}/${action}`, undefined, 60_000)
  }

  async prune(target: ContainerTarget): Promise<string> {
    const ep = await this.connect()
    // Every unused image / volume, as the buttons say (by default: only dangling images, anonymous volumes).
    const filters = { image: { dangling: ['false'] }, volume: { all: ['true'] } }[target as 'image' | 'volume']
    const path = `/${target}s/prune`
    let r: Record<string, any>
    try {
      r = await json<Record<string, any>>(ep, 'POST', filters ? `${path}?filters=${enc(JSON.stringify(filters))}` : path, undefined, 120_000)
    } catch (err) {
      // Engines before Docker 23 (API 1.42) do not know the volumes' "all" filter: all their unused volumes go anyway.
      if (target !== 'volume') throw err
      r = await json<Record<string, any>>(ep, 'POST', path, undefined, 120_000)
    }
    const removed = r?.ContainersDeleted ?? r?.ImagesDeleted ?? r?.VolumesDeleted ?? r?.NetworksDeleted ?? []
    const space = r?.SpaceReclaimed ? `, ${formatBytes(r.SpaceReclaimed)} freed` : ''
    return `${removed.length} removed${space}`
  }

  async create(target: 'volume' | 'network', name: string, options: CreateOptions = {}): Promise<void> {
    const ep = await this.connect()
    const body = {
      ...(name ? { Name: name } : {}),
      ...(options.driver ? { Driver: options.driver } : {}),
      ...(options.options && Object.keys(options.options).length ? { [target === 'volume' ? 'DriverOpts' : 'Options']: options.options } : {}),
      ...(options.labels && Object.keys(options.labels).length ? { Labels: options.labels } : {})
    }
    await json(ep, 'POST', target === 'volume' ? '/volumes/create' : '/networks/create', body)
  }

  async spec(id: string): Promise<ContainerSpec> {
    const ep = await this.connect()
    return specOf(await json<Record<string, any>>(ep, 'GET', `/containers/${enc(id)}/json`))
  }

  async recreate(id: string, change: Partial<Pick<ContainerSpec, 'env' | 'mounts' | 'ports'>>): Promise<string> {
    const ep = await this.connect()
    const c = await json<Record<string, any>>(ep, 'GET', `/containers/${enc(id)}/json`)
    const oldId = String(c.Id)
    const name = String(c.Name ?? '').replace(/^\//, '')
    const running = !!c.State?.Running || !!c.State?.Paused
    const { config, host } = recreateBody(c, change)
    // Networks: the first at creation, the others connected after.
    const mode = String(host.NetworkMode ?? '')
    const own = !['host', 'none'].includes(mode) && !mode.startsWith('container:')
    const networks = own ? Object.entries((c.NetworkSettings?.Networks ?? {}) as Record<string, Record<string, any>>) : []
    const endpoint = (n: Record<string, any>): Record<string, unknown> => ({
      Aliases: ((n.Aliases ?? []) as string[]).filter((a) => !oldId.startsWith(a)),
      IPAMConfig: n.IPAMConfig ?? undefined,
      Links: n.Links ?? undefined
    })
    const [first, ...others] = networks
    const networking = first ? { EndpointsConfig: { [first[0]]: endpoint(first[1]) } } : undefined

    // The old container steps aside (renamed, stopped); put back if anything fails.
    const aside = `${name}-old-${Date.now().toString(36)}`
    await json(ep, 'POST', `/containers/${enc(oldId)}/rename?name=${enc(aside)}`)
    let newId: string | undefined
    try {
      if (running) await json(ep, 'POST', `/containers/${enc(oldId)}/stop`, undefined, 60_000)
      const created = await json<{ Id: string }>(ep, 'POST', `/containers/create?name=${enc(name)}`, {
        ...config,
        HostConfig: host,
        NetworkingConfig: networking
      })
      newId = created.Id
      for (const [net, n] of others) await json(ep, 'POST', `/networks/${enc(net)}/connect`, { Container: newId, EndpointConfig: endpoint(n) })
      if (running) await json(ep, 'POST', `/containers/${enc(newId)}/start`, undefined, 60_000)
    } catch (err) {
      if (newId) await json(ep, 'DELETE', `/containers/${enc(newId)}?force=1`).catch(() => undefined)
      await json(ep, 'POST', `/containers/${enc(oldId)}/rename?name=${enc(name)}`).catch(() => undefined)
      if (running) await json(ep, 'POST', `/containers/${enc(oldId)}/start`, undefined, 60_000).catch(() => undefined)
      throw err
    }
    // (Named and anonymous volumes stay: no v=1.)
    await json(ep, 'DELETE', `/containers/${enc(oldId)}?force=1`)
    return newId
  }

  async searchImages(term: string): Promise<ImageSuggestion[]> {
    const ep = await this.connect()
    const raw = await json<{ name?: string; description?: string; star_count?: number; is_official?: boolean }[]>(
      ep,
      'GET',
      `/images/search?term=${encodeURIComponent(term)}&limit=25`,
      undefined,
      8000
    )
    return (raw ?? [])
      .filter((r) => r.name)
      .map((r) => ({ name: r.name!, description: r.description || undefined, stars: r.star_count, official: !!r.is_official }))
  }

  async inspect(target: ContainerTarget, id: string): Promise<string> {
    const ep = await this.connect()
    const path = { container: `/containers/${enc(id)}/json`, image: `/images/${enc(id)}/json`, volume: `/volumes/${enc(id)}`, network: `/networks/${enc(id)}` }[
      target
    ]
    return JSON.stringify(await json(ep, 'GET', path), null, 2)
  }

  async logs(id: string, onText: (text: string) => void, onEnd: (error?: string) => void): Promise<() => void> {
    const ep = await this.connect()
    // Without a TTY, stdout and stderr come multiplexed in frames.
    const info = await json<{ Config?: { Tty?: boolean } }>(ep, 'GET', `/containers/${enc(id)}/json`)
    const tty = info?.Config?.Tty === true
    let rest: Buffer = Buffer.alloc(0)
    return stream(
      ep,
      `/containers/${enc(id)}/logs?follow=1&stdout=1&stderr=1&tail=500`,
      (chunk) => {
        if (tty) return onText(chunk.toString('utf8'))
        const r = demux(Buffer.concat([rest, chunk]))
        rest = r.rest
        if (r.text) onText(r.text)
      },
      onEnd
    )
  }

  async stats(id: string, onStats: (s: ContainerStats) => void, onEnd: (error?: string) => void): Promise<() => void> {
    const ep = await this.connect()
    let buffered = ''
    return stream(
      ep,
      `/containers/${enc(id)}/stats?stream=1`,
      (chunk) => {
        buffered += chunk.toString('utf8')
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            onStats(statsSample(JSON.parse(line)))
          } catch {
            /* a partial line */
          }
        }
      },
      onEnd
    )
  }

  cli(): { command: string; env?: Record<string, string> } | undefined {
    const command = which(this.id)
    if (!command) return undefined
    // The CLI talks to the same engine as the API (Docker understands every endpoint form; Podman's
    // CONTAINER_HOST no named pipes, where it finds its machine by itself).
    const env: Record<string, string> = {}
    const ep = this.endpoint
    if (ep && (this.id === 'docker' || !ep.label.startsWith('npipe:'))) env[this.id === 'docker' ? 'DOCKER_HOST' : 'CONTAINER_HOST'] = ep.label
    return { command, env }
  }
}

/** Docker lists a port once per address family (0.0.0.0 and ::): once is enough. */
function dedupePorts(ports: ContainerInfo['ports']): ContainerInfo['ports'] {
  const seen = new Set<string>()
  return ports.filter((p) => {
    const key = `${p.host}:${p.container}/${p.protocol}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function formatBytes(n: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}
