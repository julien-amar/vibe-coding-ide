import { useEffect, useState } from 'react'
import type { ContainerBackendId } from '@shared/types'
import { TerminalView } from '../TerminalView'
import { ENGINE_LABEL } from './model'

// ---------------------------------------------------------------------------
// Terminal: a shell in the selected container (`exec -it … sh`), inside the tab

export function ContainerTerminal({
  backend,
  id,
  name,
  visible
}: {
  backend: ContainerBackendId
  id: string
  name: string
  visible: boolean
}): React.JSX.Element {
  const [session, setSession] = useState<string>()
  const [error, setError] = useState<string>()
  const [ended, setEnded] = useState<number>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    let sid: string | undefined
    setSession(undefined)
    setEnded(undefined)
    void (async () => {
      const profile = await window.ide.containers.shellProfile(backend, id, name)
      if (!profile) {
        if (alive) setError(`The ${ENGINE_LABEL[backend]} command line tool is not installed.`)
        return
      }
      try {
        const s = await window.ide.pty.create({ profileId: profile.id, cols: 80, rows: 24, panel: true })
        sid = s.sessionId
        if (alive) setSession(sid)
        else window.ide.pty.kill(sid)
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
    })()
    const off = window.ide.pty.onExit((s, code) => {
      if (s === sid && alive) setEnded(code)
    })
    return () => {
      alive = false
      off()
      if (sid) window.ide.pty.kill(sid)
    }
  }, [backend, id, name, attempt])
  return (
    <div className="ctr-terminal" hidden={!visible}>
      {(ended !== undefined || error) && (
        <div className="ctr-output-head">
          <span className="muted">{error ?? `The shell ended (exit ${ended}).`}</span>
          <button
            className="tool-button"
            onClick={() => {
              setError(undefined)
              setAttempt((a) => a + 1)
            }}
          >
            New shell
          </button>
        </div>
      )}
      {session && ended === undefined && (
        <div className="ctr-terminal-host">
          <TerminalView key={session} sessionId={session} visible={visible} />
        </div>
      )}
    </div>
  )
}
