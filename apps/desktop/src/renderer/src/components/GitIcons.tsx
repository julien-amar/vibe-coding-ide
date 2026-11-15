/** The Git panel's action icons (16×16, outlined, in the text's colour). */

export type GitIconName = 'fetch' | 'pull' | 'push' | 'publish' | 'pullRequest' | 'rebase' | 'continue' | 'abort'

const PATHS: Record<GitIconName, React.JSX.Element> = {
  // A cloud, an arrow down out of it.
  fetch: (
    <>
      <path d="M4.6 10.5H4a3 3 0 0 1-.3-6 4 4 0 0 1 7.6-.9 3 3 0 0 1 1 5.9" />
      <path d="M8 7v7M5.8 11.8 8 14l2.2-2.2" />
    </>
  ),
  // An arrow down into a tray.
  pull: (
    <>
      <path d="M8 2v8.5M4.8 7.3 8 10.5l3.2-3.2" />
      <path d="M2.5 11v2.5h11V11" />
    </>
  ),
  // An arrow up out of a tray.
  push: (
    <>
      <path d="M8 10.5V2M4.8 5.2 8 2l3.2 3.2" />
      <path d="M2.5 11v2.5h11V11" />
    </>
  ),
  // A cloud, an arrow up into it.
  publish: (
    <>
      <path d="M4.6 10.5H4a3 3 0 0 1-.3-6 4 4 0 0 1 7.6-.9 3 3 0 0 1 1 5.9" />
      <path d="M8 14V7M5.8 9.2 8 7l2.2 2.2" />
    </>
  ),
  // Two branches' commits, one to be merged into the other (the usual pull request symbol).
  pullRequest: (
    <>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.2M8.8 2.9 7.2 4.5l1.6 1.6" />
    </>
  ),
  // A branch's commit moved onto the top of another line.
  rebase: (
    <>
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="12" cy="9" r="1.6" />
      <path d="M4 10.9V5.1M10.6 8.1C9 6.6 7.4 4.3 5.6 3.7M6.4 2.2 5.4 3.6l1.5.9" />
    </>
  ),
  // Carry on.
  continue: <path d="M5 3.2v9.6L12.5 8Z" />,
  // Stop.
  abort: <path d="M4 4l8 8M12 4l-8 8" />
}

export function GitIcon({ name }: { name: GitIconName }): React.JSX.Element {
  return (
    <svg
      className="git-icon"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  )
}
