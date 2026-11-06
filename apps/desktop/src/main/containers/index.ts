import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IpcMain, WebContents } from 'electron'
import type { ContainerAction, ContainerBackendId, ContainerJob, ContainerListKind, ContainerStreamEvent, ContainerTarget, Profile } from '@shared/types'
import { directLaunch } from '../harness'
import { launchSpec, registerProfile } from '../profiles'
import { killTree } from '../tests/core'
import type { ContainerBackend } from './backend'
import { EngineBackend } from './engine-backend'
import { WslcBackend } from './wslc-backend'

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

/** Ids, names and references from the renderer: no option injection into CLI commands. */
const safe = (v: unknown, what: string): string => {
  const s = String(v ?? '').trim()
  if (!s || s.startsWith('-') || /[\0\r\n]/.test(s)) throw new Error(`Invalid ${what}`)
  return s
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
    case 'compose': {
      if (backend === 'wslc') throw new Error('wslc has no Compose.')
      if (!['up', 'down', 'restart', 'pull', 'stop'].includes(job.action)) throw new Error('Invalid Compose action')
      return ['compose', '-p', safe(job.project, 'project'), ...many('-f', job.configFiles), ...(job.action === 'up' ? ['up', '-d'] : [job.action])]
    }
  }
}

export function registerContainerIpc(ipcMain: IpcMain): void {
  /** Running streams: id → stop. */
  const streams = new Map<string, () => void>()
  let next = 1

  const startStream = (
    wc: WebContents,
    start: (id: string, send: (e: ContainerStreamEvent) => void, end: (code?: number, error?: string) => void) => Promise<() => void>
  ): string => {
    const id = `cs-${next++}`
    const send = (e: ContainerStreamEvent): void => {
      if (!wc.isDestroyed()) wc.send('containers:stream', e)
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

  ipcMain.handle('containers:backends', () => Promise.all(Object.values(backends).map((b) => b.info())))

  ipcMain.handle('containers:list', async (_e, backend: string, kind: string) => {
    try {
      if (!KINDS.has(kind as ContainerListKind)) throw new Error('Invalid list')
      return await backendOf(backend).list(kind as ContainerListKind)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('containers:action', async (_e, backend: string, target: string, id: string, action: string) => {
    try {
      if (!TARGETS.has(target as ContainerTarget) || !ACTIONS.has(action as ContainerAction)) throw new Error('Invalid action')
      await backendOf(backend).action(target as ContainerTarget, safe(id, 'id'), action as ContainerAction)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('containers:prune', async (_e, backend: string, target: string) => {
    try {
      if (!TARGETS.has(target as ContainerTarget)) throw new Error('Invalid target')
      return { ok: true, text: await backendOf(backend).prune(target as ContainerTarget) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('containers:create', async (_e, backend: string, target: string, name: string) => {
    try {
      if (target !== 'volume' && target !== 'network') throw new Error('Invalid target')
      await backendOf(backend).create(target, safe(name, 'name'))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('containers:inspect', async (_e, backend: string, target: string, id: string) => {
    try {
      if (!TARGETS.has(target as ContainerTarget)) throw new Error('Invalid target')
      return { ok: true, text: await backendOf(backend).inspect(target as ContainerTarget, safe(id, 'id')) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('containers:logs', (e, backend: string, id: string) =>
    startStream(e.sender, async (sid, send, end) => {
      return backendOf(backend).logs(
        safe(id, 'id'),
        (text) => send({ stream: sid, kind: 'text', text }),
        (error) => end(undefined, error)
      )
    })
  )

  ipcMain.handle('containers:stats', (e, backend: string, id: string) =>
    startStream(e.sender, async (sid, send, end) => {
      return backendOf(backend).stats(
        safe(id, 'id'),
        (stats) => send({ stream: sid, kind: 'stats', stats }),
        (error) => end(undefined, error)
      )
    })
  )

  ipcMain.handle('containers:job', (e, backend: string, job: ContainerJob) =>
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

  ipcMain.on('containers:stopStream', (_e, id: string) => streams.get(String(id))?.())

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
  ipcMain.handle('containers:shellProfile', (_e, backend: string, id: string, name?: string) => {
    const c = safe(id, 'container')
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
  ipcMain.handle('containers:loginProfile', (_e, backend: string, registry: string) => {
    const r = String(registry ?? '').trim()
    return cliProfile(backend, `container-login:${backend}:${r || 'default'}`, `${backend} login${r ? ` ${r}` : ''}`, [
      'login',
      ...(r ? [safe(r, 'registry')] : [])
    ])
  })
}
