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
  app: {
    openExternal: (url) => ipcRenderer.send('app:openExternal', url)
  }
}

contextBridge.exposeInMainWorld('devhub', api)
