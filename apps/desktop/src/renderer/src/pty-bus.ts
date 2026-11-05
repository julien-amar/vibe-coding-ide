/** Single IPC listener fanning PTY events out to per-session handlers. */
type DataHandler = (data: string) => void
type ExitHandler = (sessionId: string, code: number) => void

const dataHandlers = new Map<string, Set<DataHandler>>()
const exitHandlers = new Set<ExitHandler>()

window.ide.pty.onData((id, data) => {
  dataHandlers.get(id)?.forEach((h) => h(data))
})
window.ide.pty.onExit((id, code) => {
  exitHandlers.forEach((h) => h(id, code))
})

export function onSessionData(sessionId: string, handler: DataHandler): () => void {
  let set = dataHandlers.get(sessionId)
  if (!set) dataHandlers.set(sessionId, (set = new Set()))
  set.add(handler)
  return () => {
    set!.delete(handler)
    if (set!.size === 0) dataHandlers.delete(sessionId)
  }
}

export function onSessionExit(handler: ExitHandler): () => void {
  exitHandlers.add(handler)
  return () => exitHandlers.delete(handler)
}
