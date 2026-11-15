import type { GitStatusFile } from '@shared/types'

/** Messages sent to the AI agent from the Git panel. */

/** Files with a merge conflict (porcelain: U on either side, or added / deleted by both). */
export const conflictedFiles = (files: GitStatusFile[]): string[] =>
  files
    .filter((f) => f.index === 'U' || f.worktree === 'U' || (f.index === 'A' && f.worktree === 'A') || (f.index === 'D' && f.worktree === 'D'))
    .map((f) => f.path)

/** Shell quoting: single quotes (literal in POSIX shells and PowerShell), double quotes when the text has a '. */
const quote = (s: string): string => (s.includes("'") ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : `'${s}'`)

/**
 * Prompt asking the agent to resolve a rebase stopped on conflicts. `repo`: the repository's folder
 * relative to the project folder (the agent's), '' for the project folder itself.
 */
export function rebaseConflictPrompt(repo: string, files: string[]): string {
  const where = repo ? `cd ${quote(repo)} && ` : ''
  return [
    'A git rebase stopped on conflicts. Please resolve them.',
    '',
    `Repository: ${repo || 'the project folder'}`,
    ...(files.length ? ['Conflicted files:', ...files.map((f) => `- ${f}`)] : ['Conflicted files: see `git status`.']),
    '',
    "For each file: merge both sides (keep what each change means to do, not just one side's version), remove the conflict markers, then stage it (git add).",
    'When all are resolved, continue the rebase:',
    `${where}git -c core.editor=true rebase --continue`,
    'If it stops on another conflict, resolve that one the same way. Do not abort the rebase, commit otherwise or push.'
  ].join('\n')
}
