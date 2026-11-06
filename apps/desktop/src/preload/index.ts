import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppSettings, IdeApi, PackageUpdateInfo, TestResult, UpdateStatus } from '@shared/types'

const api: IdeApi = {
  platform: process.platform,
  debug: process.argv.includes('--vibe-coding-ide-debug'),
  profiles: {
    list: (refresh) => ipcRenderer.invoke('profiles:list', refresh),
    all: () => ipcRenderer.invoke('profiles:all'),
    icon: (id) => ipcRenderer.invoke('profiles:icon', id),
    wslAgents: (distro) => ipcRenderer.invoke('profiles:wslAgents', distro)
  },
  pty: {
    create: (req) => ipcRenderer.invoke('pty:create', req),
    attach: (id) => ipcRenderer.invoke('pty:attach', id),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string, data: string): void => cb(id, data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.off('pty:data', listener)
    },
    onExit: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string, code: number): void => cb(id, code)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.off('pty:exit', listener)
    },
    updates: (id) => ipcRenderer.invoke('pty:updates', id),
    dismissUpdates: (id, accepted) => ipcRenderer.send('pty:dismissUpdates', id, accepted),
    onUpdates: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string, info: PackageUpdateInfo): void => cb(id, info)
      ipcRenderer.on('pty:updates', listener)
      return () => ipcRenderer.off('pty:updates', listener)
    }
  },
  window: {
    init: () => ipcRenderer.invoke('window:init'),
    reportState: (state) => ipcRenderer.send('window:state', state),
    detachTab: (tab, x, y) => ipcRenderer.invoke('window:detach', tab, x, y),
    adoptTab: (tab, fromWindowId) => ipcRenderer.invoke('window:adopt', tab, fromWindowId),
    onTabTransferred: (cb) => {
      const listener = (_e: IpcRendererEvent, key: string): void => cb(key)
      ipcRenderer.on('window:tabTransferred', listener)
      return () => ipcRenderer.off('window:tabTransferred', listener)
    },
    close: () => ipcRenderer.send('window:close')
  },
  project: {
    pickFolder: (defaultPath) => ipcRenderer.invoke('project:pickFolder', defaultPath),
    recent: () => ipcRenderer.invoke('project:recent'),
    touch: (root) => ipcRenderer.send('project:touch', root),
    forget: (root) => ipcRenderer.invoke('project:forget', root)
  },
  git: {
    log: (root) => ipcRenderer.invoke('git:log', root),
    op: (root, req) => ipcRenderer.invoke('git:op', root, req),
    watch: (root) => ipcRenderer.send('git:watch', root),
    unwatch: (root) => ipcRenderer.send('git:unwatch', root),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, root: string): void => cb(root)
      ipcRenderer.on('git:changed', listener)
      return () => ipcRenderer.off('git:changed', listener)
    }
  },
  tests: {
    discover: (root) => ipcRenderer.invoke('tests:discover', root),
    run: (root, req) => ipcRenderer.invoke('tests:run', root, req),
    stop: (root) => ipcRenderer.send('tests:stop', root),
    onOutput: (cb) => {
      const listener = (_e: IpcRendererEvent, root: string, text: string): void => cb(root, text)
      ipcRenderer.on('tests:output', listener)
      return () => ipcRenderer.off('tests:output', listener)
    },
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, root: string, projectId: string, result: TestResult): void => cb(root, projectId, result)
      ipcRenderer.on('tests:progress', listener)
      return () => ipcRenderer.off('tests:progress', listener)
    }
  },
  harness: {
    check: (root, server) => ipcRenderer.invoke('harness:check', root, server),
    skills: (root, harness) => ipcRenderer.invoke('harness:skills', root, harness),
    readSkill: (path) => ipcRenderer.invoke('harness:readSkill', path),
    pickSkillFolder: (root) => ipcRenderer.invoke('harness:pickSkillFolder', root),
    projectMcpServers: (root) => ipcRenderer.invoke('harness:projectMcp', root),
    support: () => ipcRenderer.invoke('harness:support')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    reset: () => ipcRenderer.invoke('settings:reset'),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, s: AppSettings): void => cb(s)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.off('settings:changed', listener)
    }
  },
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    onStatus: (cb) => {
      const listener = (_e: IpcRendererEvent, s: UpdateStatus): void => cb(s)
      ipcRenderer.on('update:status', listener)
      return () => ipcRenderer.off('update:status', listener)
    },
    check: () => ipcRenderer.send('update:check'),
    install: () => ipcRenderer.send('update:install')
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url) => ipcRenderer.send('app:openExternal', url),
    openInEditor: (root, file, line, column, base) => ipcRenderer.invoke('app:openInEditor', root, file, line, column, base)
  }
}

contextBridge.exposeInMainWorld('ide', api)
