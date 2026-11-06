import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentHarnessSupport, Harness } from '@shared/types'
import { InstructionsView } from './HarnessInstructions'
import { McpView } from './HarnessMcp'
import { SkillsView } from './HarnessSkills'

type View = 'mcp' | 'skills' | 'instructions'

/**
 * Settings of one AI agent pane (opened from its ⚙ button): the MCP servers,
 * skills and instructions this agent gets — its own, independent of the other
 * panes and projects (kept with the pane, not in the repository). Changes are
 * saved at once; the running agent keeps the previous settings until restarted.
 */
export function HarnessDialog({
  root,
  agent,
  agentId,
  harness,
  stale,
  onChange,
  onRestart,
  onClose
}: {
  root: string
  /** The pane's agent, for the title. */
  agent: string
  /** The agent's id ("claude", "codex"…): what it supports of these settings. */
  agentId?: string
  harness: Harness
  /** The running agent started with older settings. */
  stale: boolean
  onChange: (h: Harness) => void
  onRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  const [view, setView] = useState<View>('mcp')
  const [support, setSupport] = useState<AgentHarnessSupport[]>([])
  useEffect(() => {
    void window.ide.harness.support().then(setSupport)
  }, [])
  // Keyboard focus starts in the dialog. Esc closes it wherever the focus is (a button that went
  // away, a terminal behind): caught before anything else, except inside an open server form,
  // where Esc only closes the form.
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || (e.target instanceof Element && e.target.closest('.harness-editor'))) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const save = async (next: Harness): Promise<void> => onChange(next)
  const current = support.find((s) => s.agent === agentId)
  const enabledServers = harness.mcpServers.filter((s) => s.enabled).length
  const enabledSkills = harness.skills.filter((s) => s.enabled).length

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog harness-dialog" role="dialog" aria-modal="true" aria-label={`${agent} settings`} tabIndex={-1}>
        <div className="harness-dialog-head">
          <strong>{agent} settings</strong>
          <span className="muted">— this panel only</span>
          <span className="spacer" />
          <button className="icon-button pane-action" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="pane-toolbar harness-toolbar">
          <div className="segmented" role="tablist">
            <button role="tab" aria-selected={view === 'mcp'} className={view === 'mcp' ? 'active' : ''} onClick={() => setView('mcp')}>
              MCP servers <span className="count">{enabledServers}</span>
            </button>
            <button role="tab" aria-selected={view === 'skills'} className={view === 'skills' ? 'active' : ''} onClick={() => setView('skills')}>
              Skills <span className="count">{enabledSkills}</span>
            </button>
            <button
              role="tab"
              aria-selected={view === 'instructions'}
              className={view === 'instructions' ? 'active' : ''}
              onClick={() => setView('instructions')}
            >
              Instructions {harness.instructions.trim() ? <span className="harness-dot" aria-label="set" /> : null}
            </button>
          </div>
        </div>
        <AgentSupport agent={agent} current={current} />
        {stale && (
          <div className="harness-stale" role="status">
            <span>The agent runs with the previous settings. Restart it to apply the changes (the conversation starts over).</span>
            <button className="tool-button primary" onClick={onRestart}>
              Restart agent
            </button>
          </div>
        )}
        <div className="harness-body">
          {view === 'mcp' && <McpView root={root} harness={harness} save={save} support={current} />}
          {view === 'skills' && <SkillsView root={root} harness={harness} save={save} support={current} />}
          {view === 'instructions' && <InstructionsView harness={harness} save={save} />}
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * What this panel's agent gets of the settings (each part ✓ / ✗, and how or why), so nothing is
 * silently left out.
 */
function AgentSupport({ agent, current }: { agent: string; current?: AgentHarnessSupport }): React.JSX.Element {
  if (!current) {
    return (
      <div className="harness-support-line none" role="note">
        These settings are not given to {agent}: vibe-coding-ide does not know how to pass them to this agent.
      </div>
    )
  }
  const part = (label: string, ok: boolean): React.JSX.Element => (
    <span className={ok ? 'ok' : 'no'} title={`${label}: ${ok ? 'given to the agent' : 'not given to the agent'}`}>
      {ok ? '✓' : '✗'} {label}
    </span>
  )
  const nothing = !current.mcp && !current.skills && !current.instructions
  return (
    <div className={`harness-support-line${nothing ? ' none' : ''}`} role="note">
      <strong>{current.label}:</strong>
      {part('MCP servers', current.mcp)}
      {part('skills', current.skills)}
      {part('instructions', current.instructions)}
      {current.note && <span className="muted">— {current.note}</span>}
    </div>
  )
}
