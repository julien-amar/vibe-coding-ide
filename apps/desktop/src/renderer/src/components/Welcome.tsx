import { useTabs } from '../store'

/**
 * Shown when a window has no tab: what the app does, in six illustrated cards, and how to start.
 * The illustrations are inline SVG drawn with the theme's colours (light / dark).
 */
export function Welcome(): React.JSX.Element {
  const openProject = (): void => {
    void window.ide.project.pickFolder().then((root) => {
      if (root) void useTabs.getState().openProject(root)
    })
  }
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <header className="welcome-hero">
          <AppMark />
          <div>
            <h1>vibe-coding-ide</h1>
            <p>Terminals, projects and AI agents — side by side, in tabs.</p>
          </div>
        </header>
        <div className="welcome-actions">
          <button className="primary" onClick={openProject}>
            Open a project…
          </button>
          <button onClick={() => useTabs.getState().setLauncherOpen(true)}>
            New tab <kbd>Ctrl+T</kbd>
          </button>
        </div>
        <div className="welcome-grid">
          {FEATURES.map((f) => (
            <section key={f.title} className="welcome-card">
              <div className="welcome-art" aria-hidden="true">
                {f.art}
              </div>
              <h2>{f.title}</h2>
              <p>{f.text}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

const FEATURES: { title: string; text: string; art: React.JSX.Element }[] = [
  {
    title: 'Terminals & tabs',
    text: 'Every shell and WSL distribution, in tabs you can drag into new windows.',
    art: <TerminalsArt />
  },
  {
    title: 'Projects',
    text: 'Git, terminals and an AI agent for a folder, in panels you arrange.',
    art: <ProjectArt />
  },
  {
    title: 'AI agents',
    text: 'Claude Code, Codex, opencode, pi… each panel with its own MCP servers and skills.',
    art: <AgentArt />
  },
  {
    title: 'Git',
    text: 'History graph, line-by-line staging, branches, worktrees and pull requests.',
    art: <GitArt />
  },
  {
    title: 'Tests',
    text: 'Vitest to Maven: live results, and a failing test sent to your agent in one click.',
    art: <TestsArt />
  },
  {
    title: 'Always current',
    text: 'Package updates for your systems, and the app updates itself.',
    art: <UpdatesArt />
  }
]

// ---------------------------------------------------------------------------
// Illustrations (viewBox 160 × 96; colours from CSS classes, see welcome.css)

function Window({ x, y, w, h, children }: { x: number; y: number; w: number; h: number; children?: React.ReactNode }): React.JSX.Element {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className="w-surface w-stroke" width={w} height={h} rx="6" />
      <path className="w-bar" d={`M0 6a6 6 0 0 1 6-6h${w - 12}a6 6 0 0 1 6 6v6H0z`} />
      <circle className="w-dot" cx="7" cy="6" r="1.6" />
      <circle className="w-dot" cx="12" cy="6" r="1.6" />
      <circle className="w-dot" cx="17" cy="6" r="1.6" />
      {children}
    </g>
  )
}

function AppMark(): React.JSX.Element {
  return (
    <svg className="welcome-mark" viewBox="0 0 64 64" aria-hidden="true">
      <rect className="w-accent-fill" width="64" height="64" rx="14" />
      <path d="M17 22l10 10-10 10" fill="none" stroke="var(--accent-text)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M32 43h15" stroke="var(--accent-text)" strokeWidth="5" strokeLinecap="round" />
    </svg>
  )
}

function TerminalsArt(): React.JSX.Element {
  return (
    <svg viewBox="0 0 160 96">
      <Window x={34} y={8} w={110} h={66}>
        <rect className="w-shell" x="24" y="2" width="26" height="8" rx="2" opacity="0.35" />
      </Window>
      <Window x={16} y={22} w={110} h={66}>
        <rect className="w-shell" x="24" y="2" width="26" height="8" rx="2" />
        <rect className="w-wsl" x="53" y="2" width="26" height="8" rx="2" opacity="0.45" />
        <path className="w-shell-stroke" d="M10 24l6 5-6 5" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <rect className="w-muted" x="21" y="27" width="40" height="4" rx="2" />
        <rect className="w-muted" x="10" y="40" width="62" height="4" rx="2" opacity="0.6" />
        <rect className="w-muted" x="10" y="49" width="48" height="4" rx="2" opacity="0.6" />
        <rect className="w-accent-fill" x="62" y="49" width="3" height="6" rx="1" />
      </Window>
    </svg>
  )
}

function ProjectArt(): React.JSX.Element {
  return (
    <svg viewBox="0 0 160 96">
      <Window x={12} y={8} w={136} h={80}>
        {/* Git panel */}
        <rect className="w-project-soft" x="6" y="18" width="58" height="56" rx="4" />
        <circle className="w-project" cx="16" cy="30" r="3" />
        <circle className="w-project" cx="16" cy="44" r="3" />
        <circle className="w-agent" cx="28" cy="52" r="3" />
        <circle className="w-project" cx="16" cy="62" r="3" />
        <path className="w-project-stroke" d="M16 33v26M16 47c0 3 12 2 12 5" fill="none" strokeWidth="2" />
        <rect className="w-muted" x="36" y="28" width="22" height="4" rx="2" />
        <rect className="w-muted" x="36" y="42" width="18" height="4" rx="2" />
        <rect className="w-muted" x="36" y="60" width="20" height="4" rx="2" />
        {/* Agent panel */}
        <rect className="w-agent-soft" x="70" y="18" width="60" height="26" rx="4" />
        <rect className="w-agent" x="76" y="25" width="30" height="4" rx="2" />
        <rect className="w-muted" x="76" y="33" width="44" height="4" rx="2" />
        {/* Terminal panel */}
        <rect className="w-shell-soft" x="70" y="48" width="60" height="26" rx="4" />
        <path className="w-shell-stroke" d="M76 56l4 3.5-4 3.5" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <rect className="w-muted" x="84" y="57.5" width="26" height="4" rx="2" />
      </Window>
    </svg>
  )
}

function AgentArt(): React.JSX.Element {
  return (
    <svg viewBox="0 0 160 96">
      <Window x={10} y={10} w={92} h={76}>
        <rect className="w-agent-soft" x="8" y="20" width="58" height="16" rx="8" />
        <rect className="w-agent" x="15" y="26" width="38" height="4" rx="2" />
        <rect className="w-surface-2" x="26" y="42" width="58" height="16" rx="8" />
        <rect className="w-muted" x="33" y="48" width="40" height="4" rx="2" />
        <rect className="w-agent-soft" x="8" y="62" width="44" height="8" rx="4" />
      </Window>
      {/* MCP servers and skills plugged into the agent */}
      <path className="w-agent-stroke" d="M102 34h14M102 58h14" strokeWidth="2" strokeDasharray="3 3" />
      <rect className="w-surface w-agent-stroke" x="116" y="22" width="34" height="24" rx="6" strokeWidth="1.5" />
      {/* A plug: two prongs, the body, the cord */}
      <path className="w-agent-stroke" d="M129 26v5M137 26v5M133 39v4" fill="none" strokeWidth="2" strokeLinecap="round" />
      <path className="w-agent" d="M126 31h14v3a7 5 0 0 1-14 0z" />
      <rect className="w-surface w-agent-stroke" x="116" y="50" width="34" height="24" rx="6" strokeWidth="1.5" />
      <path className="w-agent" d="M133 54l2.4 5 5.4.6-4 3.7 1.1 5.3-4.9-2.7-4.9 2.7 1.1-5.3-4-3.7 5.4-.6z" />
    </svg>
  )
}

function GitArt(): React.JSX.Element {
  return (
    <svg viewBox="0 0 160 96">
      <path className="w-project-stroke" d="M24 78V18" fill="none" strokeWidth="3" strokeLinecap="round" />
      <path className="w-agent-stroke" d="M24 66c0-12 22-10 22-22V34c0-8-22-6-22-16" fill="none" strokeWidth="3" strokeLinecap="round" />
      <path className="w-wsl-stroke" d="M24 54c0-8 44-6 44-16" fill="none" strokeWidth="3" strokeLinecap="round" />
      <circle className="w-surface w-project-stroke" cx="24" cy="78" r="5" strokeWidth="3" />
      <circle className="w-surface w-project-stroke" cx="24" cy="54" r="5" strokeWidth="3" />
      <circle className="w-surface w-project-stroke" cx="24" cy="30" r="5" strokeWidth="3" />
      <circle className="w-project" cx="24" cy="18" r="6" />
      <circle className="w-surface w-agent-stroke" cx="46" cy="44" r="5" strokeWidth="3" />
      <circle className="w-surface w-wsl-stroke" cx="68" cy="38" r="5" strokeWidth="3" />
      {/* A diff with a staged line */}
      <rect className="w-surface w-stroke" x="88" y="16" width="62" height="64" rx="6" />
      <rect className="w-add" x="94" y="26" width="50" height="8" rx="2" />
      <rect className="w-del" x="94" y="38" width="50" height="8" rx="2" />
      <rect className="w-add" x="94" y="50" width="50" height="8" rx="2" />
      <rect className="w-accent-stroke" x="92.5" y="48.5" width="53" height="11" rx="3" fill="none" strokeWidth="1.5" />
      <rect className="w-muted" x="94" y="64" width="34" height="4" rx="2" />
    </svg>
  )
}

function TestsArt(): React.JSX.Element {
  const row = (y: number, status: 'ok' | 'fail' | 'skip', w: number): React.JSX.Element => (
    <g key={y}>
      {status === 'ok' && (
        <path className="w-ok-stroke" d={`M24 ${y + 1}l3 3 6-6`} fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {status === 'fail' && <path className="w-fail-stroke" d={`M25 ${y - 3}l7 7m0-7l-7 7`} fill="none" strokeWidth="2.4" strokeLinecap="round" />}
      {status === 'skip' && <circle className="w-muted-stroke" cx="28.5" cy={y + 0.5} r="3.5" fill="none" strokeWidth="2" />}
      <rect className="w-muted" x="40" y={y - 2} width={w} height="5" rx="2.5" />
    </g>
  )
  return (
    <svg viewBox="0 0 160 96">
      <Window x={12} y={8} w={92} h={80}>
        {row(26, 'ok', 40)}
        {row(38, 'ok', 32)}
        {row(50, 'fail', 44)}
        {row(62, 'skip', 28)}
        {row(74, 'ok', 36)}
      </Window>
      {/* The failure, sent to the agent */}
      <path className="w-agent-stroke" d="M104 58c14 0 14-20 26-20" fill="none" strokeWidth="2" strokeDasharray="3 3" />
      <circle className="w-agent" cx="138" cy="38" r="13" />
      <path d="M133 38h10m-4-4l4 4-4 4" fill="none" stroke="var(--surface)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function UpdatesArt(): React.JSX.Element {
  return (
    <svg viewBox="0 0 160 96">
      <circle className="w-accent-soft" cx="62" cy="48" r="34" />
      <path className="w-accent-stroke" d="M84 40a24 24 0 0 0-43-7M40 56a24 24 0 0 0 43 7" fill="none" strokeWidth="5" strokeLinecap="round" />
      <path className="w-accent-fill" d="M33 24l12 2-6 11zM91 72l-12-2 6-11z" />
      {/* Package boxes */}
      <g transform="translate(104 26)">
        <path className="w-wsl" d="M0 10l20-10 20 10-20 10z" opacity="0.85" />
        <path className="w-wsl" d="M0 10v22l20 10V20z" opacity="0.6" />
        <path className="w-wsl" d="M40 10v22L20 42V20z" />
        <circle className="w-ok" cx="38" cy="4" r="8" />
        <path d="M34 4l3 3 5-5" fill="none" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
}
