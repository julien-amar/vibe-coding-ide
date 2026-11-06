import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { McpCheckResult, McpServer } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { launchSpec, which } from '../profiles'
import { killTree, LineReader, programCommand } from '../tests/core'
import { sanitizeHarness } from './model'

// ---------------------------------------------------------------------------
// The repository's .mcp.json (Claude Code's project MCP servers), to import.

export function readProjectMcpJson(root: string): McpServer[] {
  let json: { mcpServers?: Record<string, Record<string, unknown>> }
  try {
    json = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
  } catch {
    return []
  }
  return Object.entries(json.mcpServers ?? {})
    .map(
      ([name, s]) =>
        sanitizeHarness({
          mcpServers: [
            s.url
              ? { name, transport: s.type === 'sse' ? 'sse' : 'http', url: s.url, headers: s.headers }
              : { name, transport: 'stdio', command: s.command, args: s.args, env: s.env }
          ]
        }).mcpServers[0]
    )
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Health check: start the server (stdio) or call it (http), initialize, list its tools.

const CLIENT_INFO = { name: 'vibe-coding-ide', version: '0.1.0' }
const PROTOCOL = '2025-06-18'
const CHECK_TIMEOUT = 60_000

interface RpcResponse {
  id?: number
  result?: Record<string, unknown>
  error?: { message?: string }
}

const toolsOf = (r: RpcResponse): McpCheckResult['tools'] =>
  ((r.result?.tools as { name: string; description?: string }[] | undefined) ?? []).map((t) => ({ name: t.name, description: t.description }))

const serverOf = (r: RpcResponse): McpCheckResult['server'] => r.result?.serverInfo as McpCheckResult['server']

function checkStdio(root: string, s: McpServer, timeout: number): Promise<McpCheckResult> {
  if (!s.command) return Promise.resolve({ ok: false, error: 'No command.' })
  // A WSL project's agent runs inside the distribution: so does its server (and the check).
  const wsl = process.platform === 'win32' && parseWslPath(root) !== undefined
  const exe = wsl || isAbsolute(s.command) ? s.command : (which(s.command) ?? s.command)
  const inWsl = wsl ? programCommand(root, s.command, s.args ?? [], s.env ?? {}) : undefined
  const spec = inWsl ? { command: inWsl.file, args: inWsl.args } : launchSpec(exe, s.args ?? [])
  return new Promise((done) => {
    let stderr = ''
    let server: McpCheckResult['server']
    let finished = false
    const child = spawn(spec.command, spec.args, {
      cwd: existsSync(root) && !root.startsWith('\\\\') ? root : undefined,
      env: { ...process.env, ...(s.env ?? {}), ...(inWsl?.env ?? {}) },
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    const finish = (r: McpCheckResult): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      killTree(child)
      done({ ...r, log: stderr.trim().split(/\r?\n/).slice(-20).join('\n') || undefined })
    }
    const timer = setTimeout(() => finish({ ok: false, error: `No answer within ${timeout / 1000} s.` }), timeout)
    const send = (msg: object): void => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    }
    const reader = new LineReader((line) => {
      let msg: RpcResponse
      try {
        msg = JSON.parse(line) as RpcResponse
      } catch {
        return // servers sometimes log on stdout
      }
      if (msg.error) return finish({ ok: false, error: msg.error.message ?? 'The server returned an error.', server })
      if (msg.id === 1) {
        server = serverOf(msg)
        send({ method: 'notifications/initialized' })
        send({ id: 2, method: 'tools/list', params: {} })
      } else if (msg.id === 2) finish({ ok: true, server, tools: toolsOf(msg) })
    })
    child.stdout.on('data', (b: Buffer) => reader.push(b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf8')).slice(-20_000)))
    child.on('error', (err) => finish({ ok: false, error: `Cannot start ${s.command}: ${err.message}` }))
    child.on('exit', (code) => finish({ ok: false, error: `The server exited (code ${code}) before answering.`, server }))
    child.stdin.on('error', () => undefined)
    send({ id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO } })
  })
}

/** A JSON-RPC response from a Streamable HTTP reply: plain JSON, or Server-Sent Events. */
export function parseHttpReply(contentType: string, body: string, id: number): RpcResponse | undefined {
  const candidates = contentType.includes('text/event-stream')
    ? body
        .split(/\r?\n\r?\n/)
        .map((ev) =>
          ev
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n')
        )
        .filter(Boolean)
    : [body]
  for (const c of candidates) {
    try {
      const msg = JSON.parse(c) as RpcResponse | RpcResponse[]
      const found = (Array.isArray(msg) ? msg : [msg]).find((m) => m.id === id)
      if (found) return found
    } catch {
      /* not JSON */
    }
  }
  return undefined
}

async function checkHttp(s: McpServer, timeout: number): Promise<McpCheckResult> {
  if (!s.url) return { ok: false, error: 'No URL.' }
  const signal = AbortSignal.timeout(timeout)
  let session: string | undefined
  const post = async (msg: object, id?: number): Promise<RpcResponse | undefined> => {
    const res = await fetch(s.url!, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(session ? { 'mcp-session-id': session } : {}),
        ...(s.headers ?? {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...msg })
    })
    session = res.headers.get('mcp-session-id') ?? session
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    if (id === undefined) return undefined
    const reply = parseHttpReply(res.headers.get('content-type') ?? '', await res.text(), id)
    if (!reply) throw new Error('The server sent no answer.')
    return reply
  }
  try {
    const init = await post({ id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO } }, 1)
    if (init?.error) return { ok: false, error: init.error.message }
    await post({ method: 'notifications/initialized' })
    const tools = await post({ id: 2, method: 'tools/list', params: {} }, 2)
    if (tools?.error) return { ok: false, error: tools.error.message, server: serverOf(init!) }
    return { ok: true, server: serverOf(init!), tools: toolsOf(tools!) }
  } catch (err) {
    return { ok: false, error: (err as Error).name === 'TimeoutError' ? `No answer within ${timeout / 1000} s.` : (err as Error).message }
  }
}

export async function checkMcpServer(root: string, server: unknown, timeout = CHECK_TIMEOUT): Promise<McpCheckResult> {
  const s = sanitizeHarness({ mcpServers: [server] }).mcpServers[0]
  if (!s) return { ok: false, error: 'The server needs a name.' }
  if (s.transport === 'stdio') return checkStdio(root, s, timeout)
  if (s.transport === 'http') return checkHttp(s, timeout)
  return { ok: false, error: 'The check is not available for SSE servers yet (the agent can still use them).' }
}
