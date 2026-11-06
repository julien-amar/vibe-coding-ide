import claudeCode from './assets/logos/claude-code.svg?raw'
import codex from './assets/logos/codex.svg?raw'
import geminiCli from './assets/logos/gemini-cli.svg?raw'
import linux from './assets/logos/linux.svg?raw'
import opencode from './assets/logos/opencode.svg?raw'
import pi from './assets/logos/pi.svg?raw'

/**
 * Product logos (see THIRD-PARTY-NOTICES.md): the AI agents' own marks, and Tux for WSL.
 * Single-colour marks (opencode, pi, Tux) are drawn in the current text colour, so they show in
 * light and dark themes; the others keep their colours.
 */
const AGENT_LOGOS: Record<string, string> = { claude: claudeCode, codex, gemini: geminiCli, opencode, pi }

/** The logo of an agent profile ("agent:claude", "wslagent:Ubuntu:codex"), if known. */
export function agentLogo(profileId: string): { agent: string; svg: string } | undefined {
  const agent = /^(?:agent:|wslagent:[^:]+:)(.+)$/.exec(profileId)?.[1]
  const svg = agent ? AGENT_LOGOS[agent] : undefined
  return agent && svg ? { agent, svg } : undefined
}

export const LINUX_LOGO = linux

/** An inline SVG logo (local, trusted assets). */
export function Logo({ svg, size = 16, className = '' }: { svg: string; size?: number; className?: string }): React.JSX.Element {
  return <span className={`logo ${className}`} style={{ width: size, height: size }} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
}
