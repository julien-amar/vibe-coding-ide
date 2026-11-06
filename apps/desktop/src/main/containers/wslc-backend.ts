import { execFile, spawn } from 'node:child_process'
import type {
  ContainerAction,
  ContainerBackendInfo,
  ContainerInfo,
  ContainerListKind,
  ContainerListResult,
  ContainerPort,
  ContainerStats,
  ContainerTarget
} from '@shared/types'
import { which } from '../profiles'
import { killTree } from '../tests/core'
import { composeOf, type ContainerBackend } from './backend'

/**
 * wslc (WSL containers, Windows) through its command line tool: `--format json` gives one JSON object
 * per line, with the same fields as the Docker CLI's.
 */
export class WslcBackend implements ContainerBackend {
  readonly id = 'wslc'

  private run(args: string[], timeout = 60_000): Promise<string> {
    const exe = which('wslc')
    if (!exe) return Promise.reject(new Error('wslc is not installed (it comes with recent WSL versions on Windows).'))
    return new Promise((resolve, reject) => {
      execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(cleanError(String(stderr || stdout)) || err.message))
        else resolve(String(stdout))
      })
    })
  }

  async info(): Promise<ContainerBackendInfo> {
    const base = { id: this.id, label: 'wslc', features: { pause: false, compose: false } } as const
    if (process.platform !== 'win32') return { ...base, available: false, error: 'wslc is a Windows tool (WSL containers).' }
    try {
      const v = (await this.run(['version'], 20_000)).trim().split(/\r?\n/)[0]
      return { ...base, available: true, detail: v.replace(/^wslc\s*/, '') }
    } catch (e) {
      return { ...base, available: false, error: (e as Error).message }
    }
  }

  async list(kind: ContainerListKind): Promise<ContainerListResult> {
    if (kind === 'compose') return { ok: true, compose: [] }
    if (kind === 'containers') {
      return { ok: true, containers: jsonLines(await this.run(['list', '--all', '--format', 'json'])).map(wslcContainer) }
    }
    if (kind === 'images') {
      return {
        ok: true,
        images: jsonLines(await this.run(['images', '--format', 'json'])).map((i) => ({
          id: String(i.ID ?? ''),
          tags: i.Repository && i.Repository !== '<none>' ? [`${i.Repository}:${i.Tag ?? 'latest'}`] : [],
          size: String(i.Size ?? ''),
          containers: Number(i.Containers) >= 0 ? Number(i.Containers) : undefined
        }))
      }
    }
    if (kind === 'volumes') {
      return {
        ok: true,
        volumes: jsonLines(await this.run(['volume', 'list', '--format', 'json'])).map((v) => ({
          name: String(v.Name ?? ''),
          driver: String(v.Driver ?? ''),
          mountpoint: v.Mountpoint ? String(v.Mountpoint) : undefined,
          created: v.CreatedAt ? String(v.CreatedAt) : undefined
        }))
      }
    }
    return {
      ok: true,
      networks: jsonLines(await this.run(['network', 'list', '--format', 'json'])).map((n) => ({
        id: String(n.ID ?? ''),
        name: String(n.Name ?? ''),
        driver: String(n.Driver ?? ''),
        scope: n.Scope ? String(n.Scope) : undefined
      }))
    }
  }

  async action(target: ContainerTarget, id: string, action: ContainerAction): Promise<void> {
    if (target === 'container') {
      if (action === 'pause' || action === 'unpause') throw new Error('wslc cannot pause containers.')
      await this.run(action === 'remove' ? ['remove', '--force', id] : [action, id])
      return
    }
    if (action !== 'remove') throw new Error(`Cannot ${action} a ${target}.`)
    await this.run(target === 'image' ? ['image', 'remove', id] : [target, 'remove', id])
  }

  async prune(target: ContainerTarget): Promise<string> {
    const out = await this.run([target, 'prune', '--force'], 120_000)
    return out.trim().split(/\r?\n/).pop() || 'Done'
  }

  async create(target: 'volume' | 'network', name: string): Promise<void> {
    await this.run([target, 'create', name])
  }

  async inspect(target: ContainerTarget, id: string): Promise<string> {
    return (await this.run(['inspect', '--type', target, id])).trim()
  }

  async logs(id: string, onText: (text: string) => void, onEnd: (error?: string) => void): Promise<() => void> {
    const exe = which('wslc')
    if (!exe) throw new Error('wslc is not installed.')
    const child = spawn(exe, ['logs', '--follow', '--tail', '500', id], { windowsHide: true })
    child.stdout.on('data', (b: Buffer) => onText(b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => onText(b.toString('utf8')))
    child.on('error', (e) => onEnd(e.message))
    child.on('close', () => onEnd())
    return () => killTree(child)
  }

  /** wslc stats has no stream: a sample every 2 s. */
  async stats(id: string, onStats: (s: ContainerStats) => void, onEnd: (error?: string) => void): Promise<() => void> {
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const rows = jsonLines(await this.run(['stats', '--all', '--no-trunc', '--format', 'json'], 20_000))
        const row = rows.find((r) => String(r.ID ?? '').startsWith(id) || id.startsWith(String(r.ID ?? '-')) || r.Name === id)
        if (row) onStats(wslcStats(row))
      } catch (e) {
        stopped = true
        return onEnd((e as Error).message)
      }
      if (!stopped) timer = setTimeout(() => void tick(), 2000)
    }
    let timer: NodeJS.Timeout | undefined
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }

  cli(): { command: string } | undefined {
    const command = which('wslc')
    return command ? { command } : undefined
  }
}

/** The JSON objects of a `--format json` output (one per line). */
export function jsonLines(out: string): Record<string, any>[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, any>]
      } catch {
        return []
      }
    })
}

/** "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp" → ports (each published port once). */
export function parsePorts(text: string | undefined): ContainerPort[] {
  const out: ContainerPort[] = []
  const seen = new Set<string>()
  for (const part of (text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(?:(.*):(\d+)->)?(\d+)(?:-\d+)?\/(\w+)$/.exec(part)
    if (!m) continue
    const port: ContainerPort = { host: m[2] ? Number(m[2]) : undefined, container: Number(m[3]), protocol: m[4], ip: m[1] || undefined }
    const key = `${port.host}:${port.container}/${port.protocol}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(port)
  }
  return out
}

/** "k=v,k2=v2" labels (values may contain "=", and JSON with commas, as wslc's own metadata). */
export function parseLabels(text: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const m of (text ?? '').matchAll(/(?:^|,)([\w.-]+)=((?:\{.*?\}(?=,[\w.-]+=|$))|[^,]*)/g)) labels[m[1]] = m[2]
  return labels
}

export function wslcContainer(c: Record<string, any>): ContainerInfo {
  return {
    id: String(c.ID ?? ''),
    name: String(c.Names ?? c.ID ?? ''),
    image: String(c.Image ?? ''),
    state: String(c.State ?? '').toLowerCase(),
    status: String(c.Status ?? ''),
    ports: parsePorts(c.Ports),
    compose: composeOf(parseLabels(c.Labels))
  }
}

/** "12.5MiB / 1.9GiB" → bytes (1024- and 1000-based units). */
export function parseSize(text: string | undefined): number {
  const m = /^([\d.]+)\s*([kKMGT]?i?B)?$/.exec((text ?? '').trim())
  if (!m) return 0
  const unit = m[2] ?? 'B'
  const pow = ' kMGT'.indexOf(unit[0].toUpperCase() === 'K' ? 'k' : unit[0])
  const base = unit.includes('i') ? 1024 : 1000
  return Number(m[1]) * (pow > 0 ? base ** pow : 1)
}

export function wslcStats(r: Record<string, any>): ContainerStats {
  const pair = (s: unknown): [number, number] => {
    const [a, b] = String(s ?? '').split('/')
    return [parseSize(a), parseSize(b)]
  }
  const [memUsed, memLimit] = pair(r.MemUsage)
  const [netRx, netTx] = pair(r.NetIO)
  const [blockRead, blockWrite] = pair(r.BlockIO)
  return { cpu: parseFloat(String(r.CPUPerc ?? '0')) || 0, memUsed, memLimit, netRx, netTx, blockRead, blockWrite, pids: Number(r.PIDs) || undefined }
}

/** wslc prints its copyright banner before errors: keep the message. */
const cleanError = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^Copyright \(c\)|^For privacy information/.test(l))
    .join('\n')
    .trim()
