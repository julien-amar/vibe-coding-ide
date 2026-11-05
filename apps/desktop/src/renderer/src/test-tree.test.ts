import { describe, expect, it } from 'vitest'
import type { TestProject } from '@shared/types'
import { aggregateStatus, buildTestTree, filterTestTree, formatDuration, stripAnsi } from './test-tree'

const project: TestProject = {
  id: 'vitest:apps/web',
  framework: 'vitest',
  dir: '/r/apps/web',
  relDir: 'apps/web',
  tests: [
    { id: 'a.test.ts::math > adds', file: 'a.test.ts', suite: ['math'], name: 'adds', line: 3 },
    { id: 'a.test.ts::math > deep > mul', file: 'a.test.ts', suite: ['math', 'deep'], name: 'mul', line: 7 },
    { id: 'a.test.ts::top', file: 'a.test.ts', suite: [], name: 'top' },
    { id: 'b.test.ts::other', file: 'b.test.ts', suite: [], name: 'other' }
  ]
}

describe('Tests panel tree', () => {
  it('groups tests by file and nested suites, with run requests for every level', () => {
    const tree = buildTestTree(project)
    expect(tree.label).toBe('Vitest · apps/web')
    expect(tree.testIds).toHaveLength(4)
    const [a, b] = tree.children
    expect(a.label).toBe('a.test.ts')
    expect(a.req).toEqual({ projectId: 'vitest:apps/web', file: 'a.test.ts' })
    expect(a.children.map((c) => `${c.kind}:${c.label}`)).toEqual(['suite:math', 'test:top'])
    const math = a.children[0]
    expect(math.testIds).toEqual(['a.test.ts::math > adds', 'a.test.ts::math > deep > mul'])
    const deep = math.children[1]
    expect(deep.req).toEqual({ projectId: 'vitest:apps/web', file: 'a.test.ts', titlePath: ['math', 'deep'] })
    expect(deep.children[0].req).toEqual({ projectId: 'vitest:apps/web', file: 'a.test.ts', titlePath: ['math', 'deep', 'mul'], line: 7 })
    expect(b.children.map((c) => c.label)).toEqual(['other'])
  })

  it('combines statuses: running, then failed, then passed, then skipped', () => {
    const ids = ['x', 'y']
    const p = 'p'
    expect(aggregateStatus(p, ids, {})).toBeUndefined()
    expect(aggregateStatus(p, ids, { 'p|x': { id: 'x', status: 'skipped' } })).toBe('skipped')
    expect(aggregateStatus(p, ids, { 'p|x': { id: 'x', status: 'skipped' }, 'p|y': { id: 'y', status: 'passed' } })).toBe('passed')
    expect(aggregateStatus(p, ids, { 'p|x': { id: 'x', status: 'failed' }, 'p|y': { id: 'y', status: 'passed' } })).toBe('failed')
    expect(aggregateStatus(p, ids, { 'p|x': { id: 'x', status: 'failed' }, 'p|y': { status: 'running' } })).toBe('running')
  })

  it('filters tests and drops empty groups', () => {
    const tree = filterTestTree(buildTestTree(project), (t) => t.name.includes('mul'))!
    expect(tree.testIds).toEqual(['a.test.ts::math > deep > mul'])
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].children[0].children[0].label).toBe('deep')
  })

  it('formats output and durations', () => {
    expect(stripAnsi('\x1b[32m✓\x1b[39m ok \x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('✓ ok link')
    expect(formatDuration(12.4)).toBe('12 ms')
    expect(formatDuration(1534)).toBe('1.53 s')
    expect(formatDuration(undefined)).toBe('')
  })
})
