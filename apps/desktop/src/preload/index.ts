import { contextBridge, ipcRenderer } from 'electron'
import type { IpcArgs, IpcChannel, IpcEvent, IpcEvents, IpcResult } from '@shared/ipc'
import type { IdeApi } from '@shared/types'

/** A request with a reply, typed by channel (shared/ipc.ts). */
const invoke = <C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> => ipcRenderer.invoke(channel, ...args)
/** A one-way message. */
const send = <C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): void => ipcRenderer.send(channel, ...args)
/** Listens to an event of the main process; returns the function that stops listening. */
function on<E extends IpcEvent>(event: E, cb: (...args: IpcEvents[E]) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...(args as IpcEvents[E]))
  ipcRenderer.on(event, listener)
  return () => ipcRenderer.off(event, listener)
}

const api: IdeApi = {
  platform: process.platform,
  debug: process.argv.includes('--vibe-coding-ide-debug'),
  profiles: {
    list: (refresh) => invoke('profiles:list', refresh),
    all: () => invoke('profiles:all'),
    icon: (id) => invoke('profiles:icon', id),
    wslAgents: (distro) => invoke('profiles:wslAgents', distro)
  },
  pty: {
    create: (req) => invoke('pty:create', req),
    attach: (id) => invoke('pty:attach', id),
    write: (id, data) => send('pty:write', id, data),
    resize: (id, cols, rows) => send('pty:resize', id, cols, rows),
    kill: (id) => send('pty:kill', id),
    onData: (cb) => on('pty:data', cb),
    onExit: (cb) => on('pty:exit', cb),
    updates: (id) => invoke('pty:updates', id),
    dismissUpdates: (id, accepted) => send('pty:dismissUpdates', id, accepted),
    onUpdates: (cb) => on('pty:updates', cb)
  },
  window: {
    init: () => invoke('window:init'),
    reportState: (state) => send('window:state', state),
    detachTab: (tab, x, y) => invoke('window:detach', tab, x, y),
    adoptTab: (tab, fromWindowId) => invoke('window:adopt', tab, fromWindowId),
    onTabTransferred: (cb) => on('window:tabTransferred', cb),
    close: () => send('window:close')
  },
  project: {
    pickFolder: (defaultPath) => invoke('project:pickFolder', defaultPath),
    recent: () => invoke('project:recent'),
    touch: (root) => send('project:touch', root),
    forget: (root) => invoke('project:forget', root)
  },
  git: {
    log: (root) => invoke('git:log', root),
    op: (root, req) => invoke('git:op', root, req),
    watch: (root) => send('git:watch', root),
    unwatch: (root) => send('git:unwatch', root),
    onChanged: (cb) => on('git:changed', cb)
  },
  tests: {
    discover: (root) => invoke('tests:discover', root),
    run: (root, req) => invoke('tests:run', root, req),
    stop: (root) => send('tests:stop', root),
    onOutput: (cb) => on('tests:output', cb),
    onProgress: (cb) => on('tests:progress', cb)
  },
  harness: {
    check: (root, server) => invoke('harness:check', root, server),
    skills: (root, harness) => invoke('harness:skills', root, harness),
    readSkill: (path) => invoke('harness:readSkill', path),
    pickSkillFolder: (root) => invoke('harness:pickSkillFolder', root),
    projectMcpServers: (root) => invoke('harness:projectMcp', root),
    support: () => invoke('harness:support')
  },
  containers: {
    backends: () => invoke('containers:backends'),
    list: (backend, kind) => invoke('containers:list', backend, kind),
    action: (backend, target, id, action) => invoke('containers:action', backend, target, id, action),
    prune: (backend, target) => invoke('containers:prune', backend, target),
    create: (backend, target, name, options) => invoke('containers:create', backend, target, name, options),
    inspect: (backend, target, id) => invoke('containers:inspect', backend, target, id),
    logs: (backend, id) => invoke('containers:logs', backend, id),
    stats: (backend, id) => invoke('containers:stats', backend, id),
    job: (backend, job) => invoke('containers:job', backend, job),
    stopStream: (stream) => send('containers:stopStream', stream),
    onStream: (cb) => on('containers:stream', cb),
    shellProfile: (backend, id, name) => invoke('containers:shellProfile', backend, id, name),
    loginProfile: (backend, registry) => invoke('containers:loginProfile', backend, registry),
    spec: (backend, id) => invoke('containers:spec', backend, id),
    recreate: (backend, id, change) => invoke('containers:recreate', backend, id, change),
    searchImages: (backend, input) => invoke('containers:searchImages', backend, input),
    listFiles: (backend, id, path) => invoke('containers:listFiles', backend, id, path),
    readFile: (backend, id, path) => invoke('containers:readFile', backend, id, path),
    saveFile: (backend, id, path) => invoke('containers:saveFile', backend, id, path)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    reset: () => invoke('settings:reset'),
    onChanged: (cb) => on('settings:changed', cb)
  },
  update: {
    status: () => invoke('update:status'),
    onStatus: (cb) => on('update:status', cb),
    check: () => send('update:check'),
    install: () => send('update:install')
  },
  app: {
    version: () => invoke('app:version'),
    openExternal: (url) => send('app:openExternal', url),
    openInEditor: (root, file, line, column, base) => invoke('app:openInEditor', root, file, line, column, base)
  }
}

contextBridge.exposeInMainWorld('ide', api)
