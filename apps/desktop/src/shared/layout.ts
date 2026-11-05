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
