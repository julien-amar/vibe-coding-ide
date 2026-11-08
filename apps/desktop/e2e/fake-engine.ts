import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * A fake Docker Engine API over TCP (DOCKER_HOST=tcp://127.0.0.1:<port>) for the Containers tab's
 * end-to-end tests: in-memory containers, images, volumes and networks; logs (multiplexed frames)
 * and stats streams. Every request is recorded in `calls`.
 */
export interface FakeEngine {
  url: string
  /** The same server over HTTP: a fake Docker Hub web API (search, tags). */
  hubUrl: string
  calls: string[]
  /** Bodies of POST /containers/create. */
  created: Record<string, any>[]
  /** Bodies of POST /volumes/create. */
  volumeBodies: Record<string, any>[]
  close(): Promise<void>
}

interface FakeContainer {
  Id: string
  Names: string[]
  Image: string
  State: string
  Status: string
  Created: number
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[]
  Labels: Record<string, string>
  Env?: string[]
  ImageID?: string
}

export async function startFakeEngine(): Promise<FakeEngine> {
  const calls: string[] = []
  const created: Record<string, any>[] = []
  const volumeBodies: Record<string, any>[] = []
  const containers: FakeContainer[] = [
    {
      Id: 'c0ffee000001',
      Names: ['/shop-web-1'],
      Image: 'nginx:alpine',
      ImageID: 'sha256:aaaa1111bbbb',
      State: 'running',
      Status: 'Up 5 minutes',
      Created: Math.floor(Date.now() / 1000) - 300,
      Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
      Env: ['PATH=/usr/bin:/bin', 'NGINX_PORT=80', 'API_TOKEN=s3cret'],
      Labels: {
        'com.docker.compose.project': 'shop',
        'com.docker.compose.service': 'web',
        'com.docker.compose.project.config_files': '/srv/shop/compose.yaml'
      }
    },
    {
      Id: 'c0ffee000002',
      Names: ['/db'],
      Image: 'postgres:16',
      State: 'exited',
      Status: 'Exited (0) 1 hour ago',
      Created: Math.floor(Date.now() / 1000) - 7200,
      Ports: [],
      Labels: {}
    }
  ]
  // Containers: -1 (not computed), as Docker answers by default.
  const images = [
    { Id: 'sha256:aaaa1111bbbb', RepoTags: ['nginx:alpine'], Size: 23_400_000, Created: Math.floor(Date.now() / 1000) - 86400, Containers: -1 },
    { Id: 'sha256:cccc2222dddd', RepoTags: ['busybox:latest'], Size: 4_300_000, Created: Math.floor(Date.now() / 1000) - 86400, Containers: -1 }
  ]
  let volumes = [{ Name: 'pgdata', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/pgdata/_data', CreatedAt: '2026-11-01T10:00:00Z' }]
  const networks = [
    { Id: 'n1', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
    { Id: 'n2', Name: 'shop_default', Driver: 'bridge', Scope: 'local' }
  ]

  const frame = (type: number, text: string): Buffer => {
    const payload = Buffer.from(text)
    const header = Buffer.alloc(8)
    header[0] = type
    header.writeUInt32BE(payload.length, 4)
    return Buffer.concat([header, payload])
  }

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')))
    req.on('end', () => route(req, res, raw))
  })
  const route = (req: IncomingMessage, res: ServerResponse, raw: string): void => {
    const url = req.url ?? ''
    calls.push(`${req.method} ${url}`)
    const send = (status: number, body?: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    const byId = (id: string): FakeContainer | undefined => containers.find((c) => c.Id === id || c.Names[0] === `/${id}`)
    let m: RegExpExecArray | null
    if (url === '/_ping') return res.end('OK')
    if (url === '/version') return send(200, { Version: '27.3.1-fake', ApiVersion: '1.47' })
    if (url.startsWith('/containers/json')) return send(200, containers)
    if ((m = /^\/containers\/([^/]+)\/json$/.exec(url))) {
      const c = byId(m[1])
      return c
        ? send(200, {
            Id: c.Id,
            Name: c.Names[0],
            State: { Running: c.State === 'running', Paused: c.State === 'paused' },
            Config: {
              Tty: false,
              Image: c.Image,
              Hostname: c.Id.slice(0, 12),
              Env: c.Env ?? [],
              Labels: c.Labels,
              ExposedPorts: { '80/tcp': {}, '443/tcp': {} }
            },
            HostConfig: { NetworkMode: 'shop_default', Binds: ['/srv/shop/html:/usr/share/nginx/html:ro'], PortBindings: { '80/tcp': [{ HostPort: '8080' }] } },
            Mounts: [
              { Type: 'bind', Source: '/srv/shop/html', Destination: '/usr/share/nginx/html', RW: false },
              { Type: 'volume', Name: 'anon123', Destination: '/var/cache/nginx', RW: true }
            ],
            NetworkSettings: { Networks: { shop_default: { Aliases: ['web', c.Id.slice(0, 12)] } } }
          })
        : send(404, { message: 'No such container' })
    }
    if ((m = /^\/containers\/([^/]+)\/rename\?name=(.+)$/.exec(url)) && req.method === 'POST') {
      const c = byId(m[1])
      if (!c) return send(404, { message: 'No such container' })
      c.Names = ['/' + decodeURIComponent(m[2])]
      return send(204)
    }
    if ((m = /^\/containers\/create\?name=(.+)$/.exec(url)) && req.method === 'POST') {
      const body = JSON.parse(raw || '{}') as Record<string, any>
      created.push(body)
      const id = 'c0ffee' + String(100 + created.length).padStart(6, '0')
      const old = containers.find((c) => c.Image === body.Image)
      containers.push({
        Id: id,
        Names: ['/' + decodeURIComponent(m[1])],
        Image: String(body.Image),
        State: 'created',
        Status: 'Created',
        Created: Math.floor(Date.now() / 1000),
        Ports: old?.Ports ?? [],
        Labels: body.Labels ?? {},
        Env: body.Env
      })
      return send(201, { Id: id })
    }
    if ((m = /^\/containers\/([^/]+)\/(start|stop|restart|pause|unpause|kill)$/.exec(url)) && req.method === 'POST') {
      const c = byId(m[1])
      if (!c) return send(404, { message: 'No such container' })
      c.State = m[2] === 'stop' || m[2] === 'kill' ? 'exited' : m[2] === 'pause' ? 'paused' : 'running'
      c.Status = c.State === 'running' ? 'Up 1 second' : c.State === 'paused' ? 'Up 1 second (Paused)' : 'Exited (0) 1 second ago'
      return send(204)
    }
    if ((m = /^\/containers\/([^/?]+)\?force=1$/.exec(url)) && req.method === 'DELETE') {
      const i = containers.findIndex((c) => c.Id === m![1])
      if (i >= 0) containers.splice(i, 1)
      return send(204)
    }
    if ((m = /^\/containers\/([^/]+)\/logs/.exec(url))) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' })
      res.write(frame(1, `hello from ${m[1]}\n`))
      res.write(frame(2, 'a warning on stderr\n'))
      const iv = setInterval(() => res.write(frame(1, 'tick\n')), 1000)
      res.on('close', () => clearInterval(iv)) // (the response: the request's close comes once its body is read)
      return
    }
    if ((m = /^\/containers\/([^/]+)\/stats/.exec(url))) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      let total = 1_000_000
      let system = 100_000_000
      let n = 0
      const sample = (): void => {
        const pre = { cpu_usage: { total_usage: total }, system_cpu_usage: system }
        // A varying load (20–80 %), so the graphs have a shape.
        total += Math.round(2_500_000 + 1_500_000 * Math.sin(n++ / 2))
        system += 10_000_000
        res.write(
          JSON.stringify({
            cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: 2 },
            precpu_stats: pre,
            memory_stats: { usage: 52_428_800, limit: 1_073_741_824, stats: { inactive_file: 0 } },
            networks: { eth0: { rx_bytes: 1500, tx_bytes: 900 } },
            blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 4096 }] },
            pids_stats: { current: 3 }
          }) + '\n'
        )
      }
      sample()
      const iv = setInterval(sample, 500)
      res.on('close', () => clearInterval(iv))
      return
    }
    if (url === '/images/json') return send(200, images)
    // Prune: dangling images only, unless filtered with dangling=false (then every unused one).
    if (url.startsWith('/images/prune') && req.method === 'POST') {
      const all = new URLSearchParams(url.split('?')[1] ?? '').get('filters')?.includes('"dangling":["false"]')
      const used = new Set(containers.map((c) => c.ImageID))
      const gone = images.filter((i) => !used.has(i.Id) && (all || !i.RepoTags.length))
      for (const g of gone) images.splice(images.indexOf(g), 1)
      return send(200, { ImagesDeleted: gone.map((g) => ({ Deleted: g.Id })), SpaceReclaimed: gone.reduce((n, g) => n + g.Size, 0) })
    }
    // Registry search (the engine's) and Docker Hub's web API (search, tags).
    if ((m = /^\/images\/search\?term=([^&]+)/.exec(url))) {
      const term = decodeURIComponent(m[1])
      const all = [
        { name: 'bitnami/redis', description: 'Bitnami Redis', star_count: 300, is_official: false },
        { name: 'redis', description: 'Redis is an open source key-value store', star_count: 13000, is_official: true },
        { name: 'nginx', description: 'Official build of Nginx.', star_count: 20000, is_official: true }
      ]
      return send(
        200,
        all.filter((x) => x.name.includes(term))
      )
    }
    if ((m = /^\/v2\/repositories\/library\/redis\/tags\/\?(.*)$/.exec(url))) {
      const prefix = new URLSearchParams(m[1]).get('name') ?? ''
      const tags = ['7.4-alpine', '7.4', '7', '6.2', 'latest'].filter((t) => t.startsWith(prefix))
      return send(200, { results: tags.map((name) => ({ name, last_updated: '2026-10-30T12:00:00Z', full_size: 15_000_000 })) })
    }
    if (url.startsWith('/v2/search/repositories/')) return send(200, { results: [] })
    if (url === '/volumes') return send(200, { Volumes: volumes })
    if (url === '/volumes/create' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}') as Record<string, any>
      volumeBodies.push(body)
      const name = body.Name ?? 'generated0123456789'
      volumes.push({ Name: name, Driver: body.Driver ?? 'local', Mountpoint: `/var/lib/docker/volumes/${name}/_data`, CreatedAt: new Date().toISOString() })
      return send(201, { Name: name })
    }
    if ((m = /^\/volumes\/([^/]+)$/.exec(url)) && req.method === 'DELETE') {
      volumes = volumes.filter((v) => v.Name !== decodeURIComponent(m![1]))
      return send(204)
    }
    if ((m = /^\/volumes\/([^/]+)$/.exec(url))) return send(200, volumes.find((v) => v.Name === decodeURIComponent(m![1])) ?? {})
    if (url === '/networks') return send(200, networks)
    send(404, { message: `fake engine: ${req.method} ${url} not implemented` })
  }
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return {
    url: `tcp://127.0.0.1:${port}`,
    hubUrl: `http://127.0.0.1:${port}`,
    calls,
    created,
    volumeBodies,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}
