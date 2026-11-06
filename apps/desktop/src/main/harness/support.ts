import type { AgentHarnessSupport } from '@shared/types'

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
    note: 'opencode 2 runs with its own private server (--standalone) so the panel’s settings apply. It always adds your own and the repository’s MCP servers.'
  },
  {
    agent: 'pi',
    label: 'pi',
    mcp: true,
    skills: true,
    instructions: true,
    strictMcp: false,
    strictSkills: true,
    note: 'MCP servers need pi 1.5 or later (added by a session-only extension); a server of the same name in ~/.pi/agent/mcp.json or the repository’s .pi/mcp.json takes precedence, and those servers are always added.'
  },
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
