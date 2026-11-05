import { hasVisiblePane, panesOf, updateAt, type PaneNode } from '@shared/layout'
import type { LayoutNode, Profile } from '@shared/types'
import { useProfiles } from '../profiles'
import { useTabs, type Tab } from '../store'
import { GitLogPane } from './GitLogPane'
import { ProfileIcon } from './ProfileIcon'
import { ProfileSelect } from './ProfileSelect'
import { SplitView } from './SplitView'
import { TerminalView } from './TerminalView'

const PANE_ICON: Record<PaneNode['type'], string> = { git: '⎇', terminal: '>_', agent: 'AI' }

/** Human label for a pane (used in the side rail). */
function paneLabel(pane: PaneNode, profiles: Profile[]): string {
  if (pane.type === 'git') return 'Git'
  const name = profiles.find((p) => p.id === pane.profileId)?.name
  if (pane.type === 'agent') return name ?? 'AI agent'
  return name ?? 'Terminal'
}

function CollapseButton({ tab, pane }: { tab: Tab; pane: PaneNode }): React.JSX.Element {
  const setPaneCollapsed = useTabs((s) => s.setPaneCollapsed)
  return (
    <button
      className="icon-button collapse-button"
      title="Collapse to the side bar (the process keeps running)"
      aria-label="Collapse panel"
      onClick={() => setPaneCollapsed(tab.id, pane.id, true)}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <path d="M3 2v10M11 3.5L7 7l4 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function TerminalPane({ tab, pane, visible, autoFocus }: { tab: Tab; pane: PaneNode; visible: boolean; autoFocus: boolean }): React.JSX.Element {
  const profiles = useProfiles()
  const restartPane = useTabs((s) => s.restartPane)
  const exitCode = useTabs((s) => (pane.sessionId ? s.paneExit[pane.sessionId] : undefined))
  const isAgent = pane.type === 'agent'
  const choices = profiles.filter((p) => (isAgent ? p.kind === 'agent' : p.kind !== 'agent'))

  return (
    <div className="pane">
      <div className="pane-header">
        <ProfileSelect
          value={pane.profileId}
          choices={choices}
          placeholder={isAgent ? 'No agent' : 'No shell'}
          title={isAgent ? 'Switch AI agent (restarts the pane)' : 'Switch shell (restarts the pane)'}
          onChange={(id) => void restartPane(tab.id, pane.id, id)}
        />
        <span className="pane-path" title={tab.project?.root}>
          {tab.project?.root}
        </span>
        <span className="spacer" />
        {pane.profileId && (
          <button className="icon-button" title="Restart" onClick={() => void restartPane(tab.id, pane.id)}>
            ⟳
          </button>
        )}
        <CollapseButton tab={tab} pane={pane} />
      </div>
      <div className="pane-body">
        {pane.sessionId ? (
          <TerminalView key={pane.sessionId} sessionId={pane.sessionId} restoredScrollback={pane.scrollback} visible={visible} autoFocus={autoFocus} />
        ) : (
          <div className="pane-message">
            {isAgent ? <p>No AI agent CLI found on PATH (claude, codex, gemini, opencode, pi).</p> : <p>No shell available.</p>}
          </div>
        )}
        {exitCode !== undefined && (
          <div className="pane-exited">
            <span>Process exited with code {exitCode}</span>
            <button onClick={() => void restartPane(tab.id, pane.id)}>Restart</button>
          </div>
        )}
      </div>
    </div>
  )
}

function GitPane({ tab, pane, visible }: { tab: Tab; pane: PaneNode; visible: boolean }): React.JSX.Element {
  return (
    <div className="pane">
      <div className="pane-header">
        <span className="pane-icon git">{PANE_ICON.git}</span>
        <span className="pane-title">Git</span>
        <span className="spacer" />
        <CollapseButton tab={tab} pane={pane} />
      </div>
      <div className="pane-body">
        <GitLogPane root={tab.project!.root} visible={visible} />
      </div>
    </div>
  )
}

/** Vertical bar on the left listing collapsed panels; click one to bring it back. */
function SideRail({ tab, panes }: { tab: Tab; panes: PaneNode[] }): React.JSX.Element {
  const profiles = useProfiles()
  const setPaneCollapsed = useTabs((s) => s.setPaneCollapsed)
  const paneExit = useTabs((s) => s.paneExit)
  return (
    <nav className="side-rail" aria-label="Collapsed panels">
      {panes.map((p) => {
        const label = paneLabel(p, profiles)
        const profile = profiles.find((x) => x.id === p.profileId)
        const exited = p.sessionId !== undefined && paneExit[p.sessionId] !== undefined
        return (
          <button
            key={p.id}
            className={`rail-item ${p.type}${exited ? ' exited' : ''}`}
            title={`Show ${label}${exited ? ' (process exited)' : ''}`}
            onClick={() => setPaneCollapsed(tab.id, p.id, false)}
          >
            {profile ? <ProfileIcon profile={profile} /> : <span className={`pane-icon ${p.type}`}>{PANE_ICON[p.type]}</span>}
            <span className="rail-label">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

export function ProjectView({ tab, visible }: { tab: Tab; visible: boolean }): React.JSX.Element | null {
  const setLayout = useTabs((s) => s.setLayout)
  const setPaneCollapsed = useTabs((s) => s.setPaneCollapsed)
  if (!tab.project) return null
  const layout = tab.project.layout
  const panes = panesOf(layout)
  const collapsed = panes.filter((p) => p.collapsed)
  // Keyboard focus goes to the visible agent pane if there is one, otherwise the visible terminal.
  const shownPanes = panes.filter((p) => !p.collapsed)
  const focusId = (shownPanes.find((p) => p.type === 'agent' && p.sessionId) ?? shownPanes.find((p) => p.type === 'terminal'))?.id

  const render = (node: LayoutNode, path: number[]): React.ReactNode => {
    if (node.kind === 'split') {
      const visibleChildren = node.children.map(hasVisiblePane)
      // A split with a single visible child just shows that child.
      if (visibleChildren.filter(Boolean).length === 1) {
        const only = visibleChildren.indexOf(true)
        return render(node.children[only], [...path, only])
      }
      return (
        <SplitView
          node={node}
          visible={visibleChildren}
          onResize={(sizes) => setLayout(tab.id, updateAt(layout, path, (n) => (n.kind === 'split' ? { ...n, sizes } : n)))}
          renderChild={(i) => render(node.children[i], [...path, i])}
        />
      )
    }
    if (node.type === 'git') return <GitPane tab={tab} pane={node} visible={visible} />
    return <TerminalPane tab={tab} pane={node} visible={visible} autoFocus={node.id === focusId} />
  }

  return (
    <div className="project-view">
      {collapsed.length > 0 && <SideRail tab={tab} panes={collapsed} />}
      <div className="project-main">
        {hasVisiblePane(layout) ? (
          render(layout, [])
        ) : (
          <div className="empty-state">
            <p>All panels are collapsed.</p>
            <button onClick={() => collapsed.forEach((p) => setPaneCollapsed(tab.id, p.id, false))}>Show all panels</button>
          </div>
        )}
      </div>
    </div>
  )
}
