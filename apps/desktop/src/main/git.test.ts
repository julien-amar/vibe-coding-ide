import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitPrefs } from '@shared/types'
import { DEFAULT_GIT_PREFS } from '@shared/settings-defaults'
import { commandWords, diffFlags, findGitRepos, gitLog, gitOp } from './git'

/**
 * Integration tests: the Git panel operations against a real repository
 * (requires git on PATH, as on developer machines and CI runners).
 */
let base: string
let repo: string

const run = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const write = (file: string, content: string): void => {
  mkdirSync(join(repo, file, '..'), { recursive: true })
  writeFileSync(join(repo, file), content)
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vibe-coding-ide-git-')))
  repo = join(base, 'repo')
  mkdirSync(repo)
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 'Test User')
  run('config', 'user.email', 'test@example.com')
  run('config', 'core.autocrlf', 'false')
  write('README.md', 'hello\n')
  run('add', '.')
  run('commit', '-q', '-m', 'Initial commit')
  run('switch', '-q', '-c', 'feature/a')
  write('feature.txt', 'feature\n')
  run('add', '.')
  run('commit', '-q', '-m', 'Feature work')
  run('switch', '-q', 'main')
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('git panel operations on a real repository', () => {
  it('lists the history of all branches', async () => {
    const log = await gitLog(repo)
    expect(log.isRepo).toBe(true)
    expect(log.branch).toBe('main')
    expect(log.commits.map((c) => c.subject)).toEqual(expect.arrayContaining(['Initial commit', 'Feature work']))
  })

  it('reports a folder that is not a repository', async () => {
    const log = await gitLog(base)
    expect(log.isRepo).toBe(false)
  })

  it('stages, commits and shows the commit details', async () => {
    write('README.md', 'hello\nworld\n')
    write('src/app.ts', 'export const x = 1\n')
    let r = await gitOp(repo, { op: 'status' })
    expect(r.status?.files.map((f) => f.path).sort()).toEqual(['README.md', 'src/app.ts'])

    const diff = await gitOp(repo, { op: 'diff', path: 'README.md' })
    expect(diff.text).toContain('+world')
    const untracked = await gitOp(repo, { op: 'diff', path: 'src/app.ts', untracked: true })
    expect(untracked.ok).toBe(true)
    expect(untracked.text).toContain('+export const x = 1')

    expect((await gitOp(repo, { op: 'stage', paths: ['README.md', 'src/app.ts'] })).ok).toBe(true)
    r = await gitOp(repo, { op: 'commit', message: 'Add app' })
    expect(r.ok).toBe(true)

    const head = run('rev-parse', 'HEAD').trim()
    const parent = run('rev-parse', 'HEAD~1').trim()
    const files = await gitOp(repo, { op: 'commitFiles', hash: head, parent })
    expect(files.text).toBe('Add app')
    expect(files.files).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'README.md' },
        { status: 'A', path: 'src/app.ts' }
      ])
    )
    const fileDiff = await gitOp(repo, { op: 'commitDiff', hash: head, parent, path: 'src/app.ts' })
    expect(fileDiff.text).toContain('+export const x = 1')

    const root = run('rev-list', '--max-parents=0', 'HEAD').trim()
    const rootFiles = await gitOp(repo, { op: 'commitFiles', hash: root })
    expect(rootFiles.files).toEqual([{ status: 'A', path: 'README.md' }])
  })

  it('refuses a commit without a message and unstages / discards', async () => {
    expect((await gitOp(repo, { op: 'commit', message: '  ' })).ok).toBe(false)
    write('README.md', 'changed\n')
    await gitOp(repo, { op: 'stage', paths: ['README.md'] })
    await gitOp(repo, { op: 'unstage', paths: ['README.md'] })
    expect((await gitOp(repo, { op: 'status' })).status?.files[0]).toMatchObject({ path: 'README.md', index: ' ', worktree: 'M' })
    await gitOp(repo, { op: 'discard', paths: ['README.md'] })
    write('junk.tmp', 'x')
    await gitOp(repo, { op: 'discard', paths: ['junk.tmp'], untracked: true })
    expect((await gitOp(repo, { op: 'status' })).status?.files).toEqual([])
  })

  it('creates, switches, merges, renames and deletes branches', async () => {
    expect((await gitOp(repo, { op: 'createBranch', branch: 'fix/typo', checkout: true })).ok).toBe(true)
    expect((await gitOp(repo, { op: 'status' })).status?.branch).toBe('fix/typo')
    expect((await gitOp(repo, { op: 'switch', branch: 'main' })).ok).toBe(true)
    expect((await gitOp(repo, { op: 'merge', branch: 'feature/a' })).ok).toBe(true)
    expect((await gitOp(repo, { op: 'renameBranch', branch: 'fix/typo', newName: 'fix/renamed' })).ok).toBe(true)

    const branches = await gitOp(repo, { op: 'branches' })
    expect(
      branches.branches
        ?.filter((b) => !b.remote)
        .map((b) => b.name)
        .sort()
    ).toEqual(['feature/a', 'fix/renamed', 'main'])
    expect(branches.branches?.find((b) => b.current)?.name).toBe('main')

    expect((await gitOp(repo, { op: 'deleteBranch', branch: 'fix/renamed' })).ok).toBe(true)
  })

  it('accepts HEAD as the start point of a new branch or feature (dialog opened before branches load)', async () => {
    expect((await gitOp(repo, { op: 'createBranch', branch: 'from-head', start: 'HEAD', checkout: false })).ok).toBe(true)
    expect((await gitOp(repo, { op: 'deleteBranch', branch: 'from-head' })).ok).toBe(true)
    const wt = await gitOp(repo, { op: 'addWorktree', branch: 'from-head', start: 'HEAD' })
    expect(wt.ok).toBe(true)
    expect((await gitOp(repo, { op: 'removeWorktree', path: wt.path })).ok).toBe(true)
    expect((await gitOp(repo, { op: 'deleteBranch', branch: 'feature/from-head' })).ok).toBe(true)
  })

  it('refuses to delete an unmerged branch unless forced', async () => {
    run('switch', '-q', '-c', 'wip')
    write('wip.txt', 'wip\n')
    run('add', '.')
    run('commit', '-q', '-m', 'WIP')
    run('switch', '-q', 'main')
    const r = await gitOp(repo, { op: 'deleteBranch', branch: 'wip' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not fully merged/i)
    expect((await gitOp(repo, { op: 'deleteBranch', branch: 'wip', force: true })).ok).toBe(true)
  })

  it('creates and removes a feature worktree next to the repository', async () => {
    const add = await gitOp(repo, { op: 'addWorktree', branch: 'search' })
    expect(add.ok).toBe(true)
    expect(add.text).toBe('feature/search')
    expect(add.path && existsSync(add.path)).toBe(true)
    const list = (await gitOp(repo, { op: 'branches' })).worktrees ?? []
    expect(list.map((w) => w.branch)).toContain('feature/search')

    expect((await gitOp(repo, { op: 'removeWorktree', path: add.path })).ok).toBe(true)
    expect(existsSync(add.path!)).toBe(false)
  })

  it('rejects option injection and invalid ids', async () => {
    expect((await gitOp(repo, { op: 'createBranch', branch: '--evil' })).error).toBe('Invalid branch name')
    expect((await gitOp(repo, { op: 'createBranch', branch: 'bad..name' })).ok).toBe(false)
    expect((await gitOp(repo, { op: 'commitFiles', hash: 'HEAD; rm -rf /' })).error).toBe('Invalid commit id')
    expect((await gitOp(repo, { op: 'removeWorktree', path: base })).error).toBe('Unknown worktree')
  })
})

describe('history pages and the repositories of a project folder', () => {
  it('reads the history a page at a time', async () => {
    const all = await gitLog(repo)
    expect(all.hasMore).toBe(false)
    const first = await gitLog(repo, { limit: 1 })
    expect(first.commits.map((c) => c.hash)).toEqual([all.commits[0].hash])
    expect(first.hasMore).toBe(true)
    const second = await gitLog(repo, { skip: 1, limit: 1 })
    expect(second.commits.map((c) => c.hash)).toEqual([all.commits[1].hash])
    // Invalid values from the renderer: from the newest commit, a page of the default size.
    expect((await gitLog(repo, { skip: -5, limit: 0 })).commits.map((c) => c.hash)).toEqual(all.commits.map((c) => c.hash))
    expect((await gitLog(repo, { limit: 2.7 })).commits).toHaveLength(2)
  })

  it('finds the repositories of a folder: itself, sub-folders (submodules too), not dependencies', async () => {
    const project = join(base, 'workspace')
    const init = (dir: string): void => {
      mkdirSync(dir, { recursive: true })
      execFileSync('git', ['-C', dir, 'init', '-q'])
    }
    init(join(project, 'api'))
    init(join(project, 'libs', 'shared'))
    // A submodule / worktree: a .git file.
    mkdirSync(join(project, 'libs', 'vendored'), { recursive: true })
    writeFileSync(join(project, 'libs', 'vendored', '.git'), 'gitdir: ../../.git/modules/vendored\n')
    init(join(project, 'node_modules', 'dep'))
    init(join(project, '.cache', 'tool'))
    expect((await findGitRepos(project)).map((r) => r.relPath)).toEqual(['api', 'libs/shared', 'libs/vendored'])
    // The folder of a repository, or a folder inside one: itself first.
    expect((await findGitRepos(repo)).map((r) => r.relPath)).toEqual([''])
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    expect(await findGitRepos(join(repo, 'src'))).toEqual([{ path: join(repo, 'src'), relPath: '' }])
    // A folder without any.
    mkdirSync(join(base, 'empty'))
    expect(await findGitRepos(join(base, 'empty'))).toEqual([])
  })
})

describe('Git panel settings: how diffs are shown, the push command', () => {
  const prefs = (p: Partial<GitPrefs>): GitPrefs => ({ ...DEFAULT_GIT_PREFS, ...p })

  it('turns the settings into diff flags, and a command line into words', () => {
    expect(diffFlags(DEFAULT_GIT_PREFS)).toEqual(['-U3'])
    expect(diffFlags(prefs({ contextLines: 0, whitespace: 'all', ignoreBlankLines: true }))).toEqual(['-U0', '--ignore-all-space', '--ignore-blank-lines'])
    expect(diffFlags(prefs({ whitespace: 'eol' }))).toEqual(['-U3', '--ignore-space-at-eol'])
    expect(commandWords(`git review -t "my topic" 'a b'`)).toEqual(['git', 'review', '-t', 'my topic', 'a b'])
    expect(commandWords('   ')).toEqual([])
  })

  it('shows diffs with the context asked for (0: only the changes), and stages lines of such a diff', async () => {
    write('ctx.txt', 'a\nb\nc\nd\ne\nf\ng\n')
    run('add', 'ctx.txt')
    run('commit', '-q', '-m', 'ctx')
    write('ctx.txt', 'a\nb\nc\nD\ne\nf\nG\n')
    const zero = prefs({ contextLines: 0 })
    const diff = (await gitOp(repo, { op: 'diff', path: 'ctx.txt' }, zero)).text!
    expect(diff).not.toMatch(/^ c$/m)
    expect((await gitOp(repo, { op: 'diff', path: 'ctx.txt' })).text).toMatch(/^ c$/m)
    // Stage the first change only (its lines in this diff).
    const lines = diff.split('\n')
    const first = [lines.indexOf('-d'), lines.indexOf('+D')]
    expect(await gitOp(repo, { op: 'applyLines', path: 'ctx.txt', staged: false, action: 'stage', lines: first, diffText: diff }, zero)).toEqual({ ok: true })
    expect(run('show', ':ctx.txt')).toBe('a\nb\nc\nD\ne\nf\ng\n')
    run('reset', '-q', '--', 'ctx.txt')
  })

  it('leaves whitespace changes out when asked; lines are then not staged separately', async () => {
    write('ws.txt', 'one\ntwo\n')
    run('add', 'ws.txt')
    run('commit', '-q', '-m', 'ws')
    write('ws.txt', 'one  \ntwo\nthree\n')
    const ignore = prefs({ whitespace: 'all' })
    const diff = (await gitOp(repo, { op: 'diff', path: 'ws.txt' }, ignore)).text!
    expect(diff).toContain('+three')
    expect(diff).not.toContain('-one')
    const r = await gitOp(repo, { op: 'applyLines', path: 'ws.txt', staged: false, action: 'stage', lines: [1], diffText: diff }, ignore)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ignore whitespace/)
  })

  it('pushes with the push command of the settings (git … or another program, run in the repository)', async () => {
    expect(await gitOp(repo, { op: 'push' }, prefs({ pushCommand: 'git tag pushed-by-command' }))).toEqual({ ok: true })
    expect(run('tag', '--list', 'pushed-by-command').trim()).toBe('pushed-by-command')
    const node = process.execPath.includes('node') ? 'node' : undefined
    if (node) {
      expect(await gitOp(repo, { op: 'push' }, prefs({ pushCommand: `node -e "require('fs').writeFileSync('pushed.txt', 'by the push command')"` }))).toEqual({
        ok: true
      })
      expect(readFileSync(join(repo, 'pushed.txt'), 'utf8')).toBe('by the push command')
    }
    const missing = await gitOp(repo, { op: 'push' }, prefs({ pushCommand: 'no-such-push-tool-xyz' }))
    expect(missing.ok).toBe(false)
    expect(missing.error).toMatch(/was not found/)
  })
})

describe('rebase on a branch', () => {
  it('rebases the current branch (local changes set aside, then put back); a conflict leaves a rebase to continue or abort', async () => {
    run('switch', '-q', 'main')
    run('switch', '-q', '-c', 'rebase/base')
    write('base.txt', 'base\n')
    run('add', 'base.txt')
    run('commit', '-q', '-m', 'Base work')
    run('switch', '-q', 'main')
    run('switch', '-q', '-c', 'rebase/topic')
    write('topic.txt', 'topic\n')
    run('add', 'topic.txt')
    run('commit', '-q', '-m', 'Topic work')
    // An uncommitted change: kept through the rebase.
    write('README.md', 'hello, edited\n')

    expect((await gitOp(repo, { op: 'rebase', branch: 'rebase/base' })).ok).toBe(true)
    expect(run('log', '--format=%s', '-2').trim().split('\n')).toEqual(['Topic work', 'Base work'])
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('hello, edited\n')
    expect((await gitOp(repo, { op: 'status' })).status?.rebasing).toBeUndefined()
    run('checkout', '-q', '--', 'README.md')

    // Both branches change the same line: the rebase stops.
    run('switch', '-q', 'rebase/base')
    write('topic.txt', 'base side\n')
    run('add', 'topic.txt')
    run('commit', '-q', '-m', 'Base changes topic.txt')
    run('switch', '-q', 'rebase/topic')
    const r = await gitOp(repo, { op: 'rebase', branch: 'rebase/base' })
    expect(r.ok).toBe(false)
    expect((await gitOp(repo, { op: 'status' })).status?.rebasing).toBe(true)
    expect(await gitOp(repo, { op: 'rebaseAbort' })).toEqual({ ok: true })
    expect((await gitOp(repo, { op: 'status' })).status?.rebasing).toBeUndefined()
    expect(run('log', '--format=%s', '-1').trim()).toBe('Topic work')
    // Not a branch name: refused.
    expect((await gitOp(repo, { op: 'rebase', branch: '--onto' })).ok).toBe(false)
    run('switch', '-q', 'main')
  })
})

describe('rebase continued after resolving its conflicts', () => {
  it('continues a rebase stopped on a conflict once the files are resolved and staged (no editor waited for)', async () => {
    run('switch', '-q', 'main')
    run('switch', '-q', '-c', 'continue/base')
    write('shared.txt', 'base version\n')
    run('add', 'shared.txt')
    run('commit', '-q', '-m', 'Base adds shared.txt')
    run('switch', '-q', 'main')
    run('switch', '-q', '-c', 'continue/topic')
    write('shared.txt', 'topic version\n')
    run('add', 'shared.txt')
    run('commit', '-q', '-m', 'Topic adds shared.txt')

    expect((await gitOp(repo, { op: 'rebase', branch: 'continue/base' })).ok).toBe(false)
    expect((await gitOp(repo, { op: 'status' })).status?.rebasing).toBe(true)
    // Not resolved yet: continuing fails, the rebase is still there.
    expect((await gitOp(repo, { op: 'rebaseContinue' })).ok).toBe(false)
    expect((await gitOp(repo, { op: 'status' })).status?.rebasing).toBe(true)

    // Resolved and staged: the rebase ends, the topic commit (its message kept) on top of the base.
    write('shared.txt', 'both versions\n')
    run('add', 'shared.txt')
    expect(await gitOp(repo, { op: 'rebaseContinue' })).toEqual({ ok: true })
    expect((await gitOp(repo, { op: 'status' })).status?.rebasing).toBeUndefined()
    expect(run('log', '--format=%s', '-2').trim().split('\n')).toEqual(['Topic adds shared.txt', 'Base adds shared.txt'])
    expect(run('show', 'HEAD:shared.txt')).toBe('both versions\n')
    run('switch', '-q', 'main')
  })
})

describe('pull from a chosen branch', () => {
  it('merges a local branch in, pulls a remote one from its remote; a name that is not a branch is refused', async () => {
    run('switch', '-q', 'main')
    run('switch', '-q', '-c', 'pull/side')
    write('side.txt', 'side\n')
    run('add', 'side.txt')
    run('commit', '-q', '-m', 'Side work')
    run('switch', '-q', 'main')
    expect((await gitOp(repo, { op: 'pull', branch: 'pull/side', remote: false })).ok).toBe(true)
    expect(run('log', '--format=%s', '-1').trim()).toBe('Side work')

    // A remote branch: the repository as its own remote ("self").
    run('switch', '-q', '-c', 'pull/remote-work')
    write('remote.txt', 'from the remote\n')
    run('add', 'remote.txt')
    run('commit', '-q', '-m', 'Remote work')
    run('switch', '-q', 'main')
    run('remote', 'add', 'self', repo)
    run('fetch', '-q', 'self')
    expect((await gitOp(repo, { op: 'pull', branch: 'self/pull/remote-work', remote: true })).ok).toBe(true)
    expect(run('log', '--format=%s', '-1').trim()).toBe('Remote work')
    expect((await gitOp(repo, { op: 'pull', branch: 'nowhere/main', remote: true })).ok).toBe(false)
    expect((await gitOp(repo, { op: 'pull', branch: '--rebase' })).ok).toBe(false)
    run('remote', 'remove', 'self')
  })
})

describe('where a repository is hosted', () => {
  it('tells a supported host from its remote (none without a remote, or for another host)', async () => {
    const dir = join(base, 'hosted')
    mkdirSync(dir)
    execFileSync('git', ['-C', dir, 'init', '-q'])
    expect(await gitOp(dir, { op: 'remoteHost' })).toEqual({ ok: true, host: undefined })
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/app.git'])
    expect((await gitOp(dir, { op: 'remoteHost' })).host).toBe('github')
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git'])
    expect((await gitOp(dir, { op: 'remoteHost' })).host).toBe('gitlab')
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://git.example.org/acme/app.git'])
    expect((await gitOp(dir, { op: 'remoteHost' })).host).toBeUndefined()
  })
})
