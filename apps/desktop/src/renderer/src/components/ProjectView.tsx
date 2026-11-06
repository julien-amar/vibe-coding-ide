import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hasVisiblePane, panesOf, updateAt, type DropSide, type PaneNode } from '@shared/layout'
import type { LayoutNode, PaneType, Profile } from '@shared/types'
import { parseWslPath } from '@shared/wsl-paths'
import { useProfiles } from '../profiles'
import { useTabs, type Tab } from '../store'
import { GitPanel } from './GitPanel'
import { ProfileIcon } from './ProfileIcon'
import { ProfileSelect } from './ProfileSelect'
import { SplitView } from './SplitView'
import { TerminalView } from './TerminalView'
import { TestPanel } from './TestPanel'
import { emptyHarness, harnessSize } from '@shared/harness'
import { HarnessDialog } from './HarnessDialog'

const PANE_ICON: Record<PaneNode['type'], string> = { git: '⎇', terminal: '>_', agent: 'AI', tests: '✓' }
const PANE_MIME = 'application/x-vibe-coding-ide-pane'

/** Project folder for display: WSL folders as "<distro>: /linux/path". */
function displayPath(root: string): string {
  const wsl = parseWslPath(root)
  return wsl ? `${wsl.distro}: ${wsl.path}` : root
}

/** Human label for a pane (used in the side rail). */
function paneLabel(pane: PaneNode, profiles: Profile[]): string {
  if (pane.type === 'git') return 'Git'
  if (pane.type === 'tests') return 'Tests'
  const name = profiles.find((p) => p.id === pane.profileId)?.name
  if (pane.type === 'agent') return name ?? 'AI agent'
  return name ?? 'Terminal'
}

const Icon = ({ d }: { d: string }): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ICONS = {
  collapse: 'M3 2v10M11 3.5L7 7l4 3.5',
  splitRight: 'M2 2.5h10v9H2zM7 2.5v9',
  splitDown: 'M2 2.5h10v9H2zM2 7h10',
  close: 'M3.5 3.5l7 7M10.5 3.5l-7 7'
}

/** Which edge of a pane the pointer is closest to (drop zones for moving panes). */
function sideAt(e: React.DragEvent, el: HTMLElement): DropSide {
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y }
  return (Object.keys(d) as DropSide[]).reduce((a, b) => (d[a] <= d[b] ? a : b))
}

/**
 * Common frame of a project panel: a header (drag handle to move the panel,
 * split / collapse / close buttons) and a body that accepts dropped panels.
 */
function PaneFrame({ tab, pane, title, actions, children }: { tab: Tab; pane: PaneNode; title: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const addPane = useTabs((s) => s.addPane)
  const closePane = useTabs((s) => s.closePane)
  const movePaneTo = useTabs((s) => s.movePane)
  const setPaneCollapsed = useTabs((s) => s.setPaneCollapsed)
  const setPaneDrop = useTabs((s) => s.setPaneDrop)
  const dropSide = useTabs((s) => (s.paneDrop?.paneId === pane.id ? s.paneDrop.side : undefined))
  const onlyPane = tab.project ? panesOf(tab.project.layout).length <= 1 : true
  // Terminal and agent panels can be split (the new panel duplicates the kind and profile).
  // Git and Tests panels have no split buttons: add panels from the side rail's "+" instead.
  const canSplit = pane.type === 'terminal' || pane.type === 'agent'
  const split = (side: DropSide): void => void addPane(tab.id, pane.type, { target: pane.id, side, profileId: pane.profileId })

  const isPaneDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(PANE_MIME)

  return (
    <div className="pane">
      <div
        className="pane-header"
        draggable
        title="Drag to move this panel"
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_MIME, JSON.stringify({ tabId: tab.id, paneId: pane.id }))
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => setPaneDrop(undefined)}
      >
        {title}
        <span className="spacer" />
        {actions}
        {canSplit && (
          <>
            <button className="icon-button pane-action" title="Split right" onClick={() => split('right')}>
              <Icon d={ICONS.splitRight} />
            </button>
            <button className="icon-button pane-action" title="Split down" onClick={() => split('bottom')}>
              <Icon d={ICONS.splitDown} />
            </button>
          </>
        )}
        <button className="icon-button pane-action collapse-button" title="Collapse to the side bar (the process keeps running)" onClick={() => setPaneCollapsed(tab.id, pane.id, true)}>
          <Icon d={ICONS.collapse} />
        </button>
        <button className="icon-button pane-action" title={onlyPane ? 'A project keeps at least one panel' : 'Close panel (stops its process)'} disabled={onlyPane} onClick={() => closePane(tab.id, pane.id)}>
          <Icon d={ICONS.close} />
        </button>
      </div>
      <div
        className="pane-body"
        onDragOver={(e) => {
          if (!isPaneDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          setPaneDrop({ paneId: pane.id, side: sideAt(e, e.currentTarget) })
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setPaneDrop(undefined)
        }}
        onDrop={(e) => {
          if (!isPaneDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          setPaneDrop(undefined)
          try {
            const { tabId, paneId } = JSON.parse(e.dataTransfer.getData(PANE_MIME)) as { tabId: string; paneId: string }
            if (tabId === tab.id && paneId !== pane.id) movePaneTo(tab.id, paneId, pane.id, sideAt(e, e.currentTarget))
          } catch {
            /* not a pane drag */
          }
        }}
      >
        {children}
        {dropSide && <div className={`pane-drop-zone ${dropSide}`} />}
      </div>
    </div>
  )
}

function TerminalPane({ tab, pane, visible, autoFocus }: { tab: Tab; pane: PaneNode; visible: boolean; autoFocus: boolean }): React.JSX.Element {
  const profiles = useProfiles()
  const restartPane = useTabs((s) => s.restartPane)
  const exitCode = useTabs((s) => (pane.sessionId ? s.paneExit[pane.sessionId] : undefined))
  const harnessStale = useTabs((s) => !!pane.sessionId && !!s.harnessStale[pane.sessionId])
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The dialog floats over the whole window: close it when its tab is hidden (another tab shown).
  useEffect(() => {
    if (!visible) setSettingsOpen(false)
  }, [visible])
  const settingsCount = harnessSize(pane.harness)
  const isAgent = pane.type === 'agent'
  // Agents installed in another WSL distro than the project's cannot run there: hide them.
  const distro = parseWslPath(tab.project?.root ?? '')?.distro.toLowerCase()
  const choices = profiles
    .filter((p) => (isAgent ? p.kind === 'agent' : p.kind !== 'agent'))
    .filter((p) => !(p.kind === 'agent' && p.wslDistro && p.wslDistro.toLowerCase() !== distro))
    // In a WSL project, the distro's own shell/agents come first.
    .sort((a, b) => Number(b.wslDistro?.toLowerCase() === distro && !!distro) - Number(a.wslDistro?.toLowerCase() === distro && !!distro))

  return (
    <PaneFrame
      tab={tab}
      pane={pane}
      title={
        <>
          <ProfileSelect
            value={pane.profileId}
            choices={choices}
            placeholder={isAgent ? 'No agent' : 'No shell'}
            title={isAgent ? 'Switch AI agent (restarts the pane)' : 'Switch shell (restarts the pane)'}
            onChange={(id) => void restartPane(tab.id, pane.id, id)}
          />
          <span className="pane-path" title={tab.project?.root}>
            {/* LRM marks keep slashes in place despite the rtl trick that ellipsizes from the left. */}
            {'\u200E' + displayPath(tab.project?.root ?? '') + '\u200E'}
          </span>
        </>
      }
      actions={
        <>
          {isAgent && (
            <button
              className={`icon-button pane-action agent-settings${settingsCount ? ' set' : ''}`}
              title="AI agent settings: MCP servers, skills, instructions (this panel only)"
              aria-label="AI agent settings"
              onClick={() => setSettingsOpen(true)}
            >
              ⚙{settingsCount > 0 && <span className="agent-settings-count">{settingsCount}</span>}
            </button>
          )}
          {pane.profileId && (
            <button className="icon-button pane-action" title="Restart" onClick={() => void restartPane(tab.id, pane.id)}>
              ⟳
            </button>
          )}
        </>
      }
    >
      {pane.sessionId ? (
        <TerminalView key={pane.sessionId} sessionId={pane.sessionId} restoredScrollback={pane.scrollback} visible={visible} autoFocus={autoFocus} />
      ) : (
        <div className="pane-message">
          {isAgent ? <p>No AI agent CLI found on PATH (claude, codex, gemini, opencode, pi).</p> : <p>No shell available.</p>}
        </div>
      )}
      {settingsOpen && (
        <HarnessDialog
          root={tab.project?.root ?? ''}
          agent={profiles.find((p) => p.id === pane.profileId)?.name ?? 'AI agent'}
          // "agent:codex", "wslagent:Ubuntu:codex" → "codex".
          agentId={/^(?:agent:|wslagent:[^:]+:)(.+)$/.exec(pane.profileId ?? '')?.[1]}
          harness={pane.harness ?? emptyHarness()}
          stale={harnessStale}
          onChange={(h) => useTabs.getState().setPaneHarness(tab.id, pane.id, h)}
          onRestart={() => void restartPane(tab.id, pane.id)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {isAgent && harnessStale && exitCode === undefined && (
        <div className="pane-exited harness-stale-bar">
          <span>This agent's settings changed: restart it to apply them (the conversation starts over).</span>
          <button onClick={() => void restartPane(tab.id, pane.id)}>Restart</button>
        </div>
      )}
      {exitCode !== undefined && (
        <div className="pane-exited">
          <span>Process exited with code {exitCode}</span>
          <button onClick={() => void restartPane(tab.id, pane.id)}>Restart</button>
        </div>
      )}
    </PaneFrame>
  )
}

function GitPane({ tab, pane, visible }: { tab: Tab; pane: PaneNode; visible: boolean }): React.JSX.Element {
  return (
    <PaneFrame
      tab={tab}
      pane={pane}
      title={
        <>
          <span className="pane-icon git">{PANE_ICON.git}</span>
          <span className="pane-title">Git</span>
        </>
      }
    >
      <GitPanel root={tab.project!.root} visible={visible} openProject={(path) => void useTabs.getState().openProject(path)} />
    </PaneFrame>
  )
}

function TestsPane({ tab, pane, visible }: { tab: Tab; pane: PaneNode; visible: boolean }): React.JSX.Element {
  return (
    <PaneFrame
      tab={tab}
      pane={pane}
      title={
        <>
          <span className="pane-icon tests">{PANE_ICON.tests}</span>
          <span className="pane-title">Tests</span>
        </>
      }
    >
      <TestPanel root={tab.project!.root} tabId={tab.id} visible={visible} />
    </PaneFrame>
  )
}

/**
 * "+" menu of the side rail: add a panel to the project. The menu is rendered
 * in a portal with fixed positioning: inside the rail it would be clipped by
 * the rail's scroll container (overflow) and hidden behind the panels.
 */
function AddPanelButton({ tab }: { tab: Tab }): React.JSX.Element {
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const addPane = useTabs((s) => s.addPane)
  const open = menuPos !== undefined

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setMenuPos(undefined)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuPos(undefined)
    }
    const close = (): void => setMenuPos(undefined)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open])

  const toggle = (): void => {
    if (open) return setMenuPos(undefined)
    const r = buttonRef.current!.getBoundingClientRect()
    setMenuPos({ left: r.right + 6, top: r.top })
  }

  const add = (type: PaneType): void => {
    setMenuPos(undefined)
    void addPane(tab.id, type)
  }

  return (
    <div className="rail-add">
      <button ref={buttonRef} className="rail-item add" title="Add a panel" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <span className="rail-plus">+</span>
      </button>
      {menuPos &&
        createPortal(
        <div ref={menuRef} className="context-menu rail-menu" role="menu" style={{ left: menuPos.left, top: menuPos.top }}>
          <button onClick={() => add('terminal')}>
            <span className="pane-icon">{PANE_ICON.terminal}</span> Terminal
          </button>
          <button onClick={() => add('agent')}>
            <span className="pane-icon agent">{PANE_ICON.agent}</span> AI agent
          </button>
          <button onClick={() => add('git')}>
            <span className="pane-icon git">{PANE_ICON.git}</span> Git
          </button>
          <button onClick={() => add('tests')}>
            <span className="pane-icon tests">{PANE_ICON.tests}</span> Tests
          </button>
        </div>,
          document.body
        )}
    </div>
  )
}

/** Vertical bar on the left: add panels, and buttons for collapsed panels (click to bring back). */
function SideRail({ tab, panes }: { tab: Tab; panes: PaneNode[] }): React.JSX.Element {
  const profiles = useProfiles()
  const setPaneCollapsed = useTabs((s) => s.setPaneCollapsed)
  const paneExit = useTabs((s) => s.paneExit)
  return (
    <nav className="side-rail" aria-label="Panels">
      <AddPanelButton tab={tab} />
      {panes.length > 0 && <div className="rail-separator" />}
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
    if (node.type === 'git') return <GitPane key={node.id} tab={tab} pane={node} visible={visible} />
    if (node.type === 'tests') return <TestsPane key={node.id} tab={tab} pane={node} visible={visible} />
    return <TerminalPane key={node.id} tab={tab} pane={node} visible={visible} autoFocus={node.id === focusId} />
  }

  return (
    <div className="project-view">
      <SideRail tab={tab} panes={collapsed} />
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
