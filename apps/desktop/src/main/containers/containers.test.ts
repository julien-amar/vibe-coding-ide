import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeProjects } from './backend'
import { candidates, demux, parseHost, statsSample } from './engine'
import { EngineBackend } from './engine-backend'
import { containerPath, parseListing } from './files'
import { createOptions, envList, jobArgs } from './index'
import { splitReference, suggestImages } from './registry-search'
import { mountList, portList, recreateBody, specOf } from './spec'
import { jsonLines, parseLabels, parsePorts, parseSize, wslcContainer, wslcStats } from './wslc-backend'

describe('engine endpoints', () => {
  it('parses DOCKER_HOST / CONTAINER_HOST forms', () => {
    expect(parseHost('tcp://127.0.0.1:2375')).toEqual({ host: '127.0.0.1', port: 2375, label: 'tcp://127.0.0.1:2375' })
    expect(parseHost('unix:///var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock', label: 'unix:///var/run/docker.sock' })
    expect(parseHost('npipe:////./pipe/docker_engine')?.socketPath).toBe('\\\\.\\pipe\\docker_engine')
    expect(parseHost('ssh://me@host')).toBeUndefined()
  })

  it('looks where each engine usually listens, the environment variable first', () => {
    expect(candidates('docker', {}, 'win32').map((e) => e.label)).toEqual(['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine'])
    expect(candidates('podman', {}, 'win32').map((e) => e.label)).toEqual(['npipe:////./pipe/podman-machine-default'])
    expect(candidates('docker', {}, 'linux')[0].socketPath).toBe('/var/run/docker.sock')
    expect(candidates('podman', { XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')[0].socketPath).toBe('/run/user/1000/podman/podman.sock')
    expect(candidates('docker', { DOCKER_HOST: 'tcp://h:1' }, 'linux')).toEqual([{ host: 'h', port: 1, label: 'tcp://h:1' }])
  })
})

describe('Engine API streams', () => {
  const frame = (type: number, text: string): Buffer => {
    const payload = Buffer.from(text)
    const header = Buffer.alloc(8)
    header[0] = type
    header.writeUInt32BE(payload.length, 4)
    return Buffer.concat([header, payload])
  }

  it('demultiplexes logs, keeping a frame cut between chunks for the next one', () => {
    const all = Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n'), frame(1, 'tail')])
    const first = demux(all.subarray(0, 20))
    expect(first.text).toBe('out\nerr\n'.slice(0, first.text.length))
    const second = demux(Buffer.concat([first.rest, all.subarray(20)]))
    expect(first.text + second.text).toBe('out\nerr\ntail')
    expect(second.rest.length).toBe(0)
  })

  it('computes stats like `docker stats`', () => {
    const s = statsSample({
      cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 200 } },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'Read', value: 5 },
          { op: 'write', value: 7 }
        ]
      },
      pids_stats: { current: 3 }
    })
    expect(s).toEqual({ cpu: 80, memUsed: 800, memLimit: 4000, netRx: 11, netTx: 22, blockRead: 5, blockWrite: 7, pids: 3 })
  })
})

describe('wslc (CLI) output', () => {
  it('reads JSON lines after the banner', () => {
    expect(jsonLines('Copyright (c) Microsoft\n{"a":1}\n\n{"b":2}\nnot json')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('parses ports, labels, sizes, containers and stats', () => {
    expect(parsePorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp')).toEqual([
      { host: 8080, container: 80, protocol: 'tcp', ip: '0.0.0.0' },
      { host: undefined, container: 443, protocol: 'tcp', ip: undefined }
    ])
    expect(parseLabels('com.docker.compose.project=web,meta={"V1":{"Flags":0,"Ports":[]}},x=1')).toEqual({
      'com.docker.compose.project': 'web',
      meta: '{"V1":{"Flags":0,"Ports":[]}}',
      x: '1'
    })
    expect(parseSize('1.5KiB')).toBe(1536)
    expect(parseSize('2MB')).toBe(2_000_000)
    expect(parseSize('0B')).toBe(0)
    const c = wslcContainer({
      ID: '0a00a7e82bc5',
      Names: 'bright_catskill',
      Image: 'hello-world',
      State: 'exited',
      Status: 'Exited (0) 37 hours ago',
      Ports: ''
    })
    expect(c).toMatchObject({ id: '0a00a7e82bc5', name: 'bright_catskill', state: 'exited', ports: [] })
    expect(wslcStats({ CPUPerc: '12.5%', MemUsage: '1MiB / 2MiB', NetIO: '1kB / 2kB', BlockIO: '0B / 0B', PIDs: 4 })).toEqual({
      cpu: 12.5,
      memUsed: 1048576,
      memLimit: 2097152,
      netRx: 1000,
      netTx: 2000,
      blockRead: 0,
      blockWrite: 0,
      pids: 4
    })
  })
})

describe('jobs (CLI arguments)', () => {
  it('builds pull / build / run / compose command lines', () => {
    expect(jobArgs('docker', { kind: 'pull', image: 'nginx:alpine' })).toEqual(['pull', 'nginx:alpine'])
    expect(
      jobArgs('wslc', { kind: 'build', context: 'C:\\app', tag: 'app:dev', dockerfile: 'Dockerfile.dev', target: 'dev', buildArgs: ['A=1', ' '] })
    ).toEqual(['build', '-t', 'app:dev', '-f', 'Dockerfile.dev', '--target', 'dev', '--build-arg', 'A=1', 'C:\\app'])
    expect(jobArgs('docker', { kind: 'run', image: 'nginx', name: 'web', ports: ['8080:80'], env: ['A=b'], restart: 'unless-stopped' })).toEqual([
      'run',
      '-d',
      '--name',
      'web',
      '-p',
      '8080:80',
      '-e',
      'A=b',
      '--restart',
      'unless-stopped',
      'nginx'
    ])
    expect(jobArgs('docker', { kind: 'compose', project: 'shop', action: 'up', configFiles: ['/srv/shop/compose.yaml'] })).toEqual([
      'compose',
      '-p',
      'shop',
      '-f',
      '/srv/shop/compose.yaml',
      'up',
      '-d'
    ])
  })

  it('refuses option injection and Compose on wslc', () => {
    expect(() => jobArgs('docker', { kind: 'pull', image: '--help' })).toThrow(/Invalid image/)
    expect(() => jobArgs('wslc', { kind: 'compose', project: 'x', action: 'up', configFiles: [] })).toThrow(/no Compose/)
  })
})

describe('Docker through the Engine API (a fake engine over TCP)', () => {
  let server: Server
  const calls: string[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`)
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/_ping') return res.end('OK')
      if (req.url === '/version') return send(200, { Version: '27.0.0' })
      if (req.url === '/containers/json?all=1')
        return send(200, [
          {
            Id: 'abc',
            Names: ['/web-1'],
            Image: 'nginx',
            State: 'running',
            Status: 'Up 1 minute',
            Created: 1,
            Ports: [
              { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
              { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }
            ],
            Labels: {
              'com.docker.compose.project': 'shop',
              'com.docker.compose.service': 'web',
              'com.docker.compose.project.config_files': '/srv/shop/compose.yaml'
            }
          }
        ])
      if (req.url === '/containers/abc/stop' && req.method === 'POST') return send(204, '')
      if (req.url === '/images/nope' && req.method === 'DELETE') return send(409, { message: 'image is being used by running container abc' })
      send(404, { message: 'page not found' })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => {
    delete process.env.DOCKER_HOST
    server.close()
  })

  it('lists, acts and reports the engine errors', async () => {
    const docker = new EngineBackend('docker')
    const info = await docker.info()
    expect(info).toMatchObject({ available: true, label: 'Docker' })
    expect(info.detail).toMatch(/^27\.0\.0 · tcp:\/\/127\.0\.0\.1:\d+$/)
    const { containers } = await docker.list('containers')
    expect(containers).toEqual([
      {
        id: 'abc',
        name: 'web-1',
        image: 'nginx',
        state: 'running',
        status: 'Up 1 minute',
        created: 1,
        ports: [{ host: 8080, container: 80, protocol: 'tcp', ip: '0.0.0.0' }],
        compose: { project: 'shop', service: 'web', workingDir: undefined, configFiles: ['/srv/shop/compose.yaml'] }
      }
    ])
    expect(composeProjects(containers!)).toEqual([
      { name: 'shop', workingDir: undefined, configFiles: ['/srv/shop/compose.yaml'], services: [{ name: 'web', state: 'running', container: 'web-1' }] }
    ])
    await docker.action('container', 'abc', 'stop')
    expect(calls).toContain('POST /containers/abc/stop')
    await expect(docker.action('image', 'nope', 'remove')).rejects.toThrow('image is being used by running container abc')
  })

  it('reports an engine that is not running', async () => {
    const saved = process.env.DOCKER_HOST
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:1'
    const info = await new EngineBackend('docker').info()
    process.env.DOCKER_HOST = saved
    expect(info.available).toBe(false)
    expect(info.error).toMatch(/not running/)
  })
})

describe('container files', () => {
  it('normalises container paths and rejects relative ones', () => {
    expect(containerPath('/')).toBe('/')
    expect(containerPath('/etc/../usr//lib/./x/')).toBe('/usr/lib/x')
    expect(containerPath('/..')).toBe('/')
    expect(() => containerPath('etc')).toThrow()
    expect(() => containerPath('/a\nb')).toThrow()
  })

  it('parses a listing: folders first, sizes and times, links', () => {
    const out = ['f\t12 1700000000\thosts', 'd\t4096 1700000001\tbin', 'L\t7 1700000002\tlib64', 'l\t\tbroken link', 'junk', 'f\t3 1\twith\ttab'].join('\n')
    expect(parseListing(out)).toEqual([
      { name: 'bin', type: 'dir', size: 4096, mtime: 1700000001 },
      { name: 'lib64', type: 'dirlink', size: 7, mtime: 1700000002 },
      { name: 'broken link', type: 'link', size: undefined, mtime: undefined },
      { name: 'hosts', type: 'file', size: 12, mtime: 1700000000 },
      { name: 'with\ttab', type: 'file', size: 3, mtime: 1 }
    ])
  })
})

describe('pull suggestions and environments', () => {
  it('splits image references: registry, repository, tag prefix', () => {
    expect(splitReference('redis')).toEqual({ repo: 'library/redis', tag: undefined, hub: true })
    expect(splitReference('redis:7')).toEqual({ repo: 'library/redis', tag: '7', hub: true })
    expect(splitReference('bitnami/redis:')).toEqual({ repo: 'bitnami/redis', tag: '', hub: true })
    expect(splitReference('docker.io/library/nginx:1.2')).toEqual({ repo: 'library/nginx', tag: '1.2', hub: true })
    expect(splitReference('ghcr.io/owner/app:v1')).toEqual({ repo: 'owner/app', tag: 'v1', hub: false })
    expect(splitReference('localhost:5000/app')).toEqual({ repo: 'app', tag: undefined, hub: false })
  })

  it('suggests nothing for short or spaced input', async () => {
    expect(await suggestImages(undefined, 'r')).toEqual({ ok: true, items: [] })
    expect(await suggestImages(undefined, 'red is')).toEqual({ ok: true, items: [] })
  })

  it('accepts KEY=VALUE environments only', () => {
    expect(envList(['A=1', 'B=', 'C=x=y'])).toEqual(['A=1', 'B=', 'C=x=y'])
    expect(() => envList(['NOVALUE'])).toThrow()
    expect(() => envList(['=1'])).toThrow()
    expect(() => envList(['BAD KEY=1'])).toThrow()
    expect(() => envList('A=1')).toThrow()
  })
})

describe('new volume settings', () => {
  it('keeps the driver, options and labels; refuses option injection', () => {
    expect(createOptions({ driver: 'local', options: { type: 'nfs', o: 'addr=10.0.0.5,rw' }, labels: { a: 'b' } })).toEqual({
      driver: 'local',
      options: { type: 'nfs', o: 'addr=10.0.0.5,rw' },
      labels: { a: 'b' }
    })
    expect(createOptions(undefined)).toEqual({ driver: undefined, options: undefined, labels: undefined })
    expect(() => createOptions({ driver: '--privileged' })).toThrow()
    expect(() => createOptions({ options: { '-o': 'x' } })).toThrow()
    expect(() => createOptions({ labels: { 'a b': 'x' } })).toThrow()
    expect(() => createOptions({ labels: { a: 'x\ny' } })).toThrow()
  })
})

describe('container settings (volumes, ports) and their recreation', () => {
  const inspect = {
    Id: 'abc123def456789',
    Config: { Hostname: 'abc123def456', Env: ['A=1'], ExposedPorts: { '80/tcp': {}, '443/tcp': {} } },
    HostConfig: { Binds: ['/srv/html:/html:ro'], PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }] }, Tmpfs: { '/run': '' } },
    Mounts: [
      { Type: 'bind', Source: '/srv/html', Destination: '/html', RW: false },
      { Type: 'volume', Name: 'anon1', Destination: '/cache', RW: true }
    ]
  }

  it('reads mounts, published and exposed ports', () => {
    expect(specOf(inspect)).toEqual({
      env: ['A=1'],
      mounts: [
        { type: 'bind', source: '/srv/html', target: '/html', readOnly: true },
        { type: 'volume', source: 'anon1', target: '/cache', readOnly: false },
        { type: 'tmpfs', source: '', target: '/run', readOnly: false }
      ],
      ports: [{ container: 80, protocol: 'tcp', hostPort: '8080', hostIp: '' }],
      exposed: ['443/tcp']
    })
  })

  it('validates mounts and ports from the window', () => {
    expect(mountList([{ type: 'tmpfs', source: 'x', target: '/t' }])).toEqual([{ type: 'tmpfs', source: '', target: '/t', readOnly: false }])
    expect(() => mountList([{ type: 'volume', source: 'v', target: 'rel' }])).toThrow()
    expect(() => mountList([{ type: 'bind', source: '', target: '/a' }])).toThrow()
    expect(() =>
      mountList([
        { type: 'volume', source: 'v', target: '/a' },
        { type: 'volume', source: 'w', target: '/a' }
      ])
    ).toThrow()
    expect(portList([{ container: '80', protocol: 'tcp', hostPort: '8000-8010' }])).toEqual([
      { container: 80, protocol: 'tcp', hostPort: '8000-8010', hostIp: '' }
    ])
    expect(() => portList([{ container: 70000 }])).toThrow()
    expect(() => portList([{ container: 80, hostPort: 'abc' }])).toThrow()
    expect(() => portList([{ container: 80, protocol: 'icmp' }])).toThrow()
    expect(() =>
      portList([
        { container: 80, hostPort: '8080' },
        { container: 81, hostPort: '8080' }
      ])
    ).not.toThrow() // different container ports
  })

  it('builds the new container: given mounts (structured), ports published and exposed; the rest kept', () => {
    const { config, host } = recreateBody(inspect, {
      mounts: [{ type: 'volume', source: 'data', target: '/data', readOnly: false }],
      ports: [{ container: 443, protocol: 'tcp', hostPort: '8443', hostIp: '127.0.0.1' }]
    })
    expect(config.Hostname).toBeUndefined()
    expect(config.Env).toEqual(['A=1'])
    expect(host.Binds).toEqual([])
    expect(host.Tmpfs).toBeUndefined()
    expect(host.Mounts).toEqual([{ Type: 'volume', Source: 'data', Target: '/data', ReadOnly: false }])
    expect(host.PortBindings).toEqual({ '443/tcp': [{ HostIp: '127.0.0.1', HostPort: '8443' }] })
    expect(Object.keys(config.ExposedPorts)).toEqual(['80/tcp', '443/tcp'])
    // Nothing about mounts given: binds kept, anonymous volumes kept by name.
    expect(recreateBody(inspect, { env: ['B=2'] }).host.Binds).toEqual(['/srv/html:/html:ro', 'anon1:/cache'])
  })
})
