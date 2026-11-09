import type { TestProject } from '@shared/types'
import type { TestTreeNode } from '../test-tree'

/** What a row of the Tests tree stands for, by framework: its icon. */
type IconKind = 'file' | 'package' | 'namespace' | 'class' | 'suite' | 'test'

/** The project's language: its badge text and colour class. */
function language(project: TestProject): { text: string; lang: string } {
  const sources = project.tests.map((t) => t.source ?? t.file)
  switch (project.framework) {
    case 'vitest':
    case 'jest':
    case 'playwright':
      return sources.some((f) => /\.[mc]?tsx?$/.test(f)) ? { text: 'TS', lang: 'ts' } : { text: 'JS', lang: 'js' }
    case 'pytest':
      return { text: 'Py', lang: 'py' }
    case 'go':
      return { text: 'Go', lang: 'go' }
    case 'cargo':
      return { text: 'Rs', lang: 'rs' }
    case 'maven':
    case 'gradle':
      return sources.some((f) => /\.kts?$/.test(f)) ? { text: 'Kt', lang: 'kt' } : { text: 'Java', lang: 'java' }
    case 'dotnet': {
      const ext = project.projectFile?.split('.').pop()?.toLowerCase()
      return { text: ext === 'fsproj' ? 'F#' : ext === 'vbproj' ? 'VB' : 'C#', lang: 'dotnet' }
    }
  }
}

/** A row's icon: files, describe() blocks, modules… differ by framework. */
function iconKind(framework: TestProject['framework'], kind: TestTreeNode['kind']): IconKind | undefined {
  if (kind === 'test') return 'test'
  if (kind === 'namespace' || kind === 'class') return kind
  if (kind === 'file')
    // Go: the package folder; Java: the class.
    return framework === 'go' ? 'package' : framework === 'maven' || framework === 'gradle' ? 'class' : 'file'
  if (kind === 'suite')
    // pytest: a class; Rust: a module; JS: a describe() block (Go: a test with subtests).
    return framework === 'pytest' ? 'class' : framework === 'cargo' ? 'namespace' : framework === 'go' ? 'test' : 'suite'
  return undefined
}

const PATHS: Record<IconKind, React.JSX.Element> = {
  // A page with a folded corner.
  file: (
    <>
      <path d="M4 1.8h5.2L12.5 5v9.2H4Z" />
      <path d="M9 1.8V5.2h3.4" />
    </>
  ),
  // A folder.
  package: <path d="M1.8 4.2c0-.6.4-1 1-1h3.4l1.5 1.6h5.5c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" />,
  // { }
  namespace: (
    <>
      <path d="M6 2.5c-1.4 0-2 .6-2 1.8v1.9c0 .9-.5 1.5-1.5 1.8 1 .3 1.5.9 1.5 1.8v1.9c0 1.2.6 1.8 2 1.8" />
      <path d="M10 2.5c1.4 0 2 .6 2 1.8v1.9c0 .9.5 1.5 1.5 1.8-1 .3-1.5.9-1.5 1.8v1.9c0 1.2-.6 1.8-2 1.8" />
    </>
  ),
  // A box (an object type).
  class: (
    <>
      <path d="M8 1.8 13.5 4.8v6.4L8 14.2 2.5 11.2V4.8Z" />
      <path d="M2.5 4.8 8 7.8l5.5-3M8 7.8v6.4" />
    </>
  ),
  // A block of nested items (describe()).
  suite: (
    <>
      <path d="M2.5 3h11M5 6.5h8.5M5 10h8.5M2.5 13.5h11" />
      <path d="M2.5 3v10.5" />
    </>
  ),
  // A flask.
  test: (
    <>
      <path d="M6 1.8h4M6.7 1.8v4.3L3 12.6c-.5.9.1 1.8 1.1 1.8h7.8c1 0 1.6-.9 1.1-1.8L9.3 6.1V1.8" />
      <path d="M4.6 10h6.8" />
    </>
  )
}

/** The icon of a row of the Tests tree: a project's language, then what each level stands for. */
export function TestTreeIcon({ node, project }: { node: TestTreeNode; project?: TestProject }): React.JSX.Element | null {
  if (!project) return null
  if (node.kind === 'project') {
    const { text, lang } = language(project)
    return (
      <span className={`test-icon test-icon-project lang-${lang}`} aria-hidden>
        {text}
      </span>
    )
  }
  const kind = iconKind(project.framework, node.kind)
  if (!kind) return null
  return (
    <svg
      className={`test-icon test-icon-${kind}`}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[kind]}
    </svg>
  )
}
