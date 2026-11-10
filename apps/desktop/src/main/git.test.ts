import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findGitRepos, gitLog, gitOp } from './git'

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
