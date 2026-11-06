import { describe, expect, it } from 'vitest'
import type { LayoutNode } from './types'
import { appendPane, hasVisiblePane, insertPane, mapPanes, movePane, panesOf, removePane, sessionIdsOf, updateAt, type PaneNode } from './layout'

const pane = (id: string, extra: Partial<PaneNode> = {}): PaneNode => ({ kind: 'pane', id, type: 'terminal', ...extra })

/** Compact text form of a tree: row[a, column[b, c]] */
const shape = (n: LayoutNode | null): string => (!n ? 'null' : n.kind === 'pane' ? n.id : `${n.dir}[${n.children.map(shape).join(', ')}]`)

/** The default project layout: row[column[git, terminal], agent] */
const projectLayout = (): LayoutNode => ({
  kind: 'split',
  dir: 'row',
  sizes: [0.6, 0.4],
  children: [
    { kind: 'split', dir: 'column', sizes: [0.55, 0.45], children: [pane('git', { type: 'git' }), pane('terminal')] },
    pane('agent', { type: 'agent' })
  ]
})

describe('panesOf / mapPanes', () => {
  it('lists panes in document order', () => {
    expect(panesOf(projectLayout()).map((p) => p.id)).toEqual(['git', 'terminal', 'agent'])
  })

  it('maps panes without touching the structure', () => {
    const mapped = mapPanes(projectLayout(), (p) => ({ ...p, collapsed: p.id === 'git' }))
    expect(shape(mapped)).toBe(shape(projectLayout()))
    expect(panesOf(mapped).find((p) => p.id === 'git')?.collapsed).toBe(true)
  })
})

describe('insertPane', () => {
  it('splits a pane in two when the parent goes in another direction', () => {
    const out = insertPane(projectLayout(), 'terminal', pane('new'), 'right')
    expect(shape(out)).toBe('row[column[git, row[terminal, new]], agent]')
  })

  it('adds a sibling (sharing the target space) when the parent goes in the same direction', () => {
    const out = insertPane(projectLayout(), 'terminal', pane('new'), 'bottom')
    expect(shape(out)).toBe('row[column[git, terminal, new], agent]')
    const column = (out as Extract<LayoutNode, { kind: 'split' }>).children[0] as Extract<LayoutNode, { kind: 'split' }>
    expect(column.sizes).toEqual([0.55, 0.225, 0.225])
  })

  it('inserts before the target for left / top', () => {
    expect(shape(insertPane(projectLayout(), 'agent', pane('new'), 'left'))).toBe('row[column[git, terminal], new, agent]')
    expect(shape(insertPane(projectLayout(), 'git', pane('new'), 'top'))).toBe('row[column[new, git, terminal], agent]')
  })

  it('wraps a single-pane root', () => {
    expect(shape(insertPane(pane('a'), 'a', pane('b'), 'bottom'))).toBe('column[a, b]')
  })
})

describe('removePane', () => {
  it('collapses a split left with one child into that child', () => {
    expect(shape(removePane(projectLayout(), 'git'))).toBe('row[terminal, agent]')
  })

  it('flattens nested splits going in the same direction and keeps proportions', () => {
    const tree = insertPane(projectLayout(), 'terminal', pane('t2'), 'right') // row[column[git, row[terminal, t2]], agent]
    const out = removePane(tree, 'git') as Extract<LayoutNode, { kind: 'split' }>
    expect(shape(out)).toBe('row[terminal, t2, agent]')
    expect(out.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(out.sizes[0]).toBeCloseTo(0.3)
    expect(out.sizes[1]).toBeCloseTo(0.3)
  })

  it('returns null when the last pane goes', () => {
    expect(removePane(pane('only'), 'only')).toBeNull()
  })

  it('ignores unknown panes', () => {
    expect(shape(removePane(projectLayout(), 'nope'))).toBe(shape(projectLayout()))
  })
})

describe('movePane', () => {
  it('moves a pane next to another one', () => {
    expect(shape(movePane(projectLayout(), 'git', 'agent', 'bottom'))).toBe('row[terminal, column[agent, git]]')
  })

  it('is a no-op when moving a pane onto itself or onto a missing target', () => {
    const tree = projectLayout()
    expect(movePane(tree, 'git', 'git', 'left')).toBe(tree)
    expect(shape(movePane(tree, 'git', 'missing', 'left'))).toBe(shape(tree))
  })
})

describe('appendPane / updateAt / hasVisiblePane / sessionIdsOf', () => {
  it('appends on the right edge', () => {
    expect(shape(appendPane(projectLayout(), pane('x')))).toBe('row[column[git, terminal], agent, x]')
    expect(shape(appendPane(pane('a'), pane('b')))).toBe('row[a, b]')
  })

  it('updates the node at a path', () => {
    const out = updateAt(projectLayout(), [0], (n) => (n.kind === 'split' ? { ...n, sizes: [0.9, 0.1] } : n))
    expect(((out as Extract<LayoutNode, { kind: 'split' }>).children[0] as Extract<LayoutNode, { kind: 'split' }>).sizes).toEqual([0.9, 0.1])
  })

  it('knows when every pane is collapsed', () => {
    const all = mapPanes(projectLayout(), (p) => ({ ...p, collapsed: true }))
    expect(hasVisiblePane(all)).toBe(false)
    expect(hasVisiblePane(mapPanes(all, (p) => (p.id === 'agent' ? { ...p, collapsed: false } : p)))).toBe(true)
  })

  it('collects the live sessions of terminal and project tabs', () => {
    expect(sessionIdsOf({ kind: 'shell', autoTitle: 'x', sessionId: 's1' })).toEqual(['s1'])
    const layout = mapPanes(projectLayout(), (p) => (p.type === 'git' ? p : { ...p, sessionId: `s-${p.id}` }))
    expect(sessionIdsOf({ kind: 'project', autoTitle: 'p', project: { root: '/r', name: 'r', layout } })).toEqual(['s-terminal', 's-agent'])
  })
})
