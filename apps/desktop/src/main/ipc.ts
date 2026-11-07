import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { IpcArgs, IpcChannel, IpcEvent, IpcEvents, IpcResult } from '@shared/ipc'

/**
 * The main process side of the window contract (shared/ipc.ts): handlers and events typed by
 * channel. Arguments still come from a window: handlers check them (ids, paths, options).
 */

/** A request with a reply (ipcRenderer.invoke). */
export function handle<C extends IpcChannel>(channel: C, fn: (e: IpcMainInvokeEvent, ...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>): void {
  ipcMain.handle(channel, (e, ...args) => fn(e, ...(args as IpcArgs<C>)))
}

/** A one-way message (ipcRenderer.send). */
export function listen<C extends IpcChannel>(channel: C, fn: (e: IpcMainEvent, ...args: IpcArgs<C>) => void): void {
  ipcMain.on(channel, (e, ...args) => fn(e, ...(args as IpcArgs<C>)))
}

/** An event to a window (skipped if the window is gone). */
export function emit<E extends IpcEvent>(wc: WebContents, event: E, ...args: IpcEvents[E]): void {
  if (!wc.isDestroyed()) wc.send(event, ...args)
}
