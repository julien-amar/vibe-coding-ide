import { useEffect, useRef, useState } from 'react'
import { tabTitle, toSnapshot, useTabs, type Tab } from '../store'
import { onTabDragEnd, onTabDragStart } from '../tab-dnd'
import { KindBadge } from './KindBadge'

interface MenuState {
  tabId: string
  x: number
  y: number
}

function TabItem({
  tab,
  active,
  editing,
  onStartEdit,
  onEndEdit,
  onContextMenu
}: {
  tab: Tab
  active: boolean
  editing: boolean
  onStartEdit: () => void
  onEndEdit: () => void
  onContextMenu: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const activate = useTabs((s) => s.activate)
  const close = useTabs((s) => s.close)
  const rename = useTabs((s) => s.rename)
  const dropSide = useTabs((s) => (s.drop?.tabId === tab.id ? s.drop.side : undefined))
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(tabTitle(tab))
      requestAnimationFrame(() => inputRef.current?.select())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const commit = (): void => {
    // An empty name restores the automatic (shell-provided) title.
    rename(tab.id, draft)
    onEndEdit()
  }

  return (
    <div
      className={`tab${active ? ' active' : ''}${tab.exitCode !== undefined ? ' exited' : ''}${dropSide ? ` drop-${dropSide}` : ''}`}
      role="tab"
      aria-selected={active}
      draggable={!editing}
      data-tab-id={tab.id}
      onMouseDown={(e) => {
        if (e.button === 0) activate(tab.id)
      }}
      onAuxClick={(e) => {
        if (e.button === 1) close(tab.id)
      }}
      onDoubleClick={onStartEdit}
      onContextMenu={onContextMenu}
      onDragStart={(e) => onTabDragStart(e, tab)}
      onDragEnd={(e) => onTabDragEnd(e, tab)}
      title={tab.customTitle ? `${tab.customTitle} — ${tab.autoTitle}` : tab.autoTitle}
    >
      <KindBadge kind={tab.kind} />
      {editing ? (
        <input
          ref={inputRef}
          className="tab-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') onEndEdit()
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="tab-title">{tabTitle(tab)}</span>
      )}
      <button
        className="tab-close"
        title="Close tab (Ctrl+Shift+W)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => close(tab.id)}
      >
        ×
      </button>
    </div>
  )
}

export function TabStrip(): React.JSX.Element {
  const tabs = useTabs((s) => s.tabs)
  const activeId = useTabs((s) => s.activeId)
  const launcherOpen = useTabs((s) => s.launcherOpen)
  const setLauncherOpen = useTabs((s) => s.setLauncherOpen)
  const close = useTabs((s) => s.close)
  const closeOthers = useTabs((s) => s.closeOthers)
  const [editingId, setEditingId] = useState<string>()
  const [menu, setMenu] = useState<MenuState>()

  useEffect(() => {
    if (!menu) return
    const off = (): void => setMenu(undefined)
    window.addEventListener('mousedown', off)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('mousedown', off)
      window.removeEventListener('blur', off)
    }
  }, [menu])

  const menuTab = menu && tabs.find((t) => t.id === menu.tabId)
  const act = (fn: () => void) => () => {
    fn()
    setMenu(undefined)
  }

  return (
    <div className="titlebar">
      <div className="tab-strip" role="tablist">
        {tabs.map((t) => (
          <TabItem
            key={t.id}
            tab={t}
            active={t.id === activeId}
            editing={editingId === t.id}
            onStartEdit={() => setEditingId(t.id)}
            onEndEdit={() => setEditingId(undefined)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ tabId: t.id, x: e.clientX, y: e.clientY })
            }}
          />
        ))}
        <button
          className={`new-tab${launcherOpen ? ' open' : ''}`}
          title="New tab (Ctrl+Shift+T)"
          onClick={() => setLauncherOpen(!launcherOpen)}
        >
          +
        </button>
      </div>
      <div className="titlebar-drag" />
      {menu && menuTab && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={act(() => setEditingId(menu.tabId))}>Rename tab</button>
          <button
            disabled={tabs.length < 2}
            onClick={act(() => void window.devhub.window.detachTab(toSnapshot(menuTab), window.screenX + 160, window.screenY + 60))}
          >
            Move to new window
          </button>
          <div className="context-menu-separator" />
          <button onClick={act(() => close(menu.tabId))}>Close tab</button>
          <button disabled={tabs.length < 2} onClick={act(() => closeOthers(menu.tabId))}>
            Close other tabs
          </button>
        </div>
      )}
    </div>
  )
}
