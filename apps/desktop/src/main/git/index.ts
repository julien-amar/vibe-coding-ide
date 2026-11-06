/** The Git panel's backend: repository reading, operations, pull requests, change notifications. */
export { gitLog, gitStatus, parseNameStatus, parseStatus, worktreeDir } from './repo'
export { gitOp } from './ops'
export { GitWatcher } from './watcher'
