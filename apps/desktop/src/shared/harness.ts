import type { Harness } from './types'

/** An AI agent panel's settings (MCP servers, skills, instructions): helpers shared by main and renderer. */

export const emptyHarness = (): Harness => ({ mcpServers: [], skills: [], instructions: '' })

/** Nothing to give the agent (no server, skill, instructions or "only these" option). */
export const harnessIsEmpty = (h: Harness): boolean => !h.mcpServers.length && !h.skills.length && !h.instructions.trim() && !h.strictMcp && !h.strictSkills

/** Number of things set (shown on the agent panel's settings button). */
export const harnessSize = (h?: Harness): number =>
  !h ? 0 : h.mcpServers.filter((s) => s.enabled).length + h.skills.filter((s) => s.enabled).length + (h.instructions.trim() ? 1 : 0)
