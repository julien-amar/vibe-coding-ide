import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { WebContents } from 'electron'
import * as pty from 'node-pty'
import type { PackageUpdateInfo, Profile } from '@shared/types'
import { lastReportedCwd } from './shell-integration'
import { emit } from './ipc'

/** Max bytes of output kept per session, replayed when a window (re)attaches. */
const MAX_BUFFER = 1024 * 1024

interface Session {
  id: string
  profile: Profile
  proc: pty.IPty
  chunks: string[]
  size: number
  subscribers: Set<WebContents>
  exitCode?: number
  /** Working directory last reported by the shell (OSC 7 / OSC 9;9). */
  cwd?: string
}

/**
 * Owns all PTY sessions. Sessions live here, independent of any window, so a
 * tab can later be moved to another window without losing its process.
 */
export class PtyManager {
  private sessions = new Map<string, Session>()

  create(profile: Profile, cols: number, rows: number, owner: WebContents, cwd?: string): string {
    const id = randomUUID()
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'vibe-coding-ide', ...profile.env } as Record<string, string>
    const proc = pty.spawn(profile.command, profile.args, {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1),
      cwd: cwd ?? homedir(),
      env
    })
    const session: Session = { id, profile, proc, chunks: [], size: 0, subscribers: new Set() }
    this.sessions.set(id, session)
    this.subscribe(session, owner)

    proc.onData((data) => {
      if (data.includes('\x1b]')) session.cwd = lastReportedCwd(data) ?? session.cwd
      session.chunks.push(data)
      session.size += data.length
      while (session.size > MAX_BUFFER && session.chunks.length > 1) {
        session.size -= session.chunks.shift()!.length
      }
      for (const wc of session.subscribers) emit(wc, 'pty:data', id, data)
    })
    proc.onExit(({ exitCode }) => {
      session.exitCode = exitCode
      for (const wc of session.subscribers) emit(wc, 'pty:exit', id, exitCode)
      this.sessions.delete(id)
    })
    return id
  }

  private subscribe(session: Session, wc: WebContents): void {
    if (session.subscribers.has(wc)) return
    session.subscribers.add(wc)
    wc.once('destroyed', () => session.subscribers.delete(wc))
  }

  /** Only windows subscribed to a session may drive it. */
  private owned(id: string, wc: WebContents): Session | undefined {
    const s = this.sessions.get(id)
    return s && s.subscribers.has(wc) ? s : undefined
  }

  /** Move a session from one window to another (tab drag between windows). */
  transfer(id: string, from: WebContents, to: WebContents): boolean {
    const s = this.owned(id, from)
    if (!s) return false
    s.subscribers.delete(from)
    this.subscribe(s, to)
    return true
  }

  /** A session's pending package updates, to the windows showing it. */
  notifyUpdates(id: string, info: PackageUpdateInfo): void {
    for (const wc of this.sessions.get(id)?.subscribers ?? []) emit(wc, 'pty:updates', id, info)
  }

  /** Whether a window may act on a session (it shows it). */
  isSubscribed(id: string, wc: WebContents): boolean {
    return !!this.owned(id, wc)
  }

  cwd(id: string): string | undefined {
    return this.sessions.get(id)?.cwd
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  /** Last `maxBytes` of output, cut at a line boundary (for saving scrollback). */
  tail(id: string, maxBytes = 128 * 1024): string {
    const s = this.sessions.get(id)
    if (!s) return ''
    const all = s.chunks.join('')
    if (all.length <= maxBytes) return all
    const cut = all.indexOf('\n', all.length - maxBytes)
    return cut < 0 ? '' : all.slice(cut + 1)
  }

  attach(id: string, wc: WebContents): string {
    const s = this.owned(id, wc)
    return s ? s.chunks.join('') : ''
  }

  write(id: string, data: string, wc: WebContents): void {
    this.owned(id, wc)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number, wc: WebContents): void {
    const s = this.owned(id, wc)
    if (!s || cols < 2 || rows < 1) return
    try {
      s.proc.resize(Math.floor(cols), Math.floor(rows))
    } catch {
      /* process may have just exited */
    }
  }

  kill(id: string, wc: WebContents): void {
    const s = this.owned(id, wc)
    if (!s) return
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
    this.sessions.delete(id)
  }

  /** Kill sessions no window is subscribed to anymore (e.g. window closed). */
  reapOrphans(): void {
    for (const s of this.sessions.values()) {
      if (s.subscribers.size === 0) {
        try {
          s.proc.kill()
        } catch {
          /* ignore */
        }
        this.sessions.delete(s.id)
      }
    }
  }

  killAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.proc.kill()
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear()
  }
}
