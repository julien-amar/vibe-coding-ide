import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentHarnessSupport, Harness, McpCheckResult, McpServer, SkillInfo } from '@shared/types'
import { formatPairs, joinArgs, parsePairs, skillPath, splitArgs } from '../harness-form'
import { notify } from './Dialogs'

type View = 'mcp' | 'skills' | 'instructions'

const emptyServer = (): McpServer => ({ name: '', transport: 'stdio', command: '', args: [], enabled: true })
export const emptyHarness = (): Harness => ({ mcpServers: [], skills: [], instructions: '' })

/** Number of things set in a harness (shown on the agent pane's settings button). */
export const harnessSize = (h?: Harness): number =>
  !h ? 0 : h.mcpServers.filter((s) => s.enabled).length + h.skills.filter((s) => s.enabled).length + (h.instructions.trim() ? 1 : 0)

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
      <div
        ref={dialogRef}
        className="dialog harness-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${agent} settings`}
        tabIndex={-1}
      >
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
            <button role="tab" aria-selected={view === 'instructions'} className={view === 'instructions' ? 'active' : ''} onClick={() => setView('instructions')}>
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
          {view === 'skills' && <SkillsView root={root} harness={harness} save={save} />}
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

// ---------------------------------------------------------------------------
// MCP servers

function McpView({
  root,
  harness,
  save,
  support
}: {
  root: string
  harness: Harness
  save: (h: Harness) => Promise<void>
  /** What the pane's agent supports (undefined: unknown agent). */
  support?: AgentHarnessSupport
}): React.JSX.Element {
  const canStrict = !support || support.strictMcp
  const [editing, setEditing] = useState<{ index: number; server: McpServer }>()
  const [checks, setChecks] = useState<Record<string, McpCheckResult | 'checking'>>({})
  const [expanded, setExpanded] = useState<string>()
  const [importable, setImportable] = useState<McpServer[]>([])

  useEffect(() => {
    void window.ide.harness.projectMcpServers(root).then((list) => setImportable(list.filter((s) => !harness.mcpServers.some((h) => h.name === s.name))))
  }, [root, harness.mcpServers])

  const servers = harness.mcpServers
  const setServers = (mcpServers: McpServer[]): Promise<void> => save({ ...harness, mcpServers })

  const check = async (s: McpServer): Promise<void> => {
    setChecks((c) => ({ ...c, [s.name]: 'checking' }))
    setExpanded(s.name)
    const r = await window.ide.harness.check(root, s)
    setChecks((c) => ({ ...c, [s.name]: r }))
  }

  return (
    <div className="harness-section">
      <div className="harness-actions">
        <button className="tool-button" onClick={() => setEditing({ index: -1, server: emptyServer() })} disabled={!!editing}>
          + Add server
        </button>
        {importable.length > 0 && (
          <button className="tool-button" title="Servers of the repository's .mcp.json" onClick={() => void setServers([...servers, ...importable])}>
            Import {importable.length} from .mcp.json
          </button>
        )}
        <span className="spacer" />
        <label
          className="harness-check"
          title={
            canStrict
              ? "The agent ignores other MCP configurations (yours, the repository's .mcp.json)"
              : `${support!.label} cannot be made to ignore its other MCP configurations`
          }
        >
          <input
            type="checkbox"
            checked={!!harness.strictMcp && canStrict}
            disabled={!canStrict}
            onChange={(e) => void save({ ...harness, strictMcp: e.target.checked || undefined })}
          />{' '}
          Only these servers
        </label>
      </div>

      {editing && (
        <ServerEditor
          server={editing.server}
          taken={servers.filter((_, i) => i !== editing.index).map((s) => s.name)}
          onCancel={() => setEditing(undefined)}
          onSave={(s) => {
            const next = editing.index < 0 ? [...servers, s] : servers.map((x, i) => (i === editing.index ? s : x))
            setEditing(undefined)
            void setServers(next)
          }}
        />
      )}

      {servers.length === 0 && !editing && (
        <p className="muted harness-empty">
          No MCP servers yet. Add one (a command the agent starts, or an HTTP endpoint)
          {importable.length ? ', or import the repository’s .mcp.json' : ''}.
        </p>
      )}

      <ul className="harness-list">
        {servers.map((s, i) => {
          const c = checks[s.name]
          return (
            <li key={s.name} className={`harness-item${s.enabled ? '' : ' disabled'}`}>
              <div className="harness-row">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  title={s.enabled ? 'Enabled: given to the agent' : 'Disabled'}
                  aria-label={`Enable ${s.name}`}
                  onChange={(e) => void setServers(servers.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
                />
                <span className="harness-name">{s.name}</span>
                <span className="harness-badge">{s.transport}</span>
                <span className="harness-detail" title={s.transport === 'stdio' ? `${s.command} ${joinArgs(s.args)}` : s.url}>
                  {s.transport === 'stdio' ? `${s.command} ${joinArgs(s.args)}` : s.url}
                </span>
                {c && c !== 'checking' && (
                  <button className={`harness-status ${c.ok ? 'ok' : 'bad'}`} onClick={() => setExpanded(expanded === s.name ? undefined : s.name)}>
                    {c.ok ? `✓ ${c.tools?.length ?? 0} tools` : '✗ failed'}
                  </button>
                )}
                {c === 'checking' && <span className="busy">checking…</span>}
                <button className="tool-button" disabled={c === 'checking'} title="Start the server and list its tools" onClick={() => void check(s)}>
                  Check
                </button>
                <button className="tool-button" onClick={() => setEditing({ index: i, server: s })} disabled={!!editing}>
                  Edit
                </button>
                <button className="icon-button pane-action" title={`Remove ${s.name}`} onClick={() => void setServers(servers.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
              {expanded === s.name && c && c !== 'checking' && (
                <div className="harness-check-result">
                  {c.ok ? (
                    <>
                      <div className="muted">
                        {c.server?.name ?? s.name}
                        {c.server?.version ? ` ${c.server.version}` : ''}
                      </div>
                      <ul className="harness-tools">
                        {(c.tools ?? []).map((t) => (
                          <li key={t.name}>
                            <code>{t.name}</code>
                            {t.description ? <span className="muted"> — {t.description}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <div className="harness-error">{c.error}</div>
                  )}
                  {c.log && <pre className="harness-log">{c.log}</pre>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ServerEditor({ server, taken, onSave, onCancel }: { server: McpServer; taken: string[]; onSave: (s: McpServer) => void; onCancel: () => void }): React.JSX.Element {
  const [name, setName] = useState(server.name)
  const [transport, setTransport] = useState(server.transport)
  const [command, setCommand] = useState(server.command ?? '')
  const [args, setArgs] = useState(joinArgs(server.args))
  const [env, setEnv] = useState(formatPairs(server.env, '='))
  const [url, setUrl] = useState(server.url ?? '')
  const [headers, setHeaders] = useState(formatPairs(server.headers, ':'))
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  const trimmed = name.trim()
  const error = !trimmed
    ? 'A name is needed.'
    : taken.includes(trimmed)
      ? 'Another server has this name.'
      : transport === 'stdio' && !command.trim()
        ? 'A command is needed.'
        : transport !== 'stdio' && !/^https?:\/\/\S+$/.test(url.trim())
          ? 'An http(s) URL is needed.'
          : undefined

  const submit = (): void => {
    if (error) return
    onSave(
      transport === 'stdio'
        ? { name: trimmed, transport, command: command.trim(), args: splitArgs(args), env: parsePairs(env, '='), enabled: server.enabled }
        : { name: trimmed, transport, url: url.trim(), headers: parsePairs(headers, ':'), enabled: server.enabled }
    )
  }

  return (
    <form
      className="harness-editor"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onKeyDown={(e) => {
        // Escape closes the editor, not the whole dialog.
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <label>
        Name
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" />
      </label>
      <label>
        Transport
        <select value={transport} onChange={(e) => setTransport(e.target.value as McpServer['transport'])}>
          <option value="stdio">stdio — a command the agent starts</option>
          <option value="http">http — Streamable HTTP endpoint</option>
          <option value="sse">sse — HTTP + Server-Sent Events (legacy)</option>
        </select>
      </label>
      {transport === 'stdio' ? (
        <>
          <label>
            Command
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </label>
          <label>
            Arguments
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder='-y @modelcontextprotocol/server-filesystem "C:\My Docs"' />
          </label>
          <label>
            Environment <span className="muted">(KEY=value, one per line)</span>
            <textarea rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="API_KEY=…" />
          </label>
        </>
      ) : (
        <>
          <label>
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
          </label>
          <label>
            Headers <span className="muted">(Name: value, one per line)</span>
            <textarea rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization: Bearer …" />
          </label>
        </>
      )}
      <p className="muted harness-note">Stored by vibe-coding-ide in its own settings (not in the repository), as plain text.</p>
      <div className="harness-editor-buttons">
        {error && <span className="harness-error">{error}</span>}
        <span className="spacer" />
        <button type="button" className="tool-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="tool-button primary" disabled={!!error}>
          {server.name ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Skills

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  harness: 'harness',
  project: 'repository (.claude/skills)',
  user: 'your skills (~/.claude/skills)'
}

function SkillsView({ root, harness, save }: { root: string; harness: Harness; save: (h: Harness) => Promise<void> }): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [preview, setPreview] = useState<{ path: string; text: string }>()

  useEffect(() => {
    void window.ide.harness.skills(root, harness).then(setSkills)
  }, [root, harness])

  const add = async (): Promise<void> => {
    const folder = await window.ide.harness.pickSkillFolder(root)
    if (!folder) return
    const path = skillPath(root, folder)
    if (harness.skills.some((s) => s.path === path)) return notify('This folder is already in the harness.')
    await save({ ...harness, skills: [...harness.skills, { path, enabled: true }] })
    const found = await window.ide.harness.skills(root, { ...harness, skills: [...harness.skills, { path, enabled: true }] })
    if (!found.some((s) => s.source === 'harness' && !s.missing && s.path.replace(/\\/g, '/').includes(path.replace(/\\/g, '/'))))
      notify('No SKILL.md in this folder or its sub-folders: the agent will not find a skill there.', 'error')
  }

  /** The harness entry a listed skill comes from (a folder of skills lists several). */
  const entryOf = (s: SkillInfo): number =>
    harness.skills.findIndex((h) => {
      const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
      const abs = /^([a-z]:|\/|\\\\)/i.test(h.path) ? h.path : `${root}/${h.path}`
      return norm(s.path) === norm(abs) || norm(s.path).startsWith(norm(abs) + '/')
    })

  const toggle = (i: number, enabled: boolean): void => void save({ ...harness, skills: harness.skills.map((s, j) => (j === i ? { ...s, enabled } : s)) })
  const remove = (i: number): void => void save({ ...harness, skills: harness.skills.filter((_, j) => j !== i) })

  const own = skills.filter((s) => s.source === 'harness')
  const native = skills.filter((s) => s.source !== 'harness')
  return (
    <div className="harness-section">
      <div className="harness-actions">
        <button className="tool-button" onClick={() => void add()}>
          + Add skill folder…
        </button>
        <span className="muted">A folder with a SKILL.md, or a folder of skills.</span>
      </div>
      {own.length === 0 && <p className="muted harness-empty">No skills added to this project's harness.</p>}
      <ul className="harness-list">
        {own.map((s) => {
          const i = entryOf(s)
          const entry = harness.skills[i]
          return (
            <li key={s.path} className={`harness-item${entry?.enabled === false ? ' disabled' : ''}`}>
              <div className="harness-row">
                <input type="checkbox" checked={entry?.enabled !== false} aria-label={`Enable ${s.name}`} onChange={(e) => toggle(i, e.target.checked)} />
                <button className="link-button harness-name" disabled={s.missing} onClick={() => void openPreview(s.path, preview, setPreview)}>
                  {s.name}
                </button>
                {s.missing ? <span className="harness-error">no SKILL.md here</span> : <span className="harness-detail">{s.description}</span>}
                <span className="spacer" />
                <button className="icon-button pane-action" title="Remove from the harness" onClick={() => remove(i)}>
                  ✕
                </button>
              </div>
              {preview?.path === s.path && <pre className="harness-preview">{preview.text}</pre>}
            </li>
          )
        })}
      </ul>
      {native.length > 0 && (
        <>
          <h4 className="harness-subtitle">Also loaded by Claude Code on its own</h4>
          <ul className="harness-list">
            {native.map((s) => (
              <li key={s.path} className="harness-item">
                <div className="harness-row">
                  <button className="link-button harness-name" onClick={() => void openPreview(s.path, preview, setPreview)}>
                    {s.name}
                  </button>
                  <span className="harness-detail">{s.description}</span>
                  <span className="spacer" />
                  <span className="harness-badge">{SOURCE_LABEL[s.source]}</span>
                </div>
                {preview?.path === s.path && <pre className="harness-preview">{preview.text}</pre>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

async function openPreview(path: string, current: { path: string } | undefined, set: (p: { path: string; text: string } | undefined) => void): Promise<void> {
  if (current?.path === path) return set(undefined)
  set({ path, text: (await window.ide.harness.readSkill(path)) || '(empty)' })
}

// ---------------------------------------------------------------------------
// Instructions

function InstructionsView({ harness, save }: { harness: Harness; save: (h: Harness) => Promise<void> }): React.JSX.Element {
  const [text, setText] = useState(harness.instructions)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef({ harness, text })
  latest.current = { harness, text }
  const flush = (): void => {
    clearTimeout(timer.current)
    const { harness: h, text: t } = latest.current
    if (t !== h.instructions) void save({ ...h, instructions: t })
  }
  // Save when leaving the view.
  useEffect(() => () => flush(), [])

  return (
    <div className="harness-section harness-instructions">
      <p className="muted">Added to the agent's system prompt in this project — conventions, commands to use, things to avoid.</p>
      <textarea
        aria-label="Instructions"
        value={text}
        placeholder={'Use pnpm, not npm.\nRun `pnpm test` before committing.'}
        onChange={(e) => {
          setText(e.target.value)
          clearTimeout(timer.current)
          timer.current = setTimeout(flush, 600)
        }}
        onBlur={flush}
      />
    </div>
  )
}
