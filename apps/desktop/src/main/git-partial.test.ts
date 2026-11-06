import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hunkLines, partialPatch, partialUnsupported } from '@shared/git-patch'
import { gitOp } from './git'
import { firstUrl, newPullRequestUrl, parseRemote } from './git/hosting'

let base: string
let repo: string
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const write = (file: string, content: string): void => writeFileSync(join(repo, file), content)
const read = (file: string): string => readFileSync(join(repo, file), 'utf8')
/** Content of a file in the index. */
const staged = (file: string): string => git('show', `:${file}`)

const ORIGINAL = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].join('\n') + '\n'

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vibe-coding-ide-partial-')))
  repo = join(base, 'repo')
  mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test User')
  git('config', 'user.email', 'test@example.com')
  git('config', 'core.autocrlf', 'false')
  // Settings that change the diff's format must not break partial staging.
  git('config', 'diff.noprefix', 'true')
  write('list.txt', ORIGINAL)
  git('add', '.')
  git('commit', '-q', '-m', 'list')
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

/** The file's diff as the Changes view shows it, and the index of a line in it. */
async function diffOf(file: string, stagedDiff = false): Promise<{ text: string; at: (line: string) => number }> {
  const r = await gitOp(repo, { op: 'diff', path: file, staged: stagedDiff })
  const text = r.text ?? ''
  const lines = text.split('\n')
  return {
    text,
    at: (line) => {
      const i = lines.indexOf(line)
      if (i < 0) throw new Error(`${line} not in diff:\n${text}`)
      return i
    }
  }
}

describe('partial staging on a real repository', () => {
  it('stages, unstages and discards single lines and hunks', async () => {
    // Two hunks: "two" → "TWO" (+ an added line) near the top, "eleven" removed near the bottom.
    write('list.txt', ORIGINAL.replace('two\n', 'TWO\nadded\n').replace('eleven\n', ''))
    let d = await diffOf('list.txt')
    expect(hunkLines(d.text)).toHaveLength(2)

    // Stage only the added line (not the TWO change, not the second hunk).
    let r = await gitOp(repo, { op: 'applyLines', path: 'list.txt', staged: false, action: 'stage', lines: [d.at('+added')], diffText: d.text })
    expect(r).toEqual({ ok: true })
    expect(staged('list.txt')).toBe(ORIGINAL.replace('two\n', 'two\nadded\n'))
    expect(read('list.txt')).toBe(ORIGINAL.replace('two\n', 'TWO\nadded\n').replace('eleven\n', '')) // worktree untouched

    // Stage the whole second hunk.
    d = await diffOf('list.txt')
    r = await gitOp(repo, { op: 'applyLines', path: 'list.txt', staged: false, action: 'stage', lines: hunkLines(d.text)[1], diffText: d.text })
    expect(r.ok).toBe(true)
    expect(staged('list.txt')).toBe(ORIGINAL.replace('two\n', 'two\nadded\n').replace('eleven\n', ''))

    // Unstage the added line again (from the staged diff).
    d = await diffOf('list.txt', true)
    r = await gitOp(repo, { op: 'applyLines', path: 'list.txt', staged: true, action: 'unstage', lines: [d.at('+added')], diffText: d.text })
    expect(r.ok).toBe(true)
    expect(staged('list.txt')).toBe(ORIGINAL.replace('eleven\n', ''))

    // Discard the "two" → "TWO" change in the worktree, keeping the added line.
    d = await diffOf('list.txt')
    r = await gitOp(repo, { op: 'applyLines', path: 'list.txt', staged: false, action: 'discard', lines: [d.at('-two'), d.at('+TWO')], diffText: d.text })
    expect(r.ok).toBe(true)
    expect(read('list.txt')).toBe(ORIGINAL.replace('two\n', 'two\nadded\n').replace('eleven\n', ''))
  })

  it('refuses a diff that changed meanwhile, and wrong actions', async () => {
    write('list.txt', ORIGINAL.replace('five', 'FIVE'))
    const d = await diffOf('list.txt')
    write('list.txt', ORIGINAL.replace('five', 'FIVE').replace('nine', 'NINE'))
    let r = await gitOp(repo, { op: 'applyLines', path: 'list.txt', staged: false, action: 'stage', lines: [d.at('+FIVE')], diffText: d.text })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/changed meanwhile/)
    r = await gitOp(repo, { op: 'applyLines', path: 'list.txt', staged: false, action: 'unstage', lines: [1], diffText: d.text })
    expect(r.error).toMatch(/Invalid action/)
  })
})

describe('partial patches', () => {
  const diff = [
    'diff --git a/f b/f',
    'index 1..2 100644',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+B',
    ' c',
    '@@ -10,2 +10,1 @@ fn',
    ' x',
    '-y',
    '\\ No newline at end of file',
    ''
  ].join('\n')

  it('keeps the selected lines; unselected removals become context (forward), additions (reverse)', () => {
    expect(partialPatch(diff, [7], false)).toBe(['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -1,3 +1,4 @@', ' a', ' b', '+B', ' c', ''].join('\n'))
    // Reverse: the current content has B, which stays (context) while b is restored.
    expect(partialPatch(diff, [6], true)).toBe(['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -1,4 +1,3 @@', ' a', '-b', ' B', ' c', ''].join('\n'))
    // Only the second hunk; the "no newline" marker follows its line.
    expect(partialPatch(diff, [11], false)).toBe(
      ['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -10,2 +10,1 @@ fn', ' x', '-y', '\\ No newline at end of file', ''].join('\n')
    )
    expect(partialPatch(diff, [], false)).toBeUndefined()
  })

  it('tells which diffs cannot be split', () => {
    expect(partialUnsupported(diff)).toBeUndefined()
    expect(partialUnsupported('diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+x\n')).toBe('new file')
    expect(partialUnsupported('diff --git a/f b/f\nBinary files a/f and b/f differ\n')).toBe('binary file')
  })
})

describe('pull request hosts', () => {
  it('parses remotes', () => {
    expect(parseRemote('https://github.com/julien-amar/vibe-coding-ide.git')).toEqual({ kind: 'github', web: 'https://github.com/julien-amar/vibe-coding-ide' })
    expect(parseRemote('git@github.com:owner/repo.git')).toEqual({ kind: 'github', web: 'https://github.com/owner/repo' })
    expect(parseRemote('ssh://git@gitlab.example.com:2222/group/sub/repo.git')).toEqual({ kind: 'gitlab', web: 'https://gitlab.example.com/group/sub/repo' })
    expect(parseRemote('git@bitbucket.org:team/repo.git')?.kind).toBe('bitbucket')
    expect(parseRemote('https://org@dev.azure.com/org/Project/_git/repo')).toEqual({ kind: 'azure', web: 'https://dev.azure.com/org/Project/_git/repo' })
    expect(parseRemote('git@ssh.dev.azure.com:v3/org/Project/repo')).toEqual({ kind: 'azure', web: 'https://dev.azure.com/org/Project/_git/repo' })
    expect(parseRemote('/srv/git/repo.git')).toBeUndefined()
    expect(parseRemote('https://example.com/a/b.git')).toBeUndefined()
  })

  it('builds the new pull request pages', () => {
    const gh = parseRemote('https://github.com/o/r')!
    expect(newPullRequestUrl(gh, 'main', 'feature/x y')).toBe('https://github.com/o/r/compare/main...feature/x%20y?expand=1')
    expect(newPullRequestUrl(parseRemote('https://gitlab.com/g/r')!, 'main', 'f')).toBe(
      'https://gitlab.com/g/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=f&merge_request%5Btarget_branch%5D=main'
    )
    expect(firstUrl('Creating pull request…\n\nhttps://github.com/o/r/pull/7\n')).toBe('https://github.com/o/r/pull/7')
  })
})
