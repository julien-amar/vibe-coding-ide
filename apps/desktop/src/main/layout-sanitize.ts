import type { LayoutNode, TabSnapshot } from '@shared/types'
import { harnessIsEmpty, sanitizeHarness } from './harness'

/** Validation of tabs and layouts coming from a renderer (or the saved layout file): drops anything malformed. */

const PANE_TYPES = new Set(['terminal', 'agent', 'git', 'tests'])
const TAB_KINDS = new Set(['shell', 'wsl', 'agent', 'tool', 'project', 'containers'])

export function sanitizeLayout(n: LayoutNode | undefined, depth = 0): LayoutNode | undefined {
  if (!n || typeof n !== 'object' || depth > 8) return undefined
  if (n.kind === 'split' && Array.isArray(n.children)) {
    const children = n.children.map((c) => sanitizeLayout(c, depth + 1)).filter((c): c is LayoutNode => !!c)
    if (children.length === 0) return undefined
    const sizes =
      Array.isArray(n.sizes) && n.sizes.length === children.length && n.sizes.every((v) => Number(v) > 0)
        ? n.sizes.map(Number)
        : children.map(() => 1 / children.length)
    return { kind: 'split', dir: n.dir === 'column' ? 'column' : 'row', sizes, children }
  }
  if (n.kind === 'pane' && PANE_TYPES.has(n.type)) {
    const harness = n.type === 'agent' && n.harness ? sanitizeHarness(n.harness) : undefined
    return {
      kind: 'pane',
      id: String(n.id),
      type: n.type,
      profileId: n.profileId ? String(n.profileId) : undefined,
      sessionId: n.sessionId ? String(n.sessionId) : undefined,
      collapsed: n.collapsed === true ? true : undefined,
      // AI agent panes keep their own settings.
      harness: harness && !harnessIsEmpty(harness) ? harness : undefined
    }
  }
  return undefined
}

export function sanitizeTab(t: TabSnapshot): TabSnapshot {
  const layout = t.project && typeof t.project.root === 'string' ? sanitizeLayout(t.project.layout) : undefined
  return {
    kind: TAB_KINDS.has(t.kind) ? t.kind : 'shell',
    profileId: t.profileId ? String(t.profileId) : undefined,
    autoTitle: String(t.autoTitle ?? ''),
    customTitle: t.customTitle ? String(t.customTitle) : undefined,
    sessionId: t.sessionId ? String(t.sessionId) : undefined,
    project: t.project && layout ? { root: String(t.project.root), name: String(t.project.name ?? ''), layout } : undefined
  }
}
