import { useEffect, useRef, useState } from 'react'
import type { AgentHarnessSupport, Harness, McpCheckResult, McpServer } from '@shared/types'
import { formatPairs, joinArgs, parsePairs, splitArgs } from '../harness-form'

/** Agent settings, MCP servers tab: the servers, their editor and health check. */

const emptyServer = (): McpServer => ({ name: '', transport: 'stdio', command: '', args: [], enabled: true })

export function McpView({
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
