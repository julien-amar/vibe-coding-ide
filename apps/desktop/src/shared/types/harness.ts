/** An AI agent panel's own settings (harness): MCP servers, skills, instructions. */

/** An MCP server of a harness. */
export interface McpServer {
  /** Unique within the harness (the server's name for the agent). */
  name: string
  /** stdio: a command the agent starts; http: a Streamable HTTP endpoint; sse: legacy HTTP + Server-Sent Events. */
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  /** stdio: environment variables of the server process. */
  env?: Record<string, string>
  url?: string
  /** http / sse: request headers (e.g. Authorization). */
  headers?: Record<string, string>
  enabled: boolean
}

/** A skill of a harness: a folder with a SKILL.md (or a folder of such folders). */
export interface HarnessSkill {
  path: string
  enabled: boolean
}

/**
 * Settings of one AI agent pane (kept with the pane in the app's layout, not in the repository):
 * MCP servers, skills and instructions, given to the agent in its own format at launch.
 */
export interface Harness {
  mcpServers: McpServer[]
  skills: HarnessSkill[]
  /** Added to the agent's system prompt. */
  instructions: string
  /** Use only the harness's MCP servers (not the user's or the repository's .mcp.json). */
  strictMcp?: boolean
  /** Use only the harness's skills (not the user's, the repository's or the agent's bundled ones). */
  strictSkills?: boolean
}

/** Result of starting an MCP server and listing its tools. */
export interface McpCheckResult {
  ok: boolean
  error?: string
  server?: { name?: string; version?: string }
  tools?: { name: string; description?: string }[]
  /** Last lines the server printed on stderr (stdio). */
  log?: string
}

/** A skill found on disk (SKILL.md front matter). */
export interface SkillInfo {
  path: string
  name: string
  description?: string
  /** harness: added to this project's harness; project: the repository's .claude/skills; user: ~/.claude/skills. */
  source: 'harness' | 'project' | 'user'
  /** Harness skills: the folder has no SKILL.md (moved or deleted). */
  missing?: boolean
}

/** What an agent supports of a harness. */
export interface AgentHarnessSupport {
  agent: string
  label: string
  mcp: boolean
  skills: boolean
  instructions: boolean
  /** "Only these servers": the agent can be made to ignore its other MCP configurations. */
  strictMcp: boolean
  /** "Only these skills": the agent can be made to ignore its other skills. */
  strictSkills: boolean
  /** How the settings reach the agent, or why they do not. */
  note?: string
}
