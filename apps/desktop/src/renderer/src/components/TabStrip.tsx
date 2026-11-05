import { useEffect, useRef, useState } from 'react'
import { tabTitle, useTabs, type Tab } from '../store'
import { KindBadge } from './KindBadge'

const DRAG_TYPE = 'application/x-devhub-tab'

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
  onContextMenu,
  dropSide
}: {
  tab: Tab
  active: boolean
  editing: boolean
  onStartEdit: () => void
  onEndEdit: () => void
  onContextMenu: (e: React.MouseEvent) => void
  dropSide?: 'before' | 'after'
}): React.JSX.Element {
  const { activate, close, rename } = useTabs()
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
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, tab.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
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
  const { tabs, activeId, launcherOpen, setLauncherOpen, move, close, closeOthers } = useTabs()
  const [editingId, setEditingId] = useState<string>()
  const [menu, setMenu] = useState<MenuState>()
  const [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' }>()

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

  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    const el = (e.target as HTMLElement).closest<HTMLElement>('.tab')
    if (!el) return
    const rect = el.getBoundingClientRect()
    setDrop({ id: el.dataset.tabId!, side: e.clientX < rect.left + rect.width / 2 ? 'before' : 'after' })
  }

  const onDrop = (e: React.DragEvent): void => {
    const dragged = e.dataTransfer.getData(DRAG_TYPE)
    setDrop(undefined)
    if (!dragged || !drop || dragged === drop.id) return
    e.preventDefault()
    const without = tabs.filter((t) => t.id !== dragged)
    const targetIdx = without.findIndex((t) => t.id === drop.id)
    move(dragged, drop.side === 'before' ? targetIdx : targetIdx + 1)
  }

  return (
    <div className="titlebar">
      <div className="tab-strip" role="tablist" onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => setDrop(undefined)}>
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
            dropSide={drop?.id === t.id ? drop.side : undefined}
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
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              setEditingId(menu.tabId)
              setMenu(undefined)
            }}
          >
            Rename tab
          </button>
          <button
            onClick={() => {
              close(menu.tabId)
              setMenu(undefined)
            }}
          >
            Close tab
          </button>
          <button
            disabled={tabs.length < 2}
            onClick={() => {
              closeOthers(menu.tabId)
              setMenu(undefined)
            }}
          >
            Close other tabs
          </button>
        </div>
      )}
    </div>
  )
}
