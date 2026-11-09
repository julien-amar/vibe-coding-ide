import { describe, expect, it } from 'vitest'
import type { TestProject } from '@shared/types'
import {
  aggregateStatus,
  buildTestTree,
  filterTestTree,
  formatDuration,
  groupTestTrees,
  nodeStatus,
  splitLocations,
  stripAnsi,
  type TestTreeNode
} from './test-tree'

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

  it('finds file locations in stack traces (Node, Windows, WSL, pytest, file URLs)', () => {
    const loc = (t: string): (string | { file: string; line: number; column?: number })[] =>
      splitLocations(t).map((p) => (typeof p === 'string' ? p : { file: p.file, line: p.line, column: p.column }))
    expect(loc('    at C:/Users/me/app/src/a.test.ts:9:19')).toEqual(['    at ', { file: 'C:/Users/me/app/src/a.test.ts', line: 9, column: 19 }])
    expect(loc('at Object.<anonymous> (C:\\app\\jest\\x.check.js:7:30)')).toEqual([
      'at Object.<anonymous> (',
      { file: 'C:\\app\\jest\\x.check.js', line: 7, column: 30 },
      ')'
    ])
    expect(loc('/home/me/app/test/x.spec.ts:12:3')).toEqual([{ file: '/home/me/app/test/x.spec.ts', line: 12, column: 3 }])
    expect(loc('py/check_math.py:9: AssertionError')).toEqual([{ file: 'py/check_math.py', line: 9, column: undefined }, ': AssertionError'])
    expect(loc('at file:///C:/app/node_modules/vitest/dist/x.js:1:2')).toEqual([
      'at ',
      { file: 'file:///C:/app/node_modules/vitest/dist/x.js', line: 1, column: 2 }
    ])
    // file:// URLs are shown as plain paths (the link still opens the file).
    const shown = (t: string): string[] => splitLocations(t).flatMap((p) => (typeof p === 'string' ? [] : [p.text]))
    expect(shown('at file:///C:/app/node_modules/x.js:1:2')).toEqual(['C:/app/node_modules/x.js:1:2'])
    expect(shown('at file:///home/me/app/x.js:3:4')).toEqual(['/home/me/app/x.js:3:4'])
    expect(shown('at (C:\\app\\x.js:5:6)')).toEqual(['C:\\app\\x.js:5:6'])
    // Not locations: URLs with a port, versions, plain numbers.
    expect(loc('see http://localhost:3000 and v5.1.0:2 or 12:30')).toEqual(['see http://localhost:3000 and v5.1.0:2 or 12:30'])
  })

  it('formats output and durations', () => {
    expect(stripAnsi('\x1b[32m✓\x1b[39m ok \x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('✓ ok link')
    expect(formatDuration(12.4)).toBe('12 ms')
    expect(formatDuration(1534)).toBe('1.53 s')
    expect(formatDuration(undefined)).toBe('')
  })
})

describe('Tests panel tree (.NET)', () => {
  const dotnet = (relDir: string, projectFile: string, names: string[]): TestProject => ({
    id: `dotnet:${relDir}`,
    framework: 'dotnet',
    dir: `/r/${relDir}`,
    relDir,
    projectFile,
    tests: names.map((n) => {
      const dot = n.lastIndexOf('.')
      return { id: `${n.slice(0, dot)}::${n.slice(dot + 1)}`, file: n.slice(0, dot), suite: [], name: n.slice(dot + 1) }
    })
  })
  const p1 = dotnet('tests/Project1', 'Project1.csproj', ['namespace1.namespace2.class3.test3'])
  const p2 = dotnet('tests/Project2', 'Project2.fsproj', ['namespace1.namespace2.namespace3.class1.test1', 'namespace1.namespace2.namespace4.class2.test2'])
  const vitest = { ...project }

  /** "kind label" lines, indented by depth. */
  const outline = (n: TestTreeNode, depth = 0): string[] => [`${'  '.repeat(depth)}${n.kind} ${n.label}`, ...n.children.flatMap((c) => outline(c, depth + 1))]

  it('groups the test projects under the tab, then namespaces (single-child chains merged), classes and tests', () => {
    const trees = groupTestTrees([p1, p2].map(buildTestTree), [p1, p2], 'my-repo')
    expect(trees).toHaveLength(1)
    expect(outline(trees[0])).toEqual([
      'group my-repo',
      '  project Project1',
      '    namespace namespace1.namespace2',
      '      class class3',
      '        test test3',
      '  project Project2',
      '    namespace namespace1.namespace2',
      '      namespace namespace3',
      '        class class1',
      '          test test1',
      '      namespace namespace4',
      '        class class2',
      '          test test2'
    ])
    expect(trees[0].testIds).toHaveLength(3)
  })

  it('runs a merged namespace, a class and a test by their full names', () => {
    const ns = buildTestTree(p1).children[0]
    expect(ns.req).toEqual({ projectId: 'dotnet:tests/Project1', file: 'namespace1.namespace2' })
    expect(ns.children[0].req).toEqual({ projectId: 'dotnet:tests/Project1', file: 'namespace1.namespace2.class3' })
    expect(ns.children[0].children[0].req).toEqual({
      projectId: 'dotnet:tests/Project1',
      file: 'namespace1.namespace2.class3',
      titlePath: ['test3'],
      line: undefined
    })
  })

  it('keeps other frameworks beside the group; a project without a project file is named after its folder', () => {
    const noFile = { ...p1, projectFile: undefined }
    const trees = groupTestTrees([vitest, noFile].map(buildTestTree), [vitest, noFile], 'my-repo')
    expect(trees.map((t) => `${t.kind} ${t.label}`)).toEqual(['project Vitest · apps/web', 'group my-repo'])
    expect(trees[1].children[0].label).toBe('Project1')
  })

  it('combines the statuses of a group, and filters across its projects', () => {
    const [group] = groupTestTrees([p1, p2].map(buildTestTree), [p1, p2], 'my-repo')
    const results = {
      'dotnet:tests/Project1|namespace1.namespace2.class3::test3': { id: 'x', status: 'passed' as const },
      'dotnet:tests/Project2|namespace1.namespace2.namespace4.class2::test2': { id: 'y', status: 'failed' as const }
    }
    expect(nodeStatus(group, results)).toBe('failed')
    const onlyFailed = filterTestTree(group, (t, projectId) => results[`${projectId}|${t.id}` as keyof typeof results]?.status === 'failed')!
    expect(outline(onlyFailed)).toEqual([
      'group my-repo',
      '  project Project2',
      '    namespace namespace1.namespace2',
      '      namespace namespace4',
      '        class class2',
      '          test test2'
    ])
  })
})
