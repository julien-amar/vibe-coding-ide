/** The Git panel's backend: repository reading, operations, pull requests, change notifications. */
export { commandWords, diffFlags, gitLog, gitStatus, LOG_PAGE, parseNameStatus, parseStatus, worktreeDir } from './repo'
export { findGitRepos } from './repos'
export { gitOp } from './ops'
export { GitWatcher } from './watcher'
