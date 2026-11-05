import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { AgentHarnessSupport, Harness, McpCheckResult, McpServer, SkillInfo } from '@shared/types'
import { launchSpec, which } from './profiles'
import { killTree, LineReader } from './tests/core'

/**
 * Harness: the settings of one AI agent pane — MCP servers, skills and
 * instructions — kept with the pane in the app's layout (not in the repository)
 * and given to the agent in its own format at launch. Claude Code gets generated
 * files passed with flags (--mcp-config, --append-system-prompt-file, --plugin-dir for skills).
 */

export const emptyHarness = (): Harness => ({ mcpServers: [], skills: [], instructions: '' })

/** Nothing to give the agent. */
export const harnessIsEmpty = (h: Harness): boolean => !h.mcpServers.length && !h.skills.length && !h.instructions.trim() && !h.strictMcp

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strMap = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string' && k) out[k] = x
  return Object.keys(out).length ? out : undefined
}

/** A harness from untrusted JSON (the renderer, or a file edited by hand): only known, well-typed fields. */
export function sanitizeHarness(input: unknown): Harness {
  const h = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const seen = new Set<string>()
  const mcpServers: McpServer[] = []
  for (const raw of Array.isArray(h.mcpServers) ? h.mcpServers : []) {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const name = str(s.name)?.trim()
    const transport = s.transport === 'http' || s.transport === 'sse' ? s.transport : 'stdio'
    if (!name || seen.has(name)) continue
    seen.add(name)
    mcpServers.push({
      name,
      transport,
      command: transport === 'stdio' ? str(s.command)?.trim() : undefined,
      args: transport === 'stdio' && Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : undefined,
      env: transport === 'stdio' ? strMap(s.env) : undefined,
      url: transport !== 'stdio' ? str(s.url)?.trim() : undefined,
      headers: transport !== 'stdio' ? strMap(s.headers) : undefined,
      enabled: s.enabled !== false
    })
  }
  const skills = (Array.isArray(h.skills) ? h.skills : [])
    .map((raw) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}))
    .filter((s) => typeof s.path === 'string' && s.path.trim())
    .map((s) => ({ path: (s.path as string).trim(), enabled: s.enabled !== false }))
  return { mcpServers, skills, instructions: str(h.instructions) ?? '', strictMcp: h.strictMcp === true || undefined }
}

// ---------------------------------------------------------------------------
// Agents

/** The agent of an agent profile id ("agent:claude", "wslagent:Ubuntu:claude"). */
export const agentOf = (profileId: string): string | undefined => /^(?:agent:|wslagent:[^:]+:)(.+)$/.exec(profileId)?.[1]

export const HARNESS_SUPPORT: AgentHarnessSupport[] = [
  { agent: 'claude', label: 'Claude Code', mcp: true, skills: true, instructions: true },
  ...[
    ['codex', 'Codex CLI'],
    ['gemini', 'Gemini CLI'],
    ['opencode', 'opencode'],
    ['pi', 'pi']
  ].map(([agent, label]) => ({ agent, label, mcp: false, skills: false, instructions: false, note: 'Not yet: the harness is not applied to this agent.' }))
]

/** A stdio command as Claude Code should start it: Windows .cmd / .bat scripts (npx, uvx shims…) through cmd.exe. */
function stdioCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  const found = isAbsolute(command) ? command : which(command)
  if (found && /\.(cmd|bat)$/i.test(found)) return { command: 'cmd', args: ['/c', command, ...args] }
  return { command, args }
}

/** Claude Code's MCP configuration (the format of .mcp.json) for the enabled servers. */
export function claudeMcpConfig(servers: McpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {}
  for (const s of servers.filter((x) => x.enabled)) {
    if (s.transport === 'stdio') {
      if (!s.command) continue
      const c = stdioCommand(s.command, s.args ?? [])
      mcpServers[s.name] = { command: c.command, args: c.args, ...(s.env ? { env: s.env } : {}) }
    } else if (s.url) {
      mcpServers[s.name] = { type: s.transport, url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
    }
  }
  return { mcpServers }
}

/** Skill folders of a path: the folder itself (it has a SKILL.md) or its sub-folders that have one. */
export function skillFolders(path: string): string[] {
  if (existsSync(join(path, 'SKILL.md'))) return [path]
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(path, e.name, 'SKILL.md')))
      .map((e) => join(path, e.name))
  } catch {
    return []
  }
}

const resolveSkillPath = (root: string, p: string): string => (isAbsolute(p) ? p : resolve(root, p))

/**
 * Launch arguments giving `agent` the project's harness; generated files go to `outDir` (app data,
 * not the repository). Agents without a compiler get no arguments.
 */
export function compileHarness(agent: string | undefined, harness: Harness, root: string, outDir: string): string[] {
  if (agent !== 'claude') return []
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const args: string[] = []

  const mcp = claudeMcpConfig(harness.mcpServers)
  if (Object.keys(mcp.mcpServers).length || harness.strictMcp) {
    const file = join(outDir, 'mcp.json')
    writeFileSync(file, JSON.stringify(mcp, null, 2))
    args.push('--mcp-config', file)
    if (harness.strictMcp) args.push('--strict-mcp-config')
  }

  if (harness.instructions.trim()) {
    const file = join(outDir, 'instructions.md')
    writeFileSync(file, harness.instructions.trim() + '\n')
    args.push('--append-system-prompt-file', file)
  }

  // Skills: a plugin for this session (--plugin-dir) whose skills/ holds copies of the harness's skills.
  const folders = harness.skills.filter((s) => s.enabled).flatMap((s) => skillFolders(resolveSkillPath(root, s.path)))
  if (folders.length) {
    const plugin = join(outDir, 'plugin')
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'project-harness', version: '1.0.0', description: `Skills of the vibe-coding-ide harness of ${basename(root)}` }, null, 2)
    )
    const used = new Set<string>()
    for (const f of folders) {
      let name = basename(f)
      for (let i = 2; used.has(name); i++) name = `${basename(f)}-${i}`
      used.add(name)
      cpSync(f, join(plugin, 'skills', name), { recursive: true })
    }
    args.push('--plugin-dir', plugin)
  }
  return args
}

// ---------------------------------------------------------------------------
// Skills

/** name / description from a SKILL.md front matter. */
export function skillMeta(text: string): { name?: string; description?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const field = (k: string): string | undefined => {
    const v = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim()
    return v ? v.replace(/^["']|["']$/g, '') : undefined
  }
  return { name: field('name'), description: field('description') }
}

function skillInfo(folder: string, source: SkillInfo['source']): SkillInfo {
  const meta = skillMeta(readFileSync(join(folder, 'SKILL.md'), 'utf8'))
  return { path: folder, name: meta.name ?? basename(folder), description: meta.description, source }
}

export function listSkills(root: string, harness: Harness): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const s of harness.skills) {
    const path = resolveSkillPath(root, s.path)
    const folders = skillFolders(path)
    if (!folders.length) out.push({ path, name: basename(path), source: 'harness', missing: true })
    for (const f of folders) out.push(skillInfo(f, 'harness'))
  }
  // What Claude Code already loads by itself (shown, not managed).
  for (const [dir, source] of [
    [join(root, '.claude', 'skills'), 'project'],
    [join(homedir(), '.claude', 'skills'), 'user']
  ] as const) {
    if (existsSync(dir)) for (const f of skillFolders(dir)) if (f !== dir) out.push(skillInfo(f, source))
  }
  return out
}

/** A skill's SKILL.md (only that file can be read this way). */
export function readSkillFile(folder: string): string {
  const file = join(folder, 'SKILL.md')
  return statSync(file).isFile() ? readFileSync(file, 'utf8') : ''
}

// ---------------------------------------------------------------------------
// The repository's .mcp.json (Claude Code's project MCP servers), to import.

export function readProjectMcpJson(root: string): McpServer[] {
  let json: { mcpServers?: Record<string, Record<string, unknown>> }
  try {
    json = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
  } catch {
    return []
  }
  return Object.entries(json.mcpServers ?? {}).map(([name, s]) =>
    sanitizeHarness({
      mcpServers: [
        s.url
          ? { name, transport: s.type === 'sse' ? 'sse' : 'http', url: s.url, headers: s.headers }
          : { name, transport: 'stdio', command: s.command, args: s.args, env: s.env }
      ]
    }).mcpServers[0]
  ).filter(Boolean)
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
  const exe = isAbsolute(s.command) ? s.command : (which(s.command) ?? s.command)
  const spec = launchSpec(exe, s.args ?? [])
  return new Promise((done) => {
    let stderr = ''
    let server: McpCheckResult['server']
    let finished = false
    const child = spawn(spec.command, spec.args, {
      cwd: existsSync(root) && !root.startsWith('\\\\') ? root : undefined,
      env: { ...process.env, ...(s.env ?? {}) },
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
        .map((ev) => ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))
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
