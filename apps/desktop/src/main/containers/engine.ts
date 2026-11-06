import { request as httpRequest, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import type { ContainerStats } from '@shared/types'

/** Docker Engine API (also served by Podman) over a local socket, named pipe or TCP. */

export interface Endpoint {
  socketPath?: string
  host?: string
  port?: number
  /** Shown to the user. */
  label: string
}

/** DOCKER_HOST / CONTAINER_HOST: tcp://host:port, unix:///path, npipe:////./pipe/name. */
export function parseHost(value: string | undefined): Endpoint | undefined {
  const v = value?.trim()
  if (!v) return undefined
  const tcp = /^(?:tcp|http):\/\/([^:/]+):(\d+)\/?$/.exec(v)
  if (tcp) return { host: tcp[1], port: Number(tcp[2]), label: v }
  const unix = /^unix:\/\/(\/.+)$/.exec(v)
  if (unix) return { socketPath: unix[1], label: v }
  const pipe = /^npipe:\/\/(?:\/\/\.|\/\.|)\/pipe\/(.+)$/.exec(v.replace(/\\/g, '/'))
  if (pipe) return { socketPath: `\\\\.\\pipe\\${pipe[1]}`, label: v }
  return undefined
}

/** Where each engine usually listens on this OS (the environment variable first). */
export function candidates(engine: 'docker' | 'podman', env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Endpoint[] {
  const fromEnv = parseHost(engine === 'docker' ? env.DOCKER_HOST : env.CONTAINER_HOST)
  if (fromEnv) return [fromEnv]
  const pipe = (name: string): Endpoint => ({ socketPath: `\\\\.\\pipe\\${name}`, label: `npipe:////./pipe/${name}` })
  const sock = (path: string): Endpoint => ({ socketPath: path, label: `unix://${path}` })
  const home = homedir()
  if (engine === 'docker') {
    if (platform === 'win32') return [pipe('docker_engine'), pipe('dockerDesktopLinuxEngine')]
    return [sock('/var/run/docker.sock'), sock(posix.join(home, '.docker', 'run', 'docker.sock')), sock(posix.join(home, '.rd', 'docker.sock'))]
  }
  if (platform === 'win32') return [pipe('podman-machine-default')]
  const runtime = env.XDG_RUNTIME_DIR
  return [
    ...(runtime ? [sock(posix.join(runtime, 'podman', 'podman.sock'))] : []),
    sock('/run/podman/podman.sock'),
    sock(posix.join(home, '.local', 'share', 'containers', 'podman', 'machine', 'podman.sock')),
    sock(posix.join(home, '.local', 'share', 'containers', 'podman', 'machine', 'qemu', 'podman.sock'))
  ]
}

const target = (ep: Endpoint): { socketPath?: string; host?: string; port?: number } =>
  ep.socketPath ? { socketPath: ep.socketPath } : { host: ep.host, port: ep.port }

/** One request; resolves with the status and the body (never rejects for HTTP errors). */
export function call(ep: Endpoint, method: string, path: string, body?: unknown, timeout = 15_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      {
        ...target(ep),
        method,
        path,
        timeout,
        headers: { Host: 'docker', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error('The engine did not answer in time.')))
    req.on('error', reject)
    req.end(data)
  })
}

/** A request whose answer is JSON; HTTP errors become exceptions with the engine's message. */
export async function json<T>(ep: Endpoint, method: string, path: string, body?: unknown, timeout?: number): Promise<T> {
  const r = await call(ep, method, path, body, timeout)
  if (r.status >= 400) {
    let message = r.body.trim()
    try {
      message = (JSON.parse(r.body) as { message?: string }).message ?? message
    } catch {
      /* plain text */
    }
    throw new Error(message || `The engine answered ${r.status}.`)
  }
  if (!r.body.trim()) return undefined as T
  return JSON.parse(r.body) as T
}

/** A streaming GET (logs, stats): chunks as they come; returns a function that stops it. */
export function stream(ep: Endpoint, path: string, onData: (chunk: Buffer) => void, onEnd: (error?: string) => void): () => void {
  let ended = false
  const end = (error?: string): void => {
    if (ended) return
    ended = true
    onEnd(error)
  }
  const req = httpRequest({ ...target(ep), method: 'GET', path, headers: { Host: 'docker' } }, (res: IncomingMessage) => {
    if ((res.statusCode ?? 0) >= 400) {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => end(Buffer.concat(chunks).toString('utf8').trim() || `The engine answered ${res.statusCode}.`))
      return
    }
    res.on('data', onData)
    res.on('end', () => end())
    res.on('error', (e) => end(e.message))
  })
  req.on('error', (e) => end(e.message))
  req.end()
  return () => {
    ended = true
    req.destroy()
  }
}

/**
 * Container logs without a TTY come multiplexed: frames of an 8-byte header (stream type, 3 zero
 * bytes, big-endian length) and the payload. Returns the text of the complete frames and what is
 * left over (a frame cut between chunks).
 */
export function demux(buffer: Buffer): { text: string; rest: Buffer } {
  let text = ''
  let i = 0
  while (buffer.length - i >= 8) {
    const size = buffer.readUInt32BE(i + 4)
    if (buffer.length - i - 8 < size) break
    text += buffer.subarray(i + 8, i + 8 + size).toString('utf8')
    i += 8 + size
  }
  return { text, rest: buffer.subarray(i) }
}

/** A sample of the Engine API's /stats into the numbers shown (CPU % of the whole host, as `docker stats`). */
export function statsSample(s: Record<string, any>): ContainerStats {
  const cpu = s.cpu_stats ?? {}
  const pre = s.precpu_stats ?? {}
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0)
  const systemDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0)
  const cpus = cpu.online_cpus ?? cpu.cpu_usage?.percpu_usage?.length ?? 1
  const mem = s.memory_stats ?? {}
  const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? mem.stats?.cache ?? 0
  const nets = Object.values((s.networks ?? {}) as Record<string, { rx_bytes?: number; tx_bytes?: number }>)
  const io = (s.blkio_stats?.io_service_bytes_recursive ?? []) as { op?: string; value?: number }[]
  const ioSum = (op: string): number => io.filter((x) => x.op?.toLowerCase() === op).reduce((a, x) => a + (x.value ?? 0), 0)
  return {
    cpu: systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0,
    memUsed: Math.max(0, (mem.usage ?? 0) - cache),
    memLimit: mem.limit ?? 0,
    netRx: nets.reduce((a, n) => a + (n.rx_bytes ?? 0), 0),
    netTx: nets.reduce((a, n) => a + (n.tx_bytes ?? 0), 0),
    blockRead: ioSum('read'),
    blockWrite: ioSum('write'),
    pids: s.pids_stats?.current
  }
}
