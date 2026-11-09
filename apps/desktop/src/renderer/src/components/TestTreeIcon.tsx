import type { TestProject } from '@shared/types'
import type { TestTreeNode } from '../test-tree'

/** The language of a .NET project file: its badge. */
const LANGUAGE: Record<string, string> = { csproj: 'C#', fsproj: 'F#', vbproj: 'VB' }

/**
 * The icon of a row of a .NET test tree: the project (its language), a namespace, a class, a test.
 * Other frameworks' rows have none.
 */
export function TestTreeIcon({ node, project }: { node: TestTreeNode; project?: TestProject }): React.JSX.Element | null {
  if (project?.framework !== 'dotnet') return null
  const svg = (className: string, children: React.ReactNode): React.JSX.Element => (
    <svg
      className={`test-icon ${className}`}
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
      {children}
    </svg>
  )
  switch (node.kind) {
    case 'project': {
      const ext = project.projectFile?.split('.').pop()?.toLowerCase() ?? ''
      return (
        <span className="test-icon test-icon-project" aria-hidden>
          {LANGUAGE[ext] ?? '.N'}
        </span>
      )
    }
    case 'namespace':
      // { }
      return svg(
        'test-icon-namespace',
        <>
          <path d="M6 2.5c-1.4 0-2 .6-2 1.8v1.9c0 .9-.5 1.5-1.5 1.8 1 .3 1.5.9 1.5 1.8v1.9c0 1.2.6 1.8 2 1.8" />
          <path d="M10 2.5c1.4 0 2 .6 2 1.8v1.9c0 .9.5 1.5 1.5 1.8-1 .3-1.5.9-1.5 1.8v1.9c0 1.2-.6 1.8-2 1.8" />
        </>
      )
    case 'class':
      // A box (an object type).
      return svg(
        'test-icon-class',
        <>
          <path d="M8 1.8 13.5 4.8v6.4L8 14.2 2.5 11.2V4.8Z" />
          <path d="M2.5 4.8 8 7.8l5.5-3M8 7.8v6.4" />
        </>
      )
    case 'test':
      // A flask.
      return svg(
        'test-icon-test',
        <>
          <path d="M6 1.8h4M6.7 1.8v4.3L3 12.6c-.5.9.1 1.8 1.1 1.8h7.8c1 0 1.6-.9 1.1-1.8L9.3 6.1V1.8" />
          <path d="M4.6 10h6.8" />
        </>
      )
    default:
      return null
  }
}
