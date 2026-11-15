import { describe, expect, it } from 'vitest'
import type { GitStatusFile } from '@shared/types'
import { conflictedFiles, rebaseConflictPrompt } from './git-prompt'

describe('Merge with AI (a rebase stopped on conflicts)', () => {
  it('finds the conflicted files (both modified, added or deleted by both, deleted by one side)', () => {
    const f = (path: string, index: string, worktree: string): GitStatusFile => ({ path, index, worktree })
    expect(
      conflictedFiles([
        f('both.txt', 'U', 'U'),
        f('added.txt', 'A', 'A'),
        f('deleted.txt', 'D', 'D'),
        f('theirs.txt', 'D', 'U'),
        f('staged.txt', 'M', ' '),
        f('new.txt', '?', '?')
      ])
    ).toEqual(['both.txt', 'added.txt', 'deleted.txt', 'theirs.txt'])
  })

  it('asks to merge both sides, stage each file and continue the rebase (in the repository’s folder)', () => {
    const p = rebaseConflictPrompt('libs/shared', ['src/a.ts', 'README.md'])
    expect(p).toContain('A git rebase stopped on conflicts.')
    expect(p).toContain('Repository: libs/shared')
    expect(p).toContain('- src/a.ts\n- README.md')
    expect(p).toContain('merge both sides')
    expect(p).toContain(`cd 'libs/shared' && git -c core.editor=true rebase --continue`)
    expect(p).toContain('Do not abort the rebase')
    // The project folder's own repository: no cd.
    expect(rebaseConflictPrompt('', ['a.txt'])).toContain('Repository: the project folder\n')
    expect(rebaseConflictPrompt('', ['a.txt'])).toContain('\ngit -c core.editor=true rebase --continue')
  })
})
