import type { Harness, McpServer } from '@shared/types'

/**
 * Harness: the settings of one AI agent panel — MCP servers, skills and instructions — kept with
 * the panel in the app's layout (not in the repository) and given to the agent in its own format
 * when it starts (see compile.ts).
 */

export { emptyHarness, harnessIsEmpty, harnessSize } from '@shared/harness'

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
