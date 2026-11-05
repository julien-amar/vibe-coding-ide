import type { TabDragPayload } from '@shared/types'
import { toSnapshot, useTabs, type Tab } from './store'

/**
 * Tab drag and drop.
 * - Within a window: reorder.
 * - Onto another DevHub window: that window adopts the tab (session moves, process keeps running).
 * - Released outside every DevHub window: the tab opens in a new window at the cursor.
 */
export const TAB_MIME = 'application/x-devhub-tab'

export function onTabDragStart(e: React.DragEvent, tab: Tab): void {
  const { windowId } = useTabs.getState()
  const payload: TabDragPayload = { windowId, tabId: tab.id, tab: toSnapshot(tab) }
  e.dataTransfer.setData(TAB_MIME, JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'move'
}

export function onTabDragEnd(e: React.DragEvent, tab: Tab): void {
  useTabs.getState().setDrop(undefined)
  // dropEffect is 'move' when some DevHub window accepted the drop.
  if (e.dataTransfer.dropEffect !== 'none') return
  const outside =
    e.screenX < window.screenX ||
    e.screenX > window.screenX + window.outerWidth ||
    e.screenY < window.screenY ||
    e.screenY > window.screenY + window.outerHeight
  // A lone tab can't be torn out of its own window (it would just move the window).
  if (!outside || useTabs.getState().tabs.length < 2) return
  void window.devhub.window.detachTab(toSnapshot(tab), e.screenX, e.screenY)
}

export function onWindowDragOver(e: React.DragEvent): void {
  if (!e.dataTransfer.types.includes(TAB_MIME)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  const el = (e.target as HTMLElement).closest<HTMLElement>('.tab')
  if (!el?.dataset.tabId) {
    useTabs.getState().setDrop(undefined)
    return
  }
  const rect = el.getBoundingClientRect()
  useTabs.getState().setDrop({ tabId: el.dataset.tabId, side: e.clientX < rect.left + rect.width / 2 ? 'before' : 'after' })
}

export function onWindowDragLeave(e: React.DragEvent): void {
  // Only clear when the pointer leaves the window, not when moving between children.
  if (!e.relatedTarget) useTabs.getState().setDrop(undefined)
}

export function onWindowDrop(e: React.DragEvent): void {
  const raw = e.dataTransfer.getData(TAB_MIME)
  const store = useTabs.getState()
  const drop = store.drop
  store.setDrop(undefined)
  if (!raw) return
  e.preventDefault()

  let payload: TabDragPayload
  try {
    payload = JSON.parse(raw) as TabDragPayload
  } catch {
    return
  }

  // Target index among this window's tabs (end of strip when not dropped on a tab).
  const indexFor = (tabs: Tab[]): number => {
    if (!drop) return tabs.length
    const i = tabs.findIndex((t) => t.id === drop.tabId)
    if (i < 0) return tabs.length
    return drop.side === 'before' ? i : i + 1
  }

  if (payload.windowId === store.windowId) {
    if (drop?.tabId === payload.tabId) return
    store.move(payload.tabId, indexFor(store.tabs.filter((t) => t.id !== payload.tabId)))
    store.activate(payload.tabId)
    return
  }

  const index = indexFor(store.tabs)
  void window.devhub.window.adoptTab(payload.tab, payload.windowId).then((ok) => {
    if (ok) useTabs.getState().insertExisting(payload.tab, index)
  })
}
