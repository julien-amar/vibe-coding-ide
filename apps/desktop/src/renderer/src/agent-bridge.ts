import { panesOf, type PaneNode } from '@shared/layout'
import { onSessionData } from './pty-bus'
import { useTabs } from './store'

/**
 * Hands text to the AI agent panel of a project tab (e.g. "Fix with agent" in
 * the Tests panel): uses the running agent, or opens an agent panel and waits
 * for it to be ready; shows the panel if it is collapsed.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolves once the session has printed nothing for `quietMs` (or after `maxMs`). */
function quiet(sessionId: string, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quietMs)
    const max = setTimeout(done, maxMs)
    const off = onSessionData(sessionId, () => {
      clearTimeout(timer)
      timer = setTimeout(done, quietMs)
    })
    function done(): void {
      off()
      clearTimeout(timer)
      clearTimeout(max)
      resolve()
    }
  })
}

/** Bracketed paste: the agent receives multi-line text as one message (not one per line). */
export const pasteSequence = (text: string): string => `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`

export async function sendToAgent(tabId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const state = useTabs.getState()
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab?.project) return { ok: false, error: 'Not a project tab.' }
  const running = (p: PaneNode): boolean => p.type === 'agent' && !!p.sessionId && state.paneExit[p.sessionId] === undefined

  let pane = panesOf(tab.project.layout).find(running)
  let fresh = false
  if (!pane) {
    const before = new Set(panesOf(tab.project.layout).map((p) => p.id))
    await state.addPane(tabId, 'agent')
    const layout = useTabs.getState().tabs.find((t) => t.id === tabId)?.project?.layout
    pane = layout && panesOf(layout).find((p) => !before.has(p.id) && p.type === 'agent')
    if (!pane?.sessionId) return { ok: false, error: 'No AI agent CLI found on PATH (claude, codex, gemini, opencode, pi).' }
    fresh = true
  }
  if (pane.collapsed) useTabs.getState().setPaneCollapsed(tabId, pane.id, false)

  const sessionId = pane.sessionId!
  // A new agent needs a moment to start and draw its prompt before it reads input.
  if (fresh) {
    await sleep(2500)
    await quiet(sessionId, 1200, 20_000)
  }
  window.ide.pty.write(sessionId, pasteSequence(text))
  // Submit separately: some agents ignore an Enter that arrives within the paste.
  await sleep(300)
  window.ide.pty.write(sessionId, '\r')
  return { ok: true }
}
