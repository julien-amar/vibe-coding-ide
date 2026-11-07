import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

const { emit, handle, listen } = await import('./ipc')

/**
 * The window contract is enforced by the compiler: each line marked @ts-expect-error must stay an
 * error (the typecheck fails otherwise). Never called: only compiled.
 */
export function contractMistakes(wc: WebContents): void {
  // @ts-expect-error a misspelt channel
  handle('containers:lst', () => ({ ok: true }))
  // @ts-expect-error a wrong reply (list replies with a ContainerListResult)
  handle('containers:list', () => 42)
  // @ts-expect-error a wrong argument type (a container id is a string)
  handle('containers:spec', (_e, _backend, _id: number) => ({ ok: true }))
  // @ts-expect-error a wrong argument type on a one-way message (columns are a number)
  listen('pty:resize', (_e, _id, _cols: string) => undefined)
  // @ts-expect-error an unknown event
  emit(wc, 'git:changd', '/repo')
  // @ts-expect-error an event with wrong arguments (git:changed carries the repository root)
  emit(wc, 'git:changed', 1)
}

describe('ipc helpers', () => {
  it('emit skips a window that is gone', () => {
    const send = vi.fn()
    emit({ isDestroyed: () => true, send } as unknown as WebContents, 'git:changed', '/repo')
    expect(send).not.toHaveBeenCalled()
    emit({ isDestroyed: () => false, send } as unknown as WebContents, 'git:changed', '/repo')
    expect(send).toHaveBeenCalledWith('git:changed', '/repo')
  })
})
