import type { LayoutNode, TabSnapshot } from './types'

export type PaneNode = Extract<LayoutNode, { kind: 'pane' }>
export type SplitNode = Extract<LayoutNode, { kind: 'split' }>

/** All panes of a layout tree, in document order. */
export function panesOf(node: LayoutNode): PaneNode[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap(panesOf)
}

/** Return a copy of the tree with every pane transformed by `fn`. */
export function mapPanes(node: LayoutNode, fn: (p: PaneNode) => PaneNode): LayoutNode {
  return node.kind === 'pane' ? fn(node) : { ...node, children: node.children.map((c) => mapPanes(c, fn)) }
}

/** Return a copy of the tree with the split at `path` (child indexes from the root) transformed. */
export function updateAt(node: LayoutNode, path: number[], fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (path.length === 0) return fn(node)
  if (node.kind !== 'split') return node
  const [head, ...rest] = path
  return { ...node, children: node.children.map((c, i) => (i === head ? updateAt(c, rest, fn) : c)) }
}

/** Whether any pane under this node is shown (not collapsed). */
export function hasVisiblePane(node: LayoutNode): boolean {
  return node.kind === 'pane' ? !node.collapsed : node.children.some(hasVisiblePane)
}

/** Every live session a tab owns (terminal tab session or project pane sessions). */
export function sessionIdsOf(tab: TabSnapshot): string[] {
  const ids = tab.sessionId ? [tab.sessionId] : []
  if (tab.project) for (const p of panesOf(tab.project.layout)) if (p.sessionId) ids.push(p.sessionId)
  return ids
}

// ---------- Pane management (add / close / split / move) ----------

export type DropSide = 'left' | 'right' | 'top' | 'bottom'

export const newPaneId = (): string => `pane-${Math.random().toString(36).slice(2, 10)}`

/** Remove a pane; splits left with one child collapse into it. Returns null if nothing is left. */
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === 'pane') return node.id === paneId ? null : node
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const r = removePane(c, paneId)
    if (r) {
      children.push(r)
      sizes.push(node.sizes[i])
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return flatten({ ...node, children, sizes })
}

/** Inline child splits that go in the same direction as their parent (keeps the tree shallow). */
function flatten(node: SplitNode): SplitNode {
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    if (c.kind === 'split' && c.dir === node.dir) {
      const total = c.sizes.reduce((a, b) => a + b, 0) || 1
      c.children.forEach((gc, j) => {
        children.push(gc)
        sizes.push((node.sizes[i] * c.sizes[j]) / total)
      })
    } else {
      children.push(c)
      sizes.push(node.sizes[i])
    }
  })
  return { ...node, children, sizes }
}

/**
 * Insert `pane` next to the pane `targetId`, on the given side. If the target's
 * parent already splits in that direction, the new pane becomes a sibling
 * (sharing the target's space); otherwise the target is split in two.
 */
export function insertPane(root: LayoutNode, targetId: string, pane: PaneNode, side: DropSide): LayoutNode {
  const dir = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'top'
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'pane') {
      if (node.id !== targetId) return node
      return { kind: 'split', dir, sizes: [0.5, 0.5], children: before ? [pane, node] : [node, pane] }
    }
    const idx = node.children.findIndex((c) => c.kind === 'pane' && c.id === targetId)
    if (idx >= 0 && node.dir === dir) {
      const sizes = [...node.sizes]
      const half = sizes[idx] / 2
      sizes[idx] = half
      const at = before ? idx : idx + 1
      const children = [...node.children]
      children.splice(at, 0, pane)
      sizes.splice(at, 0, half)
      return { ...node, children, sizes }
    }
    return { ...node, children: node.children.map(visit) }
  }
  return visit(root)
}

/** Add a pane on the right edge of the whole layout. */
export function appendPane(root: LayoutNode, pane: PaneNode): LayoutNode {
  if (root.kind === 'split' && root.dir === 'row') {
    const avg = root.sizes.reduce((a, b) => a + b, 0) / root.sizes.length
    return { ...root, children: [...root.children, pane], sizes: [...root.sizes, avg] }
  }
  return { kind: 'split', dir: 'row', sizes: [0.65, 0.35], children: [root, pane] }
}

/** Move a pane next to another pane. */
export function movePane(root: LayoutNode, paneId: string, targetId: string, side: DropSide): LayoutNode {
  if (paneId === targetId) return root
  const pane = panesOf(root).find((p) => p.id === paneId)
  if (!pane) return root
  const without = removePane(root, paneId)
  if (!without || !panesOf(without).some((p) => p.id === targetId)) return root
  return insertPane(without, targetId, pane, side)
}
