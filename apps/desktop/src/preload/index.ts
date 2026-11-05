import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DevHubApi } from '@shared/types'

const api: DevHubApi = {
  platform: process.platform,
  profiles: {
    list: (refresh) => ipcRenderer.invoke('profiles:list', refresh)
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
    pickFolder: () => ipcRenderer.invoke('project:pickFolder'),
    recent: () => ipcRenderer.invoke('project:recent'),
    touch: (root) => ipcRenderer.send('project:touch', root)
  },
  git: {
    log: (root) => ipcRenderer.invoke('git:log', root),
    watch: (root) => ipcRenderer.send('git:watch', root),
    unwatch: (root) => ipcRenderer.send('git:unwatch', root),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, root: string): void => cb(root)
      ipcRenderer.on('git:changed', listener)
      return () => ipcRenderer.off('git:changed', listener)
    }
  },
  app: {
    openExternal: (url) => ipcRenderer.send('app:openExternal', url)
  }
}

contextBridge.exposeInMainWorld('devhub', api)
