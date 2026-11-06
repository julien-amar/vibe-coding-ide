import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { parseWslPath } from '@shared/wsl-paths'
import { git } from './run'

/**
 * Notifies subscribed windows when a repository's refs change (commit,
 * checkout, fetch…). Local repos use a file watcher on `.git`; WSL repos (no
 * reliable file events over \\wsl.localhost) are polled.
 */
export class GitWatcher {
  private watchers = new Map<string, { stop: () => void; subscribers: Set<WebContents>; timer?: NodeJS.Timeout }>()

  private notify(root: string): void {
    const e = this.watchers.get(root)
    if (!e) return
    clearTimeout(e.timer)
    e.timer = setTimeout(() => e.subscribers.forEach((s) => !s.isDestroyed() && s.send('git:changed', root)), 300)
  }

  private start(root: string): (() => void) | undefined {
    if (parseWslPath(root)) {
      let last = ''
      let busy = false
      const poll = async (): Promise<void> => {
        if (busy) return
        busy = true
        try {
          const sig = await git(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']).then(
            async (refs) => refs + (await git(root, ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD']).catch(() => ''))
          )
          if (last && sig !== last) this.notify(root)
          last = sig
        } catch {
          /* repo temporarily unavailable */
        } finally {
          busy = false
        }
      }
      void poll()
      const iv = setInterval(() => void poll(), 4000)
      return () => clearInterval(iv)
    }
    const gitDir = join(root, '.git')
    if (!existsSync(gitDir)) return undefined
    let fsw: FSWatcher
    try {
      fsw = watch(gitDir, { recursive: true }, (_event, filename) => {
        const f = String(filename ?? '').replace(/\\/g, '/')
        // Ref movements matter for the log; the index for the changes view.
        if (f === 'HEAD' || f === 'index' || f === 'packed-refs' || f.startsWith('refs/') || f === 'FETCH_HEAD' || f === 'ORIG_HEAD') this.notify(root)
      })
    } catch {
      return undefined // recursive watch unsupported: manual refresh only
    }
    return () => fsw.close()
  }

  watch(root: string, wc: WebContents): void {
    let entry = this.watchers.get(root)
    if (!entry) {
      const stop = this.start(root)
      if (!stop) return
      entry = { stop, subscribers: new Set() }
      this.watchers.set(root, entry)
    }
    if (!entry.subscribers.has(wc)) {
      entry.subscribers.add(wc)
      wc.once('destroyed', () => this.unwatch(root, wc))
    }
  }

  unwatch(root: string, wc: WebContents): void {
    const entry = this.watchers.get(root)
    if (!entry) return
    entry.subscribers.delete(wc)
    if (entry.subscribers.size === 0) {
      clearTimeout(entry.timer)
      entry.stop()
      this.watchers.delete(root)
    }
  }
}
