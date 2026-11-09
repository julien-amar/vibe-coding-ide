import { useEffect, useState } from 'react'
import type { AgentHarnessSupport, Harness } from '@shared/types'
import { InstructionsView } from './HarnessInstructions'
import { McpView } from './HarnessMcp'
import { Modal } from './Modal'
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

  const save = async (next: Harness): Promise<void> => onChange(next)
  const current = support.find((s) => s.agent === agentId)
  const enabledServers = harness.mcpServers.filter((s) => s.enabled).length
  const enabledSkills = harness.skills.filter((s) => s.enabled).length

  // Keyboard focus starts in the dialog; Esc closes it, except inside an open server form (Esc closes the form).
  return (
    <Modal
      label={`${agent} settings`}
      className="dialog harness-dialog"
      onClose={onClose}
      focusDialog
      onEscape={(e) => e.target instanceof Element && !!e.target.closest('.harness-editor')}
    >
      <div className="harness-dialog-head">
        <strong>{agent} settings</strong>
        <span className="spacer" />
        <button className="icon-button pane-action" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {stale && (
        <div className="harness-stale" role="status">
          <span>The agent runs with the previous settings. Restart it to apply the changes (the conversation starts over).</span>
          <button className="tool-button primary" onClick={onRestart}>
            Restart agent
          </button>
        </div>
      )}
      <div className="pane-toolbar harness-toolbar">
        <div className="subtabs" role="tablist" aria-label="Agent settings">
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
      <div className="harness-body">
        {view === 'mcp' && <McpView root={root} harness={harness} save={save} support={current} />}
        {view === 'skills' && <SkillsView root={root} harness={harness} save={save} support={current} />}
        {view === 'instructions' && <InstructionsView harness={harness} save={save} />}
      </div>
    </Modal>
  )
}
