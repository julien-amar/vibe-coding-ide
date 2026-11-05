import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  agentOf,
  checkMcpServer,
  claudeMcpConfig,
  compileHarness,
  harnessIsEmpty,
  listSkills,
  parseHttpReply,
  readProjectMcpJson,
  sanitizeHarness,
  skillMeta
} from './harness'

const FAKE_MCP = resolve(__dirname, '../../e2e/fixtures/fake-tools/fake-mcp-server.cjs')
const base = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-harness-'))
afterAll(() => {
  // Servers started by the health checks run in `base`: on Windows the folder stays busy until they are gone.
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch {
    /* left for the OS temp cleanup */
  }
})

const write = (file: string, content: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

describe('harness model and storage', () => {
  it('keeps only valid servers and skills (unique names, known transports)', () => {
    const h = sanitizeHarness({
      mcpServers: [
        { name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'x', 3], env: { A: '1', B: 2 }, url: 'ignored' },
        { name: 'files', transport: 'stdio', command: 'dup' },
        { name: '', command: 'nameless' },
        { name: 'web', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' }, enabled: false },
        { name: 'odd', transport: 'carrier-pigeon', command: 'c' }
      ],
      skills: [{ path: 'skills/a' }, { path: '' }, { nope: 1 }],
      instructions: 42,
      strictMcp: 'yes'
    })
    expect(h).toEqual({
      mcpServers: [
        { name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' }, url: undefined, headers: undefined, enabled: true },
        { name: 'web', transport: 'http', command: undefined, args: undefined, env: undefined, url: 'https://x/mcp', headers: { Authorization: 'Bearer t' }, enabled: false },
        { name: 'odd', transport: 'stdio', command: 'c', args: undefined, env: undefined, url: undefined, headers: undefined, enabled: true }
      ],
      skills: [{ path: 'skills/a', enabled: true }],
      instructions: '',
      strictMcp: undefined
    })
  })

  it('knows when there is nothing to give the agent', () => {
    expect(harnessIsEmpty(sanitizeHarness({}))).toBe(true)
    expect(harnessIsEmpty(sanitizeHarness({ instructions: '  \n' }))).toBe(true)
    expect(harnessIsEmpty(sanitizeHarness({ instructions: 'Use pnpm.' }))).toBe(false)
    expect(harnessIsEmpty(sanitizeHarness({ strictMcp: true }))).toBe(false)
    expect(harnessIsEmpty(sanitizeHarness({ mcpServers: [{ name: 'x', command: 'y', enabled: false }] }))).toBe(false)
  })

  it('knows the agent of an agent profile', () => {
    expect(agentOf('agent:claude')).toBe('claude')
    expect(agentOf('wslagent:Ubuntu:codex')).toBe('codex')
    expect(agentOf('shell:pwsh')).toBeUndefined()
  })
})

describe('compiling a harness for Claude Code', () => {
  it('writes the MCP config (Claude Code format), instructions and a plugin with the skills, and returns the flags', () => {
    const root = join(base, 'proj')
    write(join(root, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Reviews code\n---\nSteps…')
    write(join(root, 'skills', 'review', 'checklist.md'), '- [ ] tests')
    write(join(base, 'library', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n')
    write(join(base, 'library', 'release', 'SKILL.md'), '---\nname: release\n---\n')
    const out = join(base, 'out')
    const args = compileHarness(
      'claude',
      sanitizeHarness({
        mcpServers: [
          { name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_MCP], env: { TOKEN: 'x' } },
          { name: 'docs', transport: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer t' } },
          { name: 'off', transport: 'stdio', command: 'nope', enabled: false }
        ],
        skills: [{ path: 'skills/review' }, { path: join(base, 'library') }, { path: 'skills/missing' }, { path: 'skills/review', enabled: false }],
        instructions: 'Use pnpm.\nRun the tests before committing.',
        strictMcp: true
      }),
      root,
      out
    )
    const plugin = join(out, 'plugin')
    expect(args).toEqual([
      '--mcp-config',
      join(out, 'mcp.json'),
      '--strict-mcp-config',
      '--append-system-prompt-file',
      join(out, 'instructions.md'),
      '--plugin-dir',
      plugin
    ])
    expect(JSON.parse(readFileSync(join(out, 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        fake: { command: process.execPath, args: [FAKE_MCP], env: { TOKEN: 'x' } },
        docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer t' } }
      }
    })
    expect(readFileSync(join(out, 'instructions.md'), 'utf8')).toBe('Use pnpm.\nRun the tests before committing.\n')
    expect(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('project-harness')
    for (const s of ['review/SKILL.md', 'review/checklist.md', 'deploy/SKILL.md', 'release/SKILL.md']) expect(existsSync(join(plugin, 'skills', s))).toBe(true)
  })

  it('gives nothing to agents without a compiler, and no flags for an empty harness', () => {
    expect(compileHarness('codex', sanitizeHarness({ instructions: 'x' }), base, join(base, 'o2'))).toEqual([])
    expect(compileHarness('claude', sanitizeHarness({}), base, join(base, 'o3'))).toEqual([])
  })

  it('starts Windows .cmd servers (npx…) through cmd /c', () => {
    if (process.platform !== 'win32') return
    const cfg = claudeMcpConfig(sanitizeHarness({ mcpServers: [{ name: 'n', command: 'npx', args: ['-y', 'pkg'] }] }).mcpServers)
    // npx is a .cmd shim on Windows (when Node.js is installed).
    expect(cfg.mcpServers.n).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] })
  })
})

describe('skills and the repository .mcp.json', () => {
  it('lists harness skills (and missing folders) and the skills Claude Code finds in the repository', () => {
    const root = join(base, 'skillproj')
    write(join(root, '.claude', 'skills', 'lint', 'SKILL.md'), '---\nname: "lint-it"\ndescription: Lints the code\n---\n')
    write(join(root, 'mine', 'SKILL.md'), '# no front matter')
    const skills = listSkills(root, sanitizeHarness({ skills: [{ path: 'mine' }, { path: 'gone' }] })).filter((s) => s.source !== 'user')
    expect(skills.map((s) => [s.source, s.name, s.description, !!s.missing])).toEqual([
      ['harness', 'mine', undefined, false],
      ['harness', 'gone', undefined, true],
      ['project', 'lint-it', 'Lints the code', false]
    ])
    expect(skillMeta('---\nname: x\ndescription: \'Does y\'\n---\nbody')).toEqual({ name: 'x', description: 'Does y' })
  })

  it('imports the servers of the repository .mcp.json', () => {
    const root = join(base, 'mcpjson')
    write(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'fs'], env: { A: 'b' } }, api: { type: 'http', url: 'https://api/mcp' } } })
    )
    expect(readProjectMcpJson(root).map((s) => [s.name, s.transport, s.command ?? s.url])).toEqual([
      ['files', 'stdio', 'npx'],
      ['api', 'http', 'https://api/mcp']
    ])
    expect(readProjectMcpJson(join(base, 'nothing'))).toEqual([])
  })
})

describe('MCP health check', () => {
  it('starts a stdio server, initializes it and lists its tools', async () => {
    const r = await checkMcpServer(base, { name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_MCP, '--flag'] })
    expect(r.ok).toBe(true)
    expect(r.server).toEqual({ name: 'fake-mcp', version: '1.0.0' })
    expect(r.tools).toEqual([
      { name: 'echo', description: 'Echoes its input' },
      { name: 'add', description: 'Adds two numbers' }
    ])
    expect(r.log).toContain('started with ["--flag"]')
  })

  it('reports servers that cannot start, exit early or never answer', async () => {
    const missing = await checkMcpServer(base, { name: 'x', transport: 'stdio', command: 'definitely-not-a-command-xyz' })
    expect(missing.ok).toBe(false)
    const exits = await checkMcpServer(base, { name: 'x', transport: 'stdio', command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_EXIT: '3' } })
    expect(exits).toMatchObject({ ok: false, error: expect.stringContaining('exited (code 3)') })
    expect(exits.log).toContain('failing on purpose')
    const silent = await checkMcpServer(base, { name: 'x', transport: 'stdio', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, 1500)
    expect(silent).toMatchObject({ ok: false, error: 'No answer within 1.5 s.' })
  })

  it('calls a Streamable HTTP server (JSON and Server-Sent Events replies, session id)', async () => {
    const seen: { method: string; session?: string }[] = []
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const msg = JSON.parse(body)
        seen.push({ method: msg.method, session: req.headers['mcp-session-id'] as string | undefined })
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'http-fake', version: '2' } } }))
        } else if (msg.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search' }] } })}\n\n`)
        } else {
          res.writeHead(202)
          res.end()
        }
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const r = await checkMcpServer(base, { name: 'h', transport: 'http', url: `http://127.0.0.1:${port}/mcp` })
      expect(r).toMatchObject({ ok: true, server: { name: 'http-fake', version: '2' }, tools: [{ name: 'search' }] })
      expect(seen).toEqual([
        { method: 'initialize', session: undefined },
        { method: 'notifications/initialized', session: 'abc' },
        { method: 'tools/list', session: 'abc' }
      ])
      const down = await checkMcpServer(base, { name: 'h', transport: 'http', url: 'http://127.0.0.1:1/mcp' })
      expect(down.ok).toBe(false)
    } finally {
      server.close()
    }
  })

  it('finds the answer in an SSE reply among other events', () => {
    const body = 'data: {"jsonrpc":"2.0","method":"notifications/message"}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n'
    expect(parseHttpReply('text/event-stream; charset=utf-8', body, 2)).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } })
    expect(parseHttpReply('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}', 1)).toBeTruthy()
    expect(parseHttpReply('application/json', 'oops', 1)).toBeUndefined()
  })
})
