/** The Git panel: log, status, branches, worktrees, operations, pull requests. */

export interface GitCommit {
  hash: string
  parents: string[]
  author: string
  /** Unix seconds. */
  date: number
  refs: string[]
  subject: string
}

export interface GitLog {
  isRepo: boolean
  error?: string
  branch?: string
  commits: GitCommit[]
  /** More commits after these (the next page: `skip` = the commits read so far). */
  hasMore?: boolean
}

/** A page of the history: the commits after the first `skip` (newest first), at most `limit`. */
export interface GitLogPage {
  skip?: number
  limit?: number
}

/** A git repository of a project folder. */
export interface GitRepo {
  /** Its folder (absolute). */
  path: string
  /** Its folder relative to the project folder, with forward slashes ('' = the project folder). */
  relPath: string
}

export interface GitStatusFile {
  path: string
  /** Original path of a rename/copy. */
  origPath?: string
  /** Staged state (porcelain X): ' ', M, A, D, R, C, U, ? */
  index: string
  /** Working-tree state (porcelain Y): ' ', M, D, U, ? */
  worktree: string
}

export interface GitStatus {
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  files: GitStatusFile[]
}

export interface GitBranch {
  name: string
  remote: boolean
  current: boolean
  upstream?: string
  ahead: number
  behind: number
  /** Upstream branch was deleted on the remote. */
  gone: boolean
  /** Unix seconds of the tip commit. */
  date: number
  subject: string
}

export interface GitWorktree {
  path: string
  branch?: string
  head?: string
  main: boolean
  detached?: boolean
  locked?: boolean
  prunable?: boolean
}

export type GitOp =
  | 'status'
  | 'diff'
  | 'stage'
  | 'unstage'
  | 'discard'
  | 'commit'
  | 'branches'
  | 'switch'
  | 'createBranch'
  | 'renameBranch'
  | 'deleteBranch'
  | 'merge'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'addWorktree'
  | 'removeWorktree'
  | 'commitFiles'
  | 'commitDiff'
  | 'applyLines'
  | 'lastMessage'
  | 'prInfo'
  | 'createPr'

/** Where the repository is hosted and how pull requests are made (prInfo). */
export interface GitPullRequestInfo {
  /** The remote's host; undefined when it is not a known host (GitHub, GitLab, Bitbucket, Azure DevOps). */
  host?: 'github' | 'gitlab' | 'bitbucket' | 'azure'
  /** Command line tool creating the request in the app (gh / glab); without it, the host's page opens. */
  tool?: 'gh' | 'glab'
  /** Why the tool cannot be used (not logged in…). */
  toolError?: string
  branch?: string
  /** The remote's default branch (the usual target). */
  defaultBase?: string
  /** Remote branches a request can target. */
  bases: string[]
  /** Title proposed for a new request: the branch's last commit subject. */
  title?: string
  /** The open request of the branch, if any. */
  existing?: { number: number; url: string; title: string; state: string; draft?: boolean }
}

export interface GitOpRequest {
  op: GitOp
  path?: string
  paths?: string[]
  staged?: boolean
  untracked?: boolean
  message?: string
  amend?: boolean
  branch?: string
  newName?: string
  start?: string
  checkout?: boolean
  remote?: boolean
  force?: boolean
  /** commitFiles / commitDiff: the commit, and the parent to compare with (none = root commit). */
  hash?: string
  parent?: string
  /** commitDiff: previous path of a renamed file. */
  origPath?: string
  /**
   * applyLines: stage / unstage / discard some changed lines of the file's diff (`staged`: the
   * staged diff). `lines` are indices in diffText.split('\n'); `diffText` is the diff shown, which
   * must still be the file's diff.
   */
  action?: 'stage' | 'unstage' | 'discard'
  lines?: number[]
  diffText?: string
  /** createPr: the request. */
  title?: string
  body?: string
  base?: string
  draft?: boolean
}

/** A file changed by a commit. */
export interface GitCommitFile {
  path: string
  origPath?: string
  /** A, M, D, R, C, T */
  status: string
}

export interface GitOpResult {
  ok: boolean
  error?: string
  /** Command output (diff text, commit summary…). */
  text?: string
  status?: GitStatus
  branches?: GitBranch[]
  worktrees?: GitWorktree[]
  /** New worktree folder (addWorktree). */
  path?: string
  /** commitFiles: files changed by the commit (text = full commit message). */
  files?: GitCommitFile[]
  /** prInfo: pull requests of the repository. */
  pr?: GitPullRequestInfo
  /** createPr: the new request's address (created by gh / glab), or the host's page to open. */
  url?: string
  /** createPr: the url is the host's "new pull request" page (no gh / glab), not a created request. */
  openPage?: boolean
}
