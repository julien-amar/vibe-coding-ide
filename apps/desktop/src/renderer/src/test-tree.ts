import type { TestCase, TestProject, TestResult, TestRunRequest, TestStatus } from '@shared/types'

/**
 * A row of the Tests panel tree: a test project, a file, a describe() block or a test; for .NET, the
 * project tab's test projects (group), a namespace, a class.
 */
export interface TestTreeNode {
  key: string
  kind: 'group' | 'project' | 'file' | 'suite' | 'namespace' | 'class' | 'test'
  label: string
  projectId: string
  children: TestTreeNode[]
  /** Every test under this node (itself for a test). */
  testIds: string[]
  /** How to run this node. */
  req: TestRunRequest
  test?: TestCase
}

export const FRAMEWORK_LABEL: Record<TestProject['framework'], string> = {
  vitest: 'Vitest',
  jest: 'Jest',
  playwright: 'Playwright',
  pytest: 'pytest',
  go: 'Go',
  cargo: 'Rust',
  dotnet: '.NET',
  maven: 'Maven',
  gradle: 'Gradle'
}

/** A .NET test project's name: its project file without the extension (else its folder). */
export const dotnetProjectName = (project: TestProject): string => project.projectFile?.replace(/\.[^.]+$/, '') ?? (project.relDir.split('/').pop() || '.NET')

/** Tree of a test project: files, then nested suites, then tests (in listing order). .NET: see dotnetTree. */
export function buildTestTree(project: TestProject): TestTreeNode {
  if (project.framework === 'dotnet') return dotnetTree(project)
  const projectId = project.id
  const rootNode: TestTreeNode = {
    key: projectId,
    kind: 'project',
    label: `${FRAMEWORK_LABEL[project.framework]}${project.relDir ? ` · ${project.relDir}` : ''}`,
    projectId,
    children: [],
    testIds: [],
    req: { projectId }
  }
  const groups = new Map<string, TestTreeNode>()
  const group = (parent: TestTreeNode, key: string, make: () => TestTreeNode): TestTreeNode => {
    let g = groups.get(key)
    if (!g) {
      g = make()
      groups.set(key, g)
      parent.children.push(g)
    }
    return g
  }
  // Each test once: rows are keyed by test id (a duplicate key leaves rows behind on screen).
  for (const t of uniqueTests(project.tests)) {
    const fileKey = `${projectId}|${t.file}`
    let parent = group(rootNode, fileKey, () => ({
      key: fileKey,
      kind: 'file',
      label: t.file,
      projectId,
      children: [],
      testIds: [],
      req: { projectId, file: t.file }
    }))
    const chain: TestTreeNode[] = [rootNode, parent]
    t.suite.forEach((title, i) => {
      const path = t.suite.slice(0, i + 1)
      const key = `${fileKey}|${path.join(' > ')}`
      parent = group(parent, key, () => ({
        key,
        kind: 'suite',
        label: title,
        projectId,
        children: [],
        testIds: [],
        req: { projectId, file: t.file, titlePath: path }
      }))
      chain.push(parent)
    })
    parent.children.push({
      key: `${projectId}|${t.id}`,
      kind: 'test',
      label: t.projectName ? `${t.name} [${t.projectName}]` : t.name,
      projectId,
      children: [],
      testIds: [t.id],
      req: { projectId, file: t.file, titlePath: [...t.suite, t.name], line: t.line },
      test: t
    })
    for (const n of chain) n.testIds.push(t.id)
  }
  return rootNode
}

/**
 * Tree of a .NET test project (named after its project file): namespaces, then classes, then tests.
 * A namespace whose only child is another namespace is merged with it ("Company.Product").
 */
function dotnetTree(project: TestProject): TestTreeNode {
  const projectId = project.id
  const node = (key: string, kind: TestTreeNode['kind'], label: string, req: TestRunRequest): TestTreeNode => ({
    key,
    kind,
    label,
    projectId,
    children: [],
    testIds: [],
    req
  })
  const rootNode = node(projectId, 'project', dotnetProjectName(project), { projectId })
  const nodes = new Map<string, TestTreeNode>()
  const child = (parent: TestTreeNode, key: string, make: () => TestTreeNode): TestTreeNode => {
    let n = nodes.get(key)
    if (!n) {
      n = make()
      nodes.set(key, n)
      parent.children.push(n)
    }
    return n
  }
  // Each test once: rows are keyed by test id (a duplicate key leaves rows behind on screen).
  for (const t of uniqueTests(project.tests)) {
    // t.file: the class's full name ("Ns.Sub.Class", "Ns.Class+Nested"; "(tests)": none).
    const parts = t.file === '(tests)' ? [] : t.file.split('.')
    const chain: TestTreeNode[] = [rootNode]
    let parent = rootNode
    parts.slice(0, -1).forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('.')
      parent = child(parent, `${projectId}|ns|${path}`, () => node(`${projectId}|ns|${path}`, 'namespace', part, { projectId, file: path }))
      chain.push(parent)
    })
    parent = child(parent, `${projectId}|${t.file}`, () => node(`${projectId}|${t.file}`, 'class', parts.at(-1) ?? t.file, { projectId, file: t.file }))
    chain.push(parent)
    parent.children.push({
      ...node(`${projectId}|${t.id}`, 'test', t.name, { projectId, file: t.file, titlePath: [...t.suite, t.name], line: t.line }),
      testIds: [t.id],
      test: t
    })
    for (const n of chain) n.testIds.push(t.id)
  }
  const merge = (n: TestTreeNode): TestTreeNode => {
    let m = n
    // The merged namespace runs (and is keyed) as its deepest part: the same tests.
    while (m.kind === 'namespace' && m.children.length === 1 && m.children[0].kind === 'namespace')
      m = { ...m.children[0], label: `${m.label}.${m.children[0].label}` }
    return { ...m, children: m.children.map(merge) }
  }
  return merge(rootNode)
}

/**
 * The trees shown: .NET test projects under one node named after the project tab (where the first
 * of them is); other test projects as they are.
 */
export function groupTestTrees(trees: TestTreeNode[], projects: TestProject[], tabName: string): TestTreeNode[] {
  const isDotnet = (t: TestTreeNode): boolean => projects.find((p) => p.id === t.projectId)?.framework === 'dotnet'
  const dotnet = trees.filter(isDotnet)
  if (dotnet.length === 0) return trees
  const group: TestTreeNode = {
    key: 'group:dotnet',
    kind: 'group',
    label: tabName,
    projectId: '',
    children: dotnet,
    testIds: dotnet.flatMap((t) => t.testIds),
    req: { projectId: '' }
  }
  const at = trees.findIndex(isDotnet)
  return [...trees.slice(0, at).filter((t) => !isDotnet(t)), group, ...trees.slice(at).filter((t) => !isDotnet(t))]
}

/** The tests, each id once (the first). */
function uniqueTests(tests: TestCase[]): TestCase[] {
  const seen = new Set<string>()
  return tests.filter((t) => !seen.has(t.id) && !!seen.add(t.id))
}

type ResultMap = Record<string, TestResult | { status: 'running' }>

/** Combined status of tests: running > failed > passed (all run ones passed) > skipped. */
export function aggregateStatus(projectId: string, ids: string[], results: ResultMap): TestStatus | undefined {
  let passed = false
  let skipped = false
  let failed = false
  for (const id of ids) {
    const s = results[`${projectId}|${id}`]?.status
    if (s === 'running') return 'running'
    if (s === 'failed') failed = true
    else if (s === 'passed') passed = true
    else if (s === 'skipped') skipped = true
  }
  return failed ? 'failed' : passed ? 'passed' : skipped ? 'skipped' : undefined
}

/** A node's combined status (a group: of its test projects). */
export function nodeStatus(node: TestTreeNode, results: ResultMap): TestStatus | undefined {
  if (node.kind !== 'group') return aggregateStatus(node.projectId, node.testIds, results)
  const all = node.children.map((c) => nodeStatus(c, results))
  return (['running', 'failed', 'passed', 'skipped'] as const).find((s) => all.includes(s))
}

/** Keep the tests matching `keep` and the groups that still contain some. */
export function filterTestTree(node: TestTreeNode, keep: (t: TestCase, projectId: string) => boolean): TestTreeNode | undefined {
  if (node.kind === 'test') return keep(node.test!, node.projectId) ? node : undefined
  const children = node.children
    .map((c) => filterTestTree(c, keep))
    // (A test project is kept without tests at the top, for its listing error; not inside a group.)
    .filter((c): c is TestTreeNode => !!c && (node.kind !== 'group' || c.testIds.length > 0))
  if (children.length === 0 && node.kind !== 'project') return undefined
  const testIds = children.flatMap((c) => c.testIds)
  return { ...node, children, testIds }
}

/** Remove terminal escape sequences (colors, cursor moves) from command output. */
export const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex -- terminal escape sequences (ESC, BEL) are what is removed
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, '')

/** A file location in test output ("src/a.ts:12:5", "C:\x\a.py:3", "file:///…/a.js:1:2"). */
export interface TextLocation {
  text: string
  file: string
  line: number
  column?: number
}

// Absolute Windows / POSIX paths or file:// URLs, or relative paths with an extension, then :line[:col].
const LOCATION = /(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/)?(?:[\w.@~+-]+[\\/])*[\w.@~+-]+\.[A-Za-z]\w*:(\d+)(?::(\d+))?/g

/** Split text into plain parts and file locations (for clickable stack traces). */
export function splitLocations(text: string): (string | TextLocation)[] {
  const parts: (string | TextLocation)[] = []
  let last = 0
  for (const m of text.matchAll(LOCATION)) {
    const raw = m[0]
    const pathEnd = raw.length - m[1].length - 1 - (m[2] ? m[2].length + 1 : 0)
    const file = raw.slice(0, pathEnd)
    // Not a location: URLs (http://host:port), version-like numbers.
    const before = text.slice(Math.max(0, m.index - 3), m.index)
    if (/:\/\/?$/.test(before) || /^\d+(\.\d+)*$/.test(file)) continue
    if (m.index > last) parts.push(text.slice(last, m.index))
    // Shown without the file:// scheme (file:///C:/x → C:/x, file:///home/x → /home/x).
    const shown = raw.replace(/^file:\/\/\/?([A-Za-z]:)/i, '$1').replace(/^file:\/\//i, '')
    parts.push({ text: shown, file, line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined })
    last = m.index + raw.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export const formatDuration = (ms?: number): string =>
  ms === undefined ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
