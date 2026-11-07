import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import type {
  ContainerAction,
  ContainerBackendId,
  CreateOptions,
  ContainerJob,
  ContainerListKind,
  ContainerStreamEvent,
  ContainerTarget,
  Profile
} from '@shared/types'
import { directLaunch } from '../harness'
import { launchSpec, registerProfile } from '../profiles'
import { killTree } from '../tests/core'
import type { ContainerBackend } from './backend'
import { EngineBackend } from './engine-backend'
import { containerPath, listFiles, readFilePreview, saveFile, type Cli } from './files'
import { suggestImages } from './registry-search'
import { mountList, portList } from './spec'
import { WslcBackend } from './wslc-backend'
import { emit, handle, listen } from '../ipc'

/** The Containers tab's backends and their IPC (lists, actions, streams of logs / stats / job output). */

const backends: Record<ContainerBackendId, ContainerBackend> = {
  docker: new EngineBackend('docker'),
  podman: new EngineBackend('podman'),
  wslc: new WslcBackend()
}

const backendOf = (id: unknown): ContainerBackend => {
  const b = backends[String(id) as ContainerBackendId]
  if (!b) throw new Error('Unknown container engine')
  return b
}

const TARGETS = new Set<ContainerTarget>(['container', 'image', 'volume', 'network'])
const ACTIONS = new Set<ContainerAction>(['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'remove'])
const KINDS = new Set<ContainerListKind>(['containers', 'images', 'volumes', 'networks', 'compose'])

/** A container id or name, as the engines make them (it reaches a terminal's command line). */
const containerRef = (v: unknown): string => {
  const s = safe(v, 'container')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s)) throw new Error('Invalid container')
  return s
}

/** A registry host (and port, path): ghcr.io, localhost:5000, registry.example.com/team. */
const registryRef = (v: unknown): string => {
  const s = safe(v, 'registry')
  if (!/^[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._-]+)*$/.test(s)) throw new Error('Invalid registry')
  return s
}

/** Ids, names and references from the renderer: no option injection into CLI commands. */
const safe = (v: unknown, what: string): string => {
  const s = String(v ?? '').trim()
  if (!s || s.startsWith('-') || /[\0\r\n]/.test(s)) throw new Error(`Invalid ${what}`)
  return s
}

/** Settings of a new volume or network from the renderer (exported for tests): no option injection. */
export function createOptions(v: unknown): CreateOptions {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const map = (m: unknown, what: string): Record<string, string> | undefined => {
    if (!m || typeof m !== 'object') return undefined
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(m as Record<string, unknown>)) {
      if (!k || k.startsWith('-') || /[\s=\0]/.test(k) || /[\0\r\n]/.test(String(val))) throw new Error(`Invalid ${what}: ${k}`)
      out[k] = String(val)
    }
    return out
  }
  const driver = typeof o.driver === 'string' && o.driver.trim() ? safe(o.driver, 'driver') : undefined
  return { driver, options: map(o.options, 'driver option'), labels: map(o.labels, 'label') }
}

/** A KEY=VALUE list from the renderer (exported for tests): keys without '=' or spaces, no NUL. */
export function envList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('Invalid environment')
  return v.map((e) => {
    const s = String(e)
    const key = s.split('=')[0]
    if (!s.includes('=') || !key || /[\s\0]/.test(key) || s.includes('\0')) throw new Error(`Invalid variable: ${s.slice(0, 40)}`)
    return s
  })
}

/** The CLI arguments of a job (exported for tests). */
export function jobArgs(backend: ContainerBackendId, job: ContainerJob): string[] {
  const many = (flag: string, values: string[] | undefined): string[] => (values ?? []).filter((v) => v.trim()).flatMap((v) => [flag, safe(v, flag)])
  switch (job.kind) {
    case 'pull':
      return ['pull', safe(job.image, 'image')]
    case 'build':
      return [
        'build',
        ...(job.tag?.trim() ? ['-t', safe(job.tag, 'tag')] : []),
        ...(job.dockerfile?.trim() ? ['-f', safe(job.dockerfile, 'Dockerfile')] : []),
        ...(job.target?.trim() ? ['--target', safe(job.target, 'target')] : []),
        ...many('--build-arg', job.buildArgs),
        safe(job.context, 'build context')
      ]
    case 'run':
      return [
        'run',
        '-d',
        ...(job.name?.trim() ? ['--name', safe(job.name, 'name')] : []),
        ...many('-p', job.ports),
        ...many('-e', job.env),
        ...many('-v', job.volumes),
        ...(job.network?.trim() ? ['--network', safe(job.network, 'network')] : []),
        ...(job.restart?.trim() ? ['--restart', safe(job.restart, 'restart policy')] : []),
        safe(job.image, 'image')
      ]
    case 'logout':
      return ['logout', ...(job.registry?.trim() ? [safe(job.registry, 'registry')] : [])]
    case 'compose': {
      if (backend === 'wslc') throw new Error('wslc has no Compose.')
      if (!['up', 'down', 'restart', 'pull', 'stop'].includes(job.action)) throw new Error('Invalid Compose action')
      return ['compose', '-p', safe(job.project, 'project'), ...many('-f', job.configFiles), ...(job.action === 'up' ? ['up', '-d'] : [job.action])]
    }
  }
}

export function registerContainerIpc(): void {
  /** Running streams: id → stop. */
  const streams = new Map<string, () => void>()
  let next = 1

  const startStream = (
    wc: WebContents,
    start: (id: string, send: (e: ContainerStreamEvent) => void, end: (code?: number, error?: string) => void) => Promise<() => void>
  ): string => {
    const id = `cs-${next++}`
    const send = (e: ContainerStreamEvent): void => {
      emit(wc, 'containers:stream', e)
    }
    let done = false
    const end = (code?: number, error?: string): void => {
      if (done) return
      done = true
      streams.delete(id)
      send({ stream: id, kind: 'end', code, error })
    }
    start(id, send, end).then(
      (stop) => {
        if (done) stop()
        else streams.set(id, stop)
      },
      (e: Error) => end(undefined, e.message)
    )
    wc.once('destroyed', () => streams.get(id)?.())
    return id
  }

  handle('containers:backends', () => Promise.all(Object.values(backends).map((b) => b.info())))

  handle('containers:list', async (_e, backend: string, kind: string) => {
    try {
      if (!KINDS.has(kind as ContainerListKind)) throw new Error('Invalid list')
      return await backendOf(backend).list(kind as ContainerListKind)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  handle('containers:action', async (_e, backend: string, target: string, id: string, action: string) => {
    try {
      if (!TARGETS.has(target as ContainerTarget) || !ACTIONS.has(action as ContainerAction)) throw new Error('Invalid action')
      await backendOf(backend).action(target as ContainerTarget, safe(id, 'id'), action as ContainerAction)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  handle('containers:prune', async (_e, backend: string, target: string) => {
    try {
      if (!TARGETS.has(target as ContainerTarget)) throw new Error('Invalid target')
      return { ok: true, text: await backendOf(backend).prune(target as ContainerTarget) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  handle('containers:create', async (_e, backend: string, target: string, name: string, options: unknown) => {
    try {
      if (target !== 'volume' && target !== 'network') throw new Error('Invalid target')
      // Volumes may be named by the engine.
      const n = target === 'volume' && !String(name ?? '').trim() ? '' : safe(name, 'name')
      await backendOf(backend).create(target, n, createOptions(options))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  handle('containers:inspect', async (_e, backend: string, target: string, id: string) => {
    try {
      if (!TARGETS.has(target as ContainerTarget)) throw new Error('Invalid target')
      return { ok: true, text: await backendOf(backend).inspect(target as ContainerTarget, safe(id, 'id')) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  handle('containers:logs', (e, backend: string, id: string) =>
    startStream(e.sender, async (sid, send, end) => {
      return backendOf(backend).logs(
        safe(id, 'id'),
        (text) => send({ stream: sid, kind: 'text', text }),
        (error) => end(undefined, error)
      )
    })
  )

  handle('containers:stats', (e, backend: string, id: string) =>
    startStream(e.sender, async (sid, send, end) => {
      return backendOf(backend).stats(
        safe(id, 'id'),
        (stats) => send({ stream: sid, kind: 'stats', stats }),
        (error) => end(undefined, error)
      )
    })
  )

  handle('containers:job', (e, backend: string, job: ContainerJob) =>
    startStream(e.sender, async (sid, send, end) => {
      const b = backendOf(backend)
      const cli = b.cli()
      if (!cli) throw new Error(`The ${backend} command line tool is not installed.`)
      const args = jobArgs(b.id, job)
      const cwd = job.kind === 'compose' && job.workingDir && existsSync(job.workingDir) ? job.workingDir : undefined
      send({ stream: sid, kind: 'text', text: `$ ${backend === 'wslc' ? 'wslc' : backend} ${args.join(' ')}\n` })
      // An npm-style .cmd shim (Node cannot spawn it without a shell): its script, directly.
      const launch = /\.(cmd|bat)$/i.test(cli.command) ? directLaunch(cli.command, args) : undefined
      const child = spawn(launch?.command ?? cli.command, launch?.args ?? args, { cwd, windowsHide: true, env: { ...process.env, ...(cli.env ?? {}) } })
      child.stdout.on('data', (d: Buffer) => send({ stream: sid, kind: 'text', text: d.toString('utf8') }))
      child.stderr.on('data', (d: Buffer) => send({ stream: sid, kind: 'text', text: d.toString('utf8') }))
      child.on('error', (err) => end(undefined, err.message))
      child.on('close', (code) => end(code ?? undefined))
      return () => killTree(child)
    })
  )

  listen('containers:stopStream', (_e, id: string) => streams.get(String(id))?.())

  /** Terminal profiles (opened as tabs): a shell inside a container, the engine's registry login. */
  const cliProfile = (backend: string, id: string, name: string, args: string[]): Profile | null => {
    const b = backendOf(backend)
    const cli = b.cli()
    if (!cli) return null
    // (.cmd / .bat tools through cmd.exe, as for every profile.)
    const profile: Profile = { id, name, kind: 'shell', ...launchSpec(cli.command, args), env: cli.env, source: cli.command }
    registerProfile(profile)
    return profile
  }
  // A container's environment; changing it recreates the container (Docker, Podman).
  handle('containers:spec', async (_e, backend: string, id: string) => {
    try {
      return { ok: true, spec: await backendOf(backend).spec(safe(id, 'container')) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  handle('containers:recreate', async (_e, backend: string, id: string, change: Record<string, unknown>) => {
    try {
      const b = backendOf(backend)
      if (!b.recreate) throw new Error(`${b.id} cannot recreate a container: its settings are read-only here.`)
      const c = change ?? {}
      const valid = {
        ...(c.env !== undefined ? { env: envList(c.env) } : {}),
        ...(c.mounts !== undefined ? { mounts: mountList(c.mounts) } : {}),
        ...(c.ports !== undefined ? { ports: portList(c.ports) } : {})
      }
      return { ok: true, id: await b.recreate(safe(id, 'container'), valid) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // "Pull an image" suggestions.
  handle('containers:searchImages', (_e, backend: string, input: string) =>
    suggestImages(backends[String(backend) as ContainerBackendId], String(input ?? '').slice(0, 200))
  )

  // Files of a running container (through `exec`).
  const fileCli = (backend: string): Cli => {
    const cli = backendOf(backend).cli()
    if (!cli) throw new Error(`The ${backend} command line tool is not installed.`)
    return cli
  }
  handle('containers:listFiles', async (_e, backend: string, id: string, path: string) => {
    try {
      return await listFiles(fileCli(backend), safe(id, 'container'), containerPath(path))
    } catch (err) {
      return { ok: false, path: String(path), error: (err as Error).message }
    }
  })
  handle('containers:readFile', async (_e, backend: string, id: string, path: string) => {
    try {
      return await readFilePreview(fileCli(backend), safe(id, 'container'), containerPath(path))
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  handle('containers:saveFile', async (e, backend: string, id: string, path: string) => {
    try {
      const p = containerPath(path)
      const cli = fileCli(backend)
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = { defaultPath: join(app.getPath('downloads'), posix.basename(p) || 'file') }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return null
      const saved = await saveFile(cli, safe(id, 'container'), p, r.filePath)
      return { ...saved, savedTo: r.filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  handle('containers:shellProfile', (_e, backend: string, id: string, name?: string) => {
    const c = containerRef(id)
    // The tab's title: the container's name (else its short id).
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : c.slice(0, 12)
    return cliProfile(backend, `container:${backend}:${c}`, `${label} (shell)`, [
      'exec',
      '-it',
      c,
      'sh',
      '-c',
      'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'
    ])
  })
  handle('containers:loginProfile', (_e, backend: string, registry: string) => {
    const r = String(registry ?? '').trim()
    return cliProfile(backend, `container-login:${backend}:${r || 'default'}`, `${backend} login${r ? ` ${r}` : ''}`, ['login', ...(r ? [registryRef(r)] : [])])
  })
}
