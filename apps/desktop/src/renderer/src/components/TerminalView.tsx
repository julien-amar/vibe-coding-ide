import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { PackageUpdateInfo } from '@shared/types'
import { onSessionData, onSessionExit } from '../pty-bus'
import { handleAppShortcut } from '../shortcuts'

const darkTheme: ITheme = {
  background: '#0c0c0c',
  foreground: '#cccccc',
  cursor: '#ffffff',
  selectionBackground: '#3a3d41',
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
  blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2'
}

const lightTheme: ITheme = {
  ...darkTheme,
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  selectionBackground: '#add6ff',
  white: '#6e6e6e',
  brightWhite: '#1a1a1a',
  brightYellow: '#986f00'
}

const media = window.matchMedia('(prefers-color-scheme: dark)')
const currentTheme = (): ITheme => (media.matches ? darkTheme : lightTheme)

async function copySelection(term: Terminal): Promise<boolean> {
  const text = term.getSelection()
  if (!text) return false
  await navigator.clipboard.writeText(text)
  term.clearSelection()
  return true
}

async function paste(term: Terminal): Promise<void> {
  const text = await navigator.clipboard.readText()
  if (text) term.paste(text)
}

export interface TerminalViewProps {
  sessionId: string
  /** Output saved from a previous app session, shown above the new shell. */
  restoredScrollback?: string
  /** The containing tab is shown (refit when it becomes visible). */
  visible: boolean
  /** Take keyboard focus when `visible` becomes true. */
  autoFocus?: boolean
  onTitle?: (title: string) => void
}

export function TerminalView({ sessionId, restoredScrollback, visible, autoFocus = true, onTitle }: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle

  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: currentTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.devhub.app.openExternal(uri)))
    term.open(host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* fall back to the DOM renderer */
    }
    termRef.current = term
    if (window.devhub.debug) (host as unknown as { __xterm: Terminal }).__xterm = term // debugging aid (DevTools checks)
    fitRef.current = fit

    term.attachCustomKeyEventHandler((e) => {
      if (handleAppShortcut(e)) return false
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      const ctrl = e.ctrlKey || e.metaKey
      // Ctrl+Shift+C / Ctrl+C with a selection copies; Ctrl+Shift+V / Ctrl+V pastes.
      if (ctrl && key === 'c' && (e.shiftKey || term.hasSelection())) {
        void copySelection(term)
        return false
      }
      if (ctrl && key === 'v') {
        void paste(term)
        return false
      }
      return true
    })

    host.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      void copySelection(term).then((copied) => {
        if (!copied) void paste(term)
      })
    })

    // Replay buffered output, dropping live events received before the snapshot
    // (they are already contained in it).
    let attached = false
    const offData = onSessionData(sessionId, (data) => {
      if (attached) term.write(data)
    })
    void window.devhub.pty.attach(sessionId).then((buffer) => {
      if (buffer) term.write(buffer)
      attached = true
    })
    const offExit = onSessionExit((id, code) => {
      if (id === sessionId) term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
    })

    const dataSub = term.onData((d) => window.devhub.pty.write(sessionId, d))
    const resizeSub = term.onResize(({ cols, rows }) => window.devhub.pty.resize(sessionId, cols, rows))
    const titleSub = term.onTitleChange((t) => onTitleRef.current?.(t))

    const doFit = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit()
        } catch {
          /* not ready */
        }
      }
    }
    const ro = new ResizeObserver(() => requestAnimationFrame(doFit))
    ro.observe(host)
    doFit()

    // Output saved from the previous app session: show it, then push it into the
    // scrollback so the new shell starts on a clean screen below it. Done after the
    // first fit so term.rows is the real height (and before the attach buffer,
    // which is written asynchronously).
    if (restoredScrollback) {
      term.write(restoredScrollback)
      // Leave any alternate screen (1047, unlike 1049, keeps the cursor), show the
      // cursor, reset colors, then print a marker.
      term.write('\x1b[?1047l\x1b[?25h\x1b[0m\r\n\x1b[90m── restored from previous session ──\x1b[0m\r\n')
      term.write('\r\n'.repeat(term.rows) + '\x1b[H')
    }

    const onScheme = (): void => {
      term.options.theme = currentTheme()
    }
    media.addEventListener('change', onScheme)

    return () => {
      media.removeEventListener('change', onScheme)
      ro.disconnect()
      offData()
      offExit()
      dataSub.dispose()
      resizeSub.dispose()
      titleSub.dispose()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      if (autoFocus) termRef.current?.focus()
    })
  }, [visible, autoFocus])

  return (
    <div className="terminal-view">
      <div ref={hostRef} className="terminal-host" />
      <UpdateBar sessionId={sessionId} onAccept={() => termRef.current?.focus()} />
    </div>
  )
}

/**
 * Status bar under a terminal when its system (Windows via winget, or the WSL
 * distribution) has package updates, checked once when the shell starts.
 * "Update now" types the update command into the terminal, where the user sees
 * the progress and answers prompts (sudo password, UAC); × hides the bar.
 */
function UpdateBar({ sessionId, onAccept }: { sessionId: string; onAccept: () => void }): React.JSX.Element | null {
  const [info, setInfo] = useState<PackageUpdateInfo | null>(null)

  useEffect(() => {
    let alive = true
    setInfo(null)
    // Already known (e.g. the tab moved to another window), or arriving once the check finishes.
    void window.devhub.pty.updates(sessionId).then((i) => alive && i && setInfo(i))
    const off = window.devhub.pty.onUpdates((id, i) => {
      if (id === sessionId) setInfo(i)
    })
    return () => {
      alive = false
      off()
    }
  }, [sessionId])

  if (!info) return null

  const close = (accepted: boolean): void => {
    window.devhub.pty.dismissUpdates(sessionId, accepted)
    setInfo(null)
  }

  return (
    <div className="update-bar" role="status">
      <span className="update-icon" aria-hidden>
        ⬆
      </span>
      <span className="update-text">
        {info.count} package update{info.count > 1 ? 's' : ''} available for <strong>{info.system}</strong>
        <span className="muted"> ({info.manager})</span>
      </span>
      <button
        className="link-button"
        title={`Runs in this terminal: ${info.command}`}
        onClick={() => {
          window.devhub.pty.write(sessionId, `${info.command}\r`)
          close(true)
          onAccept()
        }}
      >
        Update now
      </button>
      <span className="spacer" />
      <button className="icon-button" title="Dismiss" aria-label="Dismiss update notice" onClick={() => close(false)}>
        ×
      </button>
    </div>
  )
}
