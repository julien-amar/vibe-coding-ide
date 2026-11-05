import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { AgentHarnessSupport, Harness, McpCheckResult, McpServer, SkillInfo } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { launchSpec, which } from './profiles'
import { killTree, LineReader, programCommand } from './tests/core'

/**
 * Harness: the settings of one AI agent pane — MCP servers, skills and
 * instructions — kept with the pane in the app's layout (not in the repository)
 * and given to the agent in its own format at launch. Claude Code gets generated
 * files passed with flags (--mcp-config, --append-system-prompt-file, --plugin-dir for skills).
 */

export const emptyHarness = (): Harness => ({ mcpServers: [], skills: [], instructions: '' })

/** Nothing to give the agent. */
export const harnessIsEmpty = (h: Harness): boolean =>
  !h.mcpServers.length && !h.skills.length && !h.instructions.trim() && !h.strictMcp && !h.strictSkills

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
  return {
    mcpServers,
    skills,
    instructions: str(h.instructions) ?? '',
    strictMcp: h.strictMcp === true || undefined,
    strictSkills: h.strictSkills === true || undefined
  }
}

// ---------------------------------------------------------------------------
// Agents

/** The agent of an agent profile id ("agent:claude", "wslagent:Ubuntu:claude"). */
export const agentOf = (profileId: string): string | undefined => /^(?:agent:|wslagent:[^:]+:)(.+)$/.exec(profileId)?.[1]

/**
 * What each agent gets of its pane's settings — checked against the agents' own CLIs
 * (Claude Code 2.1, Codex CLI 0.166, opencode 1.19, pi 0.73, Gemini CLI 0.67).
 */
export const HARNESS_SUPPORT: AgentHarnessSupport[] = [
  {
    agent: 'claude',
    label: 'Claude Code',
    mcp: true,
    skills: true,
    instructions: true,
    strictMcp: true,
    strictSkills: true,
    note: '"Only these skills" turns off your skills, the repository’s and the bundled ones (not those of installed plugins).'
  },
  {
    agent: 'codex',
    label: 'Codex CLI',
    mcp: true,
    skills: true,
    instructions: true,
    strictMcp: true,
    strictSkills: true,
    note: 'Skills are listed in its instructions (name, description, SKILL.md location), as Codex lists its own.'
  },
  {
    agent: 'opencode',
    label: 'opencode',
    mcp: true,
    skills: true,
    instructions: true,
    strictMcp: false,
    strictSkills: true,
    note: 'opencode always adds your own configured MCP servers.'
  },
  { agent: 'pi', label: 'pi', mcp: false, skills: true, instructions: true, strictMcp: false, strictSkills: true, note: 'pi has no MCP support.' },
  {
    agent: 'gemini',
    label: 'Gemini CLI',
    mcp: false,
    skills: false,
    instructions: false,
    strictMcp: false,
    strictSkills: false,
    note: 'Gemini CLI only reads settings from ~/.gemini or the repository’s .gemini folder, which vibe-coding-ide does not change.'
  }
]

/** What an agent supports (agents not in the table: nothing). */
export const supportOf = (agent: string | undefined): AgentHarnessSupport | undefined => HARNESS_SUPPORT.find((s) => s.agent === agent)


/** A stdio command as Claude Code should start it: Windows .cmd / .bat scripts (npx, uvx shims…) through cmd.exe. */
function stdioCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  const found = isAbsolute(command) ? command : which(command)
  if (found && /\.(cmd|bat)$/i.test(found)) return { command: 'cmd', args: ['/c', command, ...args] }
  return { command, args }
}

/** Claude Code's MCP configuration (the format of .mcp.json) for the enabled servers. */
export function claudeMcpConfig(servers: McpServer[], target: HarnessTarget = { kind: 'host' }): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {}
  for (const s of servers.filter((x) => x.enabled)) {
    if (s.transport === 'stdio') {
      if (!s.command) continue
      const c = serverCommand(target, s.command, s.args ?? [])
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

/** Launch additions for an agent: arguments after its own, environment variables. */
export interface CompiledHarness {
  args: string[]
  env: Record<string, string>
}

/** Enabled skill folders of a harness (relative paths start from the project). */
const enabledSkillFolders = (harness: Harness, root: string): string[] =>
  harness.skills.filter((s) => s.enabled).flatMap((s) => skillFolders(resolveSkillPath(root, s.path)))

/** Where the agent runs: on Windows (or the host OS), or inside a WSL distribution. */
export type HarnessTarget = { kind: 'host' } | { kind: 'wsl'; distro: string; /** The distribution user's home, as a \\wsl.localhost path. */ home?: string }

/** A path (Windows or \\wsl.localhost) as the agent sees it: inside WSL, C:\x → /mnt/c/x and \\wsl.localhost\d\x → /x. */
export function agentPath(target: HarnessTarget, p: string): string {
  if (target.kind !== 'wsl') return p
  return parseWslPath(p)?.path ?? p.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')
}

/** The agent's home folder, readable from here (host home, or the distribution's home over \\wsl.localhost). */
const agentHome = (target: HarnessTarget): string | undefined => (target.kind === 'wsl' ? target.home : homedir())

/** Names of the skills in skill folders (SKILL.md name, or the folder name), searched a few levels down. */
export function skillNamesIn(dirs: string[], depth = 3): string[] {
  const names = new Set<string>()
  const walk = (d: string, level: number): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      names.add(skillMeta(readText(join(d, 'SKILL.md'))).name ?? basename(d))
      return
    }
    if (level < depth) for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules') walk(join(d, e.name), level + 1)
  }
  for (const d of dirs) walk(d, 0)
  return [...names]
}

/** Instructions file (trimmed text), when there are instructions. */
function instructionsFile(harness: Harness, outDir: string, extra = ''): string | undefined {
  const text = [harness.instructions.trim(), extra.trim()].filter(Boolean).join('\n\n')
  if (!text) return undefined
  const file = join(outDir, 'instructions.md')
  writeFileSync(file, text + '\n')
  return file
}

// TOML values for Codex's -c overrides (JSON strings are valid TOML basic strings).
const toml = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(toml).join(', ')}]`
  if (v && typeof v === 'object')
    return `{ ${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${tomlKey(k)} = ${toml(x)}`)
      .join(', ')} }`
  return JSON.stringify(v)
}
const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))

/** A server name Codex accepts in a dotted -c path (letters, digits, - and _). */
const codexName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_')

/** A stdio server command for the target: Windows .cmd shims through cmd /c on the host, as typed inside WSL. */
const serverCommand = (target: HarnessTarget, command: string, args: string[]): { command: string; args: string[] } =>
  target.kind === 'wsl' ? { command, args } : stdioCommand(command, args)

/** Codex's MCP server tables (config.toml [mcp_servers.<name>]) for the enabled servers. */
export function codexMcpServers(servers: McpServer[], target: HarnessTarget = { kind: 'host' }): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const s of servers.filter((x) => x.enabled)) {
    if (s.transport === 'stdio') {
      if (!s.command) continue
      const c = serverCommand(target, s.command, s.args ?? [])
      out[codexName(s.name)] = { command: c.command, args: c.args, ...(s.env ? { env: s.env } : {}) }
    } else if (s.url) {
      // Codex speaks Streamable HTTP (no legacy SSE): sse servers are given as http ones.
      out[codexName(s.name)] = { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) }
    }
  }
  return out
}

/** Skills as a list in instructions (for agents that cannot load skill folders): where to read each. */
export function skillsCatalog(folders: string[], target: HarnessTarget = { kind: 'host' }): string {
  if (!folders.length) return ''
  const lines = folders.map((f) => {
    const meta = skillMeta(readText(join(f, 'SKILL.md')))
    return `- ${meta.name ?? basename(f)}: ${meta.description ?? '(no description)'} (file: ${agentPath(target, join(f, 'SKILL.md'))})`
  })
  return [
    '## Skills',
    'These skills are available in this session. When a task matches one, read its SKILL.md first and follow it',
    '(resolve relative paths against the folder of the SKILL.md).',
    ...lines
  ].join('\n')
}

const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Launch additions giving `agent` its pane's settings; generated files go to `outDir` (app data,
 * not the repository, not the user's agent configuration). Agents without support get nothing.
 * `target`: where the agent runs (paths it is given are written for that system).
 */
export function compileHarness(agent: string | undefined, harness: Harness, root: string, outDir: string, target: HarnessTarget = { kind: 'host' }): CompiledHarness {
  const none: CompiledHarness = { args: [], env: {} }
  const support = supportOf(agent)
  if (!support || harnessIsEmpty(harness)) return none
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const args: string[] = []
  const env: Record<string, string> = {}
  const p = (path: string): string => agentPath(target, path)
  const skills = enabledSkillFolders(harness, root)
  const skillNames = skills.map((f) => skillMeta(readText(join(f, 'SKILL.md'))).name ?? basename(f))
  const home = agentHome(target)
  const strictSkills = !!harness.strictSkills && support.strictSkills

  switch (agent) {
    case 'claude': {
      const mcp = claudeMcpConfig(harness.mcpServers, target)
      if (Object.keys(mcp.mcpServers).length || harness.strictMcp) {
        const file = join(outDir, 'mcp.json')
        writeFileSync(file, JSON.stringify(mcp, null, 2))
        args.push('--mcp-config', p(file))
        if (harness.strictMcp) args.push('--strict-mcp-config')
      }
      const instructions = instructionsFile(harness, outDir)
      if (instructions) args.push('--append-system-prompt-file', p(instructions))
      // Skills: a plugin for this session (--plugin-dir) whose skills/ holds copies of the skills.
      if (skills.length) {
        const plugin = join(outDir, 'plugin')
        mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
        writeFileSync(
          join(plugin, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'project-harness', version: '1.0.0', description: `Skills of a vibe-coding-ide agent panel of ${basename(root)}` }, null, 2)
        )
        const used = new Set<string>()
        for (const f of skills) {
          let name = basename(f)
          for (let i = 2; used.has(name); i++) name = `${basename(f)}-${i}`
          used.add(name)
          cpSync(f, join(plugin, 'skills', name), { recursive: true })
        }
        args.push('--plugin-dir', p(plugin))
      }
      // Only these skills: the user's and the repository's skills, and the bundled ones, switched off
      // for this session (the plugin's skills are namespaced: project-harness:<name>).
      if (strictSkills) {
        const others = skillNamesIn([...(home ? [join(home, '.claude', 'skills')] : []), join(root, '.claude', 'skills')])
        const file = join(outDir, 'settings.json')
        writeFileSync(file, JSON.stringify({ disableBundledSkills: true, skillOverrides: Object.fromEntries(others.map((n) => [n, 'off'])) }, null, 2))
        args.push('--settings', p(file))
      }
      break
    }

    case 'codex': {
      // -c overrides on top of ~/.codex/config.toml: per server, or (only these servers) the whole table.
      const servers = codexMcpServers(harness.mcpServers, target)
      if (harness.strictMcp) args.push('-c', `mcp_servers=${toml(servers)}`)
      else for (const [name, table] of Object.entries(servers)) for (const [k, v] of Object.entries(table)) args.push('-c', `mcp_servers.${name}.${k}=${toml(v)}`)
      const text = [harness.instructions.trim(), skillsCatalog(skills, target)].filter(Boolean).join('\n\n')
      if (text) args.push('-c', `developer_instructions=${toml(text)}`)
      // Only these skills: Codex's own skills (bundled, ~/.codex, ~/.agents, the repository) switched off.
      if (strictSkills) {
        const dirs = [...(home ? [join(home, '.codex', 'skills'), join(home, '.agents', 'skills')] : []), join(root, '.agents', 'skills'), join(root, '.codex', 'skills')]
        const others = skillNamesIn(dirs).filter((n) => !skillNames.includes(n))
        if (others.length) args.push('-c', `skills.config=${toml(others.map((name) => ({ name, enabled: false })))}`)
      }
      break
    }

    case 'opencode': {
      // OPENCODE_CONFIG: an extra config file, merged with the user's and the project's.
      const config: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' }
      const mcp: Record<string, unknown> = {}
      for (const s of harness.mcpServers.filter((x) => x.enabled)) {
        if (s.transport === 'stdio' && s.command) {
          const c = serverCommand(target, s.command, s.args ?? [])
          mcp[s.name] = { type: 'local', command: [c.command, ...c.args], ...(s.env ? { environment: s.env } : {}), enabled: true }
        } else if (s.url) mcp[s.name] = { type: 'remote', url: s.url, ...(s.headers ? { headers: s.headers } : {}), enabled: true }
      }
      if (Object.keys(mcp).length) config.mcp = mcp
      const instructions = instructionsFile(harness, outDir)
      if (instructions) config.instructions = [p(instructions)]
      if (skills.length) config.skills = { paths: skills.map(p) }
      // Only these skills: the skill permission denies every other skill.
      if (strictSkills) config.permission = { skill: { '*': 'deny', ...Object.fromEntries(skillNames.map((n) => [n, 'allow'])) } }
      const file = join(outDir, 'opencode.json')
      writeFileSync(file, JSON.stringify(config, null, 2))
      env.OPENCODE_CONFIG = p(file)
      break
    }

    case 'pi': {
      const instructions = instructionsFile(harness, outDir)
      if (instructions) args.push('--append-system-prompt', p(instructions))
      // Only these skills: no skill discovery (explicit --skill paths still load).
      if (strictSkills) args.push('--no-skills')
      for (const f of skills) args.push('--skill', p(f))
      break
    }
  }
  return { args, env }
}

/**
 * An npm command shim on Windows (codex.cmd…) as a direct launch: `node <script>` (or the .exe it
 * runs). The shim runs through cmd.exe, which would mangle arguments with quotes or line breaks.
 */
export function directLaunch(command: string, args: string[]): { command: string; args: string[] } | undefined {
  if (process.platform !== 'win32') return undefined
  // launchSpec form: cmd.exe /d /c <shim.cmd> <args…>
  const shim = /cmd(\.exe)?$/i.test(command) && args[0] === '/d' && args[1] === '/c' ? args[2] : /\.cmd$/i.test(command) ? command : undefined
  if (!shim || !/\.cmd$/i.test(shim)) return undefined
  const rest = shim === command ? args : args.slice(3)
  const target = /"%dp0%\\([^"]+\.(?:js|cjs|mjs|exe))"\s+%\*/i.exec(readText(shim))?.[1]
  if (!target) return undefined
  const file = join(shim, '..', target)
  if (!existsSync(file)) return undefined
  if (/\.exe$/i.test(file)) return { command: file, args: rest }
  const node = which('node')
  return node ? { command: node, args: [file, ...rest] } : undefined
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
